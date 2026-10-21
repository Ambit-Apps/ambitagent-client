import type { Logger } from '../log.js';
import type { RunEventMessage } from '../protocol/ws.js';

/**
 * The ctx members the ADMIN implements, reached over HTTP.
 *
 * `ctx.data`, `ctx.sheets`, `ctx.docs` and `ctx.drive` are proxied for the
 * same reason `ctx.ai.complete` is: the credential belongs to the platform
 * and lives on the admin dyno. This runtime learns nothing about Google and
 * holds no key — it posts a file id and gets rows back.
 *
 * Kept out of `executor.ts` deliberately. That file is already long, and this
 * is one self-contained concern: four members, one probe, one error shape.
 *
 * ── THIS FILE IS A PAIR WITH dev-runner/src/lib/admin-capabilities.mjs ──
 * Same contract, different host. The dev-runner version was written first and
 * proved the routes from a laptop before this one shipped to a customer's
 * machine; keeping the two in step is how a local run stays a trustworthy
 * rehearsal of a real one. They differ in two ways that matter and nowhere
 * else: this one authenticates with an enrollment token and a `runId` rather
 * than a staff token and a tenant, and this one reports through the run's
 * event stream rather than to a terminal.
 */

export interface AdminCapabilityConfig {
  adminUrl: string;
  enrollmentToken: string;
}

/**
 * How long to wait for the two probes, together.
 *
 * Short on purpose. The probes decide which members exist, so a run cannot
 * start until they answer — and an admin that has stopped responding must not
 * be able to hold a customer's run open at the starting line. 4 seconds is
 * far above a healthy answer (these are two unauthenticated GETs returning a
 * dozen fields) and far below anything a person would wait through.
 *
 * Timing out is not an error. It means the members stay undefined for this
 * run and the agent's own guard reports it, which is the same outcome as an
 * admin that genuinely has no such route. The next run asks again.
 */
const PROBE_TIMEOUT_MS = 4000;

export interface SheetsApi {
  readValues(opts: { file: string; tab?: string; range?: string }): Promise<unknown>;
  readTable(opts: { file: string; tab?: string; range?: string }): Promise<unknown>;
  readGrid(opts: { file: string; tab?: string; range?: string }): Promise<unknown>;
}

export interface DocsApi {
  readText(opts: { file: string }): Promise<unknown>;
}

export interface DriveApi {
  upload(opts: {
    folder: string;
    name: string;
    bytes: Uint8Array;
    mimeType?: string;
  }): Promise<unknown>;
}

export interface DataApi {
  get(opts: { namespace: string; key: string }): Promise<unknown>;
  list(opts: { namespace: string }): Promise<unknown>;
  put(opts: { namespace: string; key: string; payload: unknown }): Promise<void>;
  delete(opts: { namespace: string; key: string }): Promise<boolean>;
}

export interface AdminCapabilities {
  data?: DataApi;
  sheets?: SheetsApi;
  docs?: DocsApi;
  drive?: DriveApi;
}

/**
 * The admin's own sentence for a failure, not a status code.
 *
 * These routes carry Google's refusals through with the fix named — "nobody
 * shared this folder with <address>", "a folder in My Drive cannot receive
 * this file, here is how to make a Shared Drive". That text is the entire
 * value of the error, and `admin returned 400` throws it away.
 *
 * Exported for its own test: a proxy whose errors are useless is a proxy
 * nobody can support over the phone.
 */
export async function describeFailure(res: Response, what: string): Promise<string> {
  const text = await res.text().catch(() => '');
  let said = text;
  try {
    const body = JSON.parse(text) as { error?: string; hint?: string };
    // `error` already contains the hint on these routes. Fall back to `hint`
    // alone in case a route ever sends only that.
    said = body.error ?? body.hint ?? text;
  } catch {
    // Not JSON — a proxy, a load balancer, an HTML error page. Pass a
    // bounded slice rather than a wall of markup.
    said = text.slice(0, 300);
  }
  if (res.status === 503) {
    return `${what}: this capability is not configured on the admin. ${said}`;
  }
  return `${what}: ${said || `admin returned ${res.status} ${res.statusText}`}`;
}

