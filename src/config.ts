import 'dotenv/config';
import { readFileSync } from 'node:fs';

/**
 * Runtime daemon config. Two sources, in priority order:
 *
 * 1. Environment variables (dev machines, systemd `Environment=` lines).
 * 2. `/etc/ambit-agent/config` (a shell-style KEY=VALUE file the
 *    installer drops on Ubuntu VMs). Env vars still override.
 *
 * Both `ADMIN_URL` and `ENROLLMENT_TOKEN` are required; startup fails
 * loudly if either is missing.
 */

const SYSTEM_CONFIG_PATH = '/etc/ambit-agent/config';

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

  const adminUrl = require('ADMIN_URL', fileConfig);
  const enrollmentToken = require('ENROLLMENT_TOKEN', fileConfig);

  const logLevel = optional('LOG_LEVEL', fileConfig, 'info') as Config['logLevel'];

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
  };
}
