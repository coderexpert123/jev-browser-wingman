#!/usr/bin/env node
// Grader-replay harness (r21 P-4, spec D7-D9). The de-risking tool for all
// future Jev grading work: any threshold/rule change ships only with a fresh
// capture, a replay report showing the candidate set flips the targeted
// bounces WITHOUT flipping recorded advances/commits, and the drift self-check
// green (D9). Nothing in r21 meets that bar; this round ships the harness.
//
// Three subcommands:
//   capture --out <file> [--url <page-url>]... [--task <fixture-page> <step-text>]... [--call <page-url> <browse_step-json>]...
//       --call runs wingman.step with the given arguments on that page; consecutive
//       calls on the same url share the page and the process's value memory, without re-navigating.
//       Launches an ephemeral headless Chrome, wraps createDefaultAsk with a
//       recorder, and appends one JSON line per ASKING round:
//       {ts, tool, host, round, chain, request, response, ms, decision}.
//       Each recorded ask also carries `stage` (askStage) so the merge can
//       consume a round's continuation asks (two-stage request 2, select-
//       option chunks) into the SAME round — F1. decision carries the loop's
//       actual round decision (kind + end status/reason + per-round
//       probabilities) per D8. Output files are UNTRACKED (.calib/ by
//       convention) — they contain page text (R7). REQUIRES TYPESAFE_API_KEY.
//   replay --capture <file> [--thresholds <overrides.json>] [--report <file>]
//       Per captured mirrored round, extracts the probability set from the
//       recorded response's answer map and re-evaluates the threshold
//       comparisons under the override set against the recorded baseline set.
//       Reports per-round would-change rows plus a summary. With NO
//       --thresholds this is the D8 drift self-check: the baseline set must
//       reproduce every recorded decision class; ANY mismatch exits 1 with
//       the offending round printed.
//   margins --slices <glob> [--slices <glob>]... [--report <file>]
//       Reads log slices (r16-r20 evidence/*.jsonl) and histograms each
//       threshold's margins: how many recorded rounds sat within +/-0.05 /
//       +/-0.10 of ready 0.3, stepDoneWithEvidence 0.5, done 0.85, target 0.5.
//       A <glob> of the form "<git-ref>:<glob>" reads paths out of a results
//       backup ref (git ls-tree + git show); anything else is a filesystem
//       glob relative to the repo root.
//
// MIRROR SCOPE (stated honestly, D7): the replay mirror evaluates threshold
// comparisons on recorded probability sets — NOT the full evidence-rule
// cascade. Evidence-bar advances (stepDoneWithEvidence 0.5 / nav 0.25),
// repeat-count/key evidence, no-progress/repeat guards, login/blocked ends,
// recover mechanicals and budget ends are NOT expressible from probabilities
// alone. Capture marks a round `mirrored: true` only when the mirror's
// baseline evaluation on that round's recorded probabilities reproduces the
// round's recorded decision kind; the self-check never judges unmirrored
// rounds. A baseline self-check failure means the loop's rule order or
// thresholds moved since the capture — the mirror has gone stale (R10).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HARNESS_DIR, '..');

const distUrl = (rel) => pathToFileURL(join(REPO_ROOT, 'dist', rel)).href;

// The four spec-pinned margin thresholds (spec D7). Used directly by the
// margins mode and as the documented fallback when dist/ is absent; the
// source actually used is printed in every report.
export const SPEC_MARGIN_THRESHOLDS = [
  { key: 'done', field: 'doneP', threshold: 0.85, label: 'done' },
  { key: 'stepDoneWithEvidence', field: 'stepDoneP', threshold: 0.5, label: 'step_done (evidence bar)' },
  { key: 'ready', field: 'readyP', threshold: 0.3, label: 'ready' },
  { key: 'target', field: 'target1P', threshold: 0.5, label: 'target', needsElement: true },
];

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Pure parts (unit-tested by tests/grader-replay.test.ts)
// ---------------------------------------------------------------------------

