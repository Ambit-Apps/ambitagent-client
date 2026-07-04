/**
 * WebSocket protocol — VENDORED COPY of
 * `ambitagent-admin/packages/shared-protocol/src/ws.ts`.
 *
 * Kept in sync by hand while the protocol churns. Before Phase 1 we
 * either extract shared-protocol to its own git repo (submodule here)
 * or publish it as a private npm package. Whichever we pick, delete
 * this file at that point.
 *
 * If you change one side without the other, the runtime accepts the
 * old shape but the admin will discard messages as unparseable.
 */

// Runtime → Admin messages
export type RuntimeToAdmin =
  | HelloMessage
  | HeartbeatMessage
  | RunEventMessage;

export interface HelloMessage {
  type: 'hello';
  runtimeId: string;
  version: string;
  os: string;
  arch: string;
  chromeVersion?: string;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  runtimeId: string;
  ts: number;
  activeRuns: number;
  cpuPercent?: number;
  ramMb?: number;
}

export interface RunEventMessage {
  type: 'run_event';
  runId: string;
  kind: RunEventKind;
  ts: number;
  payload: unknown;
}

export type RunEventKind =
  | 'started'
  | 'progress'
  | 'screenshot'
  | 'log'
  | 'error'
  | 'completed';

// Admin → Runtime messages
export type AdminToRuntime =
  | RunTaskMessage
  | CancelMessage
  | UpdateNowMessage;

export interface RunTaskMessage {
  type: 'run_task';
  runId: string;
  taskDefinitionId: string;
  /**
   * Full file bundle of the task definition. One entry per file, with
   * a bundle-relative path (e.g. "src/main.ts", "_lib/lib-common/src/csv.ts").
   * Runtime reassembles into a working module graph, then executes
   * "src/main.ts" as the entry point.
   */
  files: RunTaskFile[];
  inputs: unknown;
  credentialBundleId?: string;
}

export interface RunTaskFile {
  path: string;
  contents: string;
}

export interface CancelMessage {
  type: 'cancel';
  runId: string;
}

export interface UpdateNowMessage {
  type: 'update_now';
  releaseId: string;
}
