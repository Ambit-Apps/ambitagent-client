/**
 * Repairing the DevTools policy that blocks CDP.
 *
 * ── WHY THIS IS A SEPARATE, EXPLICIT ACT ──
 * `DeveloperToolsDisabled` is a security control. It is usually set as a
 * side effect of installing the eClinicalWorks plug-in rather than by a
 * deliberate decision, and relaxing it is the only way a browser agent can
 * work on that machine — but it is still a security control on a machine
 * that holds patient records.
 *
 * So this module exists to make the change DELIBERATE rather than silent:
 *
 *   - It never runs on its own. The installer prompts; the run path only
 *     reports. Nothing here fires without someone saying yes.
 *   - It writes a backup first, so `revert()` can put the machine back
 *     exactly as it was found — including "the key was absent", which is a
 *     different state from "the key was 0".
 *   - It repairs at the SCOPE where the block was found. On macOS and on
 *     most Windows installs that is the user's own preferences, so the fix
 *     needs no administrator and affects no other account on a shared
 *     workstation. Widening to HKLM happens only when HKLM is where the
 *     block actually is.
 *
 * The write itself is one value: DeveloperToolsAvailability = 1 ("allowed").
 * There is no narrower option — Chrome gates debugger attachment on the same
 * policy that gates the DevTools window, with no per-origin or
 * automation-only variant.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';
import { devToolsPolicyState, type DevToolsPolicyState } from './detect.js';

const exec = promisify(execCb);

/** Mirrors SYSTEM_CONFIG_PATHS[0] in config.ts — the writable install dir. */
function backupPath(): string {
  if (process.platform === 'win32') {
    return join(
      process.env.ProgramData ?? 'C:\\ProgramData',
      'Ambit Agent',
      'chrome-policy-backup.json',
    );
  }
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Ambit Agent',
      'chrome-policy-backup.json',
    );
  }
  return '/etc/ambit-agent/chrome-policy-backup.json';
}

interface Backup {
  /** When we changed it. */
  at: string;
  /** Where we wrote, so revert targets the same place. */
  scope: 'HKLM' | 'HKCU' | 'defaults';
  /**
   * Prior values, keyed by policy name. `null` means THE KEY WAS ABSENT,
   * which revert restores by deleting rather than by writing a zero — those
   * are different states and Chrome treats them differently.
   */
  previous: Record<string, string | null>;
}

export interface FixResult {
  ok: boolean;
  /** What happened, in one line, suitable for printing to an operator. */
  message: string;
  /** True when the caller needs to re-run with elevation. */
  needsElevation?: boolean;
}

const POLICY_KEY = 'SOFTWARE\\Policies\\Google\\Chrome';

async function readWindowsValue(
  scope: 'HKLM' | 'HKCU',
  key: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec(`reg query "${scope}\\${POLICY_KEY}" /v ${key}`);
    const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
    return m ? String(parseInt(m[1]!, 16)) : null;
  } catch {
    return null;
  }
}

async function readDarwinValue(key: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`defaults read com.google.Chrome ${key}`);
    return stdout.trim();
  } catch {
    return null;
  }
}

function saveBackup(b: Backup): void {
  const path = backupPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(b, null, 2), 'utf8');
}

function loadBackup(): Backup | null {
  const path = backupPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Backup;
  } catch {
    return null;
  }
}

/**
 * Relax the policy so Chrome will accept a debugger attachment.
 *
 * Returns ok:false with `needsElevation` when the block lives in HKLM and
 * we are not running elevated — the caller decides whether to re-launch
 * itself as administrator or just tell the operator.
 */
