#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createConnection } from './ws/connection.js';
import { createRealExecutor, CancelledError } from './runner/executor.js';
import { startChromeManager } from './chrome/manager.js';
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

  // A long-lived daemon must never die from a stray async error. Seen in
  // the wild: Playwright's dialog auto-dismiss racing a beforeunload
  // prompt in the managed Chrome ("Page.handleJavaScriptDialog: No
  // dialog is showing") — an unhandled rejection from deep inside
  // playwright-core that took the whole process (and its in-flight run)
  // down. Log loudly and keep serving; per-run failures are already
  // caught and reported through the executor's own error path.
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error({ err: err.message, stack: err.stack }, 'unhandled rejection (daemon continuing)');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'uncaught exception (daemon continuing)');
  });

  log.info(
    {
      adminUrl: config.adminUrl,
      wsUrl: config.wsUrl,
      runtimeId: config.runtimeId,
      version: config.version,
    },
    'ambit-agent starting',
  );

  // Bring up the managed Chrome first — Phase 2 of the browser-model
  // rollout. When enabled (default on customer machines), the daemon
  // launches its own dedicated Chrome in the background and passes the
  // CDP URL to the executor. Attach-mode agents connect there without
  // any env-var gymnastics. Headless server VMs with only api-type
  // agents set AMBIT_CHROME_ENABLED=false and skip this.
  const chrome = startChromeManager(config, log);

  const conn = createConnection(config, log);
  const executor = createRealExecutor(log, {
    adminUrl: config.adminUrl,
    enrollmentToken: config.enrollmentToken,
    chrome,
  });

  // Live cancellation registry — one AbortController per in-flight run.
  // main.ts owns this because cancel messages arrive at the WS layer,
  // not inside the executor. Registered on run_task, aborted on cancel,
  // deleted in the executor's finally so late cancels for finished runs
  // are safely ignored (map miss = "run already gone").
  const activeRuns = new Map<string, AbortController>();

  conn.on('message', (msg: AdminToRuntime) => {
    switch (msg.type) {
      case 'run_task': {
        // Fire and forget — the executor emits events back via
        // conn.send(). Failures inside the executor are caught here
        // and surfaced as an `error` event so the admin doesn't have
        // an orphan `dispatched` run.
        const ac = new AbortController();
        activeRuns.set(msg.runId, ac);
        executor
          .runTask(msg, (event) => conn.send(event), ac.signal)
          .catch((err: Error) => {
            log.error({ runId: msg.runId, err: err.message }, 'executor threw');
            conn.send({
              type: 'run_event',
              runId: msg.runId,
              kind: 'error',
              ts: Date.now(),
              payload: { message: err.message, stack: err.stack },
            });
          })
          .finally(() => {
            activeRuns.delete(msg.runId);
          });
        return;
      }
      case 'cancel': {
        const ac = activeRuns.get(msg.runId);
        if (!ac) {
          // Common: cancel arrives after the run finished on its own
          // (or was never received here). No-op, no error — admin's
          // authoritative status is already `cancelled`/`failed`.
          log.info({ runId: msg.runId }, 'cancel: run not active — ignoring');
          return;
        }
        log.info({ runId: msg.runId }, 'cancel received — aborting run');
        ac.abort(new CancelledError('cancelled by admin'));
        return;
      }
      case 'update_now':
        log.info({ releaseId: msg.releaseId }, 'update_now received (updater not wired yet)');
        return;
    }
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    await conn.stop();
    // Kill the managed Chrome we launched so it doesn't outlive the
    // daemon. If the operator was running their own Chrome via
    // AMBIT_ATTACH_CDP, the manager is a no-op and this is a no-op too.
    await chrome.stop();
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
