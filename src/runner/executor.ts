import { register } from 'tsx/esm/api';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
          browser = await launchBrowser({ headless });
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
        if (browser) {
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

    /**
     * Customer-uploaded files are stored on the admin side; the
     * runtime fetches by key via an authed API call. Not wired yet
     * — browser agents that need input files should upload
     * server-side for now. When we wire this, it'll be a GET to
     * `/rest/runs/:runId/input-files/:key` with the enrollment
     * token (same auth as ctx.ai.complete).
     */
    files: {
      async getFile(key: string): Promise<Uint8Array | null> {
        throw new Error(
          `ctx.files.getFile("${key}"): input-file fetch is not yet wired ` +
            `on the runtime side. API-type agents handle this today; ` +
            `browser-type file inputs land next.`,
        );
      },
      async getFileMeta(): Promise<null> {
        return null;
      },
    },

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

    /**
     * Product-lookup proxy. Same auth + tenant-isolation model as
     * ai.complete — POST to the admin's `/rest/products/lookup-by-image`
     * with our enrollment token. The admin loads the input-file bytes
     * from the task_run and runs the eBay + Vision + Claude chain
     * server-side. Runtimes never hold eBay app credentials or AWS
     * keys — same principle as ai.complete.
     */
    products: {
      async lookupByImage(
        inputKey: string,
        options?: {
          minMatches?: number;
          maxMatches?: number;
          categoryHint?: string;
        },
      ): Promise<unknown> {
        if (typeof inputKey !== 'string' || inputKey.length === 0) {
          throw new Error('ctx.products.lookupByImage: inputKey (string) is required');
        }
        const url = `${config.adminUrl.replace(/\/$/, '')}/rest/products/lookup-by-image`;
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
              input_key: inputKey,
              options: options ?? {},
            }),
          });
        } catch (err) {
          throw new Error(
            `ctx.products.lookupByImage: request to ${url} failed: ${(err as Error).message}`,
          );
        }
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new Error(
            `ctx.products.lookupByImage: admin returned ${res.status}: ${bodyText || res.statusText}`,
          );
        }
        return await res.json();
      },
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
        messages: Array<{
          role: 'user' | 'assistant';
          /**
           * Plain text or an array of blocks for vision (image + text).
           * The proxy validates block shapes; the runtime just passes
           * through.
           */
          content:
            | string
            | Array<
                | { type: 'text'; text: string }
                | {
                    type: 'image';
                    source: {
                      type: 'base64';
                      media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
                      data: string;
                    };
                  }
              >;
        }>;
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
