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
  | 'screenshot' // legacy — prefer `artifact` for new work
  | 'log'
  | 'artifact'   // generic file the script produced (CSV, PNG, PDF, JSON…)
  | 'error'
  | 'completed';

/**
 * Payload for `run_event` with kind='artifact'. The runtime base64-
 * encodes the bytes (our WS carries text only) and the admin writes
 * them straight into `task_run_artifacts`. Keeping the type here so
 * the wire contract == the compile-time contract on both sides.
 */
export interface ArtifactPayload {
  name: string;
  mime_type: string;
  size_bytes: number;
  contents_b64: string;
  /** Optional label — used for screenshots to indicate the moment captured. */
  label?: string;
}

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
   * The task definition's full file bundle — one entry per file with a
   * bundle-relative path (e.g. "src/main.ts", "_lib/lib-common/src/csv.ts").
   * The runtime reassembles these into a working module graph and
   * executes "src/main.ts" as the entry point.
   */
  files: RunTaskFile[];
  inputs: unknown;
  /**
   * Decrypted credential bundles the script can read via
   * `ctx.credentials(slug)`. Keyed by slug. The admin decrypts server-
   * side (it holds the key) and sends plaintext over TLS WSS — the
   * runtime never touches the credential vault directly.
   */
  credentials?: Record<string, Record<string, string>>;
  /** @deprecated use `credentials` — kept temporarily for compat. */
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
