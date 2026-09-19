// WP-H: one headless `claude -p` benchmark run.
// Spawns the CLI in stream-json mode, counts browser tool_use blocks, and
// reads the usage and cost from the final `result` event. A run that
// outlives timeoutMs has its process tree killed and is reported as killed.

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

export async function runClaude(a: {
  prompt: string;
  mcpConfigPath: string;
  allowedTools: string[];
  model: string;
  maxTurns: number;
  timeoutMs: number;
  cwd: string;
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
      detached: true,
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
  };
}
