import { SCROLL_GROWTH_POLL_MS } from '../contract/constants.js';

export interface SettleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultClock: SettleClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Polls `probe` every 100 ms until it reports a stable, ready page or the
 * budget runs out. Each probe call is raced against the remaining budget, so
 * a probe that never resolves (e.g. a modal dialog blocking evaluation) ends
 * the settle with `settled: false` at the budget; its late result is
 * discarded. A `null` probe result (execution context gone mid-navigation)
 * resets stability. Settled when `readyState` is `interactive` or `complete`
 * and `sig` is unchanged across 3 consecutive polls.
 */
export async function settleByProbe(
  probe: () => Promise<{ readyState: string; sig: string } | null>,
  budgetMs: number,
  clock: SettleClock = defaultClock,
): Promise<{ settled: boolean; ms: number }> {
  const start = clock.now();
  const deadline = start + budgetMs;
  let stableCount = 0;
  let lastSig: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      return { settled: false, ms: clock.now() - start };
    }

    type Raced = { kind: 'probe'; value: { readyState: string; sig: string } | null } | { kind: 'timeout' };
    // A rejected probe counts as not answering (like a context gone
    // mid-navigation): mapped to `null` here so a late rejection after the
    // race resolved can never surface as an unhandled rejection.
    const raced: Raced = await Promise.race([
      probe().then(
        (value): Raced => ({ kind: 'probe', value }),
        (): Raced => ({ kind: 'probe', value: null }),
      ),
      clock.sleep(remaining).then((): Raced => ({ kind: 'timeout' })),
    ]);

    if (raced.kind === 'timeout') {
      return { settled: false, ms: clock.now() - start };
    }

    const result = raced.value;
    if (result === null) {
      stableCount = 0;
      lastSig = null;
    } else {
      const ready = result.readyState === 'interactive' || result.readyState === 'complete';
      if (ready && lastSig !== null && result.sig === lastSig) {
        stableCount += 1;
      } else {
        stableCount = ready ? 1 : 0;
      }
      lastSig = result.sig;
      if (ready && stableCount >= 3) {
        return { settled: true, ms: clock.now() - start };
      }
    }

    const remainingAfter = deadline - clock.now();
    if (remainingAfter <= 0) {
      return { settled: false, ms: clock.now() - start };
    }
    await clock.sleep(Math.min(100, remainingAfter));
  }
}

export interface ScrollGrowthSnapshot { scrollY: number; growth: string }

/** r17c (D-B): self-contained in-page probe (stringified — the purity
 * contract applies; lengths/counts only, never page text). */
export function buildScrollGrowthProbeExpression(): string {
  return `(${scrollGrowthProbe.toString()})()`;
}
function scrollGrowthProbe(): unknown {
  return {
    scrollY: Math.round(window.scrollY),
    growth: (document.body ? document.body.innerText.length : 0) + ':' +
            document.getElementsByTagName('*').length,
  };
}

/** r17c (D-B): poll `probe` until scrollY or growth differs from
 * `baseline`, or the budget expires. A rejected/null probe never ends the
 * wait early (same semantics as settleByProbe's null). */
export async function waitForScrollGrowth(
  probe: () => Promise<ScrollGrowthSnapshot | null>,
  baseline: ScrollGrowthSnapshot,
  budgetMs: number,
  clock: SettleClock = defaultClock,
): Promise<{ changed: boolean; ms: number }> {
  const start = clock.now();
  const deadline = start + budgetMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      return { changed: false, ms: clock.now() - start };
    }

    type Raced = { kind: 'probe'; value: ScrollGrowthSnapshot | null } | { kind: 'timeout' };
    // Same raced-poll shape as settleByProbe: each probe is raced against the
    // remaining budget, and a rejection maps to `null` so a late rejection
    // after the race resolved can never surface as an unhandled rejection.
    // A null (rejected or context-gone) probe is not an answer: the
    // comparison is skipped and the wait continues.
    const raced: Raced = await Promise.race([
      probe().then(
        (value): Raced => ({ kind: 'probe', value }),
        (): Raced => ({ kind: 'probe', value: null }),
      ),
      clock.sleep(remaining).then((): Raced => ({ kind: 'timeout' })),
    ]);

    if (raced.kind === 'timeout') {
      return { changed: false, ms: clock.now() - start };
    }

    const result = raced.value;
    if (result !== null && (result.scrollY !== baseline.scrollY || result.growth !== baseline.growth)) {
      return { changed: true, ms: clock.now() - start };
    }

    const remainingAfter = deadline - clock.now();
    if (remainingAfter <= 0) {
      return { changed: false, ms: clock.now() - start };
    }
    await clock.sleep(Math.min(SCROLL_GROWTH_POLL_MS, remainingAfter));
  }
}
