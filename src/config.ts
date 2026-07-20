import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Runtime daemon config. Two sources, in priority order:
 *
 * 1. Environment variables (dev machines, systemd `Environment=` lines).
 * 2. The system config file — a shell-style KEY=VALUE file the installer
 *    drops on customer machines. Env vars still override.
 *      - Linux:   /etc/ambit-agent/config
 *      - Windows: %ProgramData%\Ambit Agent\config
 *
 * Both `ADMIN_URL` and `ENROLLMENT_TOKEN` are required; startup fails
 * loudly if either is missing.
 */

const SYSTEM_CONFIG_PATH =
  process.platform === 'win32'
    ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'Ambit Agent', 'config')
    : '/etc/ambit-agent/config';

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
}

function readSystemConfig(): Record<string, string> {
  try {
    const raw = readFileSync(SYSTEM_CONFIG_PATH, 'utf8');
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
    // File missing / unreadable — fine on dev machines. Env vars carry the load.
    return {};
  }
}

function require(name: string, fallback: Record<string, string>): string {
  const v = process.env[name] ?? fallback[name];
  if (!v) {
    console.error(`Missing required config: ${name}. Set it via env var or ${SYSTEM_CONFIG_PATH}.`);
    process.exit(1);
  }
  return v;
}

function optional(name: string, fallback: Record<string, string>, def: string): string {
  return process.env[name] ?? fallback[name] ?? def;
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

  return {
    adminUrl,
    wsUrl: deriveWsUrl(adminUrl),
    enrollmentToken,
    // Not persisted server-side yet — the admin resolves runtimeId via
    // the enrollment token hash. This is just for correlation in logs.
    runtimeId: optional('RUNTIME_ID', fileConfig, `runtime-${process.pid}`),
    version: process.env.npm_package_version ?? '0.0.0',
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
  };
}
