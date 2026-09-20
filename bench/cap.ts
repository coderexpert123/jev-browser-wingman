// WP-H: spend caps and pricing for the benchmark harness.
// The ceilings are hard-coded here on purpose: no CLI flag may raise them.

export const OPERATOR_CEILINGS = { runUsd: 5, phaseUsd: 17.5 } as const;

export interface LlmRates {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
}

export interface TypesafeRates {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface BenchPrices {
  llm: Record<string, LlmRates>;
  typesafe: TypesafeRates;
  killed_run_charge_usd: number;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface TypesafeUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface BenchUsage {
  llm: LlmUsage;
  typesafe: TypesafeUsage;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// A prices file counts as present and complete only when every rate the
// harness can charge is a finite number. Anything else (missing file, a
// leftover null from the example) refuses the phase.
export function pricesComplete(prices: unknown): prices is BenchPrices {
  if (typeof prices !== 'object' || prices === null) return false;
  const p = prices as BenchPrices;
  if (typeof p.llm !== 'object' || p.llm === null) return false;
  const models = Object.values(p.llm);
  if (models.length === 0) return false;
  for (const rates of models) {
    if (
      !isFiniteNumber(rates?.input_per_mtok) ||
      !isFiniteNumber(rates?.output_per_mtok) ||
      !isFiniteNumber(rates?.cache_read_per_mtok) ||
      !isFiniteNumber(rates?.cache_write_per_mtok)
    ) {
      return false;
    }
  }
  if (!isFiniteNumber(p.typesafe?.input_per_mtok) || !isFiniteNumber(p.typesafe?.output_per_mtok)) return false;
  if (!isFiniteNumber(p.killed_run_charge_usd)) return false;
  return true;
}

function fmtUsd(n: number): string {
  return n.toFixed(2);
}

export function checkStart(a: {
  capUsd?: number;
  phaseCapUsd?: number;
  prices: unknown;
  phaseSpentUsd: number;
}): { ok: true } | { ok: false; line: string } {
  if (a.capUsd === undefined || !Number.isFinite(a.capUsd)) {
    return { ok: false, line: 'BENCH-REFUSED: --cap-usd is required' };
  }
  if (a.phaseCapUsd === undefined || !Number.isFinite(a.phaseCapUsd)) {
    return { ok: false, line: 'BENCH-REFUSED: --phase-cap-usd is required' };
  }
  if (a.capUsd > OPERATOR_CEILINGS.runUsd || a.phaseCapUsd > OPERATOR_CEILINGS.phaseUsd) {
    return {
      ok: false,
      line: `BENCH-REFUSED: cap above operator ceiling (${OPERATOR_CEILINGS.runUsd} per run, ${OPERATOR_CEILINGS.phaseUsd} per phase)`,
    };
  }
  if (!pricesComplete(a.prices)) {
    return { ok: false, line: 'BENCH-REFUSED: bench/prices.json missing or incomplete' };
  }
  if (a.phaseSpentUsd >= a.phaseCapUsd) {
    return {
      ok: false,
      line: `BENCH-REFUSED: phase cap reached (spent ${fmtUsd(a.phaseSpentUsd)} of ${fmtUsd(a.phaseCapUsd)})`,
    };
  }
  return { ok: true };
}

export function shouldAbort(a: {
  runSpentUsd: number;
  capUsd: number;
  phaseSpentUsd: number;
  phaseCapUsd: number;
}): boolean {
  return a.runSpentUsd >= a.capUsd || a.phaseSpentUsd + a.runSpentUsd >= a.phaseCapUsd;
}

// Prices one run's usage. Rates are USD per million tokens. The model key
// selects the LLM rate row; the TypeSafe row is fixed.
export function priceRun(usage: BenchUsage, prices: BenchPrices, model: string = 'sonnet'): number {
  const rates = prices.llm[model] ?? Object.values(prices.llm)[0];
  const llm =
    (usage.llm.input_tokens / 1e6) * rates.input_per_mtok +
    (usage.llm.output_tokens / 1e6) * rates.output_per_mtok +
    (usage.llm.cache_read_tokens / 1e6) * rates.cache_read_per_mtok +
    (usage.llm.cache_write_tokens / 1e6) * rates.cache_write_per_mtok;
  const ts =
    (usage.typesafe.input_tokens / 1e6) * prices.typesafe.input_per_mtok +
    (usage.typesafe.output_tokens / 1e6) * prices.typesafe.output_per_mtok;
  return llm + ts;
}
