// Scripted in-memory Driver for loop tests (§ WP-C7 item 6): observations are
// scripted per page, every call is recorded, and a dialog, a stale element or
// a covered target can be raised on demand.

import {
  OPS,
  type AttachTarget,
  type DialogEvent,
  type Driver,
  type Observation,
  type Op,
  type PageInfo,
} from '../../src/contract/types.js';

export interface FakeDriverEvent {
  kind: 'attach' | 'pages' | 'observe' | 'act' | 'settle' | 'detach' | 'answerDialog';
  pageId?: string;
  elementId?: string | null;
  op?: Op;
  value?: string;
  /** r17: answerDialog only — the accept flag the loop passed. */
  accept?: boolean;
}

export class FakeDriver implements Driver {
  readonly name = 'fake';

  /** § 5.5.6 op declaration: the ops this driver executes; settable so tests
   * can simulate a legacy driver. The loop reads it as `driver.ops ?? LEGACY_OPS`. */
  ops: readonly Op[] = OPS;

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

  /** Raised during the next act() (a dialog reported since the act began).
   * r17: an ARRAY is a cascade — every event in it delivers, in order,
   * during that ONE act (C4's second-dialog-in-the-same-act scenario), then
   * the field clears. */
  dialogOnNextAct: DialogEvent | DialogEvent[] | null = null;

  /** Thrown by the next act() call (StaleElementError, CoveredTargetError, …). */
  failNextAct: Error | null = null;

  /** r17 (C5): thrown by the next answerDialog() call — an answer that failed
   * leaves the dialog open, which the loop degrades to blocked/dialog-open. */
  failNextAnswer: Error | null = null;

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

  async act(pageId: string, elementId: string | null, op: Op, value?: string): Promise<void> {
    this.events.push({ kind: 'act', pageId, elementId, op, value });
    if (this.dialogOnNextAct !== null) {
      if (Array.isArray(this.dialogOnNextAct)) {
        // Array: a cascade — all events deliver, in order, within this one
        // act (C4), then the field clears.
        const rest = this.dialogOnNextAct;
        this.dialogOnNextAct = null;
        for (const d of rest) {
          this.dialogHandler?.(d);
        }
      } else {
        const d = this.dialogOnNextAct;
        this.dialogOnNextAct = null;
        this.dialogHandler?.(d);
      }
    }
    if (this.failNextAct) {
      const e = this.failNextAct;
      this.failNextAct = null;
      throw e;
    }
  }

  /** r17 (C5): records the call; throws failNextAnswer when armed. */
  async answerDialog(pageId: string, accept: boolean): Promise<void> {
    this.events.push({ kind: 'answerDialog', pageId, accept });
    if (this.failNextAnswer) {
      const e = this.failNextAnswer;
      this.failNextAnswer = null;
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
