// Default Jev client (§ WP-C5 item 2): a minimal fetch-based `JevAsk` that
// POSTs to the TypeSafe System One endpoint. Validation mirrors
// pa/src/lib/typesafe-client.ts:201-232 (parseTypeSafeAnswers), written
// fresh here because this package never imports PA code. Never throws; no
// circuit breaker (the plan's minimal default client — callers that want a
// breaker supply their own `JevAsk` through the plugin).

import { TYPESAFE_DEFAULT_BASE_URL, TYPESAFE_MODEL, TYPESAFE_PATH } from '../contract/constants.js';
import type { JevAnswer, JevAsk, JevAskOptions, JevRequest, JevResult } from '../contract/types.js';

const MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** A probability in [0, 1], tolerating float noise up to 1.000001. */
function probability(x: unknown): number | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1.000001) return undefined;
  return Math.min(1, x);
}

/** Validate a response body against the request's questions. undefined = invalid. */
export function parseJevAnswers(request: JevRequest, body: unknown): Record<string, JevAnswer> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const answers = (body as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return undefined;
  const out: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const raw = (answers as Record<string, unknown>)[id];
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    if (question.type === 'choice') {
      if (typeof r.choice !== 'string' || !hasOwn(question.criteria, r.choice)) return undefined;
      const confidence = probability(r.confidence);
      if (confidence === undefined) return undefined;
      if (!r.probabilities || typeof r.probabilities !== 'object') return undefined;
      const probabilities: Record<string, number> = {};
      for (const [option, p] of Object.entries(r.probabilities as Record<string, unknown>)) {
        const value = probability(p);
        if (!hasOwn(question.criteria, option) || value === undefined) return undefined;
        probabilities[option] = value;
      }
      out[id] = { type: 'choice', choice: r.choice, probabilities, confidence };
    } else {
      const noul = probability(r.noul);
      if (noul === undefined) return undefined;
      out[id] = { type: 'noul', noul };
    }
  }
  return out;
}

function retryAfterMsFrom(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export function createDefaultAsk(opts: {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): JevAsk {
  const apiKey = opts.apiKey;
  const baseUrl = (opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowFn = opts.now ?? Date.now;
  const url = `${baseUrl}${TYPESAFE_PATH}`;

  return async function ask(request: JevRequest, askOpts: JevAskOptions): Promise<JevResult> {
    const started = nowFn();
    const budgetMs = askOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let retries = 0;
    try {
      const body = JSON.stringify({ model: TYPESAFE_MODEL, state: request.state, questions: request.questions });
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const remainingMs = budgetMs - (nowFn() - started);
        if (remainingMs <= 0) {
          return { ok: false, error: 'timeout', latencyMs: nowFn() - started, retries };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remainingMs);
        let status = 0;
        let headers: Headers = new Headers();
        let text = '';
        try {
          const res = await fetchFn(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body,
            signal: controller.signal,
          });
          status = res.status;
          headers = res.headers;
          text = await res.text();
        } catch {
          clearTimeout(timer);
          return {
            ok: false,
            error: controller.signal.aborted ? 'timeout' : 'network',
            latencyMs: nowFn() - started,
            retries,
          };
        }
        clearTimeout(timer);

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }

        if (status >= 200 && status < 300) {
          const answers = parseJevAnswers(request, parsed);
          if (!answers) {
            return { ok: false, error: 'invalid-response', status, latencyMs: nowFn() - started, retries };
          }
          const usage = (parsed as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | undefined)
            ?.usage;
          return {
            ok: true,
            answers,
            usage: {
              inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
              outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
            },
            latencyMs: nowFn() - started,
            status,
            retries,
          };
        }

        const retryAfterMs = status === 429 ? retryAfterMsFrom(headers) : undefined;
        const failResult: JevResult = {
          ok: false,
          error: 'http',
          status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          latencyMs: nowFn() - started,
          retries,
        };
        const retryable = status === 429 || status >= 500;
        if (!retryable || attempt === MAX_ATTEMPTS) return failResult;
        const delayMs = status === 429 ? (retryAfterMs ?? DEFAULT_RETRY_DELAY_MS) : DEFAULT_RETRY_DELAY_MS;
        if (delayMs >= budgetMs - (nowFn() - started)) return failResult;
        await sleepFn(delayMs);
        retries += 1;
      }
      return { ok: false, error: 'timeout', latencyMs: nowFn() - started, retries };
    } catch {
      return { ok: false, error: 'network', latencyMs: nowFn() - started, retries };
    }
  };
}
