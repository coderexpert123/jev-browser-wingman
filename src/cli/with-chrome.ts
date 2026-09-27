// Generic withholding proxy (spec 2026-09-26-wingman-forced-handoff § 5.9).
// Wraps another MCP stdio command (command `with-browser`, deprecated alias
// `with-chrome`; the file keeps its name). Two independent behaviours share
// the piped stdio path:
//   - lazy Chrome ensure: without a preset endpoint, the shared browser is
//     ensured lazily, just before the first tools/call is forwarded — never
//     at start-up (unchanged from the pre-0.3.0 wrapper).
//   - forced handoff: when the effective handoff is forced, capability-class
//     withholding filters tools/list and refuses withheld tools/call before
//     it ever ensures or forwards. Capability profiles are DATA (core/profiles.js);
//     no browsing product is named in this file.
// With a preset endpoint and optional handoff, stdio is left byte-for-byte
// inherited (today's original path, no processing at all).

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { loadConfig, handoffOf, resolveKey } from '../core/config.js';
import { wingmanHome } from '../contract/home.js';
import type { Op, WindowMode, WingmanConfig } from '../contract/types.js';
import { ensureChrome, probeVersion, quoteCmdLine } from '../browser/chrome.js';
import { adapterOps } from '../adapters/capabilities.js';
import { loadProfiles, profileForArgv, profileForTools, classOfCall, withheldClasses, type Profile } from '../core/profiles.js';
import { classifyTools } from '../core/classify-tools.js';
import { createDefaultAsk } from '../core/jev-client.js';
import { HANDOFF_REFUSAL_TEXT } from '../contract/constants.js';
import type { WithholdableClass } from '../contract/constants.js';

export interface WithChromeDeps {
  env?: NodeJS.ProcessEnv;
  loadConfigFn?: typeof loadConfig;
  ensureChromeFn?: typeof ensureChrome;
  probeVersionFn?: typeof probeVersion;
  spawnFn?: (command: string, args: string[], opts: Record<string, unknown>) => ChildProcess;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  adapterOps?: readonly Op[];
  loadProfilesFn?: typeof loadProfiles;
  classifyToolsFn?: typeof classifyTools;
}

interface ProxyTarget {
  port: number;
  profileDir: string;
  chromePath: string | null;
  home: string;
  window: WindowMode;
}

