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

export interface ClaudeRunResult {
  exitCode: number | null;
  killed: boolean;
  wallMs: number;
  browserToolCalls: number;
  usage: ClaudeUsage | null;
  cliReportedUsd: number | null;
  // WP-F F4: every tool_use block tallied by its full name (§ 6 WP-F F3/F4).
  toolUseCounts: Record<string, number>;
}

const BROWSER_TOOL_PREFIXES = ['mcp__playwright__', 'mcp__jev-browser-wingman__'];

function isBrowserTool(name: unknown): name is string {
  return typeof name === 'string' && BROWSER_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

interface StreamEvent {
  type?: string;
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
  const argv = [
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
      tallyToolUse(ev, toolUseCounts);
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
  };
}