/** Parse a log-slice / log.jsonl text into WingmanLogRecord objects. */
export function parseSlice(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

/** Extract the per-round probability fields a log record's phases carry. */
export function extractRoundProbs(record) {
  const rounds = record?.phases?.rounds;
  if (!Array.isArray(rounds)) return [];
  return rounds.map((r) => ({
    actionP: r.actionP,
    target1: r.target1,
    target1P: r.target1P,
    target2: r.target2,
    target2P: r.target2P,
    doneP: r.doneP,
    stepDoneP: r.stepDoneP,
    readyP: r.readyP,
    rightPageP: r.rightPageP,
    errorP: r.errorP,
    kind: r.kind,
  }));
}

/** Extract the mirror's probability set from a recorded Jev answer map. */
export function extractResponseProbs(answers = {}) {
  const noul = (k) => {
    const a = answers[k];
    return a && a.type === 'noul' && typeof a.noul === 'number' ? a.noul : undefined;
  };
  const probs = {
    doneP: noul('done'),
    stepDoneP: noul('step_done'),
    readyP: noul('ready'),
    rightPageP: noul('right_page'),
    errorP: noul('error'),
  };
  const action = answers.action;
  if (action?.type === 'choice' && typeof action.probabilities?.[action.choice] === 'number') {
    probs.actionP = action.probabilities[action.choice];
  }
  const target = answers.target;
  if (target?.type === 'choice' && target.probabilities && typeof target.choice === 'string') {
    probs.target1 = target.choice;
    probs.target1P = target.probabilities[target.choice];
    const rival = Object.entries(target.probabilities)
      .filter(([k, v]) => k !== target.choice && typeof v === 'number')
      .sort((a, b) => b[1] - a[1])[0];
    if (rival) {
      probs.target2 = rival[0];
      probs.target2P = rival[1];
    }
  }
  return probs;
}

const isElementId = (v) => typeof v === 'string' && /^e\d+$/.test(v);

/**
 * The replay decision function: the threshold-comparison mirror of the loop's
 * round rules, in the loop's rule order. Threshold comparisons only — the
 * evidence-rule cascade is out of scope (see the header note).
 *
 * probs:    {doneP?, stepDoneP?, readyP?, rightPageP?, errorP?, target1?, target1P?}
 * thresholds: {done, error, stepDone, ready, rightPage, target}
 * ctx:      {round (1-based), chain (bool)}
 *
 * Returns {kind, gate} where kind is the PhaseRound vocabulary:
 * 'done' | 'error' | 'advance' | 'wait' | 'act' (commit) | 'bounce'.
 */
export function mirrorDecision(probs, thresholds, ctx = {}) {
  const num = (v) => (typeof v === 'number' ? v : undefined);
  const round = ctx.round ?? 1;
  // Rule 3 / decideEarly rule 3 (C2: done precedes error).
  const doneP = num(probs.doneP);
  if (doneP !== undefined && doneP >= thresholds.done) return { kind: 'done', gate: 'done' };
  // Rule 4 (round >= 2 only; the question is only asked then).
  const errorP = num(probs.errorP);
  if (round >= 2 && errorP !== undefined && errorP >= thresholds.error) {
    return { kind: 'error', gate: 'error' };
  }
  // Chain rule 3's plain stepDone bar (0.85). The evidence bars
  // (stepDoneWithEvidence 0.5, nav 0.25) need history — out of mirror scope.
  const stepDoneP = num(probs.stepDoneP);
  if (ctx.chain && stepDoneP !== undefined && stepDoneP >= thresholds.stepDone) {
    return { kind: 'advance', gate: 'stepDone' };
  }
  // Chain rule 5 / ready gate.
  const readyP = num(probs.readyP);
  if (readyP !== undefined && readyP < thresholds.ready) return { kind: 'wait', gate: 'ready' };
  // Chain rule 6 / wrong-page counter.
  const rightPageP = num(probs.rightPageP);
  if (rightPageP !== undefined && rightPageP < thresholds.rightPage) {
    return { kind: 'bounce', gate: 'right_page' };
  }
  // The target bar: a listed element at/above the bar commits ('act'),
  // everything below it is a non-commit bounce. The margin rule and
  // takeover thresholds are not expressible from the recorded fields alone.
  if (isElementId(probs.target1) && num(probs.target1P) !== undefined && probs.target1P >= thresholds.target) {
    return { kind: 'act', gate: 'target' };
  }
  return { kind: 'bounce', gate: 'target' };
}

/** F1 (verifier, 2026-10-04): classify a recorded ask's request shape so the
 * capture merge can tell round-OPENING asks from continuation asks that ride
 * the SAME round. A two-stage round (element count over max_elements) asks
 * request 1 (group) then request 2 (target); a native-select value
 * resolution asks one option request per chunk plus a final (buildOption-
 * Requests/buildOptionFinalRequest); the r13 stuck ask opens its own round;
 * wingman_check's single `answer` request opens its pseudo-round. */
export function askStage(request) {
  const keys = Object.keys(request?.questions ?? {});
  if (keys.includes('group')) return 'group';
  if (keys.includes('option')) return 'option';
  if (keys.length === 1 && keys[0] === 'recover') return 'recover';
  if (keys.includes('target') && !keys.includes('done') && !keys.includes('action')) return 'target';
  return 'round';
}

/** Merge the run's log.jsonl records with the recorder's asks: one output
 * line per round that ASKED, carrying the round's recorded decision plus the
 * paired ask(s)' request/response (F1, verifier 2026-10-04). A round may
 * consume MORE than one recorded ask: the walk takes the round's opening ask
 * and then consumes CONTINUATION asks ('target' = two-stage request 2,
 * 'option' = native-select chunks/final) into the SAME round, merging their
 * answer maps. A round whose jevMs never moved ended BEFORE its ask
 * (captcha/policy/token bail, budget-time at the round top) and consumes
 * nothing — the pre-fix walk consumed exactly one ask per round, so every
 * pairing after the first multi-ask (or pre-ask-end) round shifted by one,
 * silently: unmatched rounds only mark mirrored:false and capture exits 0. */
export function mergeCapture(records, asks, thresholds) {
  const outLines = [];
  let askIdx = 0;
  let unpaired = 0;
  for (const rec of records) {
    const rounds = rec.phases?.rounds ?? [];
    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i];
      if (!round.jevMs) continue;
      const open = asks[askIdx];
      askIdx += 1;
      if (!open) {
        unpaired += 1;
        continue;
      }
      // Consume continuation asks of the SAME round; stop at the next
      // round-opening ask (a two-stage round that ended after request 1 —
      // early done/error, targetless choice, empty top groups — leaves the
      // next ask untouched for its own round).
      let answers = open.response?.ok ? open.response.answers : {};
      while (askIdx < asks.length) {
        const stage = asks[askIdx].stage ?? askStage(asks[askIdx].request);
        if (stage !== 'target' && stage !== 'option') break;
        const cont = asks[askIdx];
        askIdx += 1;
        // Request 2 never repeats the verb question (amendment 2026-09-21h),
        // so merging the answer maps cannot clobber request 1's keys.
        if (cont.response?.ok) answers = { ...answers, ...cont.response.answers };
      }
      const chain =
        rec.tool === 'browse_step' && !!open.request?.questions && 'step_done' in open.request.questions;
      const probs = extractResponseProbs(answers);
      const mirror = mirrorDecision(probs, thresholds, { round: i + 1, chain });
      const recordedKind = round.kind ?? null;
      outLines.push({
        ts: open.ts,
        tool: rec.tool,
        host: rec.host,
        round: i + 1,
        chain,
        request: open.request,
        response: open.response,
        ms: open.ms,
        decision: {
          kind: recordedKind,
          status: rec.status,
          reason: rec.reason,
          probs,
          // D8: mirrored = the mirror reproduced this round's recorded
          // decision class from its probability set at capture time. The
          // self-check never judges unmirrored rounds.
          mirrored: recordedKind !== null && mirror.kind === recordedKind,
        },
      });
    }
  }
  return { lines: outLines, unpaired };
}

