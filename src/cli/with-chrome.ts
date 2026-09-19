// WP-F2: `with-chrome` (§ 3.14, decision 2 / C23). Wraps another MCP stdio
// command; the child always carries PLAYWRIGHT_MCP_CDP_ENDPOINT. Without a
// preset endpoint the wrapper proxies the child and ensures the shared Chrome
// lazily, just before the first tools/call is forwarded — never at start-up.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import { wingmanHome } from '../contract/home.js';
import type { WindowMode } from '../contract/types.js';
import { ensureChrome, probeVersion, quoteCmdLine } from '../browser/chrome.js';

export interface WithChromeDeps {
  env?: NodeJS.ProcessEnv;
  loadConfigFn?: typeof loadConfig;
  ensureChromeFn?: typeof ensureChrome;
  probeVersionFn?: typeof probeVersion;
  spawnFn?: (command: string, args: string[], opts: Record<string, unknown>) => ChildProcess;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

interface ProxyTarget {
  port: number;
  profileDir: string;
  chromePath: string | null;
  home: string;
  window: WindowMode;
}

/** The id of a gated line: a JSON object with method "tools/call", or an array containing one. */
function gatedCallId(parsed: unknown): { gated: false } | { gated: true; id?: string | number; batch: boolean } {
  if (Array.isArray(parsed)) {
    const hasCall = parsed.some(
      (m) => m && typeof m === 'object' && !Array.isArray(m) && (m as Record<string, unknown>).method === 'tools/call',
    );
    return hasCall ? { gated: true, batch: true } : { gated: false };
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (o.method === 'tools/call') {
      const id = o.id;
      if (typeof id === 'string' || typeof id === 'number') return { gated: true, id, batch: false };
      return { gated: true, batch: false };
    }
  }
  return { gated: false };
}

export async function runWithChrome(argv: string[], deps: WithChromeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  if (argv.length === 0) {
    stderr.write('usage: jev-browser-wingman with-chrome -- <command> [args...]\n');
    return 2;
  }

  // Endpoint order (§ Browser acquisition): WINGMAN_CDP_ENDPOINT, then
  // PLAYWRIGHT_MCP_CDP_ENDPOINT; the proxy branch derives one from the config.
  const preset = env.WINGMAN_CDP_ENDPOINT || env.PLAYWRIGHT_MCP_CDP_ENDPOINT || null;
  let endpoint: string;
  let proxy: ProxyTarget | null = null;
  if (preset) {
    endpoint = preset;
  } else {
    const loaded = await (deps.loadConfigFn ?? loadConfig)(env);
    if (!loaded.ok) {
      stderr.write(`jev-browser-wingman with-chrome: config: ${loaded.error}\n`);
      return 1;
    }
    const config = loaded.config;
    endpoint = `http://127.0.0.1:${config.port}`;
    proxy = {
      port: config.port,
      profileDir: config.profile_dir,
      chromePath: config.chrome_path,
      home: wingmanHome(env),
      window: config.window,
    };
  }

  const childArgv = argv.map((a) => (a.includes('{cdp}') ? a.split('{cdp}').join(endpoint) : a));
  const childEnv: NodeJS.ProcessEnv = { ...env, PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint };

  const spawnFn = deps.spawnFn ?? ((command: string, args: string[], opts: Record<string, unknown>) => nodeSpawn(command, args, opts as never));
  let child: ChildProcess;
  if (process.platform === 'win32') {
    const comspec = env.ComSpec ?? 'cmd.exe';
    const cmdArg = '"' + quoteCmdLine(childArgv) + '"';
    child = spawnFn(comspec, ['/d', '/s', '/c', cmdArg], {
      stdio: proxy ? ['pipe', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: childEnv,
    });
  } else {
    child = spawnFn(childArgv[0], childArgv.slice(1), {
      stdio: proxy ? ['pipe', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
      env: childEnv,
    });
  }

  const forwardSignals = (signal: 'SIGINT' | 'SIGTERM'): void => {
    const handler = (): void => {
      child.kill(signal);
    };
    process.on(signal, handler);
  };
  forwardSignals('SIGINT');
  forwardSignals('SIGTERM');

  if (!proxy) {
    // Preset endpoint: the child talks protocol over inherited stdio directly.
    return await exitCodeOf(child);
  }

  // ---- proxy branch (§ 3.14) ----

  // Child stdout is forwarded in complete lines; the proxy's own error lines
  // go only between complete child lines (never inside one).
  let childBuf = '';
  const proxyQueue: string[] = [];
  const flushProxyQueue = (): void => {
    while (childBuf === '' && proxyQueue.length > 0) {
      stdout.write(proxyQueue.shift()!);
    }
  };
  const writeProxyLine = (line: string): void => {
    const payload = line + '\n';
    if (childBuf === '') {
      stdout.write(payload);
      flushProxyQueue();
    } else {
      proxyQueue.push(payload);
    }
  };
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    childBuf += chunk;
    let idx: number;
    while ((idx = childBuf.indexOf('\n')) !== -1) {
      const line = childBuf.slice(0, idx + 1);
      childBuf = childBuf.slice(idx + 1);
      stdout.write(line);
      flushProxyQueue();
    }
  });
  child.stdout!.on('end', () => {
    // The unterminated remainder is flushed when the child's stdout ends.
    if (childBuf !== '') {
      stdout.write(childBuf);
      childBuf = '';
    }
    flushProxyQueue();
  });

  // Lazy ensure state: one successful ensure marks the process; after that a
  // null probe re-arms it (the browser may have been stopped in between).
  let ensuredOnce = false;
  let lastEnsureError = 'Chrome could not be started';
  const ensureChromeFn = deps.ensureChromeFn ?? ensureChrome;
  const probeVersionFn = deps.probeVersionFn ?? probeVersion;
  const ensureIfNeeded = async (): Promise<boolean> => {
    if (ensuredOnce) {
      const answer = await probeVersionFn(proxy.port, 1500);
      if (answer !== null) return true;
    }
    const result = await ensureChromeFn(
      {
        port: proxy.port,
        profileDir: proxy.profileDir,
        chromePath: proxy.chromePath,
        home: proxy.home,
        window: proxy.window,
      },
    );
    if (result.ok) {
      ensuredOnce = true;
      return true;
    }
    lastEnsureError = result.message;
    return false;
  };

  // Every client line queues behind the previous one, in order; a gated line
  // holds the queue while its ensure runs.
  let chain: Promise<void> = Promise.resolve();
  const forward = (line: string): void => {
    child.stdin!.write(line + '\n');
  };
  const handleLine = async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const gate = gatedCallId(parsed);
    if (!gate.gated) {
      forward(line);
      return;
    }
    const ok = await ensureIfNeeded();
    if (ok || gate.batch) {
      // A failed gated array line is forwarded unchanged (a batch cannot be
      // answered piecemeal).
      forward(line);
      return;
    }
    writeProxyLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: gate.id ?? null,
        result: { content: [{ type: 'text', text: `jev-browser-wingman with-chrome: ${lastEnsureError}` }], isError: true },
      }),
    );
  };

  let stdinBuf = '';
  const feed = (chunk: string): void => {
    stdinBuf += chunk;
    let idx: number;
    while ((idx = stdinBuf.indexOf('\n')) !== -1) {
      let line = stdinBuf.slice(0, idx);
      stdinBuf = stdinBuf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const pending = chain.then(() => handleLine(line));
      chain = pending.catch(() => {});
    }
  };
  stdin.setEncoding('utf8');
  stdin.on('data', feed);
  stdin.on('end', () => {
    child.stdin!.end();
  });
  // An open stdin (a host or test harness holding the pipe) must not keep
  // this process alive once the child has exited.
  (stdin as unknown as { unref?: () => void }).unref?.();

  const code = await exitCodeOf(child);
  // Drain: the stdout handler flushes the remainder on 'end', which precedes
  // 'close'; give the error-line queue a final chance.
  flushProxyQueue();
  return code;
}

function exitCodeOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}