export async function applyDevToolsPolicyFix(): Promise<FixResult> {
  const state: DevToolsPolicyState = await devToolsPolicyState();
  if (!state.blocked) {
    return { ok: true, message: 'Chrome DevTools are already allowed — nothing to change.' };
  }

  try {
    if (process.platform === 'darwin') {
      const previous: Record<string, string | null> = {
        DeveloperToolsAvailability: await readDarwinValue('DeveloperToolsAvailability'),
        DeveloperToolsDisabled: await readDarwinValue('DeveloperToolsDisabled'),
      };
      saveBackup({ at: new Date().toISOString(), scope: 'defaults', previous });
      await exec('defaults write com.google.Chrome DeveloperToolsAvailability -int 1');
      return {
        ok: true,
        message:
          'Set DeveloperToolsAvailability=1 in com.google.Chrome preferences. ' +
          'Fully quit and reopen Chrome for it to take effect.',
      };
    }

    if (process.platform === 'win32') {
      const scope = (state.scope === 'HKLM' ? 'HKLM' : 'HKCU') as 'HKLM' | 'HKCU';
      // HKLM is machine-wide and needs administrator. Rather than failing
      // with reg.exe's "Access is denied", say which it is.
      if (scope === 'HKLM' && !(await isElevated())) {
        return {
          ok: false,
          needsElevation: true,
          message:
            'The policy is set machine-wide (HKLM), so changing it needs an ' +
            'elevated prompt. Re-run this from an Administrator PowerShell.',
        };
      }
      const previous: Record<string, string | null> = {
        DeveloperToolsAvailability: await readWindowsValue(scope, 'DeveloperToolsAvailability'),
        DeveloperToolsDisabled: await readWindowsValue(scope, 'DeveloperToolsDisabled'),
      };
      saveBackup({ at: new Date().toISOString(), scope, previous });
      // ONE key added, nothing of theirs removed. DeveloperToolsAvailability
      // supersedes the legacy DeveloperToolsDisabled, so adding ours is
      // enough — and it is the smaller intervention: the plug-in's own
      // setting stays where it put it, and reverting is then just "remove
      // the key we added" rather than "restore someone else's value and
      // hope we read it correctly".
      //
      // Both keys coexisting is not theoretical. The author's own Mac has
      // run that way since 2026-09-30 with Chrome honouring the supersede.
      //
      // Writing at the SCOPE where the block was found also keeps this out
      // of HKLM-vs-HKCU precedence territory: same hive, so the key
      // precedence above is the only rule in play.
      await exec(
        `reg add "${scope}\\${POLICY_KEY}" /v DeveloperToolsAvailability /t REG_DWORD /d 1 /f`,
      );
      return {
        ok: true,
        message:
          `Set DeveloperToolsAvailability=1 under ${scope}\\${POLICY_KEY}. ` +
          'Fully quit and reopen Chrome for it to take effect.',
      };
    }

    return { ok: false, message: `No DevTools policy repair implemented for ${process.platform}.` };
  } catch (err) {
    return { ok: false, message: `Could not change the policy: ${(err as Error).message}` };
  }
}

/**
 * Put the machine back the way we found it.
 *
 * Called by the uninstaller. A vendor that relaxes a security policy and
 * then leaves is worse than one that never touched it, so this is not
 * optional cleanup — it is part of uninstalling.
 *
 * No backup means we never changed anything, which is a success, not an
 * error: uninstall must not fail because there was nothing to undo.
 */
export async function revertDevToolsPolicyFix(): Promise<FixResult> {
  const b = loadBackup();
  if (!b) {
    return { ok: true, message: 'No Chrome policy change on record — nothing to revert.' };
  }

  try {
    for (const [key, prior] of Object.entries(b.previous)) {
      if (b.scope === 'defaults') {
        if (prior === null) {
          await exec(`defaults delete com.google.Chrome ${key}`).catch(() => { /* absent */ });
        } else {
          await exec(`defaults write com.google.Chrome ${key} -int ${Number(prior)}`);
        }
      } else {
        if (prior === null) {
          await exec(`reg delete "${b.scope}\\${POLICY_KEY}" /v ${key} /f`)
            .catch(() => { /* absent */ });
        } else {
          await exec(
            `reg add "${b.scope}\\${POLICY_KEY}" /v ${key} /t REG_DWORD /d ${Number(prior)} /f`,
          );
        }
      }
    }
    rmSync(backupPath(), { force: true });
    return {
      ok: true,
      message: `Restored Chrome's DevTools policy to how it was on ${b.at}.`,
    };
  } catch (err) {
    return { ok: false, message: `Could not revert the policy: ${(err as Error).message}` };
  }
}

/** Are we running with administrator rights? Windows only; false elsewhere. */
async function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    // `net session` is the classic probe: it needs admin and has no side
    // effects. Exit code is all we read.
    await exec('net session');
    return true;
  } catch {
    return false;
  }
}
