import { register } from 'tsx/esm/api';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';

import type {
  RunTaskMessage,
  RunEventMessage,
} from '../protocol/ws.js';
import type { Logger } from '../log.js';
import { launchBrowser } from './browser.js';

/**
 * Real executor — mirrors `apps/api/src/worker.ts` on the admin side,
 * with Playwright injected for browser-type runs.
 *
 * The pipeline per run_task:
 *   1. Reassemble the file bundle into a temp dir (fresh per run so
 *      concurrent runs don't collide).
 *   2. Drop a `type: module` package.json at the root — without it,
 *      newer Node (22.12+) treats main.ts as CJS via tsx's loader and
 *      throws ERR_REQUIRE_CYCLE_MODULE on ESM imports. Same fix we
 *      landed on the API worker side.
 *   3. For each bundled @ambit/* library under `_lib/`, generate a
 *      minimal package.json and symlink it into node_modules/@ambit/
 *      so imports resolve.
 *   4. Launch Playwright (browser-type only). tsx register() hooks
 *      the .ts loader before we dynamic-import main.ts.
 *   5. Build a `ctx` mirroring dev-runner's local ctx but with sinks
 *      wired to WebSocket events instead of console.log.
 *   6. Await mod.run(inputs, ctx). Emit `completed` with outputs on
 *      success, `error` on throw. Always clean up in `finally`.
 */

// tsx must be registered before any dynamic .ts import.
register();

export interface Executor {
  runTask(msg: RunTaskMessage, emit: (event: RunEventMessage) => void): Promise<void>;
}

export interface ExecutorConfig {
  /** Base URL of the admin API — used for the ctx.ai.complete proxy. */
  adminUrl: string;
  /** Sent as `Authorization: Bearer <token>` on proxy calls. */
  enrollmentToken: string;
}

const nowTs = () => Date.now();

