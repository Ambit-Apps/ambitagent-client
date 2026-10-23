#!/usr/bin/env node
/**
 * reset-site — forget one site in the attached Chrome, and nothing else.
 *
 *   npm run reset-site -- amazon
 *   npm run reset-site -- amazon --cdp http://localhost:9222
 *   npm run reset-site -- https://example.com            (any origin)
 *
 * ── WHY THIS EXISTS ──
 * A tester switches DSPs; a customer never does. Amazon Logistics caches the
 * signed-in DSP in localStorage["user"] (~26 KB: dspShortCode, dspId,
 * deliveryStations) and does NOT refresh it on a new sign-in. Clearing
 * cookies logs you out but leaves that blob, so the next sign-in renders the
 * PREVIOUS company: measured 2026-10-23, signed in as Orion Pax while the
 * blob still read CGLZ gave station WGR1 and "We currently do not have data
 * for this time!". Clearing cookies AND localStorage gave station DLV7 and
 * real numbers.
 *
 * That stale blob is what made Orion Pax's pages "come back empty" under
 * Xeno (runs 351/352). It was read as a fault of the shared Chrome and
 * worked around by giving those agents a private Chromium profile — a
 * test-only problem solved in the shipped manifest. This script is the fix
 * that belongs to the tester instead, so every agent stays on attached
 * Chrome (session custody, enterprise policy, extensions, bot detection).
 *
 * Scope: the named origins only. Measured on a profile with 570 cookies —
 * 13 Amazon cookies removed, 557 left signed in.
 *
 * Works for dev-runner, staging AND production testing: all three drive the
 * same attached Chrome and differ only in which control plane dispatched the
 * run, so this never needs to know which stage you are in.
 *
 * Equivalent by hand, on any machine and with no checkout:
 *   Chrome padlock -> Site settings -> Delete data.
 */
const SITES = {
  amazon: ['https://logistics.amazon.com', 'https://www.amazon.com', 'https://amazon.com'],
  ecw: ['https://mobile.ecwcloud.com'],
  lmdmax: ['https://login.lmdmax.com', 'https://scheduler.lmdmax.com', 'https://performance.lmdmax.com'],
};
const TYPES = 'cookies,local_storage,indexeddb,service_workers,cache_storage,websql';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] ?? d; };
const cdpUrl = flag('cdp') ?? process.env.AMBIT_ATTACH_CDP ?? 'http://localhost:9222';
const target = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--cdp');

if (!target) {
  console.error(`Usage: npm run reset-site -- <${Object.keys(SITES).join('|')}|https://origin>\n`);
  process.exit(1);
}
const origins = SITES[target] ?? (/^https?:\/\//.test(target) ? [target.replace(/\/+$/, '')] : null);
if (!origins) {
  console.error(`Unknown site "${target}". Known: ${Object.keys(SITES).join(', ')} — or pass a full https:// origin.`);
  process.exit(1);
}

const { chromium } = await import('playwright');
let browser;
try {
  browser = await chromium.connectOverCDP(cdpUrl);
} catch (err) {
  console.error(`Could not attach to Chrome at ${cdpUrl}.\n` +
    `Start the daemon (npm run dev), or launch Chrome with --remote-debugging-port=9222.\n(${err.message})`);
  process.exit(1);
}
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? (await ctx.newPage());
const cdp = await ctx.newCDPSession(page);

const totalBefore = (await ctx.cookies()).length;
const siteBefore = (await ctx.cookies(origins)).length;
for (const origin of origins) await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: TYPES });
// Auth cookies often sit on the parent domain (Amazon: at-main/x-main on
// .amazon.com), which clearDataForOrigin does not always reach. Sweep by name.
for (const c of await ctx.cookies(origins)) {
  await cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
}
const siteAfter = (await ctx.cookies(origins)).length;
const totalAfter = (await ctx.cookies()).length;

console.log(`reset ${target}: ${origins.join(', ')}`);
console.log(`  cookies for this site : ${siteBefore} -> ${siteAfter}`);
console.log(`  cookies left elsewhere: ${totalAfter} (of ${totalBefore})`);
console.log(siteAfter === 0
  ? '  done — sign in again as the DSP you want to test.'
  : '  WARNING: cookies survived; check the origin list above.');
await browser.close();
