// WP-D1 — Playwright adapter.
//
// Attaches over CDP with `{ noDefaults: true }` (RO-5: without it Playwright
// enables focus emulation and every attached page reports `visible`), works
// through one CDP session per page, evaluates in the `wingman` isolated world,
// and never opens pages, closes contexts or closes targets.

import { chromium as defaultChromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Page } from 'playwright-core';
import { ACT_TIMEOUT_MS, EVAL_TIMEOUT_MS, MAX_ENUMERATED } from '../contract/constants.js';
import {
  ActFailedError,
  AttachError,
  CoveredTargetError,
  DialogOpenError,
  StaleElementError,
} from '../contract/errors.js';
import type {
  AttachTarget,
  DialogEvent,
  Driver,
  ElementRecord,
  Observation,
  PageInfo,
  Op,
} from '../contract/types.js';
import {
  buildControlStateExpression,
  buildEnumerateExpression,
  buildHitTestExpression,
  buildSettleProbeExpression,
  buildVerifyExpression,
  buildVisibilityExpression,
} from '../core/page-scripts.js';
import { settleByProbe } from '../core/settle.js';
import { ensureChrome } from '../browser/chrome.js';
import { killTree } from '../browser/process-list.js';
import { wingmanHome } from '../contract/home.js';

interface PageRecord {
  page: Page;
  pageId: string;
  session: CDPSession;
  dialogOpen: boolean;
  dialogWaiters: Array<() => void>;
}

function cap(text: string, max: number): string {
  return text.slice(0, max);
}

// Cold start: `connectOverCDP` measured 6–19 s against a Chrome that is still
// coming up (WP-D1, 2026-09-19) — far over the 5 s per-attempt pin, so a plain
// single attempt fails every cold attach. The pin stays per attempt; the driver
// retries within this budget so a slow start fails late, never early.
const CONNECT_RETRY_BUDGET_MS = 20_000;