/**
 * Ask whether the admin serves a capability.
 *
 * ── WHY ASK AT ALL, RATHER THAN TRY AND SEE ──
 * `CAPABILITIES.md` → *Never break an installed client*, rule 3: during a
 * rollout this client may be newer than the admin it is talking to. A member
 * that is DEFINED and throws on first use breaks every agent, because an
 * agent's `ctx.data?.` guard cannot catch it; a member that is UNDEFINED is
 * handled by that guard already. So the question has to be asked before the
 * ctx is handed over, not when the member is called.
 */
async function probe(
  config: AdminCapabilityConfig,
  path: string,
  signal: AbortSignal,
): Promise<{ ok: true; info: Record<string, unknown> } | { ok: false; why: string }> {
  const url = `${config.adminUrl.replace(/\/$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? 'the admin did not answer in time' : (err as Error).message;
    return { ok: false, why: `could not ask the admin (${msg})` };
  }
  // 404 is the one that means "absent" rather than "broken": this admin is
  // older than the capability. Said in those words because the alternative
  // reading — that something is wrong here — sends the reader to the wrong
  // machine.
  if (res.status === 404) return { ok: false, why: 'this admin does not serve it yet' };
  if (!res.ok) return { ok: false, why: `the admin answered ${res.status}` };
  try {
    return { ok: true, info: (await res.json()) as Record<string, unknown> };
  } catch {
    return { ok: false, why: 'the admin answered with something that was not JSON' };
  }
}

/**
 * Build whichever of the four members this admin can serve.
 *
 * Never throws and never fails a run: a capability that cannot be confirmed
 * is simply absent, which every agent's guard already handles. What it does
 * do is SAY SO, on the run's own event stream — a capability that quietly
 * is not there is the failure this whole mechanism exists to avoid, and the
 * run page is where somebody will be looking.
 */
export async function buildAdminCapabilities(opts: {
  config: AdminCapabilityConfig;
  runId: string;
  emit: (event: RunEventMessage) => void;
  log: Logger;
  signal?: AbortSignal;
}): Promise<AdminCapabilities> {
  const { config, runId, emit, log } = opts;

  const note = (message: string, fields?: Record<string, unknown>) => {
    log.info({ runId, ...(fields ?? {}) }, message);
    emit({
      type: 'run_event',
      runId,
      kind: 'log',
      ts: Date.now(),
      payload: { message, ...(fields ?? {}) },
    });
  };

  // One timeout for both probes together, and it is OUR timer rather than
  // the run's cancel signal: a cancelled run should abandon the probes too,
  // so both are honoured.
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), PROBE_TIMEOUT_MS);
  const onCancel = () => timer.abort();
  opts.signal?.addEventListener('abort', onCancel, { once: true });

  let dataProbe: Awaited<ReturnType<typeof probe>>;
  let cloudProbe: Awaited<ReturnType<typeof probe>>;
  try {
    [dataProbe, cloudProbe] = await Promise.all([
      probe(config, '/rest/data/capability', timer.signal),
      probe(config, '/rest/cloud/capability', timer.signal),
    ]);
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onCancel);
  }

  /** POST to a proxy route, with the admin's own message on failure. */
  const call = async (path: string, body: unknown, what: string): Promise<unknown> => {
    const url = `${config.adminUrl.replace(/\/$/, '')}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.enrollmentToken}`,
        },
        body: JSON.stringify({ runId, ...(body as object) }),
        signal: opts.signal,
      });
    } catch (err) {
      throw new Error(`${what}: request to ${url} failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(await describeFailure(res, what));
    return res.json();
  };

  const members: AdminCapabilities = {};

  // ── WHY ABSENCE IS ANNOUNCED AND AVAILABILITY IS NOT ──
  // An absent capability is rare and actionable: with both routes deployed
  // and configured, none of these lines appear at all, so a run that shows
  // one is telling somebody something they need. Availability is the normal
  // case, and announcing it would put a line about Google on the timeline of
  // every screenshot agent — which it did, until a real run showed it.
  if (!dataProbe.ok) {
    note(`ctx.data is not available on this run — ${dataProbe.why}`);
  } else {
    members.data = {
      async get({ namespace, key }) {
        const r = (await call('/rest/data/get', { namespace, key }, 'ctx.data.get')) as {
          payload: unknown;
        };
        return r.payload;
      },
      async list({ namespace }) {
        const r = (await call('/rest/data/list', { namespace }, 'ctx.data.list')) as {
          rows: unknown;
        };
        return r.rows;
      },
      async put({ namespace, key, payload }) {
        await call('/rest/data/put', { namespace, key, payload }, 'ctx.data.put');
      },
      async delete({ namespace, key }) {
        const r = (await call('/rest/data/delete', { namespace, key }, 'ctx.data.delete')) as {
          removed: boolean;
        };
        return r.removed === true;
      },
    };
  }

  const cloudConfigured = cloudProbe.ok && cloudProbe.info.configured !== false;
  if (!cloudProbe.ok) {
    note(`ctx.sheets, ctx.docs and ctx.drive are not available on this run — ${cloudProbe.why}`);
  } else if (!cloudConfigured) {
    // The routes exist and the service account does not. A different problem
    // with a different fix, on a different machine — worth its own sentence
    // rather than being folded into "not available".
    note(
      'ctx.sheets, ctx.docs and ctx.drive are not available on this run — the admin has ' +
        'no Google service account configured',
    );
  } else {
    const principal = typeof cloudProbe.info.principal === 'string' ? cloudProbe.info.principal : null;

    /**
     * Name the share address on the run, once, the FIRST time the agent
     * actually reaches for a file.
     *
     * ── WHY LAZY AND NOT UP FRONT ──
     * It was announced up front, and that put "Google Workspace access is
     * granted by sharing a file with ambit-agents@…" on the timeline of a
     * screenshot agent that will never open a spreadsheet. Measured on a
     * real run: every agent on every machine would carry a line about a
     * capability it does not use, on the page a customer reads to find out
     * what happened.
     *
     * It is still worth saying when it IS used, because it is the address
     * somebody has to share a file with and the most common reason one of
     * these calls fails is that nobody has — so the answer sits beside the
     * question instead of being hunted for.
     */
    let principalAnnounced = false;
    const announce = () => {
      if (principalAnnounced || !principal) return;
      principalAnnounced = true;
      note(`Google Workspace access is granted by sharing a file with ${principal}`, {
        principal,
      });
    };

    const cloudCall = (path: string, body: unknown, what: string): Promise<unknown> => {
      announce();
      return call(path, body, what);
    };

    members.sheets = {
      readValues: (o) => cloudCall('/rest/cloud/sheets/read-values', o, 'ctx.sheets.readValues'),
      readTable: (o) => cloudCall('/rest/cloud/sheets/read-table', o, 'ctx.sheets.readTable'),
      readGrid: (o) => cloudCall('/rest/cloud/sheets/read-grid', o, 'ctx.sheets.readGrid'),
    };

    members.docs = {
      readText: (o) => cloudCall('/rest/cloud/docs/read-text', o, 'ctx.docs.readText'),
    };

    members.drive = {
      async upload({ folder, name, bytes, mimeType }) {
        // Base64, because the proxy speaks JSON like every other ctx call.
        // The admin enforces the 5 MB cap with a message that names it, so
        // an oversized file is refused in words rather than at the socket.
        return cloudCall(
          '/rest/cloud/drive/upload',
          {
            folder,
            name,
            bytesB64: Buffer.from(bytes).toString('base64'),
            mimeType,
          },
          'ctx.drive.upload',
        );
      },
    };
  }

  return members;
}