export function createRealExecutor(log: Logger, config: ExecutorConfig): Executor {
  return {
    async runTask(msg, emit) {
      log.info(
        { runId: msg.runId, taskDefinitionId: msg.taskDefinitionId, fileCount: msg.files.length },
        'executor: picked up run',
      );

      emit({
        type: 'run_event',
        runId: msg.runId,
        kind: 'started',
        ts: nowTs(),
        payload: { message: 'runtime picked up run' },
      });

      // Figure out shape upfront — a bundle without src/main.ts can't
      // be executed. Fail fast so we don't spin up a browser for
      // nothing.
      const hasMain = msg.files.some((f) => f.path === 'src/main.ts');
      if (!hasMain) {
        emit({
          type: 'run_event',
          runId: msg.runId,
          kind: 'error',
          ts: nowTs(),
          payload: { message: 'bundle is missing src/main.ts' },
        });
        return;
      }

      const tmpRoot = await mkdtemp(join(tmpdir(), `ambit-run-${msg.runId}-`));
      let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
      const isBrowserType = await bundleUsesPlaywright(msg);

      try {
        // 1) Write every file.
        for (const f of msg.files) {
          const dst = join(tmpRoot, f.path);
          await mkdir(dirname(dst), { recursive: true });
          await writeFile(dst, f.contents);
        }

        // 2) Bundle-root ESM marker.
        await writeFile(
          join(tmpRoot, 'package.json'),
          JSON.stringify({ name: `ambit-run-${msg.runId}`, version: '0.0.0', type: 'module' }, null, 2),
        );

        // 3) Symlink bundled @ambit/* libs into node_modules.
        const libRoot = join(tmpRoot, '_lib');
        const libs = await tryReadSubdirs(libRoot);
        if (libs.length > 0) {
          const nodeModulesAmbit = join(tmpRoot, 'node_modules', '@ambit');
          await mkdir(nodeModulesAmbit, { recursive: true });
          for (const pkg of libs) {
            const pkgDir = join(libRoot, pkg);
            await writeFile(
              join(pkgDir, 'package.json'),
              JSON.stringify(
                {
                  name: `@ambit/${pkg}`,
                  version: '0.0.0',
                  type: 'module',
                  main: './src/index.ts',
                  types: './src/index.ts',
                  exports: {
                    '.': { types: './src/index.ts', default: './src/index.ts' },
                  },
                },
                null,
                2,
              ),
            );
            await symlink(pkgDir, join(nodeModulesAmbit, pkg), 'dir');
          }
        }

        // 4) Browser? Launch it before importing the script — browser
        // scripts expect `ctx.page` to exist the moment they run.
        //
        // Default is head-full: customers on RDP-into-a-Ubuntu-VM or
        // laptop installs value seeing the browser do its thing —
        // it's the visible proof-of-work. Set HEADLESS=true on truly
        // headless server installs (no X server / no framebuffer).
        if (isBrowserType) {
          const headless = process.env.HEADLESS === 'true';
          // Persistent-profile opt-in: a bundle marks itself with the
          // `@ambit:persistent-profile` comment (e.g. vendoo-lister, so a
          // customer's Vendoo login survives across runs). Keyed per
          // runtime install — one customer per machine, so a single named
          // dir under ~/.ambit/profiles is already per-customer isolated.
          const persistentProfileDir = bundleWantsPersistentProfile(msg)
            ? join(homedir(), '.ambit', 'profiles', profileNameFor(msg))
            : undefined;
          if (persistentProfileDir) {
            await mkdir(persistentProfileDir, { recursive: true });
            log.info({ runId: msg.runId, persistentProfileDir }, 'launching with persistent profile');
          }
          browser = await launchBrowser({ headless, persistentProfileDir });
        }

        // 5) Dynamic-import the entry.
        const mainPath = join(tmpRoot, 'src', 'main.ts');
        const mainUrl = pathToFileURL(mainPath).href;
        const mod = (await import(mainUrl)) as { run?: unknown };
        if (typeof mod.run !== 'function') {
          throw new Error('main.ts does not export a run() function');
        }

        // 6) Build ctx + execute.
        const ctx = createRuntimeCtx({
          runId: msg.runId,
          inputs: msg.inputs,
          credentials: msg.credentials ?? {},
          page: browser?.page,
          emit,
          log,
          config,
        });

        const result = await (mod.run as (i: unknown, c: unknown) => Promise<unknown>)(
          msg.inputs ?? {},
          ctx,
        );

        emit({
          type: 'run_event',
          runId: msg.runId,
          kind: 'completed',
          ts: nowTs(),
          payload: { message: 'run completed', outputs: result },
        });
      } catch (err) {
        const e = err as Error;
        log.error({ runId: msg.runId, err: e.message, stack: e.stack }, 'run failed');
        emit({
          type: 'run_event',
          runId: msg.runId,
          kind: 'error',
          ts: nowTs(),
          payload: { message: e.message, stack: e.stack },
        });
      } finally {
        // AMBIT_KEEP_OPEN=1 leaves the browser up after the run (useful when
        // attached to a real Chrome so the operator can inspect the result).
        if (browser && process.env.AMBIT_KEEP_OPEN !== '1') {
          try { await browser.close(); } catch { /* ignore */ }
        }
        try {
          await rm(tmpRoot, { recursive: true, force: true });
        } catch {
          // Cleanup failure is not worth failing the run over.
        }
      }
    },
  };
}

/**
 * `ctx` handed to the script. Same shape as dev-runner's local ctx
 * — the whole point of the parity is that the same code works on
 * either side.
 */
