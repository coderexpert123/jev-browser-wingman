// WP-I — I3: `doctor --plan` (spec 2026-09-26-wingman-forced-handoff § 5.11,
// § 6 WP-I). An offline install helper: it reuses `detect` (already
// read-only) and ONLY the offline `runDoctor` checks (key-present,
// config-loaded, registration-portable, policy-loaded, profile-safe,
// handoff), via `runDoctor(..., { offlineOnly: true })`. It never runs
// adapter-attach, default-context, coexistence or jev-round, so it never
// attaches to or launches a browser and never calls TypeSafe (§ 3 rule 7).
// It never throws on an unknown client or an unrecognised browsing tool;
// those combinations get `known: false` and hints instead of steps.

import { homedir } from 'node:os';
import { DEFAULT_PORT, DEFAULT_PROFILE_DIR } from '../contract/constants.js';
import { wingmanHome } from '../contract/home.js';
import { loadConfig, handoffOf } from '../core/config.js';
import { loadProfiles, profileForArgv, withheldClasses, denyEntries, type Profile } from '../core/profiles.js';
import { adapterOps } from '../adapters/capabilities.js';
import { detect, DETECT_CLIENTS } from './detect.js';
import type { DetectDeps } from './detect.js';
import { runDoctor } from './doctor.js';
import type { DoctorDeps } from './doctor.js';
import { clientConfigPath, wingmanServerEntry, wrapBrowsingEntry } from './registrations.js';
import type { ClientId } from './registrations.js';

export type SetupPlanOutcomeId = 'O1' | 'O2' | 'O3' | 'O4' | 'O5';

export interface SetupPlanOutcome {
  id: SetupPlanOutcomeId;
  met: boolean;
  why: string;
  check: string;
  steps: string[];
  hints: string[];
}

export interface SetupPlan {
  client: string;
  known: boolean;
  outcomes: SetupPlanOutcome[];
}

export interface SetupPlanDeps {
  client: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  detectFn?: typeof detect;
  runDoctorFn?: typeof runDoctor;
  loadConfigFn?: typeof loadConfig;
  loadProfilesFn?: typeof loadProfiles;
  /** Forwarded to `runDoctor` (`offlineOnly` is always set by this module). */
  doctorDeps?: DoctorDeps;
}

function flagPresent(args: readonly string[], flags: readonly string[]): boolean {
  return flags.some((f) => args.some((a) => a === f || a.startsWith(`${f}=`)));
}

const OUTCOME_CHECKS: Record<SetupPlanOutcomeId, string> = {
  O1: 'registration-portable, config-loaded',
  O2: 'handoff',
  O3: 'adapter-attach, default-context, coexistence',
  O4: 'key-present',
  O5: 'all checks',
};

function unknownOutcomes(): SetupPlanOutcome[] {
  return (Object.keys(OUTCOME_CHECKS) as SetupPlanOutcomeId[]).map((id) => ({
    id,
    met: false,
    why: 'the client or its browsing tool is not one doctor --plan recognises',
    check: OUTCOME_CHECKS[id],
    steps: [],
    hints: [`${id}: reach it by any route that satisfies ${OUTCOME_CHECKS[id]}, then run doctor to verify`],
  }));
}

/** The offline setup plan for one client (I3). Never throws: an unknown
 * client, an unrecognised browsing tool, or any read failure along the way
 * all fall back to a `known: false` plan with hints only. */
export async function buildSetupPlan(deps: SetupPlanDeps): Promise<SetupPlan> {
  const rawClient = deps.client;
  const known = (DETECT_CLIENTS as readonly string[]).includes(rawClient);
  if (!known) {
    return { client: rawClient, known: false, outcomes: unknownOutcomes() };
  }
  const client = rawClient as ClientId;

  try {
    return await buildKnownPlan(client, deps);
  } catch {
    return { client, known: false, outcomes: unknownOutcomes() };
  }
}

