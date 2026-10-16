import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as vscode from 'vscode';
import { REPO_ROOT, getExtension, waitFor } from './helpers.js';

/** The pinned mongo-migrate-kit's CLI, as a terminal would run it via npx */
const MMK_SCRIPT = path.join(REPO_ROOT, 'node_modules/mongo-migrate-kit/dist/mmk.cjs');

suite('Fixture workspace (has mmk.config.js)', () => {
  let mongo: MongoMemoryServer | undefined;
  let workspaceDir: string;

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The fixture workspace should be open');
    workspaceDir = folder.uri.fsPath;

    mongo = await MongoMemoryServer.create();
    // The extension runs mmk with the extension host's environment, as a terminal would.
    process.env.MMK_URI = mongo.getUri();
    process.env.MMK_DB = 'mmk_integration';
    // Apply one migration from "the terminal", so the status has applied and pending rows.
    mmkInTerminal(['up', '20260101000000-create-users.js']);
  });

  suiteTeardown(async () => {
    await mongo?.stop();
  });

  /** Run mmk the way a user would in a terminal in the workspace folder */
  function mmkInTerminal(args: string[]): string {
    return execFileSync('node', [MMK_SCRIPT, ...args], {
      cwd: workspaceDir,
      env: process.env,
      encoding: 'utf8',
    });
  }

  test('activates because the workspace has an mmk config file', async () => {
    const extension = getExtension();
    await waitFor(() => extension.isActive, 15_000, 'the extension to activate');
  });

  test('"mmk: Show status (debug)" reads the same rows as mmk status in a terminal', async () => {
    const result = await vscode.commands.executeCommand('mmk.debug.showStatus');
    const terminalRows: unknown = JSON.parse(mmkInTerminal(['status', '--json']));

    assert.deepEqual(result, [{ dir: workspaceDir, rows: terminalRows }]);
    assert.ok(Array.isArray(terminalRows) && terminalRows.length === 3);
    assert.deepEqual(
      terminalRows.map((row: { file: string; status: string }) => [row.file, row.status]),
      [
        ['20260101000000-create-users.js', 'applied'],
        ['20260102000000-add-email-index.js', 'pending'],
        ['20260103000000-backfill-user-status.js', 'pending'],
      ],
    );
  });
});
