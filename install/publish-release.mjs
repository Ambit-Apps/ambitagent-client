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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const DRY = argv.includes('--dry-run');
const adminUrl = (flag('admin') ?? process.env.AMBIT_ADMIN_URL ?? '').replace(/\/+$/, '');
const token = flag('token') ?? process.env.AMBIT_ADMIN_TOKEN ?? '';
const notes = flag('notes') ?? '';

if (!adminUrl) {
  console.error('--admin <url> is required (or set AMBIT_ADMIN_URL).');
  process.exit(1);
}
if (!DRY && !token) {
  console.error(
    'A staff JWT is required: --token <jwt>, or AMBIT_ADMIN_TOKEN.\n' +
      "Sign into the portal and copy `ambit_authToken` from localStorage.",
  );
  process.exit(1);
}

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

const files = [
  { path: 'install.bat', from: join(ROOT, 'install/windows/install.bat') },
  { path: 'install.ps1', from: join(ROOT, 'install/windows/install.ps1') },
  { path: 'run-daemon.ps1', from: join(ROOT, 'install/windows/run-daemon.ps1') },
  { path: zipName, from: join(distDir, zipName) },
].map((f) => {
  const buf = readFileSync(f.from);
  return { path: f.path, contents_b64: buf.toString('base64'), bytes: buf.byteLength };
});

const total = files.reduce((n, f) => n + f.bytes, 0);
console.log(`\nRelease ${version}`);
for (const f of files) console.log(`  ${f.path.padEnd(42)} ${(f.bytes / 1024).toFixed(1)} KB`);
console.log(`  ${'total'.padEnd(42)} ${(total / 1024).toFixed(1)} KB`);

if (DRY) {
  console.log(`\nDry run — nothing uploaded. Would POST to ${adminUrl}/rest/client-releases`);
  process.exit(0);
}

// 3. Upload.
const res = await fetch(`${adminUrl}/rest/client-releases`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    version,
    notes: notes || null,
    files: files.map(({ path, contents_b64 }) => ({ path, contents_b64 })),
  }),
});

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
