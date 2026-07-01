import type {
  RunTaskMessage,
  RunEventMessage,
} from '../protocol/ws.js';
import type { Logger } from '../log.js';

/**
 * Phase 0 stub executor.
 *
 * Ignores the actual script body and just emits:
 *   started -> log("hello from echo agent") -> completed
 *
 * When Playwright wiring lands (with the task-runs work on the admin
 * side already complete), this file gets replaced with a real
 * evaluator that:
 *   - loads the script body into a sandboxed module
 *   - hands it a `ctx` object (Playwright page, ctx.reportProgress,
 *     ctx.uploadScreenshot, ctx.ai.complete)
 *   - awaits its result
 *   - emits per-step events during execution
 */

export interface Executor {
  runTask(msg: RunTaskMessage, emit: (event: RunEventMessage) => void): Promise<void>;
}

const nowTs = () => Date.now();

export function createEchoExecutor(log: Logger): Executor {
  return {
    async runTask(msg, emit) {
      log.info({ runId: msg.runId, taskDefinitionId: msg.taskDefinitionId }, 'echo executor: run');

      emit({
        type: 'run_event',
        runId: msg.runId,
        kind: 'started',
        ts: nowTs(),
        payload: { message: 'echo executor starting' },
      });

      await sleep(200);

      emit({
        type: 'run_event',
        runId: msg.runId,
        kind: 'log',
        ts: nowTs(),
        payload: { message: 'hello from echo agent', inputs: msg.inputs },
      });

      await sleep(200);

      emit({
        type: 'run_event',
        runId: msg.runId,
        kind: 'completed',
        ts: nowTs(),
        payload: {
          message: 'echo executor done',
          outputs: { echoed_inputs: msg.inputs, script_length: msg.script.length },
        },
      });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
