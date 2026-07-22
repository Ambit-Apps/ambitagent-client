import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { Logger } from '../log.js';
import type { Config } from '../config.js';
import { detectChromeBinary, chromeInstallHint } from './detect.js';

/**
 * Managed-Chrome lifecycle. The daemon launches a dedicated Chrome for
 * browser-type agents that use `browser.model: "attached_chrome"` and
 * keeps it running for the daemon's lifetime.
 *
 * Design decisions locked in this pass:
 *
 *   • Launch on daemon startup (not on-demand). Customer machines are
 *     typically laptops with a person present; the window being up
 *     immediately means they see it, do their one-time login + extension
 *     install, and every subsequent agent run is instant. Headless
 *     server VMs that don't need Chrome set `AMBIT_CHROME_ENABLED=false`.
 *
 *   • Dedicated user-data-dir + dedicated port. Never touches the
 *     customer's personal Chrome profile. Port collision = fail with a
 *     clear error rather than silently choosing another port and losing
 *     agents in a confusing "which Chrome are we talking to?" swamp.
 *
 *   • Auto-restart on unexpected exit, with exponential backoff (1s, 5s,
 *     30s, 2min). After 4 back-to-back restarts we stop trying and log
 *     an error — the customer probably has a reason for closing it,
 *     and we don't want to fight them.
 *
 *   • Level-2 branding: after launch, we open a persistent welcome tab
 *     via CDP with `<title>Ambit Agent — Managed Chrome</title>` and a
 *     one-liner explaining what the window is. That title identifies
 *     the window in the customer's taskbar so they don't confuse it
 *     with their personal Chrome.
 *
 * Env-var override: `AMBIT_ATTACH_CDP` still wins — if the operator
 * has manually launched their own debug Chrome and pointed the daemon
 * at it, we don't second-guess. Useful for dev + the transitional
 * period while customers upgrade to the daemon-managed model.
 */

const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000] as const;
const HEALTH_POLL_INTERVAL_MS = 10_000;
const HEALTH_STARTUP_TIMEOUT_MS = 30_000;
const CDP_HEALTH_PATH = '/json/version';

const WELCOME_TAB_HTML = `
<!doctype html>
<meta charset="utf-8">
<title>Ambit Agent — Managed Chrome</title>
<style>
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         color: #1f2328; background: #fafbfc; padding: 48px 40px; max-width: 620px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 10px; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 12.5px; }
  p { margin: 12px 0; }
  .callout { background: #fff8db; border-left: 3px solid #d4b83e; padding: 12px 14px; border-radius: 4px; margin: 20px 0; }
</style>
<h1>Ambit Agent — Managed Chrome</h1>
<p>This window is managed by the Ambit runtime daemon. Leave it running.</p>
<p>Do your one-time logins and extension installs here. They persist across
runs. Any agent that needs a browser attaches a new tab to this window and
drives it visibly.</p>
<div class="callout">
  <strong>Safe to use as normal:</strong> this is a real Chrome, isolated from
  your personal profile. Anything you log into here is available only to
  Ambit agents.
</div>
`.trim();

export interface ChromeManager {
  /** True when Chrome is up and responding on the CDP port. */
  isReady(): boolean;
  /** Await Chrome being ready. Rejects if it never comes up within the timeout. */
  whenReady(): Promise<string>;
  /** CDP URL (e.g. `http://localhost:9222`) — null if not ready. */
  currentUrl(): string | null;
  /** Clean shutdown — kills the Chrome process and stops the monitor loop. */
  stop(): Promise<void>;
}

/**
 * No-op manager returned when Chrome management is disabled (headless
 * server VMs, or `AMBIT_ATTACH_CDP` is set — see startChromeManager()).
 */
class DisabledChromeManager implements ChromeManager {
  isReady(): boolean { return false; }
  async whenReady(): Promise<string> {
    throw new Error(
      'Chrome is not managed by this daemon (AMBIT_CHROME_ENABLED=false or AMBIT_ATTACH_CDP is set). ' +
        'Nothing to wait for.',
    );
  }
  currentUrl(): string | null { return null; }
  async stop(): Promise<void> { /* nothing to stop */ }
}

/**
 * Factory. Returns a real manager only when management is on AND no env
 * override is present. Otherwise returns the DisabledChromeManager stub —
 * the executor's env-var fallback (AMBIT_ATTACH_CDP or manifest+env) takes
 * over from there.
 */
