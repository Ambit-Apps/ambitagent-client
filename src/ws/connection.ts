import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { arch as osArch, platform as osPlatform } from 'node:os';
import type {
  RuntimeToAdmin,
  AdminToRuntime,
  HeartbeatMessage,
} from '../protocol/ws.js';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';

/**
 * Outbound-only WebSocket connection to the admin control plane.
 *
 * Runs a lifecycle: connect → send hello → heartbeat loop → receive
 * admin messages. On any disconnect (clean or dirty), reconnects with
 * exponential backoff bounded by config.reconnectMaxDelayMs. The only
 * way this stops trying is `stop()` — which is called from the
 * SIGTERM handler in main.ts.
 *
 * Emits: `message` (parsed AdminToRuntime), `state` (connected/etc).
 * `error`s are swallowed and logged — reconnect handles them.
 */

type State = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface Connection {
  start(): void;
  stop(): Promise<void>;
  send(msg: RuntimeToAdmin): void;
  on(event: 'message', listener: (msg: AdminToRuntime) => void): void;
  on(event: 'state', listener: (s: State) => void): void;
}

function parseAdminMessage(raw: string): AdminToRuntime | null {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== 'object') return null;
    switch (msg.type) {
      case 'run_task':
      case 'cancel':
      case 'update_now':
        return msg as AdminToRuntime;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function createConnection(config: Config, log: Logger): Connection {
  const events = new EventEmitter();
  let ws: WebSocket | null = null;
  let state: State = 'idle';
  let reconnectDelay = config.reconnectMinDelayMs;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let activeRuns = 0;

  const setState = (next: State) => {
    if (state === next) return;
    state = next;
    log.info({ state: next }, 'connection state');
    events.emit('state', next);
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      const beat: HeartbeatMessage = {
        type: 'heartbeat',
        runtimeId: config.runtimeId,
        ts: Date.now(),
        activeRuns,
      };
      sendRaw(beat);
    }, config.heartbeatIntervalMs);
  };

  const sendRaw = (msg: RuntimeToAdmin): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.warn({ type: msg.type }, 'dropping message — socket not open');
      return;
    }
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'send failed');
    }
  };

  const scheduleReconnect = () => {
    if (state === 'stopped') return;
    setState('reconnecting');
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, config.reconnectMaxDelayMs);
    log.info({ delayMs: delay }, 'scheduling reconnect');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (state === 'stopped') return;
    setState('connecting');

    ws = new WebSocket(config.wsUrl, {
      headers: { Authorization: `Bearer ${config.enrollmentToken}` },
    });

    ws.on('open', () => {
      setState('connected');
      reconnectDelay = config.reconnectMinDelayMs;

      const hello: RuntimeToAdmin = {
        type: 'hello',
        runtimeId: config.runtimeId,
        version: config.version,
        os: osPlatform(),
        arch: osArch(),
        // chromeVersion filled in once Playwright is wired.
      };
      sendRaw(hello);
      startHeartbeat();
    });

    ws.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      const msg = parseAdminMessage(text);
      if (!msg) {
        log.warn({ text }, 'unparseable admin message');
        return;
      }
      log.info({ type: msg.type }, 'admin message');
      events.emit('message', msg);
    });

    ws.on('close', (code, reason) => {
      stopHeartbeat();
      const reasonText = reason?.toString('utf8') ?? '';
      log.info({ code, reason: reasonText }, 'socket closed');
      ws = null;

      // Fatal close codes (auth failures, etc.) — retry doesn't help.
      // The admin returns 4401 for a bad enrollment token, and the OS
      // wants us to notice and get help rather than pound the endpoint.
      if (code === 4401) {
        log.error({ code, reason: reasonText },
          'authentication rejected — check ENROLLMENT_TOKEN. Not retrying.');
        setState('stopped');
        return;
      }

      scheduleReconnect();
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'socket error');
      // 'close' fires after 'error' — reconnect happens there.
    });
  };

  const conn: Connection = {
    start() {
      if (state !== 'idle') return;
      log.info({ url: config.wsUrl }, 'starting connection');
      connect();
    },
    async stop() {
      setState('stopped');
      stopHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close(1000, 'shutdown');
        } catch {}
        ws = null;
      }
    },
    send(msg: RuntimeToAdmin) {
      sendRaw(msg);
    },
    on(event: 'message' | 'state', listener: (arg: never) => void) {
      // Emitter typing gets clunky with overloads — the Connection
      // interface above is the type contract; the emitter just fans
      // events through.
      events.on(event, listener as (...args: unknown[]) => void);
    },
  };

  return conn;
}