async function connectBounded(
  chromium: typeof import('playwright-core').chromium,
  endpoint: string,
): Promise<Browser> {
  const deadline = Date.now() + CONNECT_RETRY_BUDGET_MS;
  for (;;) {
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 5_000, noDefaults: true });
    } catch (e) {
      if (Date.now() >= deadline) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export function createPlaywrightDriver(opts?: { chromium?: typeof import('playwright-core').chromium }): Driver {
  const chromium = opts?.chromium ?? defaultChromium;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let launchedPid: number | null = null;
  const records = new Map<Page, PageRecord>();
  const recordsById = new Map<string, PageRecord>();
  const elementsByPage = new Map<string, ElementRecord[]>();
  let dialogHandler: ((e: DialogEvent) => void) | null = null;

  function report(e: DialogEvent): void {
    if (dialogHandler) dialogHandler(e);
  }

  function recordOfPageId(pageId: string): PageRecord {
    const rec = recordsById.get(pageId);
    if (!rec) throw new ActFailedError(`no attached page with id ${pageId}`);
    return rec;
  }

  async function ensurePageRecord(page: Page): Promise<PageRecord> {
    const existing = records.get(page);
    if (existing) return existing;
    if (!context) throw new AttachError('not attached');
    // Bounded: a stalled renderer or wedged connection must fail the call,
    // never hang the driver (measured 2026-09-19 on this machine's Chrome).
    const setup = (async () => {
      const session = await context.newCDPSession(page);
      await session.send('Page.enable');
      const info = await session.send('Target.getTargetInfo');
      return { session, pageId: info.targetInfo.targetId };
    })();
    let session: CDPSession;
    let pageId: string;
    try {
      const done = await Promise.race([
        setup,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new AttachError('page session setup timed out')), 10_000),
        ),
      ]);
      session = done.session;
      pageId = done.pageId;
    } catch (e) {
      void setup.catch(() => {});
      throw e;
    }
    const rec: PageRecord = { page, pageId, session, dialogOpen: false, dialogWaiters: [] };
    session.on('Page.javascriptDialogOpening', () => {
      rec.dialogOpen = true;
      for (const wake of rec.dialogWaiters.splice(0)) wake();
    });
    session.on('Page.javascriptDialogClosed', () => {
      rec.dialogOpen = false;
    });
    records.set(page, rec);
    recordsById.set(pageId, rec);
    return rec;
  }

  // One isolated world per evaluation in the `wingman` world (§ 3.5). The
  // WHOLE chain — getFrameTree, createIsolatedWorld, Runtime.evaluate — is
  // raced against EVAL_TIMEOUT_MS: a renderer blocked by a modal dialog never
  // answers the world-creation commands either, and only `dialogOpen` (tracked
  // from Page.javascriptDialogOpening/Closed) distinguishes that timeout as a
  // DialogOpenError; any other timeout is ActFailedError('evaluation timed
  // out').
  async function evaluateOnPage(rec: PageRecord, expression: string): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const work = (async () => {
      const tree = await rec.session.send('Page.getFrameTree');
      return rec.session.send('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: 'wingman',
      });
    })()
      .then((world) =>
        rec.session.send('Runtime.evaluate', {
          expression,
          contextId: world.executionContextId,
          returnByValue: true,
          awaitPromise: true,
        }),
      );
    const raced = await Promise.race([
      work.then(
        (r) => ({ kind: 'result' as const, r }),
        (e) => ({ kind: 'error' as const, e }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), EVAL_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (raced.kind === 'timeout') {
      if (rec.dialogOpen) {
        throw new DialogOpenError(`evaluation blocked by an open dialog on page ${rec.pageId}`);
      }
      throw new ActFailedError('evaluation timed out');
    }
    if (raced.kind === 'error') throw raced.e;
    if (raced.r.exceptionDetails) {
      const detail = raced.r.exceptionDetails;
      const text = detail.exception?.description ?? detail.text ?? 'evaluation failed';
      throw new ActFailedError(cap(text, 200));
    }
    return raced.r.result.value;
  }

  function normalizeDialogType(t: string): DialogEvent['type'] {
    return t === 'confirm' || t === 'prompt' || t === 'beforeunload' ? t : 'alert';
  }

  function dialogTypeOfPlaywright(d: Dialog): DialogEvent['type'] {
    return normalizeDialogType(d.type());
  }

  // Races one act operation against the page's next dialog event AND against
  // its own ACT_TIMEOUT_MS budget: Playwright's internal action timeout never
  // fires while its per-page bootstrap evaluate is wedged on a stalled
  // renderer (measured 2026-09-19), so the driver enforces the bound itself.
  // When the dialog wins, act resolves normally and the abandoned operation's
  // later rejection is caught and discarded, never surfaced or left unhandled.
  async function raceAgainstDialog(rec: PageRecord, op: () => Promise<unknown>): Promise<void> {
    const dialogWon = new Promise<'dialog'>((resolve) => {
      rec.dialogWaiters.push(() => resolve('dialog'));
    });
    const pending = op();
    const opRaced = Promise.race([
      pending.then(
        () => 'op' as const,
        (e) => {
          throw e;
        },
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new ActFailedError('operation timed out')), ACT_TIMEOUT_MS + 2_000);
      }),
    ]);
    const winner = await Promise.race([opRaced, dialogWon]);
    if (winner === 'dialog') {
      opRaced.catch(() => {});
      pending.catch(() => {});
      return;
    }
  }

  return {
    name: 'playwright',

    async attach(target: AttachTarget): Promise<void> {
      let endpoint: string;
      if ('cdpEndpoint' in target) {
        endpoint = target.cdpEndpoint;
        launchedPid = null;
      } else {
        const result = await ensureChrome({
          port: target.launch.port,
          profileDir: target.launch.profileDir,
          chromePath: target.launch.chromePath,
          home: wingmanHome(),
          window: target.launch.headed ? 'offscreen' : 'headless',
        });
        if (!result.ok) throw new AttachError(result.message);
        endpoint = result.endpoint;
        launchedPid = result.startedByUs && result.pid !== null ? result.pid : null;
      }
      browser = await connectBounded(chromium, endpoint);
      const ctx = browser.contexts()[0];
      if (!ctx) {
        // Leave no connection behind when attach fails (a CDP-attached browser
        // only disconnects on close, C12).
        await browser.close().catch(() => {});
        browser = null;
        throw new AttachError('no default browser context on the CDP endpoint');
      }
      context = ctx;
      // Registered before anything else. The listener only reports; it never
      // calls accept or dismiss, so Playwright never auto-dismisses either.
      context.on('dialog', (dialog) => {
        void (async () => {
          let pageId = '';
          const dialogPage = dialog.page();
          const rec = dialogPage ? records.get(dialogPage) : undefined;
          if (rec) {
            pageId = rec.pageId;
          } else if (dialogPage) {
            try {
              pageId = (await ensurePageRecord(dialogPage)).pageId;
            } catch {
              pageId = '';
            }
          }
          report({ pageId, type: dialogTypeOfPlaywright(dialog), message: cap(dialog.message(), 80) });
        })();
      });
    },

    async pages(): Promise<PageInfo[]> {
      if (!context) throw new AttachError('not attached');
      const out: PageInfo[] = [];
      for (const page of context.pages()) {
        const rec = await ensurePageRecord(page);
        let visible = false;
        let title = '';
        try {
          visible = (await evaluateOnPage(rec, buildVisibilityExpression())) === 'visible';
        } catch {
          visible = false;
        }
        try {
          title = String((await evaluateOnPage(rec, 'document.title')) ?? '');
        } catch {
          title = '';
        }
        out.push({ id: rec.pageId, url: page.url(), title, visible });
      }
      return out;
    },

    async observe(pageId: string): Promise<Observation> {
      const rec = recordOfPageId(pageId);
      const obs = (await evaluateOnPage(
        rec,
        buildEnumerateExpression({ maxElements: MAX_ENUMERATED, maxTextChars: 3_000 }),
      )) as Observation;
      elementsByPage.set(pageId, obs.elements);
      return obs;
    },

    async act(pageId: string, elementId: string, op: Op, value?: string): Promise<void> {
      const rec = recordOfPageId(pageId);
      const elements = elementsByPage.get(pageId);
      const el = elements?.find((e) => e.id === elementId);
      if (!el) throw new StaleElementError(`element ${elementId} is not in the cached observation of page ${pageId}`);

      try {
        const verify = (await evaluateOnPage(rec, buildVerifyExpression(el.path, el.fingerprint))) as {
          ok: boolean;
          reason?: string;
        };
        if (!verify.ok) {
          throw new StaleElementError(`element ${elementId} is stale (${verify.reason ?? 'unknown'})`);
        }
        const hit = (await evaluateOnPage(rec, buildHitTestExpression(el.path))) as {
          ok: boolean;
          covered?: boolean;
          x?: number;
          y?: number;
        };
        if (!hit.ok) {
          throw new CoveredTargetError(`element ${elementId} is covered by another element`);
        }

        const timeout = { timeout: ACT_TIMEOUT_MS };
        switch (op) {
          case 'click':
            await raceAgainstDialog(rec, () => rec.page.locator(el.path).click(timeout));
            break;
          case 'fill':
            await raceAgainstDialog(rec, () => rec.page.locator(el.path).fill(value ?? '', timeout));
            break;
          case 'select':
            await raceAgainstDialog(rec, () => rec.page.locator(el.path).selectOption({ value: value ?? '' }, timeout));
            break;
          case 'check':
          case 'uncheck': {
            const wanted = op === 'check';
            const state = (await evaluateOnPage(
              rec,
              buildControlStateExpression(el.controlPath ?? el.path),
            )) as { checked: boolean };
            if (state.checked !== wanted) {
              // Click `path`, not `controlPath`: for a proxied control the
              // real input can be visually hidden, and `path` is the visible
              // wrapping label that toggles it.
              await raceAgainstDialog(rec, () => rec.page.locator(el.path).click(timeout));
            }
            break;
          }
          case 'press':
            await raceAgainstDialog(rec, () => rec.page.locator(el.path).press('Enter', timeout));
            break;
          case 'scroll': {
            const innerHeight = Number(
              (await evaluateOnPage(rec, 'window.innerHeight')) ?? 0,
            );
            await raceAgainstDialog(rec, () => rec.page.mouse.wheel(0, Math.round(innerHeight * 0.8)));
            break;
          }
        }
      } catch (e) {
        if (e instanceof StaleElementError || e instanceof CoveredTargetError || e instanceof DialogOpenError) {
          throw e;
        }
        throw new ActFailedError(e instanceof Error ? e.message : String(e));
      }
    },

    async settle(pageId: string, budgetMs: number): Promise<{ settled: boolean; ms: number }> {
      const rec = recordOfPageId(pageId);
      return settleByProbe(async () => {
        try {
          return (await evaluateOnPage(rec, buildSettleProbeExpression())) as {
            readyState: string;
            sig: string;
          };
        } catch {
          return null;
        }
      }, budgetMs);
    },

    onDialog(handler: (e: DialogEvent) => void): void {
      dialogHandler = handler;
    },

    async detach(): Promise<void> {
      // Every step bounded: detach must never hang the tool call even when a
      // renderer or the connection is wedged.
      for (const rec of records.values()) {
        try {
          await Promise.race([
            rec.session.detach(),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
          ]);
        } catch {
          // already detached
        }
      }
      records.clear();
      recordsById.clear();
      elementsByPage.clear();
      if (browser) {
        // A CDP-attached browser only disconnects on close (C12); the pages
        // and contexts stay alive.
        try {
          await Promise.race([
            browser.close(),
            new Promise((resolve) => setTimeout(resolve, 10_000)),
          ]);
        } catch {
          // already gone
        }
      }
      browser = null;
      context = null;
      if (launchedPid !== null) {
        const pid = launchedPid;
        launchedPid = null;
        try {
          await killTree(pid);
        } catch {
          // already gone
        }
      }
    },
  };
}
