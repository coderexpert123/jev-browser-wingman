// WP-H: one headless `claude -p` benchmark run.
// Spawns the CLI in stream-json mode, counts browser tool_use blocks, and
// reads the usage and cost from the final `result` event. A run that
// outlives timeoutMs has its process tree killed and is reported as killed.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { quoteCmdLine } from '../src/browser/chrome.js';
import { killTree } from '../src/browser/process-list.js';

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeInit {
  claude_code_version: string | null;
  model: string | null;
}

export interface ClaudeRunResult {
  exitCode: number | null;
  killed: boolean;
  wallMs: number;
  browserToolCalls: number;
  usage: ClaudeUsage | null;
  cliReportedUsd: number | null;
  // WP-F F4: every tool_use block tallied by its full name (§ 6 WP-F F3/F4).
  toolUseCounts: Record<string, number>;
  // r24b (O4): the system/init event; null when none arrived
  init: ClaudeInit | null;
  // r24b (O7): the init event's names (plus the SessionStart-class hooks that preceded it); null when none arrived
  lists: CallerLists | null;
}

const BROWSER_TOOL_PREFIXES = ['mcp__playwright__', 'mcp__jev-browser-wingman__'];

function isBrowserTool(name: unknown): name is string {
  return typeof name === 'string' && BROWSER_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  model?: unknown;
  claude_code_version?: unknown;
  hook_name?: unknown;
  tools?: unknown;
  skills?: unknown;
  agents?: unknown;
  plugins?: unknown;
  mcp_servers?: unknown;
  message?: { content?: Array<{ type?: string; name?: string }> };
  usage?: ClaudeUsage;
  total_cost_usd?: unknown;
}

// WP-F F4: pure tally of one stream-json event's tool_use blocks, by full
// name, into `counts`. Ignores every other event shape (result, non-object,
// null, malformed content).
export function tallyToolUse(event: unknown, counts: Record<string, number>): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as StreamEvent;
  if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return;
  for (const block of ev.message.content) {
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      counts[block.name] = (counts[block.name] ?? 0) + 1;
    }
  }
}

/** r24b: the exact argv `runClaude` passes to `claude` (the bench hashes it: spec section 3.2 caller_argv_sha256). */
export function claudeArgv(a: { prompt: string; mcpConfigPath: string; allowedTools: string[]; model: string; maxTurns: number }): string[] {
  return [
    '-p',
    a.prompt,
    '--model',
    a.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(a.maxTurns),
    '--mcp-config',
    a.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    ...a.allowedTools,
  ];
}

/** r24b (O7): the names the caller CLI reports about itself in its `system`/`init` event, plus the hooks that fired before it.
 * Names only (plugins as name@version, MCP servers as name:status): no path, no description, no content. */
export interface CallerLists {
  tools: string[];
  skills: string[];
  plugins: string[];
  agents: string[];
  mcp_servers: string[];
  hooks: string[];
}

/** The five init-event lists (hooks stay empty here: they come from the earlier hook events). Null for any other event. */
export function listsFromInit(event: unknown): CallerLists | null {
  if (!event || typeof event !== 'object') return null;
  const ev = event as StreamEvent;
  if (ev.type !== 'system' || ev.subtype !== 'init') return null;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const objs = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object') : [];
  return {
    tools: strs(ev.tools),
    skills: strs(ev.skills),
    agents: strs(ev.agents),
    plugins: objs(ev.plugins).flatMap((p) =>
      typeof p.name === 'string' ? [typeof p.version === 'string' && p.version !== '' ? `${p.name}@${p.version}` : p.name] : [],
    ),
    mcp_servers: objs(ev.mcp_servers).flatMap((m) =>
      typeof m.name === 'string' ? [typeof m.status === 'string' ? `${m.name}:${m.status}` : m.name] : [],
    ),
    hooks: [],
  };
}

