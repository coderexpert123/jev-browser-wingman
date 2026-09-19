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
} from '../contract/constants.js';
import {
  ActFailedError,
  AttachError,
  CoveredTargetError,
  DialogOpenError,
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
import { settleByProbe } from '../core/settle.js';
import { CdpConnection } from './cdp-connection.js';

export function createCdpDriver(): Driver {
  return new CdpDriver();
}

const cap = (s: unknown, n: number): string => String(s ?? '').slice(0, n);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  browserContextId?: string;
}

class CdpDriver implements Driver {
  readonly name = 'cdp';

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
    el: ElementRecord,
    op: Op,
    value: string | undefined,
    point: { x: number; y: number },
  ): Promise<void> {
    const conn = this.requireConn();
    const sessionId = await this.ensureSession(pageId);
    switch (op) {
      case 'click': {
        await this.mouseClick(sessionId, point);
        return;
      }
      case 'fill': {
        if (value === undefined) {
          throw new ActFailedError('fill requires a value');
        }
        await this.mouseClick(sessionId, point);
        await this.evalIsolated(
          pageId,
          `(() => { const el = document.querySelector(${JSON.stringify(el.path)}); if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()`,
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
        await this.mouseClick(sessionId, point);
        return;
      }
      case 'press': {
        await this.evalIsolated(
          pageId,
          `(() => { const el = document.querySelector(${JSON.stringify(el.path)}); if (!el) return false; el.focus(); return true; })()`,
        );
        const keyDown = { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
        const keyUp = { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
        await conn.send('Input.dispatchKeyEvent', keyDown, sessionId);
        await conn.send('Input.dispatchKeyEvent', keyUp, sessionId);
        return;
      }
      case 'scroll': {
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
        return;
      }
      default: {
        throw new ActFailedError(`unsupported op ${op}`);
      }
    }
  }

  async act(pageId: string, elementId: string, op: Op, value?: string): Promise<void> {
    const el = await this.cachedElement(pageId, elementId);

    const verified = await this.evalIsolated(pageId, buildVerifyExpression(el.path, el.fingerprint as Fingerprint));
    if (!verified || verified.ok !== true) {
      throw new StaleElementError(`element ${elementId} changed`);
    }

    // No auto-wait exists here: retry the hit test until ACT_TIMEOUT_MS.
    const deadline = Date.now() + ACT_TIMEOUT_MS;
    let point: { x: number; y: number } | null = null;
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

    // Dialog rule: an Input.* sequence or evaluation whose page handler opens a
    // dialog does not answer until the dialog closes. Race the operation against
    // the page's next javascriptDialogOpening; when the dialog wins, resolve
    // normally and discard the orphaned command's later reply or timeout. When
    // the operation itself fails, the error surfaces — an act that did nothing
    // must never resolve as success.
    const dialogPromise = this.dialogWait(pageId);
    let opError: unknown = null;
    const opPromise = this.performOp(pageId, el, op, value, point).then(
      () => 'op' as const,
      (err) => {
        opError = err;
        return 'op' as const;
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
    if (opError !== null) {
      throw opError instanceof Error ? opError : new Error(String(opError));
    }
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
