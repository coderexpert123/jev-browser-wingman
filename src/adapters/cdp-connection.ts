// WP-D2: raw CDP connection over the global WebSocket.
// `wsEndpointFrom` resolves an HTTP debug endpoint to the browser websocket;
// `CdpConnection` multiplexes commands and events over it, with a bounded
// command timeout (default 10 s) that rejects as `cdp timeout: <method>`, and
// rejects every pending command when the socket closes.

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (params: any, sessionId?: string) => void;

export async function wsEndpointFrom(endpoint: string): Promise<string> {
  if (/^wss?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  const url = new URL('/json/version', endpoint).toString();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`cdp: /json/version returned ${res.status}`);
  }
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) {
    throw new Error('cdp: /json/version had no webSocketDebuggerUrl');
  }
  return body.webSocketDebuggerUrl;
}

export class CdpConnection {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingEntry>();
  private listeners = new Map<string, EventHandler[]>();
  private closed = false;

  static async connect(endpoint: string, opts?: { timeoutMs?: number }): Promise<CdpConnection> {
    const wsUrl = await wsEndpointFrom(endpoint);
    const timeoutMs = opts?.timeoutMs ?? 5_000;
    const conn = new CdpConnection();
    const ws = new WebSocket(wsUrl);
    conn.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // already closed
        }
        reject(new Error('cdp connect timeout'));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('cdp websocket error'));
        },
        { once: true },
      );
    });
    ws.addEventListener('message', (ev) => conn.onMessage(ev));
    ws.addEventListener('close', () => conn.onSocketClose());
    return conn;
  }

  private onMessage(ev: MessageEvent): void {
    let msg: { id?: number; error?: unknown; result?: unknown; method?: string; params?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error !== undefined) {
        entry.reject(new Error(JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const handler of [...handlers]) {
          handler(msg.params, msg.sessionId);
        }
      }
    }
  }

  private onSocketClose(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error('cdp socket closed'));
    }
  }

  send<T = any>(method: string, params?: object, sessionId?: string, timeoutMs: number = 10_000): Promise<T> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('cdp socket closed'));
    }
    const id = ++this.nextId;
    const payload: Record<string, unknown> = { id, method, params: params ?? {} };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      try {
        this.ws?.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(method: string, fn: EventHandler): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
    return () => {
      const current = this.listeners.get(method);
      if (current) {
        this.listeners.set(
          method,
          current.filter((candidate) => candidate !== fn),
        );
      }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    this.onSocketClose();
  }
}
