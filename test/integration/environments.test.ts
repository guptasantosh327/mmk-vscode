import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import * as path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as vscode from 'vscode';
import type { MmkTestApi } from '../../src/extension.js';
import type { MatrixPanel } from '../../src/views/matrix/panel.js';
import { REPO_ROOT, getExtension } from './helpers.js';

const MMK_SCRIPT = path.join(REPO_ROOT, 'node_modules/mongo-migrate-kit/dist/mmk.cjs');
const CREATE_USERS = '20260101000000-create-users.js';
const EMAIL_INDEX = '20260102000000-add-email-index.js';
const BACKFILL = '20260103000000-backfill-user-status.js';

suite('Environments (C1, C2) in the fixture workspace', () => {
  let mongo: MongoMemoryServer | undefined;
  let client: MongoClient;
  let workspaceDir: string;
  let api: MmkTestApi;

  function mmk(args: string[], env: Record<string, string> = {}): string {
    return execFileSync('node', [MMK_SCRIPT, ...args], {
      cwd: workspaceDir,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  }

  function git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
  }

  async function runLinks(file: string): Promise<string[]> {
    const document = await vscode.workspace.openTextDocument(
      path.join(workspaceDir, 'migrations', file),
    );
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      document.uri,
    );
    return lenses.map((lens) => lens.command?.title ?? '');
  }

  async function stagingRecords(): Promise<number> {
    return client.db('mmk_staging').collection('_mmk_migrations').countDocuments();
  }

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The fixture workspace should be open');
    workspaceDir = folder.uri.fsPath;

    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    process.env.MMK_URI = mongo.getUri();
    process.env.MMK_DB = 'mmk_local';

    const exports = await getExtension().activate();
    assert.ok(exports, 'The extension should return its test hooks in test mode');
    api = exports as MmkTestApi;

    // staging has the first two applied (deployed by CI); local only the first.
    mmk(['up', CREATE_USERS]);
    mmk(['up', CREATE_USERS], { MMK_DB: 'mmk_staging' });
    mmk(['up', EMAIL_INDEX], { MMK_DB: 'mmk_staging' });
    await vscode.commands.executeCommand('mmk.refresh');
    await api.idle();
  });

  suiteTeardown(async () => {
    await client?.close();
    await mongo?.stop();
  });

  test('adds staging as read-only, with its connection in the keychain, not in settings', async () => {
    const added = await vscode.commands.executeCommand<string>('mmk.addEnvironment', {
      dir: workspaceDir,
      name: 'staging',
      uri: mongo?.getUri(),
      dbName: 'mmk_staging',
      readOnly: true,
    });
    assert.equal(added, 'staging');
    await api.idle();

    const setting = vscode.workspace.getConfiguration('mmk').get<unknown[]>('environments');
    assert.deepEqual(setting, [{ name: 'staging', readOnly: true }]);
    assert.ok(!JSON.stringify(setting).includes('mongodb://'));
    assert.deepEqual(await api.environments.connection(workspaceDir, 'staging'), {
      uri: mongo?.getUri(),
      dbName: 'mmk_staging',
    });

    const staging = api.store.snapshot(workspaceDir)?.environments.staging;
    assert.deepEqual(
      staging?.rows?.map((row) => [row.file, row.status]),
      [
        [CREATE_USERS, 'applied'],
        [EMAIL_INDEX, 'applied'],
        [BACKFILL, 'pending'],
      ],
    );
  });

  test('shows the other environment next to the run links on local', async () => {
    assert.deepEqual(await runLinks(EMAIL_INDEX), [
      'Pending on local',
      'Run up on local',
      'Dry run',
      'staging: applied',
      'Run down appears once up has run on local',
    ]);
  });

  test('on staging, offers only Dry run and Copy CLI command (C1)', async () => {
    await vscode.commands.executeCommand('mmk.selectEnvironment', 'staging');
    await api.idle();
    assert.equal(api.store.selected().name, 'staging');

    assert.deepEqual(await runLinks(BACKFILL), [
      '$(lock) staging · read-only',
      'Pending on staging',
      'Dry run on staging',
      'Copy CLI command',
      "Nothing to roll back on staging: it hasn't run there",
    ]);
    const tree = api.sidebar();
    assert.ok(
      tree.includes(
        'Read-only. Run and roll back are turned off for staging; deploys go through CI.',
      ),
      tree.join('\n'),
    );
    assert.ok(tree.includes('Pending on staging · 1'), tree.join('\n'));
    assert.ok(!tree.some((line) => line.includes('Apply all')), tree.join('\n'));
  });

  test("can't write to staging from any command, and is never even asked to confirm", async () => {
    const asked: string[] = [];
    api.setConfirm((message) => {
      asked.push(message);
      return true;
    });
    const file = vscode.Uri.file(path.join(workspaceDir, 'migrations', BACKFILL));
    const applied = vscode.Uri.file(path.join(workspaceDir, 'migrations', CREATE_USERS));
    const before = await stagingRecords();

    assert.equal(await vscode.commands.executeCommand('mmk.up', file), undefined);
    assert.equal(
      await vscode.commands.executeCommand('mmk.upAll', { dir: workspaceDir }),
      undefined,
    );
    assert.equal(await vscode.commands.executeCommand('mmk.down', applied), undefined);
    assert.equal(await vscode.commands.executeCommand('mmk.redo', applied), undefined);
    assert.equal(
      await vscode.commands.executeCommand('mmk.unlock', { dir: workspaceDir }),
      undefined,
    );
    // Going around the commands to the store refuses too.
    await assert.rejects(api.store.run(workspaceDir, ['up'], 'up'), /staging is read-only/);
    await api.idle();

    assert.deepEqual(asked, []);
    assert.equal(await stagingRecords(), before);
  });

  test('can dry-run on staging', async () => {
    const rows = await vscode.commands.executeCommand<Array<{ file: string }>>('mmk.dryRun', {
      dir: workspaceDir,
    });
    assert.deepEqual(
      rows?.map((row) => row.file),
      [BACKFILL],
    );
  });

  test('compares every environment in the matrix, with notes (C2)', async () => {
    const panel = await vscode.commands.executeCommand<MatrixPanel>('mmk.compareEnvironments', {
      dir: workspaceDir,
    });
    assert.ok(panel, 'The matrix should open');
    await api.idle();
    const view = panel.view();

    assert.deepEqual(
      view.columns.map((column) => [column.name, column.readOnly]),
      [
        ['local', false],
        ['staging', true],
      ],
    );
    assert.deepEqual(
      view.rows.map((row) => [row.label, row.cells.map((cell) => cell.label), row.note]),
      [
        ['create-users.js', ['Applied', 'Applied'], ''],
        ['add-email-index.js', ['Pending', 'Applied'], 'Not on local yet'],
        ['backfill-user-status.js', ['Pending', 'Pending'], ''],
      ],
    );
    assert.deepEqual(view.summary, ['local is missing 1 that staging has']);
    assert.match(
      view.subtitle,
      /compared with each database's changelog · read-only · updated \d\d:\d\d$/,
    );
    panel.dispose();
  });

  test('runs again on local after switching back', async () => {
    await vscode.commands.executeCommand('mmk.selectEnvironment', 'local');
    api.setConfirm(() => true);
    const results = await vscode.commands.executeCommand<Array<{ status: string }>>(
      'mmk.up',
      vscode.Uri.file(path.join(workspaceDir, 'migrations', EMAIL_INDEX)),
    );
    assert.deepEqual(
      results?.map((result) => result.status),
      ['applied'],
    );
    await api.idle();
  });

  test('after a checkout, names a local migration whose file is on another branch', async () => {
    git('init', '-q', '-b', 'main');
    git('add', 'migrations', 'mmk.config.js', 'package.json');
    git('commit', '-q', '-m', 'main');
    git('checkout', '-q', '-b', 'feat/refunds');
    const created = await vscode.commands.executeCommand<string>('mmk.createMigration', {
      name: 'add refunds',
      extension: 'js',
    });
    await api.idle();
    await vscode.commands.executeCommand('mmk.up', vscode.Uri.file(created));
    git('add', 'migrations');
    git('commit', '-q', '-m', 'refunds');
    git('checkout', '-q', 'main');
    await api.idle();

    const messages = await api.checkBranch(workspaceDir, 'main');
    assert.equal(messages.length, 1);
    assert.match(
      messages[0] ?? '',
      /^Local has 1 migration from another branch: add-refunds\.js\. Its file isn't in main, so it can't be rolled back from here\. It is on feat\/refunds\.$/,
    );
    // Reported once per branch, not on every check.
    assert.deepEqual(await api.checkBranch(workspaceDir, 'main'), []);
    renameSync(path.join(workspaceDir, '.git'), path.join(workspaceDir, '.git-done'));
  });

  test('removes staging and its stored connection', async () => {
    api.setConfirm(() => true);
    assert.equal(await vscode.commands.executeCommand('mmk.removeEnvironment', 'staging'), true);
    assert.deepEqual(vscode.workspace.getConfiguration('mmk').get('environments'), []);
    assert.equal(await api.environments.connection(workspaceDir, 'staging'), null);
    assert.deepEqual(
      api.store.environments().map((environment) => environment.name),
      ['local'],
    );
  });
});
