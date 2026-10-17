import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as vscode from 'vscode';
import type { MmkTestApi } from '../../src/extension.js';
import { REPO_ROOT, getExtension } from './helpers.js';

/** The pinned mongo-migrate-kit's CLI, as a terminal would run it via npx */
const MMK_SCRIPT = path.join(REPO_ROOT, 'node_modules/mongo-migrate-kit/dist/mmk.cjs');

suite('Local workflow in the fixture workspace (A1 → A2 → A3)', () => {
  let mongo: MongoMemoryServer | undefined;
  let workspaceDir: string;
  let api: MmkTestApi;

  /** Run mmk the way a user would in a terminal in the workspace folder */
  function mmkInTerminal(args: string[]): string {
    return execFileSync('node', [MMK_SCRIPT, ...args], {
      cwd: workspaceDir,
      env: process.env,
      encoding: 'utf8',
    });
  }

  /** The titles of the run links in a file */
  async function runLinks(uri: vscode.Uri): Promise<string[]> {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
    );
    return lenses.map((lens) => lens.command?.title ?? '');
  }

  function rowOf(file: string): { status: string; batch: number | null } | undefined {
    return api.store.snapshot(workspaceDir)?.rows?.find((row) => row.file === file);
  }

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The fixture workspace should be open');
    workspaceDir = folder.uri.fsPath;

    mongo = await MongoMemoryServer.create();
    // The extension runs mmk with the extension host's environment, as a terminal would.
    process.env.MMK_URI = mongo.getUri();
    process.env.MMK_DB = 'mmk_integration';

    const exports = await getExtension().activate();
    assert.ok(exports, 'The extension should return its test hooks in test mode');
    api = exports as MmkTestApi;

    mmkInTerminal(['up', '20260101000000-create-users.js']);
    await vscode.commands.executeCommand('mmk.refresh');
    await api.idle();
  });

  suiteTeardown(async () => {
    await mongo?.stop();
  });

  test('reads the same rows as mmk status in a terminal', () => {
    const terminalRows: unknown = JSON.parse(mmkInTerminal(['status', '--json']));
    assert.deepEqual(api.store.snapshot(workspaceDir)?.rows, terminalRows);
  });

  test('shows the environment, pending and applied groups in the sidebar (A2)', () => {
    const tree = api.sidebar();
    assert.ok(
      tree.some((line) => /^local · 127\.0\.0\.1:\d+\/mmk_integration$/.test(line)),
      tree.join('\n'),
    );
    for (const line of [
      'Pending on local · 2',
      '  add-email-index.js · 2 Jan',
      '  backfill-user-status.js · 3 Jan',
      '  Apply all 2 on local',
      '  Dry run',
      'Applied on local · 1',
    ]) {
      assert.ok(tree.includes(line), `Missing "${line}" in:\n${tree.join('\n')}`);
    }
    assert.ok(
      tree.some((line) => /^ {2}Batch 1 · .+ · 1$/.test(line)),
      tree.join('\n'),
    );
  });

  test('dry run lists what up would apply and changes nothing', async () => {
    const rows = await vscode.commands.executeCommand<Array<{ file: string }>>('mmk.dryRun', {
      dir: workspaceDir,
    });
    assert.deepEqual(
      rows?.map((row) => row.file),
      ['20260102000000-add-email-index.js', '20260103000000-backfill-user-status.js'],
    );
    await api.idle();
    assert.equal(rowOf('20260102000000-add-email-index.js')?.status, 'pending');
  });

  test('create, run up, see it applied, and roll it back only after confirming', async () => {
    // A1: create through mmk, then open the file it wrote.
    const created = await vscode.commands.executeCommand<string>('mmk.createMigration', {
      name: 'add refunds collection',
      extension: 'js',
    });
    assert.ok(created && existsSync(created), `mmk should have created a file, got ${created}`);
    const file = path.basename(created);
    assert.match(file, /^\d{14}-add-refunds-collection\.js$/);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, created);
    await api.idle();
    assert.equal(rowOf(file)?.status, 'pending');
    assert.ok(
      api.sidebar().includes('  add-refunds-collection.js · new'),
      api.sidebar().join('\n'),
    );

    // A2: run links before it has run.
    const uri = vscode.Uri.file(created);
    assert.deepEqual(await runLinks(uri), [
      'Pending on local',
      'Run up on local',
      'Dry run',
      'Run down appears once up has run on local',
    ]);

    // A3: run up, then the links and the sidebar show it applied in a new batch.
    const results = await vscode.commands.executeCommand<Array<{ status: string; batch: number }>>(
      'mmk.up',
      uri,
    );
    assert.deepEqual(
      results?.map((result) => [result.status, result.batch]),
      [['applied', 2]],
    );
    await api.idle();
    assert.equal(rowOf(file)?.status, 'applied');
    const applied = await runLinks(uri);
    assert.match(applied[0] ?? '', /^\$\(check\) Applied on local · batch 2 · \d+ ms$/);
    assert.deepEqual(applied.slice(1), ['Redo', 'Run down on local']);
    assert.ok(
      api.sidebar().some((line) => /^ {2}Batch 2 · .+ · 1$/.test(line)),
      api.sidebar().join('\n'),
    );

    // Rolling back needs the modal: declining it runs nothing.
    const asked: string[] = [];
    api.setConfirm((message) => {
      asked.push(message);
      return false;
    });
    assert.equal(await vscode.commands.executeCommand('mmk.down', uri), undefined);
    await api.idle();
    assert.deepEqual(asked, ['Roll back add-refunds-collection.js on local?']);
    assert.equal(rowOf(file)?.status, 'applied');

    // Confirming it rolls the migration back.
    api.setConfirm(() => true);
    const reverted = await vscode.commands.executeCommand<Array<{ status: string }>>(
      'mmk.down',
      uri,
    );
    assert.deepEqual(
      reverted?.map((result) => result.status),
      ['reverted'],
    );
    await api.idle();
    assert.equal(rowOf(file)?.status, 'pending');
  });

  test('releasing the lock asks first, and says when no lock was held', async () => {
    api.setConfirm(() => false);
    assert.equal(
      await vscode.commands.executeCommand('mmk.unlock', { dir: workspaceDir }),
      undefined,
    );

    api.setConfirm(() => true);
    assert.deepEqual(await vscode.commands.executeCommand('mmk.unlock', { dir: workspaceDir }), {
      released: false,
      holder: null,
    });
  });
});
