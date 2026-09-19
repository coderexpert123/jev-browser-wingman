// Scripted in-memory Driver for loop tests (§ WP-C7 item 6): observations are
// scripted per page, every call is recorded, and a dialog, a stale element or
// a covered target can be raised on demand.

import type {
  AttachTarget,
  DialogEvent,
  Driver,
  Observation,
  Op,
  PageInfo,
} from '../../src/contract/types.js';

export interface FakeDriverEvent {
  kind: 'attach' | 'pages' | 'observe' | 'act' | 'settle' | 'detach';
  pageId?: string;
  elementId?: string;
  op?: Op;
  value?: string;
}

export class FakeDriver implements Driver {
  readonly name = 'fake';

  /** Every driver call, in order. */
  events: FakeDriverEvent[] = [];

  /** Pages returned by pages(). */
  pageList: PageInfo[] = [];

  /** Scripted observations per page id; the last entry repeats when exhausted. */
  observationScripts = new Map<string, Observation[]>();

  /** Delivered to onDialog immediately when raised. */
  dialogHandler: ((e: DialogEvent) => void) | null = null;

  /** Raised during the next observe() (a dialog open before any act). */
  dialogOnNextObserve: DialogEvent | null = null;

  /** Raised during the next act() (a dialog reported since the act began). */
  dialogOnNextAct: DialogEvent | null = null;

  /** Thrown by the next act() call (StaleElementError, CoveredTargetError, …). */
  failNextAct: Error | null = null;

  /** Test hook invoked at the top of every observe() (e.g. to advance a fake clock). */
  onObserve: (() => void) | null = null;

  constructor(init: { pages?: PageInfo[]; observations?: Record<string, Observation[]> } = {}) {
    if (init.pages) this.pageList = init.pages;
    if (init.observations) {
      for (const [pageId, obs] of Object.entries(init.observations)) {
        this.observationScripts.set(pageId, obs);
      }
    }
  }

  attach(_target: AttachTarget): Promise<void> {
    this.events.push({ kind: 'attach' });
    return Promise.resolve();
  }

  async pages(): Promise<PageInfo[]> {
    this.events.push({ kind: 'pages' });
    return this.pageList;
  }

  async observe(pageId: string): Promise<Observation> {
    this.events.push({ kind: 'observe', pageId });
    this.onObserve?.();
    if (this.dialogOnNextObserve) {
      const d = this.dialogOnNextObserve;
      this.dialogOnNextObserve = null;
      this.dialogHandler?.(d);
    }
    const queue = this.observationScripts.get(pageId);
    if (!queue || queue.length === 0) {
      throw new Error(`FakeDriver: no observation scripted for page ${pageId}`);
    }
    return queue.length > 1 ? (queue.shift() as Observation) : queue[0];
  }

  async act(pageId: string, elementId: string, op: Op, value?: string): Promise<void> {
    this.events.push({ kind: 'act', pageId, elementId, op, value });
    if (this.dialogOnNextAct) {
      const d = this.dialogOnNextAct;
      this.dialogOnNextAct = null;
      this.dialogHandler?.(d);
    }
    if (this.failNextAct) {
      const e = this.failNextAct;
      this.failNextAct = null;
      throw e;
    }
  }

  async settle(_pageId: string, budgetMs: number): Promise<{ settled: boolean; ms: number }> {
    this.events.push({ kind: 'settle' });
    return { settled: true, ms: budgetMs };
  }

  onDialog(handler: (e: DialogEvent) => void): void {
    this.dialogHandler = handler;
  }

  async detach(): Promise<void> {
    this.events.push({ kind: 'detach' });
  }

  /** Raise a dialog immediately (as the page itself would). */
  raiseDialog(e: DialogEvent): void {
    this.dialogHandler?.(e);
  }

  actCalls(): FakeDriverEvent[] {
    return this.events.filter((e) => e.kind === 'act');
  }
}