export function startChromeManager(config: Config, log: Logger): ChromeManager {
  if (!config.chromeEnabled) {
    log.info({ reason: 'AMBIT_CHROME_ENABLED=false' }, 'Chrome management disabled');
    return new DisabledChromeManager();
  }
  // If the operator already pointed us at a Chrome via env var, we let
  // that win. Managing a second one would just confuse things.
  if (process.env.AMBIT_ATTACH_CDP) {
    log.info(
      { attachCdp: process.env.AMBIT_ATTACH_CDP },
      'Chrome management skipped — AMBIT_ATTACH_CDP overrides',
    );
    return new DisabledChromeManager();
  }

  const binary = config.chromePath || detectChromeBinary();
  if (!binary) {
    log.error({ hint: chromeInstallHint() }, 'Google Chrome not found');
    return new DisabledChromeManager();
  }

  return new RealChromeManager(config, log, binary);
}

// ─── Implementation ─────────────────────────────────────────────────

type State = 'idle' | 'starting' | 'ready' | 'restarting' | 'stopped';

class RealChromeManager implements ChromeManager {
  private state: State = 'idle';
  private process: ChildProcess | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private readyResolvers: Array<(url: string) => void> = [];
  private readyRejecters: Array<(err: Error) => void> = [];
  private url: string;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly binary: string,
  ) {
    this.url = `http://localhost:${config.chromePort}`;
    void this.start();
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  currentUrl(): string | null {
    return this.state === 'ready' ? this.url : null;
  }

  whenReady(): Promise<string> {
    if (this.state === 'ready') return Promise.resolve(this.url);
    if (this.state === 'stopped') {
      return Promise.reject(new Error('Chrome manager is stopped'));
    }
    return new Promise((resolve, reject) => {
      this.readyResolvers.push(resolve);
      this.readyRejecters.push(reject);
    });
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    if (this.healthTimer) clearInterval(this.healthTimer);
    const p = this.process;
    this.process = null;
    if (p && !p.killed) {
      p.kill('SIGTERM');
      // Give it 3s to exit gracefully, then SIGKILL.
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          try { p.kill('SIGKILL'); } catch { /* ignore */ }
          r();
        }, 3_000);
        p.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
    this.rejectPending(new Error('Chrome manager stopped'));
  }

  private async start(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'starting';

    // Adopt an existing debug Chrome if one is already listening on our
    // port. Common transition case: an operator who used the old runbook
    // and launched Chrome by hand starts the daemon; we shouldn't fight
    // that. Also handles the case where the daemon restarts but Chrome
    // survived (dev reload, brief crash), so we skip the double-launch.
    // We do NOT own that Chrome's lifecycle in this case — no monitor
    // loop, no restart, we just report the URL.
    if (await this.pingCdp()) {
      this.log.info(
        { url: this.url },
        'debug Chrome already running on our port — adopting it (lifecycle stays with whoever launched it)',
      );
      this.markReady();
      return;
    }

    this.log.info(
      { binary: this.binary, port: this.config.chromePort, userDataDir: this.config.chromeProfileDir },
      'launching managed Chrome',
    );

    try {
      await mkdir(this.config.chromeProfileDir, { recursive: true });
    } catch (err) {
      this.log.error(
        { userDataDir: this.config.chromeProfileDir, err: (err as Error).message },
        'failed to create Chrome profile dir',
      );
      this.rejectPending(err as Error);
      return;
    }

    const args = [
      `--remote-debugging-port=${this.config.chromePort}`,
      `--user-data-dir=${this.config.chromeProfileDir}`,
      // Explicit no-first-run + no-default-browser-check so the customer
      // doesn't see Chrome's onboarding wizard the first time we launch.
      '--no-first-run',
      '--no-default-browser-check',
      // Land on the welcome tab immediately — the URL argument works as
      // Chrome's "open this at startup" spot. We rewrite the tab's DOM
      // via CDP once Chrome is ready so the title reads "Ambit Agent".
      'about:blank',
    ];

    let proc: ChildProcess;
    try {
      proc = spawn(this.binary, args, {
        stdio: 'ignore',
        detached: false,
      });
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'failed to spawn Chrome');
      this.scheduleRestart();
      return;
    }
    this.process = proc;

    proc.on('exit', (code, signal) => {
      if ((this.state as State) === 'stopped') return; // clean shutdown
      this.log.warn({ code, signal }, 'managed Chrome exited unexpectedly');
      this.state = 'restarting';
      this.scheduleRestart();
    });
    proc.on('error', (err) => {
      this.log.error({ err: err.message }, 'managed Chrome process error');
    });

    // Wait for CDP to come up. Chrome usually binds the debug port within
    // 500ms - 2s after launch; we poll every 250ms up to the startup
    // timeout, then give up + restart.
    const startedAt = Date.now();
    while (Date.now() - startedAt < HEALTH_STARTUP_TIMEOUT_MS) {
      if ((this.state as State) === 'stopped') return;
      if (await this.pingCdp()) {
        this.markReady();
        return;
      }
      await sleep(250);
    }
    this.log.warn(
      { timeoutMs: HEALTH_STARTUP_TIMEOUT_MS },
      'managed Chrome did not respond on debug port — killing and retrying',
    );
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    this.scheduleRestart();
  }

  private markReady(): void {
    this.state = 'ready';
    this.restartAttempt = 0;
    this.log.info({ url: this.url }, 'managed Chrome ready');

    // Fire the welcome tab (level-2 branding) — best-effort, don't block
    // readiness on it. If the CDP call fails, the customer still has a
    // working Chrome; they just don't see the branded title.
    void this.openWelcomeTab().catch((err: Error) => {
      this.log.warn({ err: err.message }, 'welcome tab failed (Chrome is ready anyway)');
    });

    // Fulfill pending whenReady() promises.
    const url = this.url;
    for (const r of this.readyResolvers) r(url);
    this.readyResolvers = [];
    this.readyRejecters = [];

    // Start the ongoing health check.
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_POLL_INTERVAL_MS);
  }

  private async checkHealth(): Promise<void> {
    if (this.state !== 'ready') return;
    const ok = await this.pingCdp();
    if (!ok) {
      this.log.warn({ url: this.url }, 'managed Chrome health check failed');
      // Kill the process to force the exit handler to schedule a restart.
      // The exit handler is the single restart entry-point — don't call
      // scheduleRestart() from here or we double-fire.
      const p = this.process;
      if (p && !p.killed) {
        try { p.kill('SIGKILL'); } catch { /* ignore */ }
      } else if (!p) {
        // No process but state says ready — inconsistent, force-restart.
        this.state = 'restarting';
        this.scheduleRestart();
      }
    }
  }

  private scheduleRestart(): void {
    if (this.state === 'stopped') return;
    if (this.restartAttempt >= BACKOFF_MS.length) {
      this.log.error(
        { attempts: this.restartAttempt },
        'managed Chrome failed too many times consecutively — giving up. ' +
          'Restart the daemon to try again, or check for another Chrome using port ' +
          `${this.config.chromePort}.`,
      );
      this.state = 'idle';
      this.rejectPending(new Error('managed Chrome failed to stay running'));
      return;
    }
    const delay = BACKOFF_MS[this.restartAttempt];
    this.restartAttempt += 1;
    this.log.info({ attempt: this.restartAttempt, delayMs: delay }, 'scheduling Chrome restart');
    setTimeout(() => void this.start(), delay);
  }

  private async pingCdp(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}${CDP_HEALTH_PATH}`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Open the welcome tab via CDP. We use `Target.createTarget` with a
   * data URL so there's no local file dependency — the HTML travels
   * inline in the URL. That tab identifies our Chrome window and gives
   * the customer a one-time explanation without needing an external asset.
   */
  private async openWelcomeTab(): Promise<void> {
    // Encode the welcome HTML as a data URL. Chrome accepts these
    // for `Target.createTarget` and the resulting tab has the right title.
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(WELCOME_TAB_HTML);
    // The blank tab we launched with `about:blank` is still there; instead
    // of creating a second tab, navigate the existing one via CDP.
    try {
      const list = await fetch(`${this.url}/json/list`).then((r) => r.json() as Promise<Array<{
        id: string;
        type: string;
        url: string;
      }>>);
      const blank = list.find((t) => t.type === 'page' && t.url === 'about:blank') ?? list.find((t) => t.type === 'page');
      if (blank) {
        await fetch(`${this.url}/json/activate/${blank.id}`).catch(() => {});
      }
      // Simplest reliable path: use the new-tab endpoint with our URL.
      await fetch(`${this.url}/json/new?${encodeURIComponent(dataUrl)}`, { method: 'PUT' }).catch(
        async () => {
          // Older Chrome / restricted setups block the /json/new PUT path.
          // Fall back to a GET (deprecated but widely supported).
          await fetch(`${this.url}/json/new?${encodeURIComponent(dataUrl)}`);
        },
      );
    } catch {
      // Non-fatal — Chrome still works, just no welcome tab.
    }
  }

  private rejectPending(err: Error): void {
    for (const r of this.readyRejecters) r(err);
    this.readyResolvers = [];
    this.readyRejecters = [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
