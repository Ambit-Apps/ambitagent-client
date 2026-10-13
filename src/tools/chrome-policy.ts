#!/usr/bin/env node
/**
 * chrome-policy — report, fix, or undo the Chrome DevTools policy that
 * blocks browser automation.
 *
 *   node dist/tools/chrome-policy.js            report only, exit 0/1
 *   node dist/tools/chrome-policy.js --apply    relax it (records a backup)
 *   node dist/tools/chrome-policy.js --revert   put it back as found
 *
 * ── WHY A NODE TOOL AND NOT TWO SHELL SCRIPTS ──
 * The install scripts are PowerShell on Windows and bash on macOS, and the
 * policy logic is fiddly enough — two key names, a supersede rule, three
 * scopes, "absent" versus "zero" — that writing it twice guarantees the two
 * copies drift. The installer builds the daemon before it would ask about
 * this, so `node dist/...` is available by then, and this shares the exact
 * detector the daemon uses at run time. One implementation, three callers:
 * the installer, the uninstaller, and a staffer on a machine that broke
 * later.
 *
 * Exit codes are meant to be read by a script:
 *   0  policy is fine (or the requested change succeeded)
 *   1  policy blocks automation and was not changed
 *   2  a change was attempted and failed
 *   3  the change needs an elevated prompt
 */
import { devToolsPolicyState } from '../chrome/detect.js';
import {
  applyDevToolsPolicyFix,
  revertDevToolsPolicyFix,
} from '../chrome/devtools-policy-fix.js';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.includes('--revert')) {
    const r = await revertDevToolsPolicyFix();
    console.log(r.message);
    return r.ok ? 0 : 2;
  }

  const state = await devToolsPolicyState();

  if (!state.blocked) {
    console.log('Chrome DevTools are allowed — browser agents can run on this machine.');
    return 0;
  }

  console.log(state.reason);
  console.log('');

  if (!argv.includes('--apply')) {
    // Report mode is the default ON PURPOSE. This tool can relax a security
    // setting, so the no-argument behaviour must be the one that changes
    // nothing.
    console.log('Re-run with --apply to allow DevTools (a backup is recorded, and');
    console.log('the uninstaller restores it).');
    return 1;
  }

  const r = await applyDevToolsPolicyFix();
  console.log(r.message);
  if (r.needsElevation) return 3;
  return r.ok ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`chrome-policy failed: ${(err as Error).message}`);
    process.exit(2);
  },
);
