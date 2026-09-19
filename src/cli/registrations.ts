// WP-F2: registration surfaces. Reads each CLI's MCP registration file,
// checks entries for portability problems (absolute paths, secrets in env),
// and implements the wrapped-entry rule (§ 3.12) plus the wingman server
// entry per client.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ClientId = 'claude' | 'codex' | 'opencode' | 'agy' | 'devin' | 'cursor';

export function clientConfigPath(
  client: ClientId,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  switch (client) {
    case 'claude':
      return join(home, '.claude.json');
    case 'codex':
      return join(home, '.codex', 'config.toml');
    case 'opencode':
      return join(home, '.config', 'opencode', 'opencode.jsonc');
    case 'agy':
      return join(home, '.gemini', 'config', 'mcp_config.json');
    case 'devin':
      if (platform === 'win32') {
        return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'devin', 'mcp_config.json');
      }
      return join(home, '.config', 'devin', 'mcp_config.json');
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
  }
}

export interface RegistrationEntry {
  client: ClientId;
  server: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  raw: unknown;
}

export interface ReadRegistrationsDeps {
  /** Read this file instead of the client's own config path (tests). */
  file?: string;
  readFile?: (path: string) => Promise<string>;
  fileExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  home?: string;
}

export type RegistrationsResult =
  | { file: string; exists: boolean; entries: RegistrationEntry[] }
  | { error: string };

const JSON_CLIENTS: ReadonlySet<ClientId> = new Set(['claude', 'agy', 'devin', 'cursor']);

export async function readRegistrations(
  client: ClientId,
  deps: ReadRegistrationsDeps = {},
): Promise<RegistrationsResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const readFileFn = deps.readFile ?? (async (p: string) => readFile(p, 'utf8'));
  const fileExists = deps.fileExists ?? ((p: string) => existsSync(p));
  const file = deps.file ?? clientConfigPath(client, env, platform, home);
  if (!fileExists(file)) {
    return { file, exists: false, entries: [] };
  }
  let text: string;
  try {
    text = await readFileFn(file);
  } catch (e) {
    return { error: `cannot read ${file}: ${(e as Error).message}` };
  }

  if (client === 'codex') {
    return parseCodexToml(client, file, text);
  }
  if (client === 'opencode') {
    return parseOpencodeJsonc(client, file, text);
  }
  if (JSON_CLIENTS.has(client)) {
    return parseMcpServersJson(client, file, text);
  }
  return { error: `unsupported client: ${client}` };
}

function entry(
  client: ClientId,
  server: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  raw: unknown,
): RegistrationEntry {
  return { client, server, command, args, env, raw };
}

function parseMcpServersJson(
  client: ClientId,
  file: string,
  text: string,
): RegistrationsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `cannot parse ${file}: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `${file} is not a JSON object` };
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === undefined) {
    return { file, exists: true, entries: [] };
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { error: `${file}: mcpServers is not an object` };
  }
  const entries: RegistrationEntry[] = [];
  for (const [server, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    entries.push(
      entry(
        client,
        server,
        typeof v.command === 'string' ? v.command : '',
        stringArray(v.args),
        stringRecord(v.env),
        value,
      ),
    );
  }
  return { file, exists: true, entries };
}

function parseOpencodeJsonc(
  client: ClientId,
  file: string,
  text: string,
): RegistrationsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (e) {
    return { error: `cannot parse ${file}: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `${file} is not a JSON object` };
  }
  const servers = (parsed as Record<string, unknown>).mcp;
  if (servers === undefined) {
    return { file, exists: true, entries: [] };
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { error: `${file}: mcp is not an object` };
  }
  const entries: RegistrationEntry[] = [];
  for (const [server, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    // opencode's array form [C, ...A] splits into command + args.
    let command = '';
    let args: string[] = [];
    if (Array.isArray(v.command)) {
      const parts = stringArray(v.command);
      command = parts[0] ?? '';
      args = parts.slice(1);
    } else if (typeof v.command === 'string') {
      command = v.command;
      args = stringArray(v.args);
    }
    entries.push(entry(client, server, command, args, stringRecord(v.environment), value));
  }
  return { file, exists: true, entries };
}

/** Strip `//` and `/* *\/` comments that are outside string literals. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1; // keep the newline itself
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * A narrow TOML reader for codex's `[mcp_servers.<name>]` tables: `command`
 * and `args` keys on the table plus a `[mcp_servers.<name>.env]` sub-table of
 * string keys. Handles basic `"…"` and literal `'…'` strings and string
 * arrays; ignores everything else (other tables, dotted/nested values,
 * comments).
 */
