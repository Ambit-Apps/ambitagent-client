import { exec, spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { WebSocket } from 'ws';
import type { Logger } from '../log.js';
import type { Config } from '../config.js';
import {
  chromeInstallHint,
  detectChromeBinary,
  DEVTOOLS_POLICY_FIX,
  devToolsDisabledReason,
} from './detect.js';

/**
 * Managed-Chrome lifecycle. The daemon launches a dedicated Chrome for
 * browser-type agents that use `browser.model: "attached_chrome"` and
 * keeps it running for the daemon's lifetime.
 *
 * Design decisions locked in this pass:
 *
 *   • Lazy launch on first agent run (NOT at daemon startup). The
 *     daemon sits idle at 0 Chrome-related memory until admin sends a
 *     run_task that needs a browser. `whenReady()` triggers the launch
 *     the first time it's called; subsequent calls hit the ready cache.
 *     Rationale: customers hated seeing Chrome pop up at boot when they
 *     had no intention of running an agent that hour. Trade-off is a
 *     ~2s cold-start on the first run after login; every subsequent
 *     run reuses the already-ready Chrome and is instant.
 *
 *   • User-initiated close is respected. If the customer clicks the
 *     Chrome window's X button (clean exit, code 0), we go back to
 *     idle — we do NOT auto-relaunch. The next agent run brings it
 *     back. Only crashes (non-zero exit or signal death) trigger the
 *     restart-with-backoff logic below.
 *
 *   • Dedicated user-data-dir + dedicated port. Never touches the
 *     customer's personal Chrome profile. Port collision = fail with a
 *     clear error rather than silently choosing another port and losing
 *     agents in a confusing "which Chrome are we talking to?" swamp.
 *
 *   • Auto-restart on CRASH only (not user close), with exponential
 *     backoff (1s, 5s, 30s, 2min). After 4 back-to-back restarts we
 *     go back to idle so the customer's next agent run gets a fresh
 *     attempt with a fresh restart budget.
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
const CDP_HEALTH_PATH = '/json/version';

/**
 * Health-probe tuning. Env-overridable ON PURPOSE: these are the numbers
 * that decide whether a slow machine's Chrome gets killed mid-run, and
 * getting a corrected build onto a customer laptop is far more expensive
 * than editing one line of `C:\ProgramData\Ambit Agent\config`. Tune there
 * first; only change the defaults if a value turns out to be wrong for
 * everyone.
 *
 * Read LAZILY (functions, not consts) so an override always wins no matter
 * when it lands in `process.env`. A module-load read looks equivalent and is
 * not: `loadConfig()` merges the config FILE into `process.env` at runtime,
 * which happens after this module is imported, so a file-only override would
 * have been silently ignored.
 */
function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

const healthPollIntervalMs = () => envInt('AMBIT_CHROME_HEALTH_INTERVAL_MS', 10_000);

/**
 * How long one CDP probe may take before it counts as a failure.
 *
 * Was a hardcoded 5s, on the theory that "a healthy browser answers in
 * milliseconds". True — but a browser that is *busy* is not unhealthy, and
 * `--disable-gpu` software rendering on an old iGPU saturates every core
 * while painting a heavy grid. The browser process then can't service
 * `Target.getTargets` inside 5s and we shot a perfectly alive Chrome.
 */
const healthPingTimeoutMs = () => envInt('AMBIT_CHROME_HEALTH_PING_TIMEOUT_MS', 15_000);

/**
 * Consecutive failed probes required before we treat Chrome as dead.
 *
 * WHY THIS IS NOT 1 (it was, and it cost a customer three nights of runs).
 * A single missed probe is indistinguishable from "Chrome is mid-render on a
 * slow laptop". The old code SIGKILLed on the first failure, which meant the
 * heavier the page, the more likely we were to kill the very Chrome an agent
 * was actively driving — surfacing to the agent as the maddening
 * `Target page, context or browser has been closed`. Requiring N in a row
 * means Chrome has to be unresponsive for roughly
 * N × healthPollIntervalMs() before it dies, so transient render storms are
 * ridden out while a genuinely dead Chrome is still reaped (~30-45s) and
 * restarted for the next run.
 */
const healthMaxFailures = () => envInt('AMBIT_CHROME_HEALTH_MAX_FAILURES', 3);

/**
 * How long Chrome gets to bind its debug port after launch.
 *
 * WHY 90s AND NOT 30s (which is what this was, as a hardcoded const).
 * The asymmetry here is the whole argument. Too LONG and a genuinely
 * broken machine takes longer to report a failure it was going to report
 * anyway. Too SHORT and we SIGKILL a Chrome that was coming up fine —
 * which then burns the entire restart ladder (1s/5s/30s/2min, 4 attempts)
 * failing the identical way each time, and reports a port conflict that
 * isn't there. One costs patience; the other costs the customer their
 * morning. A first-ever chrome.exe launch behind an on-access antivirus
 * scan, on a cold profile dir, on the kind of laptop we actually install
 * on, is realistically north of 30s.
 *
 * This is also the reason it's env-tunable now: it sat as a bare `const`
 * among three knobs that were deliberately made overridable after the
 * Sept-26 incident, and it is the same class of number as all three.
 */
const startupTimeoutMs = () => envInt('AMBIT_CHROME_STARTUP_TIMEOUT_MS', 90_000);

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
 * No-op manager returned when Chrome management is disabled. Constructor
 * takes the specific reason so `whenReady()` throws an actionable error
 * — the old catch-all message ("AMBIT_CHROME_ENABLED=false or AMBIT_ATTACH_CDP
 * is set") caused an hours-long debugging detour when the real reason
 * was "Google Chrome not found" and the customer was told to check the
 * wrong things.
 */
class DisabledChromeManager implements ChromeManager {
  constructor(private readonly reason: string) {}
  isReady(): boolean { return false; }
  async whenReady(): Promise<string> {
    throw new Error(this.reason);
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
    return new DisabledChromeManager(
      'Chrome management is disabled by config (AMBIT_CHROME_ENABLED=false). ' +
        'Remove that env var / config line and restart the daemon to enable managed Chrome.',
    );
  }
  // If the operator already pointed us at a Chrome via env var, we let
  // that win. Managing a second one would just confuse things.
  if (process.env.AMBIT_ATTACH_CDP) {
    log.info(
      { attachCdp: process.env.AMBIT_ATTACH_CDP },
      'Chrome management skipped — AMBIT_ATTACH_CDP overrides',
    );
    return new DisabledChromeManager(
      `AMBIT_ATTACH_CDP is set (${process.env.AMBIT_ATTACH_CDP}), so the daemon defers ` +
        'Chrome lifecycle to whatever launched the debug Chrome at that URL. ' +
        'Verify that Chrome is actually running with --remote-debugging-port set correctly, ' +
        'or unset AMBIT_ATTACH_CDP to let the daemon manage its own Chrome.',
    );
  }

  const binary = config.chromePath || detectChromeBinary();
  if (!binary) {
    log.error({ hint: chromeInstallHint() }, 'Google Chrome not found');
    return new DisabledChromeManager(
      'Google Chrome is not installed on this machine (checked standard install ' +
        'locations for the current platform). ' + chromeInstallHint(),
    );
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
  /** Consecutive failed health probes. Reset by any success, and on every
   *  state transition, so a streak can never leak across Chrome instances. */
  private healthFailures = 0;
  private readyResolvers: Array<(url: string) => void> = [];
  private readyRejecters: Array<(err: Error) => void> = [];
  private url: string;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly binary: string,
  ) {
    this.url = `http://localhost:${config.chromePort}`;
    // NOTE: no `void this.start()` here. Chrome launches on first
    // `whenReady()` call — see the lazy-launch note in the file header.
    this.log.info(
      { binary: this.binary, port: this.config.chromePort },
      'Chrome manager ready — Chrome will launch on first agent run',
    );
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
    const promise = new Promise<string>((resolve, reject) => {
      this.readyResolvers.push(resolve);
      this.readyRejecters.push(reject);
    });
    // Lazy-launch: fire start() on the FIRST call from idle. Subsequent
    // calls while 'starting' / 'restarting' just wait for the in-flight
    // start to reach markReady(). This is what makes the "user closes
    // Chrome → back to idle → next agent run relaunches it" cycle work.
    if (this.state === 'idle') {
      void this.start();
    }
    return promise;
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    if (this.healthTimer) clearInterval(this.healthTimer);
    const p = this.process;
    this.process = null;

    // Only kill Chrome if we launched it. If we adopted an existing
    // debug Chrome at startup, `this.process` was never set — that
    // Chrome's lifecycle belongs to whoever launched it, not to us.
    if (p) {
      if (process.platform === 'darwin') {
        // The ChildProcess is `open` (already exited long ago). Find
        // Chrome by our debug port and TERM it directly.
        const chromePid = await this.findChromePid();
        if (chromePid != null) {
          try { process.kill(chromePid, 'SIGTERM'); } catch { /* already gone */ }
          await this.waitForProcessExit(chromePid, 3_000);
        }
      } else if (!p.killed) {
        p.kill('SIGTERM');
        // Give Chrome 3s to exit gracefully, then SIGKILL.
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
    }

    this.rejectPending(new Error('Chrome manager stopped'));
  }

  /**
   * Find the Chrome process by the debug port it's listening on. Used
   * only on macOS where we launch via `open` and don't have a live
   * ChildProcess to send signals to. `lsof -ti :PORT` returns the PID
   * (or empty on nothing listening). Returns null if not found.
   */
  private async findChromePid(): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      exec(`lsof -ti :${this.config.chromePort}`, (err, stdout) => {
        if (err) return resolve(null);
        const pid = Number.parseInt(stdout.trim().split('\n')[0], 10);
        resolve(Number.isNaN(pid) ? null : pid);
      });
    });
  }

  /**
   * Poll until the given PID no longer exists (via kill(pid, 0) signal
   * probe), or SIGKILL it if it's still alive at the deadline. Used to
   * confirm a SIGTERM took effect before returning from stop().
   */
  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0); // signal 0 = existence check, no signal sent
      } catch {
        return; // process is gone
      }
      await sleep(100);
    }
    // Still alive at the deadline — escalate to SIGKILL.
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }

  private async start(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'starting';

    // Warn BEFORE launching, not on failure. With DevTools disabled by policy
    // Chrome starts perfectly and serves its debug endpoints — the failure only
    // shows up much later, inside Playwright, as an unreadable `_page` error.
    // Logging it here means the daemon says what is wrong at startup, which is
    // also where a customer's installer output will be looked at.
    try {
      const reason = await devToolsDisabledReason();
      if (reason) this.log.error({ fix: DEVTOOLS_POLICY_FIX }, reason);
    } catch {
      /* diagnostics must never block a launch */
    }

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
      // Force a known-good desktop viewport. Amazon Logistics (and most
      // enterprise dashboards we automate) has a reflow at ~1200px that
      // shifts column geometry — narrower windows put block tiles at
      // pixel positions that our geometry-based day-column scraper
      // misses entirely. Pin FHD here so layout is consistent across
      // customer machines regardless of Chrome's default startup size
      // (which varies by monitor DPI, OS, and per-profile last-window
      // memory). Position at top-left for the same predictability.
      '--window-size=1920,1080',
      '--window-position=0,0',
      // Stop Chrome throttling ITSELF when the customer puts this window
      // behind another one. Chrome deprioritises background and occluded
      // windows by design: timers are clamped, rendering can stop
      // entirely, and raf-driven work stalls. The welcome tab explicitly
      // invites the customer to treat this as a normal browser, so the
      // window WILL end up minimised or covered — and then an agent's
      // perfectly reasonable waits start expiring for a reason that has
      // nothing to do with the site, the network, or the machine's speed.
      // These three flags are the standard automation set and remove the
      // whole category; there is no upside to letting Chrome throttle a
      // window we are actively driving.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];

    // Optionally force software rendering. On machines whose GPU driver
    // kills the renderer on device-loss (see Config.chromeDisableGpu),
    // this trades paint speed for stability — no hardware D3D path means
    // no `exit_on_context_lost` GPU-process death mid-run. Added before
    // the startup URL so the positional `about:blank` stays last.
    if (this.config.chromeDisableGpu) {
      args.push('--disable-gpu');
      this.log.info('managed Chrome launching with --disable-gpu (software rendering)');
    }

    // Land on the welcome tab immediately — the URL argument works as
    // Chrome's "open this at startup" spot. We rewrite the tab's DOM
    // via CDP once Chrome is ready so the title reads "Ambit Agent".
    args.push('about:blank');

    let proc: ChildProcess;
    const isDarwin = process.platform === 'darwin';
    try {
      if (isDarwin) {
        // Use LaunchServices via `open -n -a <bundle> --args ...` on macOS.
        // Direct `child_process.spawn(chromeBinary, ...)` — even with
        // `detached: true` — doesn't give Chrome the WindowServer / GUI-app
        // registration it needs. Chrome-as-a-Node-child feels persistently
        // sluggish for rendering and interaction even though nothing shows
        // up as consuming CPU. `open -n` launches Chrome the same way
        // double-clicking Chrome.app in Finder does.
        //
        // Two consequences we handle below:
        //   • `open` exits immediately after launching Chrome, so we can't
        //     use `proc.on('exit')` to detect Chrome dying. Chrome-death
        //     detection moves entirely to `checkHealth()` polling — see
        //     the darwin branch in that method.
        //   • Shutdown can't use `proc.kill()` on the `open` ref either
        //     (already exited). `stop()` uses `findChromePid()` (lsof on
        //     the debug port) and delivers SIGTERM directly.
        //
        // `this.binary` is the Chrome executable path
        // (…/Chrome.app/Contents/MacOS/Google Chrome); `open -a` needs the
        // .app bundle path, which we derive by trimming the executable
        // suffix.
        const appBundle = this.binary.replace(/\.app\/Contents\/MacOS\/[^/]+$/, '.app');
        const openArgs = ['-n', '-a', appBundle, '--args', ...args];
        proc = spawn('/usr/bin/open', openArgs, { stdio: 'ignore' });
      } else {
        // Linux / Windows: direct spawn works fine — those platforms don't
        // have macOS's GUI-app-vs-service distinction. `detached: true` +
        // `unref()` gives Chrome its own process group and lets the daemon
        // exit cleanly if it needs to.
        proc = spawn(this.binary, args, {
          stdio: 'ignore',
          detached: true,
        });
        proc.unref();
      }
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'failed to spawn Chrome');
      this.scheduleRestart();
      return;
    }
    this.process = proc;

    if (!isDarwin) {
      // On Linux/Windows the ChildProcess IS Chrome — wire its exit event
      // to distinguish user-close from crash. On darwin the ChildProcess
      // is `open` (already exiting momentarily); we ignore its exit and
      // rely on the health check to notice Chrome dying.
      proc.on('exit', (code, signal) => {
        if ((this.state as State) === 'stopped') return; // clean shutdown from stop()
        // User-close signature: exit code 0, no signal. Chrome exits
        // cleanly when the last window closes. Respect that — do NOT
        // auto-relaunch; the next agent run's whenReady() will trigger
        // a fresh start from idle.
        if (code === 0 && !signal) {
          this.log.info(
            { code, signal },
            'managed Chrome exited cleanly (user closed the window) — going idle; next agent run will relaunch',
          );
          this.goIdle();
          return;
        }
        // Anything else = crash. Trigger the exponential-backoff restart.
        this.log.warn({ code, signal }, 'managed Chrome crashed');
        this.state = 'restarting';
        this.scheduleRestart();
      });
    }
    proc.on('error', (err) => {
      this.log.error({ err: err.message }, 'managed Chrome process error');
    });

    // Wait for CDP to come up. Chrome usually binds the debug port within
    // 500ms - 2s after launch; we poll every 250ms up to the startup
    // timeout, then give up + restart.
    //
    // The loop also watches whether the process is still ALIVE, because
    // "hasn't answered yet" has two completely different causes and the
    // old deadline-only loop conflated them: a Chrome that died two
    // seconds in used to be polled at for the remaining 28, and a Chrome
    // that was merely slow used to be shot at the deadline. Now a real
    // death restarts immediately and only a live-but-silent Chrome is
    // allowed to consume the full budget.
    const startedAt = Date.now();
    const deadline = startupTimeoutMs();
    while (Date.now() - startedAt < deadline) {
      if ((this.state as State) === 'stopped') return;
      if (await this.pingCdp()) {
        this.markReady();
        return;
      }
      // Liveness, but NOT on darwin: there we launch via `/usr/bin/open`,
      // whose process exits the instant Chrome is handed off, so its exit
      // code says nothing about Chrome and treating it as death would
      // abort every single macOS launch. Chrome-death detection on darwin
      // lives in checkHealth() instead — see the note in the spawn branch.
      if (!isDarwin && proc.exitCode !== null) {
        this.log.warn(
          { exitCode: proc.exitCode, afterMs: Date.now() - startedAt },
          'managed Chrome exited before it bound the debug port — restarting',
        );
        this.scheduleRestart();
        return;
      }
      await sleep(250);
    }
    this.log.warn(
      { timeoutMs: deadline, env: 'AMBIT_CHROME_STARTUP_TIMEOUT_MS' },
      'managed Chrome stayed alive but never answered on the debug port — killing and retrying. ' +
        'If this machine is simply slow to launch Chrome, raise AMBIT_CHROME_STARTUP_TIMEOUT_MS.',
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

    // Start the ongoing health check. Clear any streak carried over from a
    // previous Chrome instance — this one has answered, by definition.
    this.healthFailures = 0;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => void this.checkHealth(), healthPollIntervalMs());
  }

  private async checkHealth(): Promise<void> {
    if (this.state !== 'ready') return;
    const ok = await this.pingCdp();
    if (ok) {
      // Any success clears the streak — we only act on SUSTAINED silence.
      if (this.healthFailures > 0) {
        this.log.info(
          { after: this.healthFailures },
          'managed Chrome answered again — health failure streak cleared',
        );
        this.healthFailures = 0;
      }
      return;
    }

    this.healthFailures += 1;
    this.log.warn(
      { url: this.url, failures: this.healthFailures, threshold: healthMaxFailures() },
      'managed Chrome health check failed',
    );

    // Not dead yet — a busy Chrome is allowed to miss probes. Only a streak
    // that reaches the threshold is treated as a real death.
    if (this.healthFailures < healthMaxFailures()) return;

    this.log.warn(
      { failures: this.healthFailures, thresholdMs: this.healthFailures * healthPollIntervalMs() },
      'managed Chrome unresponsive for the full threshold — treating as dead',
    );
    this.healthFailures = 0;

    if (process.platform === 'darwin') {
      // On macOS we don't hold a live ChildProcess for Chrome (it was
      // launched via `open`, whose process has long since exited), so
      // we can't distinguish user-close from crash via an exit code.
      // Default to user-close semantics: go idle, wait for the next
      // agent run to relaunch. If it was really a crash, the customer
      // barely notices — their next Run relaunches Chrome anyway.
      // Small trade-off (no auto-recovery on crash for Mac) in exchange
      // for consistent Q1=A/Q2=A behavior across platforms.
      this.log.info('Chrome disappeared on darwin — treating as user-close, going idle');
      this.goIdle();
    } else {
      // Linux/Windows: kill our ChildProcess so its exit handler fires
      // and classifies as user-close vs crash based on exit code.
      // Single entry point avoids double-firing scheduleRestart.
      const p = this.process;
      if (p && !p.killed) {
        try { p.kill('SIGKILL'); } catch { /* ignore */ }
      } else if (!p) {
        // No process but state says ready — inconsistent. Force-idle
        // rather than restart; user-facing behavior stays predictable.
        this.log.warn('health check failed but no ChildProcess to signal — going idle');
        this.goIdle();
      }
    }
  }

  /**
   * Reset to idle state — Chrome is not running, but the manager is
   * healthy and ready to launch again on the next `whenReady()` call.
   * Called from three paths: normal user-close (exit code 0), macOS
   * health-check failure (can't distinguish user-close from crash),
   * and the fall-through after exhausting crash-restart attempts.
   */
  private goIdle(): void {
    this.state = 'idle';
    this.restartAttempt = 0;
    this.healthFailures = 0;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.process = null;
    // Pending whenReady() promises (if any) should NOT be rejected here
    // — they'll be resolved when the next start() completes. Only reject
    // on explicit stop() or crash-restart-exhausted paths.
  }

  private scheduleRestart(): void {
    if (this.state === 'stopped') return;
    if (this.restartAttempt >= BACKOFF_MS.length) {
      this.log.error(
        { attempts: this.restartAttempt },
        'managed Chrome failed too many times consecutively — giving up. ' +
          'Going back to idle; the next agent run will try again with a fresh restart budget. ' +
          'If this keeps happening, the three usual causes are: another Chrome already on port ' +
          `${this.config.chromePort}; a machine too slow to launch Chrome inside ` +
          `AMBIT_CHROME_STARTUP_TIMEOUT_MS (currently ${startupTimeoutMs()}ms — raise it); or a GPU ` +
          'driver killing the renderer (set AMBIT_CHROME_DISABLE_GPU=true). The warning logged on ' +
          'each attempt above says which.',
      );
      this.rejectPending(new Error(
        `Managed Chrome failed to start ${this.restartAttempt} times in a row. Going idle; the ` +
          `next agent run will retry. The per-attempt warnings in the daemon log say whether Chrome ` +
          `died, never answered, or never launched — check those before changing anything.`,
      ));
      this.goIdle();
      return;
    }
    const delay = BACKOFF_MS[this.restartAttempt];
    this.restartAttempt += 1;
    this.log.info({ attempt: this.restartAttempt, delayMs: delay }, 'scheduling Chrome restart');
    setTimeout(() => void this.start(), delay);
  }

  /**
   * Is there a Chrome on our port we can actually DRIVE?
   *
   * ── WHY AN HTTP 200 IS NOT AN ANSWER ──
   * This used to be `res.ok` on /json/version, and a wedged Chrome
   * answers that endpoint perfectly. Run 237 and 238 both adopted a
   * browser whose HTTP was healthy and whose CDP session was not: the
   * WebSocket connected, Playwright then hung for its full 30s, and the
   * run died pointing at the daemon — which was fine.
   *
   * So the check now opens a real CDP session and asks the browser
   * something. `Target.getTargets` is cheap, browser-level, and needs a
   * live message loop to answer, which is the thing that was missing.
   *
   * Deliberately NOT a Playwright `connectOverCDP` probe: closing that
   * handle closes the browser, and killing a Chrome the operator started
   * themselves is not this function's business.
   */
  private async pingCdp(): Promise<boolean> {
    let wsUrl: string;
    try {
      // Bounded: an unbounded fetch against a wedged-but-listening Chrome
      // would hang this probe forever, which silently disables the monitor.
      const res = await fetch(`${this.url}${CDP_HEALTH_PATH}`, {
        signal: AbortSignal.timeout(healthPingTimeoutMs()),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (!body.webSocketDebuggerUrl) return false;
      wsUrl = body.webSocketDebuggerUrl;
    } catch {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let sock: WebSocket | null = null;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sock?.close(); } catch { /* already gone */ }
        resolve(ok);
      };
      // A healthy browser answers in milliseconds — but a BUSY one can take
      // seconds, and "busy" must not read as "dead" (see healthMaxFailures).
      // A slow yes still beats killing a Chrome an agent is driving.
      const timer = setTimeout(() => finish(false), healthPingTimeoutMs());
      try {
        sock = new WebSocket(wsUrl);
        sock.onopen = () => sock?.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
        sock.onmessage = () => finish(true);
        sock.onerror = () => finish(false);
        sock.onclose = () => finish(false);
      } catch {
        finish(false);
      }
    });
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
