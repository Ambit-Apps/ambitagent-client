import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminCapabilities, describeFailure } from './capabilities.js';
import type { RunEventMessage } from '../protocol/ws.js';

/**
 * What these tests are actually protecting.
 *
 * `CAPABILITIES.md` → *Never break an installed client*, rule 3: during a
 * rollout this client can be NEWER than the admin it is talking to. If it
 * handles that by defining `ctx.data` and throwing on first use, every agent
 * breaks — an agent's `ctx.data?.` guard cannot catch a throw. The member has
 * to be absent.
 *
 * That decision is made once, from two HTTP probes, in a function with four
 * ways to be wrong: absent, unreachable, slow, and present-but-unconfigured.
 * A live admin can only demonstrate one of them at a time, so the probes are
 * stubbed here and the live run proves the happy path.
 */

const CONFIG = { adminUrl: 'http://admin.test', enrollmentToken: 'tok' };

const SILENT = {
  debug() {}, info() {}, warn() {}, error() {},
};

/** Collects what the run's event stream was told, which is half the contract. */
function recorder() {
  const messages: string[] = [];
  const emit = (e: RunEventMessage) => {
    const p = e.payload as { message?: string };
    if (p?.message) messages.push(p.message);
  };
  return { emit, messages, said: (re: RegExp) => messages.some((m) => re.test(m)) };
}

/**
 * Stub `fetch` by URL suffix. Anything unmatched throws, so a test cannot
 * accidentally pass by reaching the network.
 */
