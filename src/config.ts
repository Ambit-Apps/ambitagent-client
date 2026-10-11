import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which build this actually is.
 *
 * ── WHY NOT npm_package_version ──
 * It used to be `process.env.npm_package_version ?? '0.0.0'`. npm sets
 * that variable ONLY when npm launches the process, and run-daemon.ps1
 * invokes `node` directly — so on every Task Scheduler install it was
 * undefined and the daemon reported the fallback. Three production
 * runtimes all reported "0.0.0", the portal rendered it in a column
 * headed Version, and it looked like data. The one machine showing
 * "0.0.1" was a laptop started with an npm script, reading a
 * package.json version that has not been bumped in the project's life.
 *
 * So the number was never wrong in a way anyone could notice, which is
 * the worst kind of wrong: an update feature that says "update this
 * machine to v12" is meaningless when every machine claims 0.0.0.
 *
 * `build-info.json` is written INTO the bundle by
 * install/build-installer-zip.sh and carries the same string as the zip
 * filename, so a runtime on screen matches a file that was shipped.
 *
 * ── WHY 'unknown' AND NOT '0.0.0' ──
 * A fallback that looks like a version is exactly how this hid for
 * months. Something that cannot identify itself should say so.
 */
function resolveBuildVersion(): string {
  // dist/config.js at runtime, src/config.ts under tsx — build-info.json
  // sits at the package root in both cases, one level up.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'build-info.json'), join(here, 'build-info.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      /* not this path — try the next */
    }
  }
  // A dev machine running via npm still gets something useful.
  const fromNpm = process.env.npm_package_version;
  return fromNpm ? `${fromNpm}-dev` : 'unknown';
}

/**
 * Runtime daemon config. Two sources, in priority order:
 *
 * 1. Environment variables (dev machines, systemd `Environment=` lines).
 * 2. The system config file — a shell-style KEY=VALUE file the installer
 *    drops on customer machines. Env vars still override.
 *      - Linux:   /etc/ambit-agent/config
 *      - Windows: %ProgramData%\Ambit Agent\config
 *      - macOS:   ~/Library/Application Support/Ambit Agent/config
 *
 * Both `ADMIN_URL` and `ENROLLMENT_TOKEN` are required; startup fails
 * loudly if either is missing.
 */

/**
 * Where the installer dropped the config.
 *
 * macOS is under ~/Library rather than /etc, and that is not cosmetic:
 * the agent runs as a launchd LaunchAgent, which is per-user by
 * definition, so a root-owned /etc config paired with a user-owned agent
 * would be a split-brain. Keeping both in the user's own tree is also
 * what lets the whole macOS install run WITHOUT sudo.
 *
 * /etc/ambit-agent/config is still checked on macOS, second, so a
 * machine set up by hand before the installer existed keeps working.
 */
const SYSTEM_CONFIG_PATHS: string[] =
  process.platform === 'win32'
    ? [join(process.env.ProgramData ?? 'C:\\ProgramData', 'Ambit Agent', 'config')]
    : process.platform === 'darwin'
      ? [
          join(homedir(), 'Library', 'Application Support', 'Ambit Agent', 'config'),
          '/etc/ambit-agent/config',
        ]
      : ['/etc/ambit-agent/config'];

export interface Config {
  adminUrl: string;        // e.g. http://localhost:3100 (dev) or https://api.ambitagent.com (prod)
  wsUrl: string;           // derived from adminUrl (http→ws, https→wss) + /ws/runtime
  enrollmentToken: string; // raw token from POST /rest/runtimes/enroll
  runtimeId: string;       // stable identifier this daemon reports in `hello`; env-overrideable
  version: string;
  heartbeatIntervalMs: number;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  /**
   * Managed-Chrome lifecycle knobs — the daemon launches and monitors a
   * dedicated Chrome (separate profile, dedicated debug port) so agents
   * with `browser.model: "attached_chrome"` have somewhere to attach
   * without operator gymnastics. Default: enabled on customer machines.
   * Set `AMBIT_CHROME_ENABLED=false` on truly headless server VMs that
   * only run api-type agents.
   */
  chromeEnabled: boolean;
  /** Override the detected Chrome binary. Empty = auto-detect per OS. */
  chromePath: string;
  /** Debug port. Default 9222. */
  chromePort: number;
  /**
   * Dedicated user-data-dir for the managed Chrome. Deliberately not the
   * customer's personal Chrome profile — a fresh, isolated directory
   * under `~/.ambit/chrome-profile` by default so extension installs +
   * logins here never touch the customer's real browsing profile.
   */
  chromeProfileDir: string;
  /**
   * Launch the managed Chrome with GPU/hardware acceleration disabled
   * (`--disable-gpu`). Default false. Set `AMBIT_CHROME_DISABLE_GPU=true`
   * on machines whose GPU driver crashes the renderer on heavy pages.
   *
   * Why this exists: on some older Intel iGPUs (e.g. UHD 620, Gen 9) the
   * driver can't reset a lost D3D device inside Chrome's sandbox, so
   * Chrome applies the `exit_on_context_lost` workaround — it KILLS the
   * GPU process on any device-loss event (a display sleep, a monitor/DPI
   * change, a TDR under a heavy render). That takes every tab's renderer
   * down with it, surfacing to an automation script as "Target page,
   * context or browser has been closed" mid-run. Forcing software
   * rendering removes the hardware D3D path entirely so device-loss can't
   * happen. A command-line flag also overrides any enterprise policy that
   * locks hardware acceleration on. Slower to paint, but crash-proof —
   * the right trade on a machine that's already crawling on the hw path.
   */
  chromeDisableGpu: boolean;
}