/** The hook name of a `system`/`hook_started` event; null for any other event. */
export function hookNameFromEvent(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const ev = event as StreamEvent;
  return ev.type === 'system' && ev.subtype === 'hook_started' && typeof ev.hook_name === 'string' && ev.hook_name !== '' ? ev.hook_name : null;
}

/** r24b (O4): the caller's resolved identity from the stream's `system`/`init` event (the 2026-09-29 bench transcript's
 * init event carried claude_code_version '2.1.284' and model 'swe-2-max' for a run launched with --model sonnet).
 * Null for any other event; a non-string or empty field reads null. */
export function initFromEvent(event: unknown): ClaudeInit | null {
  if (!event || typeof event !== 'object') return null;
  const ev = event as StreamEvent;
  if (ev.type !== 'system' || ev.subtype !== 'init') return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return { claude_code_version: str(ev.claude_code_version), model: str(ev.model) };
}

export async function runClaude(a: {
  prompt: string;
  mcpConfigPath: string;
  allowedTools: string[];
  model: string;
  maxTurns: number;
  timeoutMs: number;
  cwd: string;
  // A/B rerun (2026-09-26, harness-only instrumentation for the per-handoff
  // breakdown; WP-F F1): when set, every raw stream-json line is appended
  // here verbatim, so a later pass can join tool_use/tool_result pairs for
  // the browser MCP tools. Optional and additive; omitted callers see no
  // change. It stays uncommitted output (never checked in by a builder).
  transcriptPath?: string;
}): Promise<ClaudeRunResult> {
  const argv = claudeArgv(a);

  let child;
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    const cmdArg = '"claude ' + quoteCmdLine(argv) + '"';
    child = spawn(comspec, ['/d', '/s', '/c', cmdArg], {
      cwd: a.cwd,
      // Not detached: on win32 a detached cmd re-homes the grandchild CLI's
      // output on a fresh console and the stream-json pipe stays empty
      // (observed 2026-09-20: 0 stdout bytes while the run completed fine).
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn('claude', argv, {
      cwd: a.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  const started = Date.now();
  let killed = false;
  let browserToolCalls = 0;
  let usage: ClaudeUsage | null = null;
  let cliReportedUsd: number | null = null;
  let init: ClaudeInit | null = null;
  let lists: CallerLists | null = null;
  const hooks: string[] = [];
  let stdoutText = '';
  const toolUseCounts: Record<string, number> = {};

  const killTimer = setTimeout(() => {
    killed = true;
    if (child.pid) {
      void killTree(child.pid).catch(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      });
    }
  }, a.timeoutMs);

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutText += chunk;
    let idx: number;
    while ((idx = stdoutText.indexOf('\n')) !== -1) {
      const line = stdoutText.slice(0, idx);
      stdoutText = stdoutText.slice(idx + 1);
      if (!line.trim()) continue;
      if (a.transcriptPath) {
        try {
          fs.appendFileSync(a.transcriptPath, line + '\n');
        } catch {
          // best-effort capture only
        }
      }
      let ev: StreamEvent;
      try {
        ev = JSON.parse(line) as StreamEvent;
      } catch {
        continue;
      }
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block?.type === 'tool_use' && isBrowserTool(block.name)) browserToolCalls += 1;
        }
      }
      if (init === null) {
        const h = hookNameFromEvent(ev);
        if (h !== null && !hooks.includes(h)) hooks.push(h);
      }
      tallyToolUse(ev, toolUseCounts);
      if (init === null) {
        init = initFromEvent(ev);
        if (init !== null) {
          const l = listsFromInit(ev);
          if (l !== null) lists = { ...l, hooks: [...hooks] };
        }
      }
      if (ev.type === 'result') {
        usage = ev.usage ?? null;
        cliReportedUsd = typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null;
      }
    }
  });

  const exitCode: number | null = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });

  clearTimeout(killTimer);
  return {
    exitCode,
    killed,
    wallMs: Date.now() - started,
    browserToolCalls,
    usage,
    cliReportedUsd,
    toolUseCounts,
    init,
    lists,
  };
}