async function buildKnownPlan(client: ClientId, deps: SetupPlanDeps): Promise<SetupPlan> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const detectFn = deps.detectFn ?? detect;
  const loadProfilesFn = deps.loadProfilesFn ?? loadProfiles;

  const detectDeps: DetectDeps = {
    env,
    home,
    clients: [client],
    loadConfigFn,
    readRegistrationsFn: deps.doctorDeps?.readRegistrationsFn,
  };
  const detectReport = await detectFn(detectDeps);
  const clientReport = detectReport.clients.find((c) => c.client === client) ?? null;

  const doctorReport = await (deps.runDoctorFn ?? runDoctor)(
    { client, json: true, offlineOnly: true, print: false },
    { env, loadConfigFn, ...deps.doctorDeps },
  );
  const checkOf = (id: string) => doctorReport.checks.find((c) => c.id === id) ?? null;

  const loaded = await loadConfigFn(env);
  const configMode = loaded.ok ? loaded.config.mode : 'off';
  const configPort = loaded.ok ? loaded.config.port : DEFAULT_PORT;
  const configDir = loaded.ok ? loaded.config.profile_dir : DEFAULT_PROFILE_DIR;
  const retain = loaded.ok ? handoffOf(loaded.config).retain : [];
  const adapter = loaded.ok ? loaded.config.adapter : 'playwright';

  const configPath = clientConfigPath(client, env);
  const wHome = wingmanHome(env, home);
  const profiles = loadProfilesFn(wHome);

  const wingmanServer = clientReport?.servers.find((s) => s.kind === 'jev-browser-wingman') ?? null;

  // O1: registered with the client, and wingman's top-level mode is on.
  const o1Steps: string[] = [];
  if (!wingmanServer) {
    o1Steps.push(`add to ${configPath}: ${JSON.stringify(wingmanServerEntry(client))}`);
  }
  if (configMode !== 'on') {
    o1Steps.push(`set "mode": "on" in ${wHome}/config.json`);
  }
  const o1Met = Boolean(wingmanServer) && configMode === 'on';
  const o1: SetupPlanOutcome = {
    id: 'O1',
    met: o1Met,
    why: o1Met
      ? 'wingman is registered with the client and its top-level mode is on'
      : !wingmanServer
        ? `wingman is not registered with ${client}`
        : `wingman is registered, but the top-level mode is ${configMode}, not on`,
    check: OUTCOME_CHECKS.O1,
    steps: o1Steps,
    hints: [],
  };

  // The one unwrapped browsing-tool registration this client has, if any:
  // the candidate for the O2 wrap/deny step and the O3 extension step.
  const browsingServer =
    clientReport?.servers.find((s) => s.kind !== 'jev-browser-wingman' && s.kind !== 'other' && s.mode !== 'wrapped') ??
    null;
  const browsingProfile: Profile | null = browsingServer
    ? (profiles.find((p) => p.id === browsingServer.kind) ?? null)
    : null;

  // O2: the caller's in-page action tools are withheld (proxy, deny, or
  // instruction-only with a stated reason) — read from the `handoff` check.
  const handoffCheck = checkOf('handoff');
  const o2Met =
    handoffCheck !== null &&
    handoffCheck.status === 'PASS' &&
    !handoffCheck.detail.startsWith('optional:') &&
    handoffCheck.detail !== 'no browsing tool registered';
  const o2Steps: string[] = [];
  if (!o2Met && browsingServer && browsingProfile) {
    const isExtension = flagPresent(browsingServer.args, browsingProfile.detect.extension_flags);
    if (!isExtension) {
      const wrapped = wrapBrowsingEntry(
        { command: browsingServer.command, args: browsingServer.args },
        client,
        browsingProfile,
      );
      o2Steps.push(`replace server ${browsingServer.name} in ${configPath} with: ${JSON.stringify(wrapped)}`);
    } else {
      const withheld = withheldClasses(adapterOps(adapter), retain);
      const deny = denyEntries(client, browsingServer.name, browsingProfile, withheld);
      if (deny) {
        const settingsPath = client === 'claude' ? `${homedir()}/.claude/settings.json` : configPath;
        o2Steps.push(`add to ${settingsPath}: ${JSON.stringify(deny.entries)}`);
      } else {
        o2Steps.push(`instruction-only: ${client} has no known tool deny list for a browser extension`);
      }
    }
  }
  const o2: SetupPlanOutcome = {
    id: 'O2',
    met: o2Met,
    why: o2Met
      ? "the caller's in-page action tools are withheld"
      : "nothing withholds the caller's in-page action tools yet",
    check: OUTCOME_CHECKS.O2,
    steps: o2Steps,
    hints: !o2Met && o2Steps.length === 0 ? ['no browsing-tool registration was found to wrap or deny'] : [],
  };

  // O3: wingman and the caller's browsing tool share one debuggable
  // Chromium-family browser. Always unmet except when the detected setup
  // needs no separate step (wingman launches its own shared browser).
  const needsBrowserStep =
    browsingServer !== null && (browsingServer.mode === 'extension' || browsingServer.mode === 'cdp-endpoint');
  const o3: SetupPlanOutcome = needsBrowserStep
    ? {
        id: 'O3',
        met: false,
        why: "the caller's browsing tool attaches through its own debugging endpoint, which the shared browser must expose",
        check: OUTCOME_CHECKS.O3,
        steps: [`start a Chromium-family browser with --remote-debugging-port=${configPort} --user-data-dir=${configDir}`],
        hints: ['run jev-browser-wingman doctor to verify'],
      }
    : {
        id: 'O3',
        met: true,
        why: 'wingman launches its own shared browser at first use; no separate step is needed',
        check: OUTCOME_CHECKS.O3,
        steps: ['none (wingman launches the shared browser at first use)'],
        hints: [],
      };

  // O4: a TypeSafe key is available.
  const keyCheck = checkOf('key-present');
  const o4Met = keyCheck?.status === 'PASS';
  const o4: SetupPlanOutcome = {
    id: 'O4',
    met: o4Met,
    why: o4Met ? 'a TypeSafe key is available' : 'no TypeSafe key is available yet',
    check: OUTCOME_CHECKS.O4,
    steps: o4Met ? [] : ["set TYPESAFE_API_KEY in the client's secret or env store, or secrets_file in config"],
    hints: [],
  };

  // O5: doctor passes. Always unmet: `--plan` never runs the live checks
  // that would let it certify a pass (I3).
  const o5: SetupPlanOutcome = {
    id: 'O5',
    met: false,
    why: 'doctor has not verified this setup',
    check: OUTCOME_CHECKS.O5,
    steps: [`run jev-browser-wingman doctor --client ${client}`],
    hints: [],
  };

  return { client, known: true, outcomes: [o1, o2, o3, o4, o5] };
}

/** Text rendering (I1): one block per outcome, `[met]`/`[todo]`, then its
 * steps and hints. `--json` prints the `SetupPlan` object instead. */
export function printSetupPlan(plan: SetupPlan): string {
  const lines: string[] = [`client: ${plan.client}${plan.known ? '' : ' (unknown)'}`];
  for (const o of plan.outcomes) {
    lines.push(`[${o.met ? 'met' : 'todo'}] ${o.id}: ${o.why}`);
    for (const step of o.steps) lines.push(`  - ${step}`);
    for (const hint of o.hints) lines.push(`  hint: ${hint}`);
  }
  return lines.join('\n') + '\n';
}