/** Validate + apply a threshold overrides object onto a baseline set. */
export function applyThresholdOverrides(baseline, overrides) {
  const out = { ...baseline };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (!(k in baseline)) throw new Error(`unknown threshold key: ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`threshold ${k} must be a number in [0, 1], got ${JSON.stringify(v)}`);
    }
    out[k] = v;
  }
  return out;
}

/** The D8 drift self-check: baseline replay must reproduce every recorded
 * decision class on the capture's mirrored rounds. */
export function evaluateCapture(lines, thresholds) {
  const mismatches = [];
  let checked = 0;
  let unmirrored = 0;
  lines.forEach((line, idx) => {
    const d = line.decision ?? {};
    if (!d.mirrored) {
      unmirrored += 1;
      return;
    }
    checked += 1;
    const probs = d.probs ?? extractResponseProbs(line.response?.answers ?? {});
    const got = mirrorDecision(probs, thresholds, { round: line.round ?? 1, chain: !!line.chain });
    if (got.kind !== d.kind) {
      mismatches.push({
        line: idx + 1,
        ts: line.ts,
        tool: line.tool,
        round: line.round,
        gate: got.gate,
        recorded: d.kind,
        replayed: got.kind,
        probs,
      });
    }
  });
  return { checked, unmirrored, mismatches };
}

/** Margin histogram over extracted round-probability rows (spec D7). */
export function computeMargins(rounds, specs = SPEC_MARGIN_THRESHOLDS) {
  return specs.map((spec) => {
    const rows = [];
    for (const r of rounds) {
      const p = r[spec.field];
      if (typeof p !== 'number') continue;
      if (spec.needsElement && !isElementId(r.target1)) continue;
      rows.push({ p, margin: p - spec.threshold, side: p < spec.threshold ? 'below' : 'above' });
    }
    const abs = rows.map((r) => ({ ...r, abs: Math.abs(r.margin) }));
    const within05 = abs.filter((r) => r.abs <= 0.05 + EPS).length;
    const within10 = abs.filter((r) => r.abs > 0.05 + EPS && r.abs <= 0.10 + EPS).length;
    const beyond = abs.length - within05 - within10;
    const nearest = [...abs].sort((a, b) => a.abs - b.abs).slice(0, 5);
    return {
      key: spec.key,
      label: spec.label,
      field: spec.field,
      threshold: spec.threshold,
      n: rows.length,
      within05,
      within10,
      beyond,
      below: rows.filter((r) => r.side === 'below').length,
      above: rows.filter((r) => r.side === 'above').length,
      nearest,
    };
  });
}

/** Glob to RegExp: a double-star slash matches zero or more dirs, one star never crosses a slash. */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

// ---------------------------------------------------------------------------
// Thresholds / slices IO
// ---------------------------------------------------------------------------

export async function loadThresholds() {
  try {
    const mod = await import(distUrl('src/contract/constants.js'));
    if (mod?.THRESHOLDS) return { source: 'dist/src/contract/constants.js', thresholds: { ...mod.THRESHOLDS } };
  } catch {
    // fall through to the spec-pinned set
  }
  const pinned = {};
  for (const s of SPEC_MARGIN_THRESHOLDS) pinned[s.key] = s.threshold;
  pinned.error = 0.5;
  pinned.rightPage = 0.5;
  pinned.stepDone = 0.85;
  return { source: 'SPEC_MARGIN_THRESHOLDS (dist/ absent)', thresholds: pinned };
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

/** Resolve one --slices spec to {name, read()} entries. A "<ref>:<glob>"
 * spec reads paths out of a git results-backup ref; anything else is a
 * filesystem glob relative to the repo root. */
export function resolveSlices(spec) {
  const colon = spec.indexOf(':');
  const ref = colon > 0 ? spec.slice(0, colon) : null;
  const glob = colon > 0 ? spec.slice(colon + 1) : spec;
  const re = globToRegex(glob);
  if (ref) {
    const paths = git(['ls-tree', '-r', '--name-only', ref]).split(/\r?\n/).filter((p) => re.test(p));
    if (paths.length === 0) throw new Error(`no paths under ${ref} match ${glob}`);
    return paths.map((p) => ({ name: `${ref}:${p}`, read: () => git(['show', `${ref}:${p}`]) }));
  }
  const dirPart = glob.includes('/') ? glob.split('/').slice(0, -1).join('/') : '.';
  const results = [];
  const walk = (rel) => {
    const full = rel === '.' ? REPO_ROOT : join(REPO_ROOT, rel);
    let entries;
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel === '.' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && re.test(child)) results.push(child);
    }
  };
  walk(dirPart);
  if (results.length === 0) throw new Error(`no files match ${glob}`);
  return results.map((p) => ({ name: p, read: () => fs.readFileSync(join(REPO_ROOT, p), 'utf8') }));
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));

export function renderMarginsReport({ slices, thresholdsSource, records, rounds, margins }) {
  const lines = [];
  lines.push('# Jev grader margins (r21 P-4)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Slices:');
  for (const s of slices) lines.push(`- ${s.name} (${s.records} records)`);
  lines.push('');
  lines.push(`Records parsed: ${records}; rounds with phases: ${rounds}.`);
  lines.push('');
  lines.push(
    'Scope (spec C3 correction): old log slices carry per-round probabilities only — ' +
      'never the ask request or raw answer document — so this is a threshold-MARGIN ' +
      'distribution report (the treadmill quantification), not a decision replay. ' +
      'Full decision replay requires freshly captured (request, answer) pairs (capture mode).',
  );
  lines.push('');
  lines.push(`Thresholds source: ${thresholdsSource}.`);
  lines.push('');
  lines.push(
    '| threshold | field | n | within ±0.05 | 0.05–0.10 | beyond 0.10 | below t | above t | % within ±0.10 |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const m of margins) {
    lines.push(
      `| ${m.label} ${f2(m.threshold)} | ${m.field} | ${m.n} | ${m.within05} | ${m.within10} | ${m.beyond} | ${m.below} | ${m.above} | ${pct(m.within05 + m.within10, m.n)} |`,
    );
  }
  lines.push('');
  lines.push('Nearest recorded rounds per threshold (the treadmill, |margin| ascending):');
  lines.push('');
  for (const m of margins) {
    const near = m.nearest.map((r) => `${f2(r.p)} (${r.side} by ${r.abs.toFixed(2)})`).join(', ');
    lines.push(`- ${m.label} ${f2(m.threshold)}: ${near || 'no rounds carried this field'}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderReplayReport({ captureName, lines, thresholds, overrides, source, result, baselineResult }) {
  const out = [];
  out.push('# Grader replay report (r21 P-4)');
  out.push('');
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push(`Capture: ${captureName} (${lines.length} rounds)`);
  out.push(`Thresholds source: ${source}`);
  out.push(`Baseline (from dist): ${JSON.stringify(pickThresholds(thresholds))}`);
  out.push(`Overrides: ${overrides ? JSON.stringify(overrides) : 'none (D8 drift self-check mode)'}`);
  out.push('');
  out.push(
    'Mirror scope: threshold comparisons on recorded probability sets, NOT the full ' +
      'evidence-rule cascade. Unmirrored rounds (evidence-bar advances, guards, budget ' +
      'ends, wingman_check rounds, kindless rounds) are counted, never judged.',
  );
  out.push('');
  if (overrides) {
    // D9: a candidate set may be trusted only when the baseline self-check is
    // green — the report states it, and the CLI exits 1 when it is not.
    out.push(
      `Baseline self-check: ${baselineResult.mismatches.length === 0 ? 'PASS' : 'FAIL'} (${baselineResult.checked} mirrored rounds, ${baselineResult.mismatches.length} mismatches).`,
    );
    out.push('');
    const changed = [];
    lines.forEach((line, idx) => {
      const d = line.decision ?? {};
      if (!d.mirrored) return;
      const probs = d.probs ?? extractResponseProbs(line.response?.answers ?? {});
      const under = mirrorDecision(probs, thresholds, { round: line.round ?? 1, chain: !!line.chain });
      if (under.kind !== d.kind) {
        changed.push({ line: idx + 1, ts: line.ts, tool: line.tool, round: line.round, gate: under.gate, recorded: d.kind, replayed: under.kind, probs });
      }
    });
    out.push(`Would-change rows under the override set: ${changed.length} of ${result.checked} mirrored rounds.`);
    out.push('');
    if (changed.length > 0) {
      out.push('| line | ts | tool | round | gate | recorded | replayed | key probs |');
      out.push('|---|---|---|---|---|---|---|---|');
      for (const c of changed) {
        out.push(
          `| ${c.line} | ${c.ts} | ${c.tool} | ${c.round} | ${c.gate} | ${c.recorded} | ${c.replayed} | \`${JSON.stringify(compactProbs(c.probs))}\` |`,
        );
      }
      out.push('');
      const towardCommit = changed.filter((c) => c.replayed === 'act' && c.recorded === 'bounce').length;
      const awayFromCommit = changed.filter((c) => c.recorded === 'act' && c.replayed === 'bounce').length;
      const towardAdvance = changed.filter((c) => c.replayed === 'advance').length;
      out.push(
        `Summary: ${towardCommit} bounce->commit flips, ${awayFromCommit} commit->bounce flips, ${towardAdvance} advances reached. ` +
          'A candidate set meets the D9 bar only when it flips the targeted bounces to commits WITHOUT flipping any recorded advance/commit on completed calls.',
      );
      out.push('');
    }
    out.push(`Unmirrored rounds (counted, not judged): ${result.unmirrored}.`);
  } else {
    out.push(`Self-check: ${result.mismatches.length === 0 ? 'PASS' : 'FAIL'} — ${result.checked} mirrored rounds checked, ${result.mismatches.length} mismatches, ${result.unmirrored} unmirrored.`);
    out.push('');
    for (const m of result.mismatches) {
      out.push(
        `- MISMATCH line ${m.line} (${m.tool}, round ${m.round}, ts ${m.ts}): gate ${m.gate} recorded ${m.recorded}, replayed ${m.replayed}, probs ${JSON.stringify(compactProbs(m.probs))}`,
      );
    }
    if (result.mismatches.length > 0) out.push('');
  }
  return out.join('\n');
}

function pickThresholds(t) {
  return {
    done: t.done,
    error: t.error,
    stepDone: t.stepDone,
    stepDoneWithEvidence: t.stepDoneWithEvidence,
    ready: t.ready,
    rightPage: t.rightPage,
    target: t.target,
  };
}

function compactProbs(p) {
  const out = {};
  for (const k of ['doneP', 'stepDoneP', 'readyP', 'rightPageP', 'errorP', 'target1', 'target1P', 'actionP']) {
    if (p && p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usageExit(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage:\n' +
      '  node bench/grader-replay.mjs capture --out <file> [--url <page-url>]... [--task <fixture-page> <step-text>]... [--call <page-url> <browse_step-json>]...\n' +
      '  node bench/grader-replay.mjs replay --capture <file> [--thresholds <overrides.json>] [--report <file>]\n' +
      '  node bench/grader-replay.mjs margins --slices <glob> [--slices <glob>]... [--report <file>]\n',
  );
  process.exit(2);
}

export function parseArgs(argv) {
  const opts = { url: [], task: [], slices: [], call: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      i += 1;
      if (i >= argv.length) usageExit(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--out' || a === '--capture' || a === '--thresholds' || a === '--report') opts[a.slice(2)] = val();
    else if (a === '--url') opts.url.push(val());
    else if (a === '--slices') opts.slices.push(val());
    else if (a === '--task') opts.task.push([val(), val()]);
    else if (a === '--call') {
      const url = val();
      const raw = val();
      let args = null;
      try {
        args = JSON.parse(raw);
      } catch {
        args = null;
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        usageExit('--call needs a page url and a JSON object of browse_step arguments');
      }
      opts.call.push([url, args]);
    }
    else usageExit(`unknown argument: ${a}`);
  }
  return opts;
}

async function cmdCapture(opts) {
  if (!opts.out) usageExit('capture requires --out <file>');
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    process.stderr.write('capture: TYPESAFE_API_KEY is not set — capture requires a live key (spec WP-5 item 4)\n');
    process.exit(2);
  }
  if (opts.task.length === 0 && opts.url.length === 0 && opts.call.length === 0) {
    usageExit('capture needs at least one --task <fixture-page> <step-text> or --url <page-url>');
  }

  const { launchEphemeralChrome } = await import(distUrl('src/browser/ephemeral.js'));
  const { createWingman } = await import(distUrl('src/lib.js'));
  const { createDefaultAsk } = await import(distUrl('src/core/jev-client.js'));
  const { startFixtureServer } = await import(distUrl('src/fixture-server.js'));
  const { CdpConnection } = await import(distUrl('src/adapters/cdp-connection.js'));

  const baseline = await loadThresholds();
  const home = mkdtempSync(join(tmpdir(), 'wingman-grader-capture-'));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ mode: 'on', adapter: 'cdp', gate: { mode: 'off' }, policy: { mode: 'off' } }),
  );

  const browser = await launchEphemeralChrome({ headless: true });
  const fixture = opts.task.length > 0 ? await startFixtureServer() : null;
  const env = { ...process.env, WINGMAN_HOME: home, WINGMAN_CDP_ENDPOINT: browser.endpoint };
  const asks = [];
  const innerAsk = createDefaultAsk({ apiKey: key });
  const recorderAsk = async (request, askOpts) => {
    const t0 = Date.now();
    const response = await innerAsk(request, askOpts);
    asks.push({ ts: new Date().toISOString(), request, response, ms: Date.now() - t0, stage: askStage(request) });
    return response;
  };

  let observer = null;
  const navigate = async (url) => {
    if (!observer) observer = await CdpConnection.connect(browser.endpoint);
    const { targetInfos } = await observer.send('Target.getTargets', {});
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await observer.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await observer.send('Page.enable', {}, sessionId);
    await observer.send('Page.navigate', { url }, sessionId);
    await new Promise((r) => setTimeout(r, 1500));
  };

  const calls = [];
  try {
    const wingman = await createWingman({ env, driver: 'cdp', ask: recorderAsk });
    for (const [page, stepText] of opts.task) {
      const url = `${fixture.url}/${page}.html`;
      await navigate(url);
      const r = await wingman.step({ goal: stepText, steps: [stepText] });
      calls.push({ url, goal: stepText, status: r.status, reason: r.reason });
    }
    for (const url of opts.url) {
      await navigate(url);
      const goal = `summarize what the page at ${url} is for`;
      const r = await wingman.step({ goal, steps: ['state in one short sentence what this page is for'] });
      calls.push({ url, goal, status: r.status, reason: r.reason });
    }
    let lastUrl = null;
    for (const [url, stepArgs] of opts.call) {
      if (url !== lastUrl) {
        await navigate(url);
        lastUrl = url;
      }
      const r = await wingman.step(stepArgs);
      calls.push({ url, goal: String(stepArgs.goal ?? ''), status: r.status, reason: r.reason });
    }
  } finally {
    try {
      if (observer) await observer.close();
    } catch { /* already gone */ }
    await browser.close();
    if (fixture) await fixture.close();
  }

  // Merge: walk the run's log.jsonl records and pair each ASKING round with
  // its recorded ask(s) — see mergeCapture (F1). One round may consume more
  // than one recorded ask (two-stage request 2, select-option chunks).
  const { records } = parseSlice(readFileSync(join(home, 'log.jsonl'), 'utf8'));
  const fs = await import('node:fs');
  const { lines: outLines, unpaired } = mergeCapture(records, asks, baseline.thresholds);
  if (unpaired > 0) process.stderr.write(`capture: ${unpaired} rounds had no recorded ask (skipped)\n`);
  const outPath = resolve(process.cwd(), opts.out);
  fs.mkdirSync(dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  process.stdout.write(
    `capture: ${outLines.length} rounds -> ${outPath} (${calls.length} calls, thresholds from ${baseline.source})\n`,
  );
}

async function cmdReplay(opts) {
  if (!opts.capture) usageExit('replay requires --capture <file>');
  const fs = await import('node:fs');
  const text = fs.readFileSync(resolve(process.cwd(), opts.capture), 'utf8');
  const { records } = parseSlice(text);
  const baseline = await loadThresholds();
  let overrides = null;
  let thresholds = baseline.thresholds;
  if (opts.thresholds) {
    overrides = JSON.parse(fs.readFileSync(resolve(process.cwd(), opts.thresholds), 'utf8'));
    thresholds = applyThresholdOverrides(baseline.thresholds, overrides);
  }
  const result = evaluateCapture(records, thresholds);
  const baselineResult = evaluateCapture(records, baseline.thresholds);
  const report = renderReplayReport({
    captureName: opts.capture,
    lines: records,
    thresholds,
    overrides,
    source: baseline.source,
    result,
    baselineResult,
  });
  if (opts.report) {
    const p = resolve(process.cwd(), opts.report);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, report + '\n');
    process.stdout.write(`replay: report -> ${p}\n`);
  } else {
    process.stdout.write(report + '\n');
  }
  if (!overrides) {
    // D8 drift self-check: any baseline mismatch is fatal.
    if (result.mismatches.length > 0) {
      process.stderr.write(`replay: SELF-CHECK FAILED — ${result.mismatches.length} mismatched round(s); the mirror has drifted from the loop's rule order/thresholds. Do not trust a candidate threshold validated against this mirror.\n`);
      process.exit(1);
    }
    process.stdout.write(`replay: self-check PASS (${result.checked} mirrored, ${result.unmirrored} unmirrored)\n`);
  } else if (baselineResult.mismatches.length > 0) {
    // D9: the self-check green is a precondition for trusting any candidate set.
    process.stderr.write(`replay: BASELINE SELF-CHECK FAILED — ${baselineResult.mismatches.length} mismatched round(s); the override report is not trustworthy until the mirror is repaired.\n`);
    process.exit(1);
  }
}

async function cmdMargins(opts) {
  if (!opts.slices || opts.slices.length === 0) usageExit('margins requires --slices <glob>');
  const perSlice = [];
  const allRounds = [];
  let recordsTotal = 0;
  for (const spec of opts.slices) {
    const entries = await resolveSlices(spec);
    for (const entry of entries) {
      const { records } = parseSlice(entry.read());
      const rounds = records.flatMap((r) => extractRoundProbs(r));
      perSlice.push({ name: entry.name, records: records.length });
      recordsTotal += records.length;
      allRounds.push(...rounds);
    }
  }
  const baseline = await loadThresholds();
  const margins = computeMargins(allRounds);
  const report = renderMarginsReport({
    slices: perSlice,
    thresholdsSource: baseline.source,
    records: recordsTotal,
    rounds: allRounds.length,
    margins,
  });
  if (opts.report) {
    const fs = await import('node:fs');
    const p = resolve(process.cwd(), opts.report);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, report + '\n');
    process.stdout.write(`margins: report -> ${p}\n`);
  } else {
    process.stdout.write(report + '\n');
  }
}

// Only act as a CLI when invoked directly — tests import the pure parts.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const norm = (p) => {
      const r = fs.realpathSync(resolve(p));
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const command = process.argv[2];
  const opts = parseArgs(process.argv.slice(3));
  if (command === 'capture') await cmdCapture(opts);
  else if (command === 'replay') await cmdReplay(opts);
  else if (command === 'margins') await cmdMargins(opts);
  else usageExit(command ? `unknown command: ${command}` : 'missing command');
}
