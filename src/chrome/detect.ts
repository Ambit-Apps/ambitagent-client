import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cross-platform Chrome-binary locator. Real production Chrome only —
 * NOT Chromium, NOT Edge, NOT Brave. We deliberately require Google
 * Chrome because the whole point of attach mode is to leverage the
 * customer's real Chrome ecosystem (extensions from the Web Store,
 * Google OAuth trust, no automation fingerprint).
 *
 * If Chrome isn't installed, `detectChromeBinary()` returns null and
 * the daemon logs a clear "install Chrome" instruction rather than
 * silently falling back to Playwright's bundled Chromium — silent
 * fallback is the exact failure mode the attach-mode-by-default work
 * is trying to eliminate.
 *
 * Windows + Linux paths are the standard install locations; the user's
 * son will verify them on his Windows box. If a customer has Chrome in
 * a non-standard location, they can set `AMBIT_CHROME_PATH` in the
 * daemon env to bypass detection.
 */

const CHROME_INSTALL_URL = 'https://www.google.com/chrome/';

export function detectChromeBinary(): string | null {
  const candidates = candidatePaths();
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Human-readable hint the daemon logs when detection fails. */
export function chromeInstallHint(): string {
  return (
    `Google Chrome was not found in any standard install location. Install it from ` +
    `${CHROME_INSTALL_URL} and restart the daemon. If Chrome is installed at a ` +
    `non-standard path, set AMBIT_CHROME_PATH in the daemon env.`
  );
}

function candidatePaths(): string[] {
  if (process.platform === 'darwin') return macPaths();
  if (process.platform === 'win32') return windowsPaths();
  return linuxPaths();
}

function macPaths(): string[] {
  return [
    // Standard system-wide install.
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Per-user install (some corp-managed Macs).
    join(process.env.HOME ?? '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
}

function windowsPaths(): string[] {
  // Common Windows install locations. Chrome installs to Program Files by
  // default on modern Windows; older / per-user installs land in
  // Program Files (x86) or %LOCALAPPDATA%.
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  return [
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(localAppData
      ? [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : []),
  ];
}

function linuxPaths(): string[] {
  // Standard package-manager locations. Prefer the stable channel so
  // extension APIs match what the vendoo extension expects.
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    // Some distros ship a symlink at /usr/local/bin.
    '/usr/local/bin/google-chrome',
  ];
}

/**
 * Is Chrome's DevTools disabled by enterprise policy?
 *
 * ── WHY THIS CHECK EARNS ITS PLACE ──
 * With DevTools disabled, Chrome refuses CDP debugger attachment — and the
 * symptom is unrecognisable as a permissions problem. `connectOverCDP` SUCCEEDS,
 * `Target.getTargets` works, the HTTP endpoints answer normally, and then the
 * run dies at `context.newPage()` with:
 *
 *     Cannot read properties of undefined (reading '_page')
 *
 * because Playwright's internal target map was never populated. Diagnosing that
 * from first principles took about two hours on 2026-09-30 and went through the
 * Chrome version, the Playwright version, profile state and browser-update skew
 * before landing here.
 *
 * ── WHY IT WILL HAPPEN TO CUSTOMERS ──
 * The eClinicalWorks plug-in installer sets this policy. Any customer who
 * installed it has DevTools disabled machine-wide — it is NOT per-site, despite
 * looking that way to someone who only ever opened DevTools on the EMR — so
 * every browser agent on that machine fails this way until it is changed.
 *
 * Returns a human-readable reason when disabled, or null when fine. Deliberately
 * best-effort: a check that cannot read the policy must never block a run, since
 * the overwhelmingly common case is no policy at all.
 */
export async function devToolsDisabledReason(): Promise<string | null> {
  return (await devToolsPolicyState()).reason;
}

/**
 * Where a DevTools policy was found, so a repair can target the SAME place.
 *
 * Scope matters more than it looks. On macOS the eCW plug-in writes to the
 * user's own `com.google.Chrome` preferences, and the Windows analogue is
 * HKCU — which means the usual repair needs no administrator at all. Writing
 * HKLM would also work (machine policy outranks user policy) but it relaxes
 * the setting for every account on a shared clinical workstation to fix one.
 * So: repair where it was set, and only widen when we have to.
 */
export interface DevToolsPolicyState {
  /** True when Chrome will refuse debugger attachment. */
  blocked: boolean;
  /** 'DeveloperToolsAvailability' | 'DeveloperToolsDisabled', or null. */
  key: string | null;
  /** The offending value, as a decimal string. */
  value: string | null;
  /** Machine-readable target for a repair. */
  scope: 'HKLM' | 'HKCU' | 'defaults' | null;
  /** Human-readable location, for logs and prompts. */
  where: string | null;
  /** The full explanation, or null when nothing is wrong. */
  reason: string | null;
}

const NOT_BLOCKED: DevToolsPolicyState = {
  blocked: false, key: null, value: null, scope: null, where: null, reason: null,
};

export async function devToolsPolicyState(): Promise<DevToolsPolicyState> {
  const { promisify } = await import('node:util');
  const exec = promisify((await import('node:child_process')).exec);

  const disabled = (
    key: string,
    value: string,
    where: string,
    scope: 'HKLM' | 'HKCU' | 'defaults',
  ): DevToolsPolicyState => ({
    blocked: true,
    key,
    value,
    scope,
    where,
    reason:
      `Chrome's DevTools are disabled by policy (${key}=${value}, set in ${where}). ` +
      `Chrome refuses debugger attachment while this is set, so browser agents ` +
      `cannot run. This policy is commonly installed by the eClinicalWorks ` +
      `plug-in, and it applies to ALL sites, not just the EMR.`,
  });

  try {
    if (process.platform === 'darwin') {
      // DeveloperToolsAvailability supersedes the legacy DeveloperToolsDisabled:
      // 1 = allowed, 2 = disallowed. Check it first so an explicit "allowed"
      // correctly overrides a stale legacy key.
      const read = async (k: string): Promise<string | null> => {
        try {
          const { stdout } = await exec(`defaults read com.google.Chrome ${k}`);
          return stdout.trim();
        } catch {
          return null; // key absent — `defaults` exits non-zero
        }
      };
      const availability = await read('DeveloperToolsAvailability');
      if (availability === '2') {
        return disabled('DeveloperToolsAvailability', '2', 'com.google.Chrome preferences', 'defaults');
      }
      if (availability === '1') return NOT_BLOCKED; // explicitly allowed; legacy key overridden
      if ((await read('DeveloperToolsDisabled')) === '1') {
        return disabled('DeveloperToolsDisabled', '1', 'com.google.Chrome preferences', 'defaults');
      }
      return NOT_BLOCKED;
    }

    if (process.platform === 'win32') {
      // Machine policy first, then per-user. reg.exe exits non-zero when the
      // value is absent, which is the normal case.
      for (const root of ['HKLM', 'HKCU'] as const) {
        const path = `${root}\\SOFTWARE\\Policies\\Google\\Chrome`;
        const read = async (k: string): Promise<string | null> => {
          try {
            const { stdout } = await exec(`reg query "${path}" /v ${k}`);
            const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
            return m ? String(parseInt(m[1], 16)) : null;
          } catch {
            return null;
          }
        };
        const availability = await read('DeveloperToolsAvailability');
        if (availability === '2') return disabled('DeveloperToolsAvailability', '2', path, root);
        if (availability === '1') return NOT_BLOCKED;
        if ((await read('DeveloperToolsDisabled')) === '1') {
          return disabled('DeveloperToolsDisabled', '1', path, root);
        }
      }
      return NOT_BLOCKED;
    }

    return NOT_BLOCKED; // Linux policy lives in JSON under /etc/opt/chrome — not checked yet
  } catch {
    // Never let a diagnostic break a run.
    return NOT_BLOCKED;
  }
}

/** Platform-specific instruction for clearing the DevTools policy. */
export const DEVTOOLS_POLICY_FIX =
  process.platform === 'win32'
    ? 'Set DeveloperToolsAvailability to 1 under ' +
      'HKCU\\SOFTWARE\\Policies\\Google\\Chrome (or remove DeveloperToolsDisabled), ' +
      'then fully quit and reopen Chrome.'
    : 'Run:  defaults write com.google.Chrome DeveloperToolsAvailability -int 1  ' +
      'then fully quit and reopen Chrome.';
