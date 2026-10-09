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
 *
 *   AMBIT_PAGE_TIMEOUT_MS       default ceiling for every Playwright
 *     operation, in ms (default 60000). Raise it on a slow customer
 *     machine; an agent that sets its own page-level default still wins.
 *     See defaultTimeoutMs() below for why this lives here.
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
  /** The default operation ceiling in force for this run, so the caller can
   *  log it — a timeout is much easier to read when the log says what the
   *  limit was and which env var moves it. */
  defaultTimeoutMs: number;
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
  /**
   * The run's inputs, used ONLY to work out which already-open tab this agent
   * belongs on (see `pickStartingPage`). Never logged, never sent anywhere —
   * inputs can carry customer data.
   */
  inputs?: Record<string, unknown>;
  /**
   * Called once the starting page is chosen, so the caller can log whether an
   * existing tab was reused. This module does no logging of its own.
   */
  onTabChosen?: (reused: boolean, reason: string) => void;
  /** Called each time the self-healing page replaces a closed tab. */
  onPageRecreated?: () => void;
  /**
   * Run's abort signal. When aborted, the self-healing page proxy
   * refuses to re-open replacement tabs and throws on any async op —
   * kills the "close tab → self-heal reopens → agent's retry loop
   * hammers Chrome forever" pattern seen when scripts don't propagate
   * cancellation.
   */
  signal?: AbortSignal;
}

const missingBinary = (err: unknown): boolean =>
  /Executable doesn't exist|Please run:/.test((err as Error)?.message ?? String(err));

/**
 * The default ceiling for every Playwright operation the agent performs.
 *
 * ── WHY THE CLIENT SETS THIS AND NOT EACH AGENT ──
 * Playwright's own default is 30s, chosen for CI on a developer's machine.
 * Our agents run on whatever laptop the customer happens to own, and at
 * the time of writing exactly ONE agent out of twelve had ever set its own
 * default — the one that already had a bad night on a slow Windows box.
 * Every other agent, and every agent not yet written, silently inherited
 * 30s. That is a machine-speed assumption hiding in a library default, and
 * the only place it can be fixed once is here.
 *
 * ── THE OVERRIDE CONTRACT ──
 * This is set on the CONTEXT, not the page, for two reasons. A page-level
 * default would be lost the moment the self-healing proxy replaces a closed
 * tab (`setDefaultTimeout` binds to the page that existed when it was
 * called — see SYNC_PAGE_METHODS), whereas a context default is inherited
 * by every page created later. And Playwright resolves page-level over
 * context-level, so an agent calling `page.setDefaultTimeout(90_000)` still
 * wins outright. Agents keep full control; they just no longer have to
 * remember to take it.
 *
 * Read lazily, never as a module-level const: `loadConfig()` merges the
 * customer's config FILE into `process.env` at runtime, which happens after
 * this module is imported, so a module-load read would silently ignore a
 * file-only override. Same trap documented at length in chrome/manager.ts.
 */
