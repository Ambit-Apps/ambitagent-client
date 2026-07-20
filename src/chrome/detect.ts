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
