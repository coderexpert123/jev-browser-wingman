import { randomBytes } from 'node:crypto';
import type { Fingerprint, Op } from '../contract/types.js';
import { TOKEN_TTL_MS, TOKEN_MAX_LIVE } from '../contract/constants.js';

export interface PendingAction {
  url: string;
  elementPath: string;
  fingerprint: Fingerprint;
  verb: Op;
  binding?: string;
  optionValue?: string;
  label: string;
}

interface TokenEntry {
  action: PendingAction;
  expiresAt: number;
  used: boolean;
}

function mintToken(): string {
  return `wct_${randomBytes(16).toString('base64url')}`;
}

export class ConfirmTokenStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxLive: number;
  private readonly tokens = new Map<string, TokenEntry>();

  constructor(now: () => number = Date.now, ttlMs = TOKEN_TTL_MS, maxLive = TOKEN_MAX_LIVE) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxLive = maxLive;
  }

  mint(p: PendingAction): string {
    const token = mintToken();
    this.tokens.set(token, { action: p, expiresAt: this.now() + this.ttlMs, used: false });
    while (this.tokens.size > this.maxLive) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    return token;
  }

  consume(token: string): PendingAction | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.used) return null;
    entry.used = true;
    if (this.now() > entry.expiresAt) return null;
    return entry.action;
  }
}
