// WP-D2: raw-CDP driver. Speaks CDP directly over a CdpConnection instead of
// through playwright-core. Attach records the non-default browser contexts;
// pages(), observe, act, settle and detach then operate only on default-context
// page targets. Evaluation runs in a `wingman` isolated world created per
// evaluation; dialogs are reported through Page.javascriptDialogOpening and
// never answered (no Page.handleJavaScriptDialog anywhere). Detach detaches
// each session and closes the socket; only a Chrome this driver launched via
// ensureChrome is killed. Never calls Target.closeTarget, Browser.close or
// Target.createBrowserContext.

import {
  ACT_TIMEOUT_MS,
  EVAL_TIMEOUT_MS,
  MAX_ENUMERATED,
  NAV_TIMEOUT_MS,
  SCROLL_GROWTH_WAIT_MS,
  WAIT_OP_MS,
} from '../contract/constants.js';
import {
  ActFailedError,
  AttachError,
  CoveredTargetError,
  DialogOpenError,
  NoHistoryError,
  StaleElementError,
} from '../contract/errors.js';
import { wingmanHome } from '../contract/home.js';
import type {
  DialogEvent,
  Driver,
  ElementRecord,
  Fingerprint,
  Observation,
  Op,
  PageInfo,
  AttachTarget,
} from '../contract/types.js';
import { OPTIONAL_TARGET_OPS, TARGETLESS_OPS } from '../contract/types.js';
import { ADAPTER_OPS } from './capabilities.js';
import { ensureChrome } from '../browser/chrome.js';
import { killTree } from '../browser/process-list.js';
import {
  buildControlStateExpression,
  buildEnumerateExpression,
  buildHitTestExpression,
  buildSettleProbeExpression,
  buildVerifyExpression,
  buildVisibilityExpression,
} from '../core/page-scripts.js';
import { settleByProbe, buildScrollGrowthProbeExpression, waitForScrollGrowth, type ScrollGrowthSnapshot } from '../core/settle.js';
import { CdpConnection } from './cdp-connection.js';

export function createCdpDriver(): Driver {
  return new CdpDriver();
}

/** KB proof switch (r17 WP-B mutant): composed into the null-element guard so
 * a flipped build rejects targetless press. Never flip in shipped code. */
const KB_CDP_PRESS_NONE = false;
/** KB proof switch (r17 WP-B mutant): composed into answerDialog so a flipped
 * build never answers. Never flip in shipped code. */
const KB_CDP_DIALOG = false;
/** r17b (F3/E19): when the label click does not flip a check/uncheck target,
 * activate the CONTROL itself (a bare sibling label has no association with
 * the input, so clicking it toggles nothing). */
const KB_CDP_CHECK_TOGGLE = false;
/** KB proof switch (r17c D-B mutant): composed into the scroll growth wait so
 * a flipped build skips the post-wheel wait and the act returns before an
 * async append lands. Never flip in shipped code. */
const KB_CDP_GROWTH_WAIT = false;

const cap = (s: unknown, n: number): string => String(s ?? '').slice(0, n);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The fixed PRESS_KEYS enumeration as CDP Input.dispatchKeyEvent field sets
// (spec § 6 WP-A A4). `modifiers` rides both events; `commands` rides the
// key-down only and is added by the caller. SelectAll is Meta on macOS, Ctrl
// elsewhere. A key outside the enumeration is ActFailedError, never silence.
function cdpKeyEvents(key: string): Array<Record<string, unknown>> {
  const darwin = process.platform === 'darwin';
  let base: Record<string, unknown>;
  switch (key) {
    case 'Enter':
      base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
      break;
    case 'Tab':
      base = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 };
      break;
    case 'Escape':
      base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
      break;
    case 'Space':
      base = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' };
      break;
    case 'Backspace':
      base = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 };
      break;
    case 'ArrowUp':
      base = { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 };
      break;
    case 'ArrowDown':
      base = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 };
      break;
    case 'ArrowLeft':
      base = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 };
      break;
    case 'ArrowRight':
      base = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 };
      break;
    case 'ShiftTab':
      base = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 };
      break;
    case 'SelectAll':
      base = {
        key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
        modifiers: darwin ? 4 : 2, commands: ['selectAll'],
      };
      break;
    default:
      throw new ActFailedError(`unsupported press key ${key}`);
  }
  const down: Record<string, unknown> = { type: 'text' in base ? 'keyDown' : 'rawKeyDown', ...base };
  const up: Record<string, unknown> = {
    type: 'keyUp',
    key: base.key,
    code: base.code,
    windowsVirtualKeyCode: base.windowsVirtualKeyCode,
  };
  if (base.modifiers !== undefined) {
    up.modifiers = base.modifiers;
  }
  return [down, up];
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  browserContextId?: string;
}