function parseCodexToml(
  client: ClientId,
  file: string,
  text: string,
): RegistrationsResult {
  const servers = new Map<string, { command?: string; args?: string[]; env: Record<string, string> }>();
  let current: string | null = null; // server name for [mcp_servers.<name>]
  let currentEnv = false; // the current table is [mcp_servers.<name>.env]

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (line === '') continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      const path = table[1].trim();
      const envHeader = /^mcp_servers\.(.+?)\s*\.\s*env$/.exec(path) ?? null;
      const plainHeader = /^mcp_servers\.(.+?)$/.exec(path) ?? null;
      if (envHeader) {
        current = unquoteBasic(envHeader[1]);
        currentEnv = true;
      } else if (plainHeader) {
        current = unquoteBasic(plainHeader[1]);
        currentEnv = false;
        if (!servers.has(current)) servers.set(current, { env: {} });
      } else {
        current = null;
        currentEnv = false;
      }
      continue;
    }
    if (current === null) continue;
    const kv = /^([^=]+?)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = unquoteBasic(kv[1].trim());
    const value = kv[2].trim();
    let record = servers.get(current);
    if (!record) {
      record = { env: {} };
      servers.set(current, record);
    }
    if (currentEnv) {
      const s = parseTomlString(value);
      if (s !== undefined) record.env[key] = s;
    } else if (key === 'command') {
      const s = parseTomlString(value);
      if (s !== undefined) record.command = s;
    } else if (key === 'args') {
      const arr = parseTomlStringArray(value);
      if (arr !== undefined) record.args = arr;
    }
  }

  const entries: RegistrationEntry[] = [];
  for (const [server, record] of servers) {
    entries.push(entry(client, server, record.command ?? '', record.args ?? [], record.env, record));
  }
  return { file, exists: true, entries };
}

function stripTomlComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === '\\') i++;
      else if (ch === '"') inBasic = false;
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false;
    } else if (ch === '"') {
      inBasic = true;
    } else if (ch === "'") {
      inLiteral = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquoteBasic(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

function parseTomlString(value: string): string | undefined {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    // Basic string: undo the escapes TOML defines for the shapes we care about.
    return value.slice(1, -1).replace(/\\(.)/g, (_, c: string) => {
      if (c === 'n') return '\n';
      if (c === 't') return '\t';
      if (c === 'r') return '\r';
      if (c === '"') return '"';
      if (c === '\\') return '\\';
      return c;
    });
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return undefined;
}

function parseTomlStringArray(value: string): string[] | undefined {
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (i >= inner.length) break;
    if (inner[i] === '"' || inner[i] === "'") {
      const quote = inner[i];
      let j = i + 1;
      let element = '';
      while (j < inner.length) {
        if (quote === '"' && inner[j] === '\\') {
          element += inner[j + 1];
          j += 2;
          continue;
        }
        if (inner[j] === quote) break;
        element += inner[j];
        j++;
      }
      out.push(element);
      i = j + 1;
      while (i < inner.length && /\s/.test(inner[i])) i++;
      if (inner[i] === ',') i++;
    } else {
      // Not a string element; skip to the next comma.
      const next = inner.indexOf(',', i);
      i = next === -1 ? inner.length : next + 1;
    }
  }
  return out;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function stringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'string') out[k] = x;
  }
  return out;
}

const ABSOLUTE_PATH_RE = /^([A-Za-z]:[\\/]|\\\\|\/)/;
const SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD/i;

export function portabilityProblems(e: RegistrationEntry): string[] {
  const problems: string[] = [];
  for (const token of [e.command, ...e.args]) {
    if (token === '') continue;
    if (ABSOLUTE_PATH_RE.test(token)) {
      problems.push(`absolute-path:${token}`);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1 && ABSOLUTE_PATH_RE.test(token.slice(eq + 1))) {
      problems.push(`absolute-path:${token}`);
    }
  }
  // The value is never included (§ WP-F2 item 1).
  for (const [key, value] of Object.entries(e.env)) {
    if (value !== '' && SECRET_KEY_RE.test(key)) {
      problems.push(`secret-in-env:${key}`);
    }
  }
  return problems;
}

function stripUserDataDirArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-data-dir') {
      i++; // drop the value token too
      continue;
    }
    if (args[i].startsWith('--user-data-dir=')) continue;
    out.push(args[i]);
  }
  return out;
}

export function wrapPlaywrightEntry(
  entry: { command?: string; args?: string[] } | string[],
  client: ClientId,
): unknown {
  const isArray = Array.isArray(entry);
  const command = isArray ? (entry[0] ?? '') : (entry.command ?? '');
  const args = isArray ? entry.slice(1) : (entry.args ?? []);
  const stripped = stripUserDataDirArgs(args);
  const wrappedArgs = ['with-chrome', '--', command, ...stripped];
  if (isArray) {
    return ['jev-browser-wingman', ...wrappedArgs];
  }
  // Keys keep their original order; build with a spread (§ 3.12).
  const result: Record<string, unknown> = { ...(entry as Record<string, unknown>), command: 'jev-browser-wingman', args: wrappedArgs };
  if (client === 'codex') {
    result.startup_timeout_sec = 60;
  }
  return result;
}

export function wingmanServerEntry(client: ClientId): unknown {
  switch (client) {
    case 'claude':
    // cursor registers through the same `mcpServers` JSON family as claude,
    // so it takes the same entry shape (§ 3.12 pins the other five).
    case 'cursor':
      return { type: 'stdio', command: 'jev-browser-wingman', args: ['mcp'], env: {} };
    case 'codex':
      return { command: 'jev-browser-wingman', args: ['mcp'], tool_timeout_sec: 90 };
    case 'opencode':
      return { type: 'local', command: ['jev-browser-wingman', 'mcp'], enabled: true };
    case 'agy':
      return { command: 'jev-browser-wingman', args: ['mcp'], disabled: false };
    case 'devin':
      return { command: 'jev-browser-wingman', args: ['mcp'], transport: 'stdio' };
  }
}
