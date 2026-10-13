#!/usr/bin/env node
/**
 * publish-release — build the Windows installer bundle and upload it to
 * the admin, so staff can download it from the portal instead of emailing
 * four files Gmail refuses to carry.
 *
 * Usage, from the repo root:
 *
 *   node install/publish-release.mjs --admin https://ambitagent-prod.herokuapp.com
 *   node install/publish-release.mjs --admin http://localhost:3100 --notes "chrome throttling flags"
 *   node install/publish-release.mjs --admin ... --dry-run
 *
 * Auth: a staff JWT, from AMBIT_ADMIN_TOKEN or --token. Get one by
 * signing into the portal and copying `ambit_authToken` out of
 * localStorage — the same token the browser uses.
 *
 * ── WHAT IT UPLOADS ──
 * The three install scripts, plus the source zip that build-installer-zip.sh
 * produces. ~100 KB in total, which is why the admin stores it in a table
 * rather than S3 — see the client_releases migration for that reasoning.
 *
 * The release VERSION is taken from the built zip's filename, which is
 * the same string build-info.json carries inside it and the same string a
 * running daemon reports. One identity, derived in one place: if the
 * portal says a machine is on 20261011-114857-3aea35a, that is the file
 * that was installed on it.
 *
 * --admin is the ADMIN API url (the PUBLIC_API_URL value), not the portal
 * address. They are different hosts, and the installer bakes the API one
 * into install.bat so the daemon knows where to enroll.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const DRY = argv.includes('--dry-run');
const adminUrl = (flag('admin') ?? process.env.AMBIT_ADMIN_URL ?? '').replace(/\/+$/, '');
const notes = flag('notes') ?? '';

if (!adminUrl) {
  console.error('--admin <url> is required (or set AMBIT_ADMIN_URL).');
  process.exit(1);
}

// ── AUTH ─────────────────────────────────────────────────────────────
//
// Sessions last 24 hours, and a release goes out every few weeks. So the
// steady state of the old flow was: build for thirty seconds, fail with
// HTTP 401, go and find a browser, open devtools, copy a JWT out of
// localStorage, export it, run the whole thing again.
//
// Two things fix that. The token is CACHED, so most publishes need
// nothing. And when it is missing or stale we log in right here, using
// the 6-digit code the portal already issues — that code exists to cross
// from the device holding the email to the device doing the work, which
// is exactly this.
//
// Checked BEFORE the build, deliberately. Finding out you are logged out
// after doing the work is the wrong order, and it is how this was found.

// ── THE SAME FILE dev-runner USES ──
//
// `dev-runner login` in the agents repo already signs a staff user in and
// saves { api, email, token } to ~/.ambit/config.json at 0600. Standing up
// a second credential store here would mean the same person logging in
// twice, on the same machine, for the same account, against the same
// admin — and two places to look when a token goes stale.
//
// So this reads and writes that file, in that shape. The two repos are
// coupled through it, which is worth knowing: change the shape in one and
// the other stops seeing your session. It is three keys and they have not
// moved, so the trade is a good one.
const CRED_FILE = join(homedir(), '.ambit', 'config.json');

function readCreds() {
  try {
    return JSON.parse(readFileSync(CRED_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCreds(entry) {
  // Spread what is already there: the file is dev-runner's too, and a key
  // it adds later must not vanish because we rewrote the file.
  const next = { ...readCreds(), ...entry };
  mkdirSync(dirname(CRED_FILE), { recursive: true });
  writeFileSync(CRED_FILE, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode only applies when CREATING; an existing file
  // keeps its own. chmod unconditionally so a file that predates this is
  // not left world-readable.
  try { execFileSync('chmod', ['600', CRED_FILE]); } catch { /* Windows differs */ }
}