/** The id of a gated line: a JSON object with method "tools/call", or an array containing one. */
function gatedCallId(parsed: unknown): { gated: false } | { gated: true; id?: string | number; batch: boolean } {
  if (Array.isArray(parsed)) {
    const hasCall = parsed.some(
      (m) => m && typeof m === 'object' && !Array.isArray(m) && (m as Record<string, unknown>).method === 'tools/call',
    );
    return hasCall ? { gated: true, batch: true } : { gated: false };
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (o.method === 'tools/call') {
      const id = o.id;
      if (typeof id === 'string' || typeof id === 'number') return { gated: true, id, batch: false };
      return { gated: true, batch: false };
    }
  }
  return { gated: false };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The text before the first `=` or `{` in an endpoint_arg template, e.g.
 * "--browserUrl={endpoint}" -> "--browserUrl". */
function argFlagPrefix(template: string): string {
  const eq = template.indexOf('=');
  const brace = template.indexOf('{');
  const cut = eq === -1 ? brace : brace === -1 ? eq : Math.min(eq, brace);
  return cut === -1 ? template : template.slice(0, cut);
}

export async function runWithBrowser(argv: string[], deps: WithChromeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  if (argv.length === 0) {
    stderr.write('usage: jev-browser-wingman with-browser -- <command> [args...]\n');
    return 2;
  }

  const home = wingmanHome(env);
  const profiles = (deps.loadProfilesFn ?? loadProfiles)(home);
  const argvProfile: Profile | null = profileForArgv(profiles, argv[0], argv.slice(1));

  // Endpoint order (§ 5.9): WINGMAN_CDP_ENDPOINT, else the first loaded
  // profile's launch.endpoint_env present in env, else none (config-derived).
  const firstProfileEndpointEnvValue = (): string | null => {
    for (const p of profiles) {
      if (p.launch.endpoint_env && env[p.launch.endpoint_env]) return env[p.launch.endpoint_env] as string;
    }
    return null;
  };
  const preset = env.WINGMAN_CDP_ENDPOINT || firstProfileEndpointEnvValue() || null;

  // The config is loaded in both branches: a preset-endpoint failure prints
  // one stderr line and continues as optional; without a preset, a failure
  // keeps today's exit 1.
  const loaded = await (deps.loadConfigFn ?? loadConfig)(env);
  let config: WingmanConfig | null = null;
  if (loaded.ok) {
    config = loaded.config;
  } else if (preset) {
    stderr.write(`jev-browser-wingman with-browser: config: ${loaded.error}; handoff optional\n`);
  } else {
    stderr.write(`jev-browser-wingman with-browser: config: ${loaded.error}\n`);
    return 1;
  }

  const forced = config !== null && handoffOf(config).mode === 'forced';
  const withheld = new Set<WithholdableClass>(
    config !== null ? withheldClasses(deps.adapterOps ?? adapterOps(config.adapter), handoffOf(config).retain) : [],
  );

  let endpoint: string;
  let proxyTarget: ProxyTarget | null = null;
  if (preset) {
    endpoint = preset;
  } else {
    // loaded.ok is guaranteed here (the branch above returns 1 otherwise).
    const c = config as WingmanConfig;
    endpoint = `http://127.0.0.1:${c.port}`;
    proxyTarget = {
      port: c.port,
      profileDir: c.profile_dir,
      chromePath: c.chrome_path,
      home,
      window: c.window,
    };
  }

  let childArgv = argv.map((a) => a.split('{cdp}').join(endpoint).split('{endpoint}').join(endpoint));
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (argvProfile) {
    if (argvProfile.launch.endpoint_env) {
      childEnv[argvProfile.launch.endpoint_env] = endpoint;
    }
    if (argvProfile.launch.endpoint_arg) {
      const template = argvProfile.launch.endpoint_arg;
      const prefix = argFlagPrefix(template);
      const present = argv.some((a) => a === prefix || a.startsWith(prefix));
      if (!present) {
        childArgv = [...childArgv, template.split('{endpoint}').join(endpoint)];
      }
    }
  }

  // Piped whenever there is no preset OR the effective handoff is forced;
  // inherited stdio is kept only for preset + optional (today's byte path).
  const usePipe = !preset || forced;
  const doEnsure = !preset;

  const spawnFn = deps.spawnFn ?? ((command: string, args: string[], opts: Record<string, unknown>) => nodeSpawn(command, args, opts as never));
  let child: ChildProcess;
  if (process.platform === 'win32') {
    const comspec = env.ComSpec ?? 'cmd.exe';
    const cmdArg = '"' + quoteCmdLine(childArgv) + '"';
    child = spawnFn(comspec, ['/d', '/s', '/c', cmdArg], {
      stdio: usePipe ? ['pipe', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: childEnv,
    });
  } else {
    child = spawnFn(childArgv[0], childArgv.slice(1), {
      stdio: usePipe ? ['pipe', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
      env: childEnv,
    });
  }

  const forwardSignals = (signal: 'SIGINT' | 'SIGTERM'): void => {
    const handler = (): void => {
      child.kill(signal);
    };
    process.on(signal, handler);
  };
  forwardSignals('SIGINT');
  forwardSignals('SIGTERM');

  if (!usePipe) {
    // Preset endpoint + optional handoff: the child talks protocol over
    // inherited stdio directly, byte-for-byte.
    return await exitCodeOf(child);
  }

  // ---- proxy branch (§ 5.9) ----

  // Every line written to our own stdout — forwarded child lines and
  // proxy-generated lines alike — goes through one serialized chain, so
  // asynchronous work (ensure, classify-tools) never reorders output.
  let outputChain: Promise<void> = Promise.resolve();
  const enqueueOutput = (fn: () => void | Promise<void>): void => {
    outputChain = outputChain.then(fn);
  };
  const writeProxyLine = (line: string): void => {
    enqueueOutput(() => {
      stdout.write(line + '\n');
    });
  };

  // Lazy ensure state: one successful ensure marks the process; after that a
  // null probe re-arms it (the browser may have been stopped in between).
  let ensuredOnce = false;
  let lastEnsureError = 'Chrome could not be started';
  const ensureChromeFn = deps.ensureChromeFn ?? ensureChrome;
  const probeVersionFn = deps.probeVersionFn ?? probeVersion;
  const ensureIfNeeded = async (): Promise<boolean> => {
    const proxy = proxyTarget as ProxyTarget;
    if (ensuredOnce) {
      const answer = await probeVersionFn(proxy.port, 1500);
      if (answer !== null) return true;
    }
    const result = await ensureChromeFn({
      port: proxy.port,
      profileDir: proxy.profileDir,
      chromePath: proxy.chromePath,
      home: proxy.home,
      window: proxy.window,
    });
    if (result.ok) {
      ensuredOnce = true;
      return true;
    }
    lastEnsureError = result.message;
    return false;
  };

  // Forced-handoff withholding state.
  let activeProfile: Profile | null = null;
  const pendingToolsListIds = new Set<string | number>();
  let warnedNoProfile = false;
  let warnedNothingWithheld = false;

  const classFor = (name: string, args: unknown): string => {
    const profile = activeProfile ?? argvProfile;
    if (!profile) return 'unknown';
    return classOfCall(profile, name, args);
  };

  const isWithheldCall = (msg: unknown): boolean => {
    if (!isRecord(msg) || msg.method !== 'tools/call') return false;
    const params = isRecord(msg.params) ? msg.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const cls = classFor(name, params.arguments);
    return withheld.has(cls as WithholdableClass);
  };

  const refusalFor = (id: unknown): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    result: { content: [{ type: 'text', text: HANDOFF_REFUSAL_TEXT }], isError: true },
  });

  /** Refusal line(s) for a client message, or null when nothing is withheld. */
  const computeRefusal = (parsed: unknown): string | null => {
    if (!forced) return null;
    if (Array.isArray(parsed)) {
      const anyWithheld = parsed.some((m) => isWithheldCall(m));
      if (!anyWithheld) return null;
      const refusals = parsed
        .filter((m): m is Record<string, unknown> => isRecord(m) && m.id !== undefined)
        .map((m) => refusalFor(m.id));
      return JSON.stringify(refusals);
    }
    if (isWithheldCall(parsed)) {
      return JSON.stringify(refusalFor(isRecord(parsed) ? parsed.id : undefined));
    }
    return null;
  };

  const recordToolsListId = (parsed: unknown): void => {
    if (!forced || !isRecord(parsed) || parsed.method !== 'tools/list') return;
    const id = parsed.id;
    if (typeof id === 'string' || typeof id === 'number') pendingToolsListIds.add(id);
  };

  // ---- child -> client ----

  let childBuf = '';
  const handleChildLine = async (rawLine: string): Promise<void> => {
    if (!forced) {
      stdout.write(rawLine);
      return;
    }
    let text = rawLine;
    if (text.endsWith('\n')) text = text.slice(0, -1);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const isPendingToolsList =
      isRecord(parsed) &&
      (typeof parsed.id === 'string' || typeof parsed.id === 'number') &&
      pendingToolsListIds.has(parsed.id as string | number) &&
      isRecord(parsed.result) &&
      Array.isArray((parsed.result as Record<string, unknown>).tools);
    if (!isPendingToolsList) {
      stdout.write(rawLine);
      return;
    }
    const o = parsed as Record<string, unknown>;
    pendingToolsListIds.delete(o.id as string | number);
    const result = o.result as Record<string, unknown>;
    const tools = result.tools as Array<{ name: string; description?: string }>;
    const names = tools.map((t) => t.name);

    if (!activeProfile) {
      let matched = profileForTools(profiles, names);
      if (!matched) {
        const key = resolveKey(env, config?.secrets_file ?? null).key;
        const classified = await (deps.classifyToolsFn ?? classifyTools)(tools, {
          ask: key ? createDefaultAsk({ apiKey: key }) : null,
          home,
        });
        matched = classified.profile;
        if (!matched && !warnedNoProfile) {
          warnedNoProfile = true;
          stderr.write(
            `jev-browser-wingman with-browser: no capability profile matches the wrapped browsing tool (${classified.reason ?? 'unclassified'}); forced handoff is not enforced for it. Add a profile under ${home}/profiles or set a TypeSafe key for auto-classification.\n`,
          );
        }
      }
      activeProfile = matched;
    }

    let filteredTools = tools;
    if (activeProfile) {
      const profile = activeProfile;
      filteredTools = tools.filter((t) => {
        const cls = profile.tools[t.name];
        if (cls === undefined) return true; // no map entry: never removed here
        if (!withheld.has(cls as WithholdableClass)) return true;
        return profile.arg_rules.some((r) => r.tool === t.name); // arg-ruled tools stay listed
      });
      if (filteredTools.length === tools.length && withheld.size > 0 && !warnedNothingWithheld) {
        warnedNothingWithheld = true;
        stderr.write(
          'jev-browser-wingman with-browser: forced handoff withheld no tool from the wrapped browsing tool; check its capability profile.\n',
        );
      }
    }
    stdout.write(JSON.stringify({ ...o, result: { ...result, tools: filteredTools } }) + '\n');
  };

  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    childBuf += chunk;
    let idx: number;
    while ((idx = childBuf.indexOf('\n')) !== -1) {
      const line = childBuf.slice(0, idx + 1);
      childBuf = childBuf.slice(idx + 1);
      enqueueOutput(() => handleChildLine(line));
    }
  });
  child.stdout!.on('end', () => {
    enqueueOutput(() => {
      if (childBuf !== '') {
        stdout.write(childBuf);
        childBuf = '';
      }
    });
  });

  // ---- client -> child ----

  const forward = (line: string): void => {
    child.stdin!.write(line + '\n');
  };
  const handleLine = async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    recordToolsListId(parsed);

    const refusal = computeRefusal(parsed);
    if (refusal !== null) {
      writeProxyLine(refusal);
      return;
    }

    const gate = gatedCallId(parsed);
    if (!gate.gated || !doEnsure) {
      forward(line);
      return;
    }
    const ok = await ensureIfNeeded();
    if (ok || gate.batch) {
      // A failed gated array line is forwarded unchanged (a batch cannot be
      // answered piecemeal).
      forward(line);
      return;
    }
    writeProxyLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: gate.id ?? null,
        result: { content: [{ type: 'text', text: `jev-browser-wingman with-chrome: ${lastEnsureError}` }], isError: true },
      }),
    );
  };

  let stdinBuf = '';
  let chain: Promise<void> = Promise.resolve();
  const feed = (chunk: string): void => {
    stdinBuf += chunk;
    let idx: number;
    while ((idx = stdinBuf.indexOf('\n')) !== -1) {
      let line = stdinBuf.slice(0, idx);
      stdinBuf = stdinBuf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const pending = chain.then(() => handleLine(line));
      chain = pending.catch(() => {});
    }
  };
  stdin.setEncoding('utf8');
  stdin.on('data', feed);
  stdin.on('end', () => {
    child.stdin!.end();
  });
  // An open stdin (a host or test harness holding the pipe) must not keep
  // this process alive once the child has exited.
  (stdin as unknown as { unref?: () => void }).unref?.();

  const code = await exitCodeOf(child);
  // Drain: give the output chain a final chance to flush queued writes.
  await outputChain.catch(() => {});
  return code;
}

/** Deprecated alias of runWithBrowser (§ 5.9); the exported symbol is the
 * same function, not a wrapper. */
export const runWithChrome = runWithBrowser;

function exitCodeOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}
