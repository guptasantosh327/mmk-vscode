import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** The extension's ID: `<publisher>.<name>` from package.json */
export const EXTENSION_ID = 'guptasantosh327.mmk-vscode';

/** The repository root (tests run from out/test/integration) */
export const REPO_ROOT = path.resolve(__dirname, '../../..');

/** The extension under test */
export function getExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} should be installed in the test instance`);
  return extension;
}

/** Poll `condition` until it holds, failing after `timeoutMs` */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(100);
  }
}

/** Wait `ms` milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Give VS Code time to process activation events, so a test that expects the extension to
 * stay inactive isn't just checking too early.
 */
export async function settle(): Promise<void> {
  await sleep(3000);
}