class CdpDriver implements Driver {
  readonly name = 'cdp';

  readonly ops = ADAPTER_OPS.cdp;

  private conn: CdpConnection | null = null;
  private nonDefaultContexts = new Set<string>();
  private sessions = new Map<string, string>(); // targetId (pageId) -> flatten sessionId
  private pageBySession = new Map<string, string>(); // sessionId -> targetId
  private dialogsOpen = new Map<string, number>(); // pageId -> open-dialog count
  private dialogWaiters = new Map<string, Array<() => void>>();
  private dialogHandlers: Array<(e: DialogEvent) => void> = [];
  private elementCache = new Map<string, ElementRecord[]>();
  private launchedPid: number | null = null;
  private unsubs: Array<() => void> = [];

  private requireConn(): CdpConnection {
    if (!this.conn) {
      throw new AttachError('cdp driver is not attached');
    }
    return this.conn;
  }

  async attach(target: AttachTarget): Promise<void> {
    let endpoint: string;
    if ('launch' in target) {
      const ensured = await ensureChrome({
        port: target.launch.port,
        profileDir: target.launch.profileDir,
        chromePath: target.launch.chromePath,
        home: wingmanHome(),
        window: target.launch.headed ? 'offscreen' : 'headless',
      });
      if (!ensured.ok) {
        throw new AttachError(ensured.message);
      }
      if (ensured.startedByUs && ensured.pid) {
        this.launchedPid = ensured.pid;
      }
      endpoint = ensured.endpoint;
    } else {
      endpoint = target.cdpEndpoint;
    }

    let conn: CdpConnection;
    // Cold start: a Chrome that is still coming up can need well over one 5 s
    // connect attempt (measured 6-19 s, 2026-09-19). The 5 s per-attempt pin
    // stays; the driver retries within a 20 s budget so a slow start fails
    // late, never early.
    const connectDeadline = Date.now() + 20_000;
    for (;;) {
      try {
        conn = await CdpConnection.connect(endpoint, { timeoutMs: 5_000 });
        break;
      } catch (err) {
        if (Date.now() >= connectDeadline) {
          throw new AttachError(err instanceof Error ? err.message : String(err));
        }
        await sleep(250);
      }
    }
    this.conn = conn;

    try {
      const contexts = await conn.send<{ browserContextIds?: string[] }>('Target.getBrowserContexts');
      this.nonDefaultContexts = new Set(contexts.browserContextIds ?? []);
    } catch (err) {
      await conn.close().catch(() => {});
      this.conn = null;
      throw new AttachError(err instanceof Error ? err.message : String(err));
    }

    this.unsubs.push(
      conn.on('Page.javascriptDialogOpening', (params, sessionId) => this.onDialogOpening(params ?? {}, sessionId)),
      conn.on('Page.javascriptDialogClosed', (_params, sessionId) => this.onDialogClosed(sessionId)),
    );
  }

