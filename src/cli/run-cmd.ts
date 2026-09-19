// CLI `run` and `check` commands (§ WP-F1 item 4). Values come only from a
// file, never argv. Prints the WingmanResult JSON; exit 0 whenever a result
// is produced, 1 on tool-fault, 2 on usage. A CLI process keeps its tokens in
// memory only, so there is no --confirm-token: confirm through MCP or the
// library (README, WP-G).

import fs from 'node:fs';
import { createWingman } from '../lib.js';

export const USAGE_RUN =
  'usage: jev-browser-wingman run --goal <text> [--values-file <json>] [--url-match <s>] [--max-steps <n>] [--max-ms <n>]';
export const USAGE_CHECK = 'usage: jev-browser-wingman check --question <text> [--url-match <s>]';

interface Parsed {
  flags: Map<string, string>;
}

function parse(args: string[], allowed: string[]): Parsed | null {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      return null;
    }
    let name = arg.slice(2);
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (!allowed.includes(name)) {
      return null;
    }
    if (value === undefined) {
      if (i + 1 >= args.length) {
        return null;
      }
      value = args[++i];
    }
    flags.set(name, value);
  }
  return { flags };
}

function failUsage(stderr: NodeJS.WriteStream, usage: string): number {
  stderr.write(`${usage}\n`);
  return 2;
}

export async function runCommand(args: string[], io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } = process): Promise<number> {
  const { stdout, stderr } = io;
  // Values are withheld from argv by design: any --values flag is a usage error.
  if (args.some((a) => a === '--values' || a.startsWith('--values='))) {
    return failUsage(stderr, USAGE_RUN + '\nvalues are only accepted through --values-file');
  }
  const parsed = parse(args, ['goal', 'values-file', 'url-match', 'max-steps', 'max-ms']);
  if (!parsed || !parsed.flags.has('goal')) {
    return failUsage(stderr, USAGE_RUN);
  }
  const goal = parsed.flags.get('goal') as string;
  const input: Record<string, unknown> = { goal };
  if (parsed.flags.has('values-file')) {
    const file = parsed.flags.get('values-file') as string;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return failUsage(stderr, `cannot read values file: ${(e as Error).message}`);
    }
    let values: unknown;
    try {
      values = JSON.parse(raw);
    } catch {
      return failUsage(stderr, 'values file is not valid JSON');
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      return failUsage(stderr, 'values file must contain a JSON object of binding name to text');
    }
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return failUsage(stderr, 'values file must contain a JSON object of binding name to text');
      }
    }
    input.values = values;
  }
  if (parsed.flags.has('url-match')) {
    input.url_match = parsed.flags.get('url-match');
  }
  if (parsed.flags.has('max-steps')) {
    input.max_steps = Number(parsed.flags.get('max-steps'));
  }
  if (parsed.flags.has('max-ms')) {
    input.max_ms = Number(parsed.flags.get('max-ms'));
  }

  let result;
  try {
    const wingman = await createWingman();
    result = await wingman.do(input);
  } catch (e) {
    stderr.write(`jev-browser-wingman run: ${(e as Error).message}\n`);
    return 1;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return result.reason === 'tool-fault' ? 1 : 0;
}

export async function checkCommand(args: string[], io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } = process): Promise<number> {
  const { stdout, stderr } = io;
  const parsed = parse(args, ['question', 'url-match']);
  if (!parsed || !parsed.flags.has('question')) {
    return failUsage(stderr, USAGE_CHECK);
  }
  const input: Record<string, unknown> = { question: parsed.flags.get('question') as string };
  if (parsed.flags.has('url-match')) {
    input.url_match = parsed.flags.get('url-match');
  }

  let result;
  try {
    const wingman = await createWingman();
    result = await wingman.check(input);
  } catch (e) {
    stderr.write(`jev-browser-wingman check: ${(e as Error).message}\n`);
    return 1;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return result.reason === 'tool-fault' ? 1 : 0;
}
