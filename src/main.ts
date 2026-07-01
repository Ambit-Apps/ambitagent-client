#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createConnection } from './ws/connection.js';
import { createEchoExecutor } from './runner/executor.js';
import type { AdminToRuntime } from './protocol/ws.js';

/**
 * Daemon entry. Loads config, opens the outbound WebSocket, and hangs
 * around receiving admin messages.
 *
 * Execution of `run_task` is stubbed for Phase 0 — the admin logs the
 * message and we log it here. Real Playwright execution lands with
 * the task_runs work.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  log.info(
    {
      adminUrl: config.adminUrl,
      wsUrl: config.wsUrl,
      runtimeId: config.runtimeId,
      version: config.version,
    },
    'ambit-agent starting',
  );

  const conn = createConnection(config, log);
  const executor = createEchoExecutor(log);

  conn.on('message', (msg: AdminToRuntime) => {
    switch (msg.type) {
      case 'run_task':
        // Fire and forget — the executor emits events back via
        // conn.send(). Failures inside the executor are caught here
        // and surfaced as an `error` event so the admin doesn't have
        // an orphan `dispatched` run.
        executor
          .runTask(msg, (event) => conn.send(event))
          .catch((err: Error) => {
            log.error({ runId: msg.runId, err: err.message }, 'executor threw');
            conn.send({
              type: 'run_event',
              runId: msg.runId,
              kind: 'error',
              ts: Date.now(),
              payload: { message: err.message, stack: err.stack },
            });
          });
        return;
      case 'cancel':
        log.info({ runId: msg.runId }, 'cancel received (cancellation not wired yet)');
        return;
      case 'update_now':
        log.info({ releaseId: msg.releaseId }, 'update_now received (updater not wired yet)');
        return;
    }
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    await conn.stop();
    // Give in-flight logs a tick to flush, then exit.
    setTimeout(() => process.exit(0), 100);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  conn.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