function stubFetch(routes: Record<string, () => Promise<Response> | Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler();
    }
    throw new Error(`unstubbed fetch: ${url}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const build = (routes: Parameters<typeof stubFetch>[0], rec = recorder()) => {
  const restore = stubFetch(routes);
  return buildAdminCapabilities({ config: CONFIG, runId: '7', emit: rec.emit, log: SILENT })
    .finally(restore)
    .then((members) => ({ members, rec }));
};

// ── the four ways an admin can fail to serve a capability ───────────────

test('an OLD admin (404) leaves the members undefined, and says which', async () => {
  // The rollout case. Undefined rather than throwing, because that is the
  // only shape an agent's existing `?.` guard can handle.
  const { members, rec } = await build({
    '/rest/data/capability': () => new Response('Not Found', { status: 404 }),
    '/rest/cloud/capability': () => new Response('Not Found', { status: 404 }),
  });
  assert.equal(members.data, undefined);
  assert.equal(members.sheets, undefined);
  assert.equal(members.docs, undefined);
  assert.equal(members.drive, undefined);
  assert.ok(!('data' in members), 'absent, not present-and-undefined');
  assert.ok(rec.said(/ctx\.data is not available/), 'and the run stream was told');
  assert.ok(rec.said(/does not serve it yet/), 'in words that point at the admin, not here');
});

test('an UNREACHABLE admin also yields no members, worded differently', async () => {
  // Different cause, same safe outcome — but the message must not claim the
  // admin is old when the truth is that nobody answered.
  const { members, rec } = await build({
    '/rest/data/capability': () => { throw new Error('ECONNREFUSED'); },
    '/rest/cloud/capability': () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(members.data, undefined);
  assert.ok(rec.said(/could not ask the admin/));
  assert.ok(!rec.said(/does not serve it yet/), 'do not blame the admin version for a dead socket');
});

test('a CONFIGURED-FALSE cloud capability is absent, and blames the config', async () => {
  // The routes are deployed and the Google service account is not. A third
  // cause with a third fix — a config var on the admin — so it gets its own
  // sentence rather than being folded into "not available".
  const { members, rec } = await build({
    '/rest/data/capability': () => json({ capability: 'data' }),
    '/rest/cloud/capability': () => json({ capability: 'cloud-files', configured: false, principal: null }),
  });
  assert.ok(members.data, 'ctx.data is unaffected — it is a different route');
  assert.equal(members.sheets, undefined);
  assert.equal(members.drive, undefined);
  assert.ok(rec.said(/no Google service account configured/));
});

test('one capability absent does not take the other down', async () => {
  // They are separate prefixes precisely so they can be deployed and fail
  // independently. An agent that only wants a spreadsheet should not be
  // stopped by ctx.data being missing.
  const { members } = await build({
    '/rest/data/capability': () => new Response('', { status: 404 }),
    '/rest/cloud/capability': () => json({ configured: true, principal: 'sa@x.iam.gserviceaccount.com' }),
  });
  assert.equal(members.data, undefined);
  assert.ok(members.sheets && members.docs && members.drive);
});

// ── the happy path, and the one line a customer needs ──────────────────

test('a current admin serves all four, and says NOTHING about it', async () => {
  // The quiet case, and it has to stay quiet. This announced the Google
  // share address up front, which a real run showed meant every screenshot
  // agent carried a line about a capability it never touches — on the page a
  // customer reads to find out what happened.
  const { members, rec } = await build({
    '/rest/data/capability': () => json({ capability: 'data' }),
    '/rest/cloud/capability': () =>
      json({ configured: true, principal: 'ambit-agents@ambitagents.iam.gserviceaccount.com' }),
  });
  assert.ok(members.data && members.sheets && members.docs && members.drive);
  assert.deepEqual(rec.messages, [], 'a working capability is not news');
});

test('the share address IS named, once, on first actual use', async () => {
  // Still worth saying when it matters: it is the address somebody has to
  // share a file with, and the commonest reason these calls fail is that
  // nobody has. So it sits beside the question rather than being hunted for.
  const rec = recorder();
  const { members } = await build(
    {
      '/rest/data/capability': () => json({}),
      '/rest/cloud/capability': () =>
        json({ configured: true, principal: 'ambit-agents@ambitagents.iam.gserviceaccount.com' }),
    },
    rec,
  );

  const original = globalThis.fetch;
  globalThis.fetch = (async () => json({ tab: 'Sheet1', rows: [] })) as typeof fetch;
  try {
    await members.sheets!.readValues({ file: 'abc' });
    await members.sheets!.readValues({ file: 'abc' });
    await members.docs!.readText({ file: 'abc' });
  } finally {
    globalThis.fetch = original;
  }

  const named = rec.messages.filter((m) => /ambit-agents@ambitagents\.iam\.gserviceaccount\.com/.test(m));
  assert.equal(named.length, 1, 'once per run, not once per call');
});

test('runId is attached to every call, because the proxy requires it', async () => {
  // Tenant isolation on the admin hangs on this: the runId names the run,
  // and the run names the tenant. Omitting it is a 400, so it is worth a
  // test rather than a comment.
  const { members } = await build({
    '/rest/data/capability': () => json({}),
    '/rest/cloud/capability': () => json({ configured: false }),
  });

  let sentBody: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return json({ payload: { ok: 1 } });
  }) as typeof fetch;
  try {
    await members.data!.get({ namespace: 'ns', key: 'k' });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(sentBody.runId, '7');
  assert.equal(sentBody.namespace, 'ns');
});

// ── the error text, which is the whole value of a proxy ────────────────

test('the admin’s own sentence survives a failure', async () => {
  // These routes carry Google's refusals through with the fix named. Turning
  // that into "admin returned 400" throws away the only actionable part, and
  // this is the error somebody reads over the phone.
  const res = json(
    {
      error: 'could not read the sheet (HTTP 404) the file has not been shared with sa@x',
      hint: 'press Share and add sa@x as a Viewer',
    },
    400,
  );
  const msg = await describeFailure(res, 'ctx.sheets.readTable');
  assert.match(msg, /ctx\.sheets\.readTable/, 'says which call');
  assert.match(msg, /has not been shared/, 'and why, in the admin’s words');
});

test('a 503 is reported as "not configured", not as a failure of the call', async () => {
  const msg = await describeFailure(json({ error: 'Google Workspace is not configured' }, 503), 'ctx.drive.upload');
  assert.match(msg, /not configured on the admin/);
});

test('an HTML error page from a proxy is bounded, not pasted whole', async () => {
  const res = new Response(`<html>${'x'.repeat(5000)}</html>`, { status: 502 });
  const msg = await describeFailure(res, 'ctx.data.get');
  assert.ok(msg.length < 400, 'a log line is not a web page');
});
