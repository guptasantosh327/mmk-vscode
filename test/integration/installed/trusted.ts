import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { EXTENSION_ID, waitFor } from '../helpers.js';

/**
 * Control for untrusted.ts, run by test/integration/run-installed.mjs: in a trusted workspace,
 * the installed .vsix activates. Without this, "stays inactive" could pass because the
 * extension was never installed.
 */
export async function run(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, true, 'The workspace should be trusted');

  await waitFor(
    () => vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true,
    15_000,
    'the installed extension to activate',
  );
  process.stdout.write('Installed extension, trusted workspace\n  ✔ activates\n');
}
