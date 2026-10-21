import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFrame } from './redact.js';

/**
 * The leak these tests exist for.
 *
 * `connection.ts` logged the whole unparseable frame. A `run_task` carries
 * the customer's DECRYPTED credentials, so one truncated frame wrote their
 * eCW password into a plain log file on their own machine. Nobody had to be
 * attacked; a dropped packet was enough.
 */

/** A run_task shaped like the real thing, including the part that must not leak. */
const RUN_TASK = JSON.stringify({
  type: 'run_task',
  runId: '418',
  inputs: { week: 'W40' },
  credentials: {
    'ecw-cook': { username: 'drcook', password: 'Sunshine!2026' },
    'amazon-ori': { username: 'josh@orionpax.com', password: 'hunter2hunter2' },
  },
  files: [{ path: 'src/main.ts', contents: 'export const run = async () => {}' }],
});

test('a credential value never reaches the log, at any depth', () => {
  const summary = JSON.stringify(summarizeFrame(RUN_TASK));
  assert.ok(!summary.includes('Sunshine!2026'), 'the eCW password must not appear');
  assert.ok(!summary.includes('hunter2hunter2'), 'nor the Amazon one');
  assert.ok(!summary.includes('drcook'), 'nor the username beside it');
});

test('but what a protocol mismatch is diagnosed from survives', () => {
  // Logging nothing would be the other failure: a frame the client refuses
  // is undiagnosable from the one place anyone can see it.
  const s = summarizeFrame(RUN_TASK);
  assert.equal(s.claimedType, 'run_task', 'which frame it was');
  assert.equal(s.claimedRunId, '418', 'and which run');
  assert.ok((s.keys as string[]).includes('files'), 'the field names, which is what drifts');
  assert.ok((s.redactedKeys as string[]).includes('credentials'), 'and that one was withheld');
  assert.ok((s.bytes as number) > 100, 'and how big it was');
});

test('a key name is named, so you can see WHAT was withheld', () => {
  // The distinction worth keeping: "there was a credentials field and I did
  // not log it" is useful; silence is not.
  const s = summarizeFrame(JSON.stringify({ type: 'x', authorization: 'Bearer abc', ok: 1 }));
  assert.deepEqual(s.redactedKeys, ['authorization']);
  assert.ok((s.keys as string[]).includes('ok'));
});

test('secret-ish key names are caught as substrings, not exact matches', () => {
  // enrollmentToken, token_hash, AWS_SECRET_ACCESS_KEY — all real field
  // names in this system, none of them equal to "token" or "secret".
  const s = summarizeFrame(
    JSON.stringify({ enrollmentToken: 'a', token_hash: 'b', AWS_SECRET: 'c', runId: 1 }),
  );
  assert.deepEqual((s.redactedKeys as string[]).sort(), ['AWS_SECRET', 'enrollmentToken', 'token_hash']);
});

// ── the path that runs when the frame is NOT json ────────────────────────

test('a non-JSON frame gives a bounded preview, not the whole body', () => {
  // The real cases: an HTML error page from a proxy, a TLS terminator's
  // complaint. The opening identifies which; the rest is noise and risk.
  const html = `<!DOCTYPE html><html><body>${'x'.repeat(5000)}</body></html>`;
  const s = summarizeFrame(html);
  assert.equal(s.json, false);
  assert.ok(String(s.preview).length < 200, 'bounded');
  assert.ok(String(s.preview).endsWith('…'), 'and says it was cut');
  assert.equal(s.bytes, Buffer.byteLength(html, 'utf8'), 'the full length is still reported');
});

test('a TRUNCATED run_task still does not leak the password it got halfway through', () => {
  // The case that makes the preview masking necessary rather than
  // belt-and-braces: this is the frame that fails to parse in real life,
  // and it has half a credentials block in it.
  const truncated = RUN_TASK.slice(0, 180);
  const s = summarizeFrame(truncated);
  assert.equal(s.json, false, 'it cannot parse, so the preview path runs');
  const text = JSON.stringify(s);
  assert.ok(!text.includes('Sunshine!2026'), 'the password must still not appear');
  assert.match(String(s.preview), /\[redacted\]|run_task/, 'while the frame type stays visible');
});

test('a bearer token or a JWT loose in the text is masked', () => {
  const s = summarizeFrame('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def not-json');
  const text = JSON.stringify(s);
  assert.ok(!text.includes('eyJhbGciOiJIUzI1NiIs'), 'the JWT body must not appear');
  assert.match(String(s.preview), /\[redacted\]|\[jwt\]/);
});

test('a 64-char hex enrollment token is masked', () => {
  const token = 'a'.repeat(64);
  const s = summarizeFrame(`garbage ${token} more`);
  assert.ok(!JSON.stringify(s).includes(token));
  assert.match(String(s.preview), /\[hex-token\]/);
});

// ── the shapes that must not crash the logger ───────────────────────────

test('empty, whitespace and a bare JSON scalar are all summarised, not thrown', () => {
  // This runs inside a catch in the message handler. If it throws, a bad
  // frame takes the connection down with it.
  for (const input of ['', '   ', 'null', '42', '"text"', '[]']) {
    assert.doesNotThrow(() => summarizeFrame(input), `input: ${JSON.stringify(input)}`);
  }
  assert.equal(summarizeFrame('42').shape, 'number');
  assert.equal(summarizeFrame('').json, false);
});

test('an enormous key list is capped', () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < 500; i++) wide[`k${i}`] = i;
  const s = summarizeFrame(JSON.stringify(wide));
  assert.ok((s.keys as string[]).length <= 40, 'a log line is not a data dump');
});