/** Authoritative, not a local `exp` check — a token can also be revoked. */
async function tokenWorks(tok) {
  if (!tok) return false;
  try {
    const r = await fetch(`${adminUrl}/rest/auth/me`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    return r.ok;
  } catch (err) {
    console.error(`Could not reach ${adminUrl}: ${err.message}`);
    process.exit(1);
  }
}

async function logIn() {
  if (!process.stdin.isTTY) {
    console.error(
      'Not signed in, and there is no terminal to ask on.\n' +
        'Set AMBIT_ADMIN_TOKEN, or run this from an interactive shell.',
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const remembered = readCreds().email ?? '';
    const prompt = remembered ? `Email [${remembered}]: ` : 'Email: ';
    const email = (await rl.question(prompt)).trim() || remembered;
    if (!email) {
      console.error('An email address is required.');
      process.exit(1);
    }

    const req = await fetch(`${adminUrl}/rest/auth/request-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!req.ok) {
      console.error(`Could not send a login code: HTTP ${req.status}\n${await req.text()}`);
      process.exit(1);
    }
    // The response is deliberately the same whether or not the address is
    // a real user, so this cannot say "check your email, if you exist".
    console.log(`\nA 6-digit code is on its way to ${email}. It is good for 15 minutes.`);

    const code = (await rl.question('Code: ')).replace(/\D/g, '');
    const res = await fetch(`${adminUrl}/rest/auth/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    if (!res.ok) {
      console.error(`\nSign-in failed: HTTP ${res.status}\n${await res.text()}`);
      process.exit(1);
    }
    const body = await res.json();
    if (!body?.token) {
      console.error('\nSign-in returned no token — nothing to publish with.');
      process.exit(1);
    }
    // `api` goes in alongside the token because the two belong together —
    // a token is only valid against the admin that issued it. This is the
    // same "last login wins" contract dev-runner already documents, so a
    // publish to production does retarget dev-runner's default. Pass
    // --api to it, or log in again, to point somewhere else.
    saveCreds({ api: adminUrl, email, token: body.token });
    const hours = Math.round((body.expires_in ?? 86400) / 3600);
    console.log(`Signed in. Saved to ${CRED_FILE} — good for about ${hours}h.\n`);
    return body.token;
  } finally {
    rl.close();
  }
}

/** --token and the env var still win, for CI and one-off overrides. */
async function resolveToken() {
  // CHECKED, not trusted. An explicit token used to short-circuit straight
  // past the validity check, which meant the whole "find out before you
  // build" promise did not apply to the one case that actually broke: a
  // stale AMBIT_ADMIN_TOKEN exported into a shell weeks ago. Sessions last
  // 24 hours, so an exported one is wrong far more often than it is right,
  // and it silently outranked a perfectly good saved session.
  const fromFlag = flag('token');
  const explicit = fromFlag ?? process.env.AMBIT_ADMIN_TOKEN ?? '';
  if (explicit) {
    if (await tokenWorks(explicit)) return explicit;
    const source = fromFlag ? '--token' : 'AMBIT_ADMIN_TOKEN';
    const hint = fromFlag
      ? 'Drop --token to stop seeing this.'
      : 'Run `unset AMBIT_ADMIN_TOKEN` to stop seeing this.';
    console.log(
      `${source} was supplied but the admin rejected it — it has probably ` +
        `expired (sessions last 24h).\nIgnoring it and using your saved ` +
        `session instead. ${hint}\n`,
    );
  }
  // No check that the saved `api` matches --admin: tokenWorks() asks the
  // admin we are actually publishing to, which settles it. A staging token
  // simply fails against production and we log in, rather than us guessing
  // from two URL strings whether they are the same host.
  const cached = readCreds().token ?? '';
  if (await tokenWorks(cached)) return cached;
  if (cached) console.log('Your saved session has expired.\n');
  return logIn();
}

let token = '';
if (!DRY) token = await resolveToken();

// 1. Build. The script refuses to run with uncommitted changes, which is
//    what makes the SHA in the version string trustworthy — so this
//    deliberately does NOT pass --dirty. A release you cannot point at a
//    commit is not a release.
console.log('Building the installer zip…');
execFileSync(join(ROOT, 'install/build-installer-zip.sh'), { cwd: ROOT, stdio: 'inherit' });

// 2. Find what it just built: newest zip in install/dist.
const distDir = join(ROOT, 'install/dist');
const zipName = readdirSync(distDir)
  .filter((f) => f.endsWith('.zip'))
  .map((f) => ({ f, t: statSync(join(distDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0]?.f;
if (!zipName) {
  console.error(`No zip found in ${distDir} after building.`);
  process.exit(1);
}

// ambitagent-client-<stamp>-<sha>.zip  ->  <stamp>-<sha>
const version = zipName.replace(/^ambitagent-client-/, '').replace(/\.zip$/, '');
if (/-dirty$/.test(version)) {
  console.error(
    `Refusing to publish ${version}: built from a dirty tree, so the SHA does not\n` +
      'identify what is in it. Commit, then re-run.',
  );
  process.exit(1);
}

// One release spans both platforms. `common` is the source zip — the
// daemon is the same code either way, and only the install scripts
// differ. Publishing per-platform would let the two drift a commit
// apart with nothing on screen to show it.
const files = [
  { platform: 'common', path: zipName, from: join(distDir, zipName) },
  { platform: 'windows', path: 'install.bat', from: join(ROOT, 'install/windows/install.bat') },
  { platform: 'windows', path: 'install.ps1', from: join(ROOT, 'install/windows/install.ps1') },
  { platform: 'windows', path: 'run-daemon.ps1', from: join(ROOT, 'install/windows/run-daemon.ps1') },
  { platform: 'macos', path: 'install.sh', from: join(ROOT, 'install/macos/install.sh') },
  { platform: 'macos', path: 'uninstall.sh', from: join(ROOT, 'install/macos/uninstall.sh') },
].map((f) => {
  const buf = readFileSync(f.from);
  return {
    platform: f.platform,
    path: f.path,
    contents_b64: buf.toString('base64'),
    bytes: buf.byteLength,
  };
});

const total = files.reduce((n, f) => n + f.bytes, 0);
console.log(`\nRelease ${version}`);
for (const f of files) {
  console.log(`  ${f.platform.padEnd(8)} ${f.path.padEnd(42)} ${(f.bytes / 1024).toFixed(1)} KB`);
}
console.log(`  ${''.padEnd(8)} ${'total'.padEnd(42)} ${(total / 1024).toFixed(1)} KB`);

if (DRY) {
  console.log(`\nDry run — nothing uploaded. Would POST to ${adminUrl}/rest/client-releases`);
  process.exit(0);
}

// 3. Upload.
const body = JSON.stringify({
  version,
  notes: notes || null,
  files: files.map(({ path, contents_b64, platform }) => ({ path, contents_b64, platform })),
});
const post = (tok) =>
  fetch(`${adminUrl}/rest/client-releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body,
  });

let res = await post(token);

// A token checked before the build can still lapse during it — the window
// is small but it is real, and the cost of being wrong is making someone
// sign in and rebuild. One retry, only on 401, and only when we were not
// handed a token explicitly: if a caller passed --token we have no mandate
// to go and get a different one.
if (res.status === 401) {
  console.log('\nThe session lapsed while building. Signing in again…\n');
  token = await logIn();
  res = await post(token);
}

if (res.status === 409) {
  console.error(
    `\n${version} is already published. The version comes from the build stamp and\n` +
      'git SHA, so the same string means the same build — commit something and rebuild.',
  );
  process.exit(1);
}
if (!res.ok) {
  console.error(`\nUpload failed: HTTP ${res.status}\n${await res.text()}`);
  process.exit(1);
}

console.log(`\nPublished ${version} to ${adminUrl}.`);
console.log(`Staff can now download it at ${adminUrl}/staff/install — open that ON the`);
console.log('customer\'s machine, sign in, download, and run install.bat as administrator.');