  private onDialogOpening(params: { type?: string; message?: string }, sessionId?: string): void {
    const pageId = sessionId ? this.pageBySession.get(sessionId) : undefined;
    if (!pageId) {
      return;
    }
    this.dialogsOpen.set(pageId, (this.dialogsOpen.get(pageId) ?? 0) + 1);
    const waiters = this.dialogWaiters.get(pageId) ?? [];
    this.dialogWaiters.set(pageId, []);
    for (const waiter of waiters) {
      waiter();
    }
    const event: DialogEvent = {
      pageId,
      type: (params.type as DialogEvent['type']) ?? 'alert',
      message: cap(params.message, 80),
    };
    for (const handler of this.dialogHandlers) {
      handler(event);
    }
  }

  private onDialogClosed(sessionId?: string): void {
    const pageId = sessionId ? this.pageBySession.get(sessionId) : undefined;
    if (!pageId) {
      return;
    }
    const count = this.dialogsOpen.get(pageId) ?? 0;
    this.dialogsOpen.set(pageId, Math.max(0, count - 1));
  }

  private dialogWait(pageId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiters = this.dialogWaiters.get(pageId) ?? [];
      waiters.push(resolve);
      this.dialogWaiters.set(pageId, waiters);
    });
  }

  private dialogOpenOn(pageId: string): boolean {
    return (this.dialogsOpen.get(pageId) ?? 0) > 0;
  }

  private async ensureSession(pageId: string): Promise<string> {
    const existing = this.sessions.get(pageId);
    if (existing) {
      return existing;
    }
    const conn = this.requireConn();
    const attached = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: pageId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    this.sessions.set(pageId, sessionId);
    this.pageBySession.set(sessionId, pageId);
    await conn.send('Page.enable', {}, sessionId).catch(() => {});
    return sessionId;
  }

  // The WHOLE chain — getFrameTree, createIsolatedWorld, Runtime.evaluate — is
  // bounded by the caller's timeout (same as the playwright adapter): a renderer
  // blocked by a modal dialog never answers the world-creation commands either,
  // and only the tracked dialog state distinguishes that timeout as a
  // DialogOpenError; any other timeout is ActFailedError('evaluation timed out').
  private async evalOnSession(
    pageId: string,
    sessionId: string,
    expression: string,
    timeoutMs: number,
  ): Promise<any> {
    const conn = this.requireConn();
    const evalTimeout = (): ActFailedError | DialogOpenError => {
      if (this.dialogOpenOn(pageId)) {
        return new DialogOpenError('evaluation blocked by an open dialog');
      }
      return new ActFailedError('evaluation timed out');
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      const tree = await conn.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId);
      const world = await conn.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: 'wingman',
      }, sessionId);
      return await conn.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true },
        sessionId,
        timeoutMs,
      );
    })().then(
      (r) => ({ kind: 'result' as const, r }),
      (err) => ({ kind: 'error' as const, err }),
    );
    const raced = await Promise.race([
      work,
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (raced.kind === 'timeout') {
      throw evalTimeout();
    }
    if (raced.kind === 'error') {
      const message = raced.err instanceof Error ? raced.err.message : String(raced.err);
      if (message.startsWith('cdp timeout')) {
        throw evalTimeout();
      }
      throw raced.err;
    }
    return raced.r.result?.value;
  }

  private async evalIsolated(pageId: string, expression: string, timeoutMs = EVAL_TIMEOUT_MS): Promise<any> {
    const sessionId = await this.ensureSession(pageId);
    return this.evalOnSession(pageId, sessionId, expression, timeoutMs);
  }

  // r17c (D-B): one scroll-growth probe over the page's isolated world,
  // EVAL_TIMEOUT_MS-bounded like every other CDP round-trip (the outer race in
  // waitForScrollGrowth bounds the wait itself). A failed evaluation answers
  // null — a probe failure must never block an act, and a null baseline skips
  // the post-wheel wait entirely.
  private async probeScrollGrowth(pageId: string): Promise<ScrollGrowthSnapshot | null> {
    try {
      return (await this.evalIsolated(pageId, buildScrollGrowthProbeExpression())) as ScrollGrowthSnapshot;
    } catch {
      return null;
    }
  }

  async pages(): Promise<PageInfo[]> {
    const conn = this.requireConn();
    const r = await conn.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets');
    const infos = (r.targetInfos ?? []).filter(
      (t) =>
        t.type === 'page' &&
        !(t.browserContextId && this.nonDefaultContexts.has(t.browserContextId)) &&
        !String(t.url).startsWith('devtools://'),
    );
    const out: PageInfo[] = [];
    for (const info of infos) {
      let visible = false;
      try {
        const sessionId = await this.ensureSession(info.targetId);
        const value = await this.evalOnSession(info.targetId, sessionId, buildVisibilityExpression(), 2_000);
        visible = value === 'visible';
      } catch {
        visible = false;
      }
      out.push({ id: info.targetId, url: info.url, title: info.title, visible });
    }
    return out;
  }

  async observe(pageId: string): Promise<Observation> {
    const value = await this.evalIsolated(
      pageId,
      buildEnumerateExpression({ maxElements: MAX_ENUMERATED, maxTextChars: 3_000 }),
    );
    if (!value || typeof value !== 'object' || !Array.isArray((value as Observation).elements)) {
      throw new ActFailedError('observe failed');
    }
    const observation = value as Observation;
    this.elementCache.set(pageId, observation.elements);
    return observation;
  }

  private async cachedElement(pageId: string, elementId: string): Promise<ElementRecord> {
    const cached = this.elementCache.get(pageId)?.find((e) => e.id === elementId);
    if (cached) {
      return cached;
    }
    await this.observe(pageId);
    const el = this.elementCache.get(pageId)?.find((e) => e.id === elementId);
    if (!el) {
      throw new StaleElementError(`unknown element ${elementId}`);
    }
    return el;
  }

  private async mouseClick(sessionId: string, point: { x: number; y: number }): Promise<void> {
    const conn = this.requireConn();
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId);
    await conn.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      sessionId,
    );
    await conn.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      sessionId,
    );
  }

  private async performOp(
    pageId: string,
    el: ElementRecord | null,
    op: Op,
    value: string | undefined,
    point: { x: number; y: number } | null,
  ): Promise<void | string> {
    const conn = this.requireConn();
    const sessionId = await this.ensureSession(pageId);

    // Targetless ops (spec § 6 WP-A A4): no element, no hit point. Everything
    // still runs inside act()'s dialog race.
    if (!el) {
      switch (op) {
        case 'scroll':
        case 'scroll_up': {
          // r17c (D-B): baseline before the wheel, growth wait after — the
          // wait is in-round wall time only (absorbed into act_ms), never an
          // extra round or ask. A null baseline (probe failed) skips it.
          const baseline = KB_CDP_GROWTH_WAIT ? null : await this.probeScrollGrowth(pageId);
          const viewport = await this.evalIsolated(pageId, '({ w: window.innerWidth, h: window.innerHeight })');
          const w = Number(viewport?.w ?? 0);
          const h = Number(viewport?.h ?? 0);
          const deltaY = Math.round(h * 0.8) * (op === 'scroll_up' ? -1 : 1);
          await conn.send(
            'Input.dispatchMouseEvent',
            {
              type: 'mouseWheel',
              x: Math.round(w / 2),
              y: Math.round(h / 2),
              deltaX: 0,
              deltaY,
            },
            sessionId,
          );
          if (baseline !== null) {
            await waitForScrollGrowth(() => this.probeScrollGrowth(pageId), baseline, SCROLL_GROWTH_WAIT_MS);
          }
          return;
        }
        case 'wait': {
          await sleep(WAIT_OP_MS);
          return;
        }
        case 'navigate': {
          if (value === undefined || !/^https?:\/\//i.test(value)) {
            throw new ActFailedError('navigate requires an http(s) URL');
          }
          const r = await conn.send<{ errorText?: string }>(
            'Page.navigate',
            { url: value },
            sessionId,
            NAV_TIMEOUT_MS,
          );
          if (r && r.errorText) {
            throw new ActFailedError(cap(r.errorText, 200));
          }
          return;
        }
        case 'back': {
          const hist = await conn.send<{ currentIndex: number; entries: Array<{ id: string }> }>(
            'Page.getNavigationHistory',
            {},
            sessionId,
            NAV_TIMEOUT_MS,
          );
          if (!hist || typeof hist.currentIndex !== 'number' || hist.currentIndex <= 0 || !hist.entries?.length) {
            throw new NoHistoryError('no previous page');
          }
          const entry = hist.entries[hist.currentIndex - 1];
          await conn.send(
            'Page.navigateToHistoryEntry',
            { entryId: entry.id },
            sessionId,
            NAV_TIMEOUT_MS,
          );
          return;
        }
        case 'reload': {
          await conn.send('Page.reload', {}, sessionId, NAV_TIMEOUT_MS);
          return;
        }
        case 'press': {
          // r17: a targetless press goes to the focused element — no focus
          // eval; the focused element is the target by definition.
          const [down, up] = cdpKeyEvents(value ?? 'Enter');
          await conn.send('Input.dispatchKeyEvent', down, sessionId);
          await conn.send('Input.dispatchKeyEvent', up, sessionId);
          return;
        }
        default: {
          throw new ActFailedError(`op ${op} needs an element`);
        }
      }
    }

    switch (op) {
      case 'click': {
        await this.mouseClick(sessionId, point as { x: number; y: number });
        return;
      }
      case 'fill': {
        if (value === undefined) {
          throw new ActFailedError('fill requires a value');
        }
        await this.mouseClick(sessionId, point as { x: number; y: number });
        // P9 fix: select the element's text when it can (inputs, textareas),
        // else select its whole content when it is contenteditable — the
        // browser then replaces on insert instead of appending.
        await this.evalIsolated(
          pageId,
          `(() => { const el = document.querySelector(${JSON.stringify(el.path)}); if (!el) return false; el.focus(); if (typeof el.select === 'function') el.select(); else if (el.isContentEditable) { const s = window.getSelection(); if (s) s.selectAllChildren(el); } return true; })()`,
        );
        await conn.send('Input.insertText', { text: value }, sessionId);
        return;
      }
      case 'select': {
        if (value === undefined) {
          throw new ActFailedError('select requires a value');
        }
        await this.evalIsolated(
          pageId,
          `(() => { const el = document.querySelector(${JSON.stringify(el.path)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
        );
        return;
      }
      case 'check':
      case 'uncheck': {
        const wanted = op === 'check';
        const controlPath = el.controlPath ?? el.path;
        const state = await this.evalIsolated(pageId, buildControlStateExpression(controlPath));
        if (state && state.checked === wanted) {
          return;
        }
        await this.mouseClick(sessionId, point as { x: number; y: number });
        // r17b (F3): report the act's own state change — the loop stores a
        // flip as evidence the way it stores a landed fill's 'filled'.
        let after = await this.evalIsolated(pageId, buildControlStateExpression(controlPath));
        if (after && typeof after.checked === 'boolean' && after.checked === wanted) {
          return wanted ? 'checked' : 'unchecked';
        }
        // r17b (E19 mechanism): the record's visible element is only a real
        // toggle target when it WRAPS or labels[for] the control — a bare
        // sibling label has no association, so the click toggled nothing.
        // Activate the control itself, then re-read.
        if (!KB_CDP_CHECK_TOGGLE) {
          await this.evalIsolated(
            pageId,
            `(() => { const el = document.querySelector(${JSON.stringify(controlPath)}); if (!el) return false; el.click(); return true; })()`,
          );
          after = await this.evalIsolated(pageId, buildControlStateExpression(controlPath));
          if (after && typeof after.checked === 'boolean' && after.checked === wanted) {
            return wanted ? 'checked' : 'unchecked';
          }
        }
        return;
      }
      case 'press': {
        const [down, up] = cdpKeyEvents(value ?? 'Enter');
        await this.evalIsolated(
          pageId,
          `(() => { const el = document.querySelector(${JSON.stringify(el.path)}); if (!el) return false; el.focus(); return true; })()`,
        );
        await conn.send('Input.dispatchKeyEvent', down, sessionId);
        await conn.send('Input.dispatchKeyEvent', up, sessionId);
        return;
      }
      case 'scroll': {
        // r17c (D-B): same baseline/wait shape as the targetless wheel — the
        // legacy element-targeted scroll waits for growth too.
        const baseline = KB_CDP_GROWTH_WAIT ? null : await this.probeScrollGrowth(pageId);
        const viewport = await this.evalIsolated(pageId, '({ w: window.innerWidth, h: window.innerHeight })');
        const w = Number(viewport?.w ?? 0);
        const h = Number(viewport?.h ?? 0);
        await conn.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseWheel',
            x: Math.round(w / 2),
            y: Math.round(h / 2),
            deltaX: 0,
            deltaY: Math.round(h * 0.8),
          },
          sessionId,
        );
        if (baseline !== null) {
          await waitForScrollGrowth(() => this.probeScrollGrowth(pageId), baseline, SCROLL_GROWTH_WAIT_MS);
        }
        return;
      }
      case 'hover': {
        await conn.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: (point as { x: number; y: number }).x, y: (point as { x: number; y: number }).y },
          sessionId,
        );
        return;
      }
      case 'dblclick': {
        const p = point as { x: number; y: number };
        await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, sessionId);
        await conn.send(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 },
          sessionId,
        );
        await conn.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 },
          sessionId,
        );
        await conn.send(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 2 },
          sessionId,
        );
        await conn.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 2 },
          sessionId,
        );
        return;
      }
      case 'upload': {
        if (value === undefined) {
          throw new ActFailedError('upload requires a value');
        }
        const doc = await conn.send<{ root?: { nodeId?: number } }>(
          'DOM.getDocument',
          { depth: 0 },
          sessionId,
        );
        const rootNodeId = doc?.root?.nodeId;
        if (rootNodeId === undefined) {
          throw new ActFailedError('upload could not resolve the document');
        }
        const q = await conn.send<{ nodeId?: number }>(
          'DOM.querySelector',
          { nodeId: rootNodeId, selector: el.path },
          sessionId,
        );
        if (!q || !q.nodeId) {
          throw new ActFailedError(`upload could not resolve ${el.path}`);
        }
        await conn.send('DOM.setFileInputFiles', { files: [value], nodeId: q.nodeId }, sessionId);
        // r19 (D3): a successful set reports its own completion — the input's
        // value is unreadable post-set, so success is the only path that
        // reaches this return (failures throw ActFailedError above).
        return 'uploaded';
      }
      case 'scroll_to': {
        // Deliberately skips the hit test: the hit test itself calls
        // scrollIntoView({block:'center'}), so proving scroll_to through it
        // would prove nothing. The verify step already ran in act().
        await this.evalIsolated(
          pageId,
          `(() => { const el = document.querySelector(${JSON.stringify(el.path)}); if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()`,
        );
        return;
      }
      default: {
        throw new ActFailedError(`unsupported op ${op}`);
      }
    }
  }

  async act(pageId: string, elementId: string | null, op: Op, value?: string): Promise<void | string> {
    if (!(ADAPTER_OPS.cdp as readonly Op[]).includes(op)) {
      throw new ActFailedError(`unsupported op ${op}`);
    }

    // Targetless ops (spec § 6 WP-A A4): no cached element, no verify, no hit
    // test — straight into the dialog race.
    if (elementId === null) {
      if (
        !(TARGETLESS_OPS as readonly Op[]).includes(op) &&
        !(!KB_CDP_PRESS_NONE && (OPTIONAL_TARGET_OPS as readonly Op[]).includes(op))
      ) {
        throw new ActFailedError(`op ${op} needs an element`);
      }
      await this.actRaced(pageId, null, op, value, null);
      return;
    }

    const el = await this.cachedElement(pageId, elementId);

    const verified = await this.evalIsolated(pageId, buildVerifyExpression(el.path, el.fingerprint as Fingerprint));
    if (!verified || verified.ok !== true) {
      throw new StaleElementError(`element ${elementId} changed`);
    }

    // No auto-wait exists here: retry the hit test until ACT_TIMEOUT_MS.
    // `scroll_to` skips it on purpose — the hit test itself scrolls the
    // element into view, so it can never fail for a scroll_to that works, and
    // using it would prove nothing (spec § 6 WP-A A4).
    let point: { x: number; y: number } | null = null;
    if (op !== 'scroll_to') {
      const deadline = Date.now() + ACT_TIMEOUT_MS;
      for (;;) {
        const hit = await this.evalIsolated(pageId, buildHitTestExpression(el.path));
        if (hit && hit.ok === true) {
          point = { x: Number(hit.x), y: Number(hit.y) };
          break;
        }
        if (Date.now() >= deadline) {
          throw new CoveredTargetError(`element ${elementId} is covered`);
        }
        await sleep(100);
      }
    }

    // r19 (D3): the act's own completion ('uploaded') surfaces from the
    // element-targeted path; targetless ops never carry one.
    return this.actRaced(pageId, el, op, value, point);
  }

  // Dialog rule: an Input.* sequence or evaluation whose page handler opens a
  // dialog does not answer until the dialog closes. Race the operation against
  // the page's next javascriptDialogOpening; when the dialog wins, resolve
  // normally and discard the orphaned command's later reply or timeout. When
  // the operation itself fails, the error surfaces — an act that did nothing
  // must never resolve as success. Targetless ops take the same race.
  private async actRaced(
    pageId: string,
    el: ElementRecord | null,
    op: Op,
    value: string | undefined,
    point: { x: number; y: number } | null,
  ): Promise<void | string> {
    const dialogPromise = this.dialogWait(pageId);
    let opError: unknown = null;
    const opPromise = this.performOp(pageId, el, op, value, point).then(
      (flip) => ({ ok: true as const, flip }),
      (err) => {
        opError = err;
        return { ok: false as const };
      },
    );
    const winner = await Promise.race([
      opPromise,
      dialogPromise.then(() => 'dialog' as const),
    ]);
    if (winner === 'dialog') {
      // The op's eventual reply or `cdp timeout` rejection is discarded.
      await opPromise.catch(() => {});
      return;
    }
    if (!winner.ok) {
      throw opError instanceof Error ? opError : new Error(String(opError));
    }
    return winner.flip;
  }

  async settle(pageId: string, budgetMs: number): Promise<{ settled: boolean; ms: number }> {
    await this.ensureSession(pageId);
    return settleByProbe(async () => {
      try {
        return await this.evalIsolated(pageId, buildSettleProbeExpression(), EVAL_TIMEOUT_MS);
      } catch {
        return null;
      }
    }, budgetMs);
  }

  onDialog(handler: (e: DialogEvent) => void): void {
    this.dialogHandlers.push(handler);
  }

  async answerDialog(pageId: string, accept: boolean): Promise<void> {
    const sessionId = await this.ensureSession(pageId);
    try {
      if (!KB_CDP_DIALOG) {
        await this.requireConn().send('Page.handleJavaScriptDialog', { accept }, sessionId, 3_000);
      }
    } catch (e) {
      throw new ActFailedError(e instanceof Error ? e.message : String(e));
    }
  }

  async detach(): Promise<void> {
    const conn = this.conn;
    for (const sessionId of this.sessions.values()) {
      await conn
        ?.send('Target.detachFromTarget', { sessionId }, undefined, 3_000)
        .catch(() => {});
    }
    this.sessions.clear();
    this.pageBySession.clear();
    this.dialogWaiters.clear();
    this.dialogsOpen.clear();
    this.elementCache.clear();
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
    if (conn) {
      await conn.close().catch(() => {});
    }
    this.conn = null;
    this.nonDefaultContexts.clear();
    if (this.launchedPid !== null) {
      const pid = this.launchedPid;
      this.launchedPid = null;
      await killTree(pid).catch(() => {});
    }
  }
}
