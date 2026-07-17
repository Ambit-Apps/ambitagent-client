import { chromium } from 'playwright-extra';
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
 * the fresh-temp-profile isolation above. Stealth + bundled Chromium
 * still apply.
 */

chromium.use(StealthPlugin());

export interface BrowserHandle {
  page: Page;
  context: BrowserContext;
  browser: Browser | null;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  headless?: boolean;
  /** When set, launch a PERSISTENT context at this dir so cookies /
   *  logins survive across runs. Omit for the default fresh profile. */
  persistentProfileDir?: string;
}

const missingBinary = (err: unknown): boolean =>
  /Executable doesn't exist|Please run:/.test((err as Error)?.message ?? String(err));

const BINARY_HINT =
  'Playwright Chromium binary is missing on this runtime. ' +
  'Install it with:  npx playwright install chromium';

export async function launchBrowser(
  { headless = true, persistentProfileDir }: LaunchOptions = {},
): Promise<BrowserHandle> {
  // ── Persistent profile: reuse a logged-in session across runs. ──
  if (persistentProfileDir) {
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(persistentProfileDir, {
        headless,
        viewport: { width: 1440, height: 900 },
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
    browser = await chromium.launch({ headless });
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
