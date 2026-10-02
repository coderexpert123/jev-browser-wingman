// WP-F2: the coexistence observer fingerprint (§ WP-F2 item 3). Everything
// is read through the observer's own CdpConnection, per page through a
// flatten-attached session that is detached again; nothing is written.
//
// Flake fix (2026-10-02, cloud Part-1): the fingerprint must contain only
// state whose change proves a WRITE into the page. Two former fields were
// noise sources instead:
// - `visibility` is ambient renderer/scheduler state the browser controls
//   (first-render/activation settling); the driver's attach (cdp.ts) sends
//   no page-touching message at all, so a visibility flip is never observer
//   mutation. Dropped.
// - `dialogOpen` was signalled by a single 500 ms eval timeout, conflating
//   "renderer starved" with "dialog open". A modal dialog blocks evaluation
//   INDEFINITELY; a slow renderer answers eventually. The sentinel now
//   retries once with a long budget before declaring a dialog.

import { createHash } from 'node:crypto';
import type { CdpConnection } from '../adapters/cdp-connection.js';

export interface ProbePage {
  targetId: string;
  url: string; // url without #fragment
  dialogOpen: boolean;
  globalsHash: string | null;
  htmlAttrs: string | null;
  viewport: { w: number | null; h: number | null; dpr: number | null } | null;
}

export interface ProbeFingerprint {
  contexts: string[]; // sorted browserContextIds
  pages: ProbePage[]; // sorted by targetId
}

const EVAL_TIMEOUT_MS = 500;
/** Second-chance budget for the dialog sentinel: a real dialog never answers
 * within it; a merely slow renderer does. */
const SENTINEL_RETRY_MS = 4000;

async function evalValue(conn: CdpConnection, sessionId: string, expression: string): Promise<unknown> {
  const r = await conn.send<{ result?: { value?: unknown } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    sessionId,
    EVAL_TIMEOUT_MS,
  );
  return r.result?.value;
}

async function probePage(conn: CdpConnection, targetId: string, rawUrl: string): Promise<ProbePage> {
  const url = rawUrl.split('#')[0];
  const nulls = { globalsHash: null, htmlAttrs: null, viewport: null };
  let sessionId: string | undefined;
  try {
    const attached = await conn.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
      undefined,
      EVAL_TIMEOUT_MS,
    );
    sessionId = attached.sessionId;
  } catch {
    // The page cannot even be attached; report it without detail fields.
    return { targetId, url, dialogOpen: false, ...nulls };
  }
  try {
    // A modal dialog blocks evaluation indefinitely; a slow renderer answers
    // eventually. One short timeout is retried with a long budget, so a
    // loaded machine is not misread as a dialog (see the header comment).
    await conn.send('Runtime.evaluate', { expression: '1', returnByValue: true }, sessionId, EVAL_TIMEOUT_MS);
  } catch {
    try {
      await conn.send('Runtime.evaluate', { expression: '1', returnByValue: true }, sessionId, SENTINEL_RETRY_MS);
    } catch {
      return { targetId, url, dialogOpen: true, ...nulls };
    }
  }

  let globalsHash: string | null = null;
  try {
    const globalsJson = await evalValue(
      conn,
      sessionId,
      'JSON.stringify(Object.getOwnPropertyNames(globalThis).sort())',
    );
    if (typeof globalsJson === 'string') {
      globalsHash = createHash('sha256').update(globalsJson).digest('hex').slice(0, 12);
    }
  } catch {
    // stays null
  }

  let htmlAttrs: string | null = null;
  try {
    const v = await evalValue(
      conn,
      sessionId,
      'document.documentElement.attributes.length + ":" + (document.body ? document.body.attributes.length : -1)',
    );
    if (typeof v === 'string') htmlAttrs = v;
  } catch {
    // stays null
  }

  let viewport: ProbePage['viewport'] = null;
  try {
    const v = await evalValue(
      conn,
      sessionId,
      'JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })',
    );
    if (typeof v === 'string') {
      const parsed = JSON.parse(v) as { w?: number; h?: number; dpr?: number };
      viewport = {
        w: typeof parsed.w === 'number' ? parsed.w : null,
        h: typeof parsed.h === 'number' ? parsed.h : null,
        dpr: typeof parsed.dpr === 'number' ? parsed.dpr : null,
      };
    }
  } catch {
    // stays null
  }

  try {
    await conn.send('Target.detachFromTarget', { sessionId });
  } catch {
    // the session may already be gone
  }
  return { targetId, url, dialogOpen: false, globalsHash, htmlAttrs, viewport };
}

export async function fingerprint(conn: CdpConnection): Promise<ProbeFingerprint> {
  const ctxResult = await conn.send<{ browserContextIds?: string[] }>('Target.getBrowserContexts');
  const contexts = [...(ctxResult.browserContextIds ?? [])].sort();

  const targets = await conn.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
    'Target.getTargets',
  );
  const pageTargets = targets.targetInfos
    .filter((t) => t.type === 'page')
    .sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));

  const pages: ProbePage[] = [];
  for (const t of pageTargets) {
    pages.push(await probePage(conn, t.targetId, t.url));
  }
  return { contexts, pages };
}

/** The one allowed retry trigger: identical except for page URLs. */
export function onlyUrlsChanged(before: ProbeFingerprint, after: ProbeFingerprint): boolean {
  if (JSON.stringify(before.contexts) !== JSON.stringify(after.contexts)) return false;
  if (before.pages.length !== after.pages.length) return false;
  for (let i = 0; i < before.pages.length; i++) {
    const a = before.pages[i];
    const b = after.pages[i];
    if (a.targetId !== b.targetId) return false;
    const restA = { ...a, url: '' };
    const restB = { ...b, url: '' };
    if (JSON.stringify(restA) !== JSON.stringify(restB)) return false;
  }
  return true;
}