function createRuntimeCtx({
  runId,
  inputs,
  credentials,
  page,
  emit,
  log,
  config,
}: {
  runId: string;
  inputs: unknown;
  credentials: Record<string, Record<string, string>>;
  page: Page | undefined;
  emit: (event: RunEventMessage) => void;
  log: Logger;
  config: ExecutorConfig;
}) {
  const uploadArtifact = (buf: Uint8Array, name: string, mimeType: string, label?: string) => {
    const b64 = Buffer.from(buf).toString('base64');
    emit({
      type: 'run_event',
      runId,
      kind: 'artifact',
      ts: nowTs(),
      payload: {
        name,
        mime_type: mimeType,
        size_bytes: buf.byteLength,
        contents_b64: b64,
        label,
      },
    });
    // The URL is minted server-side after insert; the runtime doesn't
    // know the artifact id. We return an opaque marker so the script
    // has *something* to log or return. The customer's run-detail page
    // is where the real download link appears.
    return `artifact:${name}`;
  };

  return {
    inputs: inputs ?? {},
    dryRun: false,

    credentials(id: string) {
      const bundle = credentials[id];
      if (!bundle) {
        emit({
          type: 'run_event',
          runId,
          kind: 'log',
          ts: nowTs(),
          payload: {
            message: `ctx.credentials("${id}"): not attached to this agent (returning empty bundle)`,
          },
        });
        return {};
      }
      return { ...bundle };
    },

    progress(msg: string) {
      emit({
        type: 'run_event',
        runId,
        kind: 'progress',
        ts: nowTs(),
        payload: { message: msg },
      });
    },

    log(msg: string, payload?: unknown) {
      const p =
        payload !== undefined && payload !== null && typeof payload === 'object'
          ? { message: msg, ...(payload as Record<string, unknown>) }
          : { message: msg, ...(payload !== undefined ? { value: payload } : {}) };
      emit({
        type: 'run_event',
        runId,
        kind: 'log',
        ts: nowTs(),
        payload: p,
      });
    },

    ai: {
      /**
       * Runtimes never hold AWS credentials. We POST to the admin's
       * `/rest/ai/proxy` endpoint (authed with our enrollment token)
       * and it forwards to Bedrock. The admin also accounts tokens
       * against the task_run and emits a `ctx.ai.complete` log event,
       * so nothing to do on this side beyond returning the text.
       */
      async complete(opts: {
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        maxTokens?: number;
        temperature?: number;
        model?: string;
      }): Promise<string> {
        if (!opts || !Array.isArray(opts.messages) || opts.messages.length === 0) {
          throw new Error('ctx.ai.complete: opts.messages is required and non-empty');
        }
        const url = `${config.adminUrl.replace(/\/$/, '')}/rest/ai/proxy`;
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.enrollmentToken}`,
            },
            body: JSON.stringify({
              runId,
              system:      opts.system,
              messages:    opts.messages,
              maxTokens:   opts.maxTokens,
              temperature: opts.temperature,
              model:       opts.model,
            }),
          });
        } catch (err) {
          throw new Error(`ctx.ai.complete: request to ${url} failed: ${(err as Error).message}`);
        }
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new Error(
            `ctx.ai.complete: admin returned ${res.status}: ${bodyText || res.statusText}`,
          );
        }
        const payload = (await res.json()) as { text?: string };
        if (typeof payload.text !== 'string') {
          throw new Error('ctx.ai.complete: admin response missing text');
        }
        return payload.text;
      },
    },

    async uploadFile(buf: Uint8Array, name: string, mimeType?: string): Promise<string> {
      const mime = mimeType ?? guessMime(name);
      return uploadArtifact(buf, name.slice(0, 255) || 'artifact.bin', mime.slice(0, 128));
    },

    // Input files the run was triggered with (e.g. the item photo the
    // vendoo-lister uploads into Vendoo). Backed by the admin's
    // enrollment-token-authed `/rest/runs/:runId/input-files/:key`.
    files: {
      async getFile(key: string): Promise<Uint8Array | null> {
        const res = await adminFetch(config, `/rest/runs/${runId}/input-files/${encodeURIComponent(key)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`ctx.files.getFile("${key}"): admin returned ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
      async getFileMeta(key: string) {
        const res = await adminFetch(config, `/rest/runs/${runId}/input-files/${encodeURIComponent(key)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`ctx.files.getFileMeta("${key}"): admin returned ${res.status}`);
        const buf = await res.arrayBuffer();
        return {
          name: res.headers.get('x-ambit-file-name') ?? key,
          mime_type: res.headers.get('content-type') ?? 'application/octet-stream',
          size_bytes: buf.byteLength,
        };
      },
    },

    // Listing-draft I/O — the cross-marketplace pipeline spine. REST to
    // the admin's runtime-authed endpoints.
    listing: {
      async create(input: {
        fields: unknown;
        status?: 'draft' | 'needs_review';
        photoArtifactKeys?: string[];
        sourceRunId?: number;
      }) {
        const res = await adminFetch(config, '/rest/listing-drafts/runtime', {
          method: 'POST',
          body: {
            fields: input.fields,
            status: input.status,
            photo_artifact_keys: input.photoArtifactKeys,
            source_run_id: input.sourceRunId ?? Number(runId),
          },
        });
        return unwrapDraft(res, 'create');
      },
      async get(id: number) {
        const res = await adminFetch(config, `/rest/listing-drafts/runtime/${id}`);
        return unwrapDraft(res, 'get');
      },
      async update(id: number, patch: unknown) {
        const res = await adminFetch(config, `/rest/listing-drafts/runtime/${id}`, {
          method: 'PATCH',
          body: patch,
        });
        return unwrapDraft(res, 'update');
      },
      async waitForConfirmation(id: number, opts?: { timeoutMs?: number; pollMs?: number }) {
        const timeoutMs = opts?.timeoutMs ?? 5 * 60_000;
        const pollMs = opts?.pollMs ?? 4_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const res = await adminFetch(config, `/rest/listing-drafts/runtime/${id}`);
          const draft = await unwrapDraft(res, 'waitForConfirmation');
          if (draft.status === 'confirmed') return draft;
          if (draft.status === 'failed' || draft.status === 'listed' || draft.status === 'listing') {
            throw new Error(`listing draft ${id} is ${draft.status}, not awaiting confirmation`);
          }
          if (Date.now() > deadline) {
            throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for draft ${id} to be confirmed`);
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
      },
    },

    // Browser-only surface. Undefined on api-type ctx.
    page,
    uploadScreenshot: page
      ? async (buf: Uint8Array, label: string): Promise<string> => {
          const safeLabel = String(label ?? 'screenshot').replace(/[^a-z0-9_-]+/gi, '-');
          return uploadArtifact(buf, `${safeLabel}.png`, 'image/png', safeLabel);
        }
      : undefined,
  };
}

async function tryReadSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Peek at the entry file for a `ctx.page` reference. Not perfect (a
 * script that renames `ctx` or reads page via bracket-notation slips
 * through), but good enough as a heuristic to avoid launching Chrome
 * for pure API-type scripts. Falls back to "browser" if unsure.
 *
 * Longer-term we should send `runtime_type` in the run_task message
 * so the runtime doesn't have to guess.
 */
async function bundleUsesPlaywright(msg: RunTaskMessage): Promise<boolean> {
  const main = msg.files.find((f) => f.path === 'src/main.ts');
  if (!main) return false;
  return /ctx\.page|ctx\.uploadScreenshot/.test(main.contents);
}

/**
 * Persistent-profile opt-in marker. A bundle whose entry file contains
 * `@ambit:persistent-profile` (optionally `@ambit:persistent-profile:NAME`)
 * launches with a reused userDataDir instead of a fresh one.
 *
 * SCAFFOLD: the durable mechanism is a manifest flag carried in the
 * `run_task` message; the marker keeps the runtime honest until then.
 */
function bundleWantsPersistentProfile(msg: RunTaskMessage): boolean {
  const main = msg.files.find((f) => f.path === 'src/main.ts');
  return !!main && /@ambit:persistent-profile/.test(main.contents);
}

function profileNameFor(msg: RunTaskMessage): string {
  const main = msg.files.find((f) => f.path === 'src/main.ts');
  const m = main?.contents.match(/@ambit:persistent-profile:([a-z0-9_-]+)/i);
  return (m?.[1] ?? 'default').toLowerCase();
}

/** Authed fetch to the admin, carrying the runtime enrollment token. */
async function adminFetch(
  config: ExecutorConfig,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<Response> {
  const url = `${config.adminUrl.replace(/\/$/, '')}${path}`;
  return fetch(url, {
    method: opts?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${config.enrollmentToken}`,
      ...(opts?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** Parse a `{ listing_draft }` response, throwing a useful error otherwise. */
async function unwrapDraft(res: Response, op: string): Promise<{ status: string; [k: string]: unknown }> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ctx.listing.${op}: admin returned ${res.status}: ${text || res.statusText}`);
  }
  const json = (await res.json()) as { listing_draft?: { status: string } };
  if (!json.listing_draft) throw new Error(`ctx.listing.${op}: response missing listing_draft`);
  return json.listing_draft as { status: string; [k: string]: unknown };
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'csv':  return 'text/csv';
    case 'json': return 'application/json';
    case 'txt':  return 'text/plain';
    case 'pdf':  return 'application/pdf';
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'html': return 'text/html';
    case 'xml':  return 'application/xml';
    default:     return 'application/octet-stream';
  }
}
