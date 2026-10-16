import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { EXTENSION_ID, settle } from '../helpers.js';

/**
 * Run by test/integration/run-installed.mjs against the installed .vsix. VS Code doesn't apply
 * Workspace Trust to an extension loaded with --extensionDevelopmentPath, so this can only be
 * tested on the installed package, the way users get it.
 */
export async function run(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false, 'The workspace should not be trusted');
  await settle();

  assert.notEqual(
    vscode.extensions.getExtension(EXTENSION_ID)?.isActive,
    true,
    'The extension should stay inactive in an untrusted workspace, even with mmk.config.js',
  );
  process.stdout.write(
    'Installed extension, untrusted workspace (Restricted Mode)\n  ✔ stays inactive even though the workspace has mmk.config.js\n',
  );
}