/** The first config path that exists, for error messages. */
function configPathHint(): string {
  return SYSTEM_CONFIG_PATHS[0] ?? '/etc/ambit-agent/config';
}

function readSystemConfig(): Record<string, string> {
  // First path that parses wins. On macOS that is the per-user file,
  // with /etc as the fallback for machines set up before the installer.
  for (const path of SYSTEM_CONFIG_PATHS) {
    const parsed = readOneConfig(path);
    if (parsed) return parsed;
  }
  return {};
}

function readOneConfig(path: string): Record<string, string> | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    // NULL, not {}. An empty object is truthy, so returning one here
    // would make readSystemConfig stop at the first path and never try
    // the /etc fallback — the fallback would exist and never run.
    //
    // Missing is also fine in itself: on a dev machine there is no
    // config file and env vars carry the load.
    return null;
  }
}

/**
 * A blank env var counts as ABSENT, not as an empty answer.
 *
 * `process.env[name] ?? fallback[name]` looks right and is not: `??`
 * only falls through on null/undefined, so an exported-but-empty
 * ADMIN_URL ('' from `export ADMIN_URL=` or a shell var that did not
 * expand) wins over a perfectly good config file, and the daemon exits
 * reporting the value as MISSING while it is sitting right there on
 * disk.
 *
 * Both installers already treat a present-but-blank key as absent —
 * Get-ConfigValue on Windows says so explicitly. The daemon disagreeing
 * with its own installers is the kind of difference nobody finds until
 * it costs an afternoon.
 */
function fromEnvOrFile(name: string, fallback: Record<string, string>): string | undefined {
  const env = process.env[name];
  if (env !== undefined && env.trim() !== '') return env;
  const file = fallback[name];
  if (file !== undefined && file.trim() !== '') return file;
  return undefined;
}

function require(name: string, fallback: Record<string, string>): string {
  const v = fromEnvOrFile(name, fallback);
  if (!v) {
    console.error(`Missing required config: ${name}. Set it via env var or ${configPathHint()}.`);
    process.exit(1);
  }
  return v;
}

function optional(name: string, fallback: Record<string, string>, def: string): string {
  return fromEnvOrFile(name, fallback) ?? def;
}

function deriveWsUrl(adminUrl: string): string {
  const stripped = adminUrl.replace(/\/$/, '');
  const wsBase = stripped.replace(/^http/, 'ws');
  return `${wsBase}/ws/runtime`;
}

export function loadConfig(): Config {
  const fileConfig = readSystemConfig();

  // Merge file config into process.env so third-party libraries that
  // read env vars directly can see the same values.
  //
  // On Linux, systemd's `EnvironmentFile=` already injects these into
  // the process environment, so this loop is a no-op. On Windows,
  // NSSM only sets what's in AppEnvironmentExtra — the file we read
  // above is otherwise invisible to Playwright (looking for
  // PLAYWRIGHT_BROWSERS_PATH) and to our own executor (checking
  // process.env.HEADLESS). Without this merge, browser-type runs
  // fail with "Chromium binary is missing" on Windows.
  //
  // Env vars set upstream (systemd, NSSM AppEnvironmentExtra, dev
  // shell) win — we only fill blanks.
  for (const [k, v] of Object.entries(fileConfig)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }

  const adminUrl = require('ADMIN_URL', fileConfig);
  const enrollmentToken = require('ENROLLMENT_TOKEN', fileConfig);

  const logLevel = optional('LOG_LEVEL', fileConfig, 'info') as Config['logLevel'];

  const chromeEnabledRaw = optional('AMBIT_CHROME_ENABLED', fileConfig, 'true').toLowerCase();
  const chromeEnabled = chromeEnabledRaw !== 'false' && chromeEnabledRaw !== '0';

  const disableGpuRaw = optional('AMBIT_CHROME_DISABLE_GPU', fileConfig, 'false').toLowerCase();
  const chromeDisableGpu = disableGpuRaw === 'true' || disableGpuRaw === '1';

  return {
    adminUrl,
    wsUrl: deriveWsUrl(adminUrl),
    enrollmentToken,
    // Not persisted server-side yet — the admin resolves runtimeId via
    // the enrollment token hash. This is just for correlation in logs.
    runtimeId: optional('RUNTIME_ID', fileConfig, `runtime-${process.pid}`),
    version: resolveBuildVersion(),
    heartbeatIntervalMs: Number(optional('HEARTBEAT_INTERVAL_MS', fileConfig, '15000')),
    reconnectMinDelayMs: Number(optional('RECONNECT_MIN_DELAY_MS', fileConfig, '1000')),
    reconnectMaxDelayMs: Number(optional('RECONNECT_MAX_DELAY_MS', fileConfig, '30000')),
    logLevel,

    chromeEnabled,
    chromePath:       optional('AMBIT_CHROME_PATH', fileConfig, ''),
    chromePort:       Number(optional('AMBIT_CHROME_PORT', fileConfig, '9222')),
    chromeProfileDir: optional(
      'AMBIT_CHROME_PROFILE_DIR',
      fileConfig,
      join(homedir(), '.ambit', 'chrome-profile'),
    ),
    chromeDisableGpu,
  };
}