function defaultTimeoutMs(): number {
  const n = Number(process.env.AMBIT_PAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000;
}

/** Apply the default ceiling to a context and report it, so the run log says
 *  which number was in force when something timed out. */
function applyDefaultTimeout(context: BrowserContext): number {
  const ms = defaultTimeoutMs();
  context.setDefaultTimeout(ms);
  context.setDefaultNavigationTimeout(ms);
  return ms;
}

/**
 * Page methods that return synchronously — they can't await a heal, so
 * they forward to the current page as-is. Everything else (goto, click,
 * screenshot, evaluate, …) is async and gets the heal-first treatment.
 */
const SYNC_PAGE_METHODS = new Set([
  'url', 'isClosed', 'viewportSize', 'video', 'frames', 'mainFrame', 'context',
  'workers', 'locator', 'frameLocator', 'getByRole', 'getByText', 'getByLabel',
  'getByTestId', 'getByPlaceholder', 'getByAltText', 'getByTitle',
  'on', 'off', 'once', 'addListener', 'removeListener', 'removeAllListeners',
  'emit', 'listenerCount', 'setDefaultTimeout', 'setDefaultNavigationTimeout',
]);

/**
 * Wrap a Page so the run survives its tab being closed mid-flight.
 *
 * Approval gates leave runs paused for minutes-to-hours with an open tab
 * parked in the customer's managed Chrome — and customers close stray
 * tabs. Without this, the first `page.goto` after resume throws "Target
 * page ... has been closed" and the whole run dies (observed on run 106).
 *
 * Every async op first checks `isClosed()` and transparently opens a
 * replacement tab in the same context. Sync accessors (url, locator, …)
 * forward to the current page unhealed — safe in practice because agent
 * flows always hit an async op (goto/waitForTimeout) before sync reads
 * after any long pause.
 */
function selfHealingPage(
  context: BrowserContext,
  initial: Page,
  onRecreate?: () => void,
  signal?: AbortSignal,
): { proxy: Page; closeCurrent: () => Promise<void> } {
  let current = initial;
  const proxy = new Proxy(initial, {
    get(_target, prop) {
      const value = (current as unknown as Record<PropertyKey, unknown>)[prop];
      if (typeof value !== 'function') return value;
      const name = String(prop);
      if (SYNC_PAGE_METHODS.has(name) || name === 'close' || typeof prop === 'symbol') {
        return (value as (...a: unknown[]) => unknown).bind(current);
      }
      return async (...args: unknown[]) => {
        // Post-cancel: refuse to keep the run alive. Without this,
        // browser.close() from the abort listener closes the tab, then
        // the next agent-code retry hits self-heal → context.newPage()
        // → throws → agent catches → retries → tight loop hammering
        // Chrome (and, until Fix B lands on admin, hammering admin
        // too). Throwing signal.reason gives the agent a coherent
        // CancelledError to catch (or propagate).
        if (signal?.aborted) {
          throw signal.reason ?? new Error('page unavailable — run cancelled');
        }
        if (current.isClosed()) {
          current = await context.newPage();
          onRecreate?.();
        }
        return (current as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
      };
    },
  }) as Page;
  return {
    proxy,
    closeCurrent: async () => {
      try { if (!current.isClosed()) await current.close(); } catch { /* ignore */ }
    },
  };
}

const BINARY_HINT =
  'Playwright Chromium binary is missing on this runtime. ' +
  'Install it with:  npx playwright install chromium';

/**
 * Every hostname the run's inputs point at.
 *
 * The agent is told where it is going — `ecw_login_url`, `url`, a dashboard
 * link — and that is a far stronger signal about which tab it belongs on than
 * anything the client could guess. Deliberately generic: no EMR or vendor names
 * are hardcoded here, so this works for every agent without a manifest change,
 * and an agent whose inputs contain no URL simply gets today's behaviour.
 */
function inputHostnames(inputs: Record<string, unknown> | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const value of Object.values(inputs ?? {})) {
    if (typeof value !== 'string') continue;
    if (!/^https?:\/\//i.test(value)) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      /* a malformed URL is simply not a hint */
    }
  }
  return hosts;
}

/**
 * Reuse the already-authenticated tab when there is one, rather than opening a
 * fresh one beside it.
 *
 * ── WHY ──
 * The daemon-managed Chrome persists a profile so a human signs in once, and
 * with `context.newPage()` every run opened a NEW tab next to the signed-in
 * one. Tabs accumulate run after run, and an agent that expects to find itself
 * already inside an application starts on `about:blank` instead.
 *
 * ── THE SAFETY RULE, WHICH IS THE WHOLE POINT ──
 * A tab is only reused when its hostname matches a URL the agent was actually
 * given. If nothing matches, we open a fresh tab — we never fall back to
 * "whatever tab happens to be open". Ported from the Playwright repo's
 * BaseTask, where that branch was load-bearing: staff had personal tabs open in
 * the debug Chrome and the task would otherwise attach to one of them and fail
 * in confusing ways.
 *
 * Polled, because a tab can briefly be `about:blank` right after Chrome boots
 * or sit mid-redirect (eCW bounces the login URL to a load-balanced host), and
 * grabbing it in that state is the same bug in slower motion.
 *
 * Only decides the page the agent STARTS on. Agents that open further tabs
 * themselves are unaffected.
 */
async function pickStartingPage(
  context: BrowserContext,
  inputs: Record<string, unknown> | undefined,
): Promise<{ page: Page; reused: boolean; reason: string }> {
  const wanted = inputHostnames(inputs);
  if (wanted.size === 0) {
    return { page: await context.newPage(), reused: false, reason: 'no URL in inputs to match against' };
  }

  const POLL_MS = 200;
  const ATTEMPTS = 15; // ~3s
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      let host: string;
      try {
        host = new URL(page.url()).hostname.toLowerCase();
      } catch {
        continue; // about:blank and friends
      }
      if (wanted.has(host)) {
        return { page, reused: true, reason: `matched ${host}` };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  return {
    page: await context.newPage(),
    reused: false,
    reason: `no open tab matched ${[...wanted].join(', ')}`,
  };
}

export async function launchBrowser(
  { headless = true, persistentProfileDir, model, attachCdpUrl, inputs, onTabChosen, onPageRecreated, signal }: LaunchOptions = {},
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
    const timeoutMs = applyDefaultTimeout(context);
    const picked = await pickStartingPage(context, inputs);
    // This module deliberately does no logging of its own — the caller owns
    // that, same as onPageRecreated.
    onTabChosen?.(picked.reused, picked.reason);
    const healed = selfHealingPage(context, picked.page, onPageRecreated, signal);
    return {
      page: healed.proxy,
      context,
      browser,
      defaultTimeoutMs: timeoutMs,
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
      //
      // AMBIT_KEEP_TAB_OPEN=1 skips the `page.close()` step — the tab
      // stays visible in the managed Chrome after the run so the
      // customer can inspect what the agent typed. The CDP disconnect
      // still runs (Playwright event listeners are released), so the
      // Chrome-slowdown concern above still applies to the CLIENT side
      // but the visible tab lingers. Recommended only during agent
      // development / testing; leave OFF in steady-state production so
      // tabs don't accumulate over dozens of runs.
      close: async () => {
        if (process.env.AMBIT_KEEP_TAB_OPEN !== '1') {
          // closeCurrent, not page.close(): after a mid-run self-heal the
          // live tab is a REPLACEMENT page — close whatever is current.
          await healed.closeCurrent();
        }
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
    const timeoutMs = applyDefaultTimeout(context);
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page: selfHealingPage(context, page, onPageRecreated, signal).proxy,
      context,
      browser: context.browser(),
      defaultTimeoutMs: timeoutMs,
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
  const timeoutMs = applyDefaultTimeout(context);
  const page = await context.newPage();

  return {
    page: selfHealingPage(context, page, onPageRecreated).proxy,
    context,
    browser,
    defaultTimeoutMs: timeoutMs,
    close: async () => {
      try { await context.close(); } catch { /* ignore */ }
      try { await browser.close(); } catch { /* ignore */ }
    },
  };
}
