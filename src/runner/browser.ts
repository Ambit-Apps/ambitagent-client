import { chromium } from 'playwright-extra';
import { chromium as pwChromium } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Playwright + stealth launcher — MUST stay in sync with
 * `ambitagent-agents/dev-runner/src/lib/browser.mjs`. The whole point
 * of dev/prod parity is that a script that works locally under
 * dev-runner behaves identically under the customer's runtime here.
 *
 * When we extract this to a shared package (`packages/lib-browser/`
 * in the agents monorepo, or a published private npm), delete both
 * copies and import from there.
 *
 * Isolation contract (mirrors dev-runner's):
 *   - No `channel: 'chrome'`, no `executablePath` → uses Playwright's
 *     bundled Chromium, completely separate from the user's system
 *     Chrome install.
 *   - No `userDataDir` → Playwright creates a fresh temp profile per
 *     launch, cleaned up on close(). The customer's real browser
 *     profile is never touched.
 *
 * Persistent-profile opt-in: pass `persistentProfileDir` to reuse a
 * logged-in session across runs (e.g. a customer's Vendoo login for the
 * vendoo-lister agent). This uses `launchPersistentContext`, keyed by a
 * per-customer/runtime directory. It is OPT-IN — every other agent keeps
 * the fresh-temp-profile isolation above.
 *
 * Launch toggles (env-driven, mirror dev-runner/src/lib/browser.mjs) —
 * for targets that don't render / detect automation under the bundled
 * stealth Chromium (e.g. Vendoo garbles fonts; Google OAuth blocks):
 *   AMBIT_NO_STEALTH=1          skip the stealth plugin.
 *   AMBIT_CHROME_CHANNEL=chrome use installed system Chrome (real fonts).
 *     Still isolated: a persistent `userDataDir` keeps it off the user's
 *     default profile.
 * The default is unchanged — bundled Chromium + stealth + fresh profile —
 * so existing agents behave exactly as before.
 */

const USE_STEALTH = process.env.AMBIT_NO_STEALTH !== '1';
const CHROME_CHANNEL = process.env.AMBIT_CHROME_CHANNEL || undefined;
if (USE_STEALTH) chromium.use(StealthPlugin());

// Strip the automation fingerprint Chrome advertises by default. This is
// what sites like Google sniff ("this browser may not be secure"). Reduces
// detection but does not fully defeat Google OAuth — the agent should only
// need a Vendoo email/password session, not Google, in the automated browser.
// AMBIT_BROWSER_ARGS: extra space-separated Chromium flags (e.g.
// "--disable-gpu" to force software rendering when head-full text
// rasterizes as garbled on screen — the DOM/screenshots are unaffected).
const EXTRA_ARGS = (process.env.AMBIT_BROWSER_ARGS || '').split(/\s+/).filter(Boolean);
const ANTI_AUTOMATION = {
  args: ['--disable-blink-features=AutomationControlled', ...EXTRA_ARGS],
  ignoreDefaultArgs: ['--enable-automation'],
};

export interface BrowserHandle {
  page: Page;
  context: BrowserContext;
  browser: Browser | null;
  close: () => Promise<void>;
}

/**
 * Explicit browser mode. Sourced from the agent's `ambit.json` `browser`
 * field (rides the `run_task` WS message). When set, the manifest wins
 * over env vars. When unset (agents uploaded before Phase 1), the
 * env-var branches below still apply for backward compat.
 *
 * `attached_chrome` — connect over CDP to a customer-managed Chrome.
 *   Requires the connection URL. Phase 1 still reads it from
 *   `AMBIT_ATTACH_CDP`; Phase 2 will have the daemon own Chrome lifecycle
 *   and pass the URL directly.
 * `chromium` — Playwright's bundled Chromium (the legacy default).
 *   Fresh temp profile unless persistentProfileDir is set.
 */
export type BrowserModel = 'attached_chrome' | 'chromium';

export interface LaunchOptions {
  headless?: boolean;
  /** When set, launch a PERSISTENT context at this dir so cookies /
   *  logins survive across runs. Omit for the default fresh profile. */
  persistentProfileDir?: string;
  /** Manifest-declared browser mode. Wins over env-var-driven behavior. */
  model?: BrowserModel;
  /**
   * CDP URL supplied by the caller (typically the daemon-managed Chrome
   * from `ChromeManager.whenReady()`). When set, `attached_chrome` mode
   * uses this instead of reading `AMBIT_ATTACH_CDP` from the env — Phase 2
   * of the browser-model rollout removes the env-var requirement for
   * customers running the daemon.
   */
  attachCdpUrl?: string;
}

const missingBinary = (err: unknown): boolean =>
  /Executable doesn't exist|Please run:/.test((err as Error)?.message ?? String(err));

const BINARY_HINT =
  'Playwright Chromium binary is missing on this runtime. ' +
  'Install it with:  npx playwright install chromium';

export async function launchBrowser(
  { headless = true, persistentProfileDir, model, attachCdpUrl }: LaunchOptions = {},
): Promise<BrowserHandle> {
  // Precedence:
  //   1. If the manifest declares model='attached_chrome', use attach mode
  //      unconditionally. The URL comes from (in order):
  //        a. the caller-supplied attachCdpUrl (Phase 2 daemon-managed Chrome)
  //        b. AMBIT_ATTACH_CDP env var (dev override, or pre-Phase-2 installs)
  //      Neither present = hard error.
  //   2. If the manifest declares model='chromium', skip attach entirely
  //      even if AMBIT_ATTACH_CDP is set (staff opted into Chromium; respect
  //      that).
  //   3. If the manifest doesn't declare a model (undefined — agents from
  //      before Phase 1), fall back to env-var behavior: attach if
  //      AMBIT_ATTACH_CDP is set, else launch Chromium.
  const envAttachCdp = process.env.AMBIT_ATTACH_CDP;
  const shouldAttach =
    model === 'attached_chrome'
      ? true
      : model === 'chromium'
        ? false
        : Boolean(envAttachCdp || attachCdpUrl);

  if (shouldAttach) {
    // Env var wins over caller-supplied URL — that's the dev-override
    // contract. Customers on the daemon-managed path don't set the env
    // and get the manager's URL automatically.
    const cdpUrl = envAttachCdp || attachCdpUrl;
    if (!cdpUrl) {
      throw new Error(
        'Agent manifest declares browser.model="attached_chrome" but no CDP URL ' +
          'is available. Either enable the daemon-managed Chrome ' +
          '(AMBIT_CHROME_ENABLED=true — the default), install Google Chrome so the ' +
          'daemon can launch it, or set AMBIT_ATTACH_CDP=http://localhost:9222 ' +
          'pointing at a Chrome you launched yourself.',
      );
    }
    let browser: Browser;
    try {
      browser = await pwChromium.connectOverCDP(cdpUrl);
    } catch (err) {
      throw new Error(
        `Could not attach to Chrome at ${cdpUrl}. If this is the daemon-managed ` +
          `Chrome, restart the daemon and check its startup logs. If this is your ` +
          `own debug Chrome, verify it's running with --remote-debugging-port. ` +
          `(${(err as Error)?.message ?? err})`,
      );
    }
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    return {
      page,
      context,
      browser,
      // Close our tab AND disconnect the CDP client — otherwise the
      // WebSocket to Chrome's debug port lingers until the daemon process
      // exits. Playwright's connectOverCDP implicitly subscribes to
      // Runtime/Page/Network/Target events on every context and page it
      // sees; every idle stale client makes Chrome serialize and dispatch
      // those events to one more listener. Over dozens of runs on the
      // long-lived daemon, that overhead compounds into "every click and
      // idle frame feels sluggish" for both agents AND manual use of the
      // shared managed Chrome.
      //
      // `browser.close()` on a connectOverCDP Browser only disconnects
      // OUR client — it does not kill the underlying Chrome process. The
      // daemon-managed Chrome (its tabs, cookies, extensions, and the
      // customer's manual browsing) is unaffected.
      close: async () => {
        try { await page.close(); } catch { /* ignore */ }
        try { await browser.close(); } catch { /* ignore */ }
      },
    };
  }

  // ── Persistent profile: reuse a logged-in session across runs. ──
  if (persistentProfileDir) {
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(persistentProfileDir, {
        headless,
        viewport: { width: 1440, height: 900 },
        ...(CHROME_CHANNEL ? { channel: CHROME_CHANNEL } : {}),
        ...ANTI_AUTOMATION,
      });
    } catch (err) {
      if (missingBinary(err)) throw new Error(BINARY_HINT);
      throw err;
    }
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page,
      context,
      browser: context.browser(),
      close: async () => {
        try { await context.close(); } catch { /* ignore */ }
      },
    };
  }

  // ── Default: fresh throwaway profile (full isolation). ──
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless,
      ...(CHROME_CHANNEL ? { channel: CHROME_CHANNEL } : {}),
      ...ANTI_AUTOMATION,
    });
  } catch (err) {
    if (missingBinary(err)) throw new Error(BINARY_HINT);
    throw err;
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  return {
    page,
    context,
    browser,
    close: async () => {
      try { await context.close(); } catch { /* ignore */ }
      try { await browser.close(); } catch { /* ignore */ }
    },
  };
}
