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
 */

chromium.use(StealthPlugin());

export interface BrowserHandle {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  close: () => Promise<void>;
}

export async function launchBrowser(
  { headless = true }: { headless?: boolean } = {},
): Promise<BrowserHandle> {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (/Executable doesn't exist|Please run:/.test(msg)) {
      throw new Error(
        'Playwright Chromium binary is missing on this runtime. ' +
          'Install it with:  npx playwright install chromium',
      );
    }
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
