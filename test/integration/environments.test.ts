import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import * as path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as vscode from 'vscode';
import type { MmkTestApi } from '../../src/extension.js';
import type { ConsolePanel } from '../../src/views/console/panel.js';
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

  test('shows the environments as a pipeline in the sidebar, and reviews from it (B)', async () => {
    let [project] = api.pipeline.view().projects;
    assert.ok(project, 'The pipeline should show the project');
    assert.deepEqual(
      project.model.steps.map((step) => [step.name, step.readOnly, step.selected, step.pending]),
      [
        ['local', false, true, 2],
        ['staging', true, false, 1],
      ],
    );
    assert.match(project.model.steps[1]?.latest ?? '', /^add-email-index\.js · batch 2 · /);
    assert.deepEqual(
      project.model.items.map((item) => [item.label, item.environments.map((env) => env.kind)]),
      [
        ['add-email-index.js', ['pending', 'applied']],
        ['backfill-user-status.js', ['pending', 'pending']],
      ],
    );

    // Picking a step selects that environment everywhere.
    await api.pipeline.receive({ type: 'select', name: 'staging' });
    assert.equal(api.store.selected().name, 'staging');
    [project] = api.pipeline.view().projects;
    assert.equal(project?.model.selected, 'staging');
    await api.pipeline.receive({ type: 'select', name: 'local' });
    assert.equal(api.store.selected().name, 'local');

    // Review opens the console's plan: a dry run, nothing written.
    const steps = (await api.pipeline.receive({ type: 'review', dir: workspaceDir })) as Array<{
      file: string;
    }>;
    assert.deepEqual(
      steps.map((step) => step.file),
      [EMAIL_INDEX, BACKFILL],
    );
    const panel = await vscode.commands.executeCommand<ConsolePanel>('mmk.openConsole', {
      dir: workspaceDir,
    });
    assert.equal(panel?.view().drawer?.kind, 'plan');
    panel?.dispose();
    await api.idle();
  });

  test("changes an environment's colour, keeping the rest of its settings entry", async () => {
    const [before] = api.pipeline.view().projects;
    assert.deepEqual(
      before?.model.steps.map((step) => [step.name, step.hue]),
      [
        ['local', 'green'],
        ['staging', 'yellow'],
      ],
    );

    assert.equal(
      await vscode.commands.executeCommand('mmk.setEnvironmentColor', 'staging', 'purple'),
      'purple',
    );
    assert.deepEqual(vscode.workspace.getConfiguration('mmk').get('environments'), [
      { name: 'staging', readOnly: true, color: 'purple' },
    ]);
    assert.equal(api.store.environment('staging')?.color, 'purple');
    const [after] = api.pipeline.view().projects;
    assert.equal(after?.model.steps[1]?.hue, 'purple');
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
      await vscode.commands.executeCommand('mmk.downBatch', { dir: workspaceDir, batch: 1 }),
      undefined,
    );
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

  test('compares every environment in the console, read-only on staging (C2–C4)', async () => {
    const panel = await vscode.commands.executeCommand<ConsolePanel>('mmk.compareEnvironments', {
      dir: workspaceDir,
    });
    assert.ok(panel, 'The console should open');
    await api.idle();
    let view = panel.view();

    assert.equal(view.filter, 'diff');
    assert.equal(view.selected, 'staging');
    assert.deepEqual(
      view.columns.map((column) => [column.name, column.readOnly]),
      [
        ['local', false],
        ['staging', true],
      ],
    );
    assert.deepEqual(
      view.model.rows.map((row) => [row.label, row.cells.map((cell) => cell.text), row.note]),
      [['add-email-index.js', ['pending', 'batch 2'], 'Not on local yet']],
    );
    assert.deepEqual(
      view.model.chips.map((chip) => [chip.id, chip.count]),
      [
        ['all', 3],
        ['pending', 1],
        ['attention', 0],
        ['diff', 1],
      ],
    );
    assert.match(view.subtitle, /records from each environment's changelog · updated \d\d:\d\d$/);

    await panel.receive({ type: 'filter', value: 'all' });
    view = panel.view();
    assert.deepEqual(
      view.model.rows.map((row) => [row.label, row.cells.map((cell) => cell.text)]),
      [
        ['create-users.js', ['batch 1', 'batch 1']],
        ['add-email-index.js', ['pending', 'batch 2']],
        ['backfill-user-status.js', ['pending', 'pending']],
      ],
    );
    // The environment line says it's read-only; no notice repeats it
    assert.deepEqual(view.model.notices, []);
    assert.equal(view.model.environment.readOnly, true);
    assert.equal(view.model.detail?.file, BACKFILL);
    assert.deepEqual(view.model.detail?.buttons, [
      { action: 'dryRun', label: 'Plan on staging', primary: false },
    ]);
    assert.match(
      view.cli,
      /^MMK_URI='<staging connection string>' MMK_DB=(mmk_staging|<staging database>) npx mmk dry-run up 20260103000000-backfill-user-status\.js$/,
    );

    // A button the console doesn't offer does nothing, even when the webview asks for it.
    const before = await stagingRecords();
    assert.equal(await panel.receive({ type: 'action', action: 'up' }), undefined);
    await api.idle();
    assert.equal(await stagingRecords(), before);

    // The plan works on staging (a dry run), but applying it is refused, and nothing is asked.
    const asked: string[] = [];
    api.setConfirm((message) => {
      asked.push(message);
      return true;
    });
    const steps = (await panel.receive({ type: 'plan' })) as Array<{ file: string }>;
    assert.deepEqual(
      steps.map((step) => step.file),
      [BACKFILL],
    );
    const plan = panel.view().drawer;
    assert.equal(plan?.kind, 'plan');
    assert.equal(plan?.kind === 'plan' && plan.readOnly, true);
    assert.equal(await panel.receive({ type: 'applyPlan' }), undefined);
    await api.idle();
    assert.deepEqual(asked, []);
    assert.equal(await stagingRecords(), before);
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

  test('runs up from the console on local, then offers to roll it back (C1, C2)', async () => {
    const panel = await vscode.commands.executeCommand<ConsolePanel>('mmk.openConsole', {
      dir: workspaceDir,
    });
    assert.ok(panel, 'The console should open');
    await api.idle();
    let view = panel.view();
    assert.equal(view.selected, 'local');
    assert.deepEqual(view.model.notices, []);
    assert.equal(view.model.detail?.file, BACKFILL);
    assert.deepEqual(
      view.model.detail?.buttons.map((button) => button.action),
      ['up', 'dryRun'],
    );
    assert.equal(view.cli, `npx mmk up ${BACKFILL}`);

    const results = (await panel.receive({ type: 'action', action: 'up' })) as Array<{
      file: string;
      status: string;
    }>;
    assert.deepEqual(
      results.map((result) => [result.file, result.status]),
      [[BACKFILL, 'applied']],
    );
    await api.idle();

    // The run stays on screen, finished, until it's closed.
    const run = panel.view().run;
    assert.equal(run?.state, 'done');
    assert.equal(run?.environment, 'local');
    assert.match(run?.label ?? '', /^up /);
    await panel.receive({ type: 'closeDrawer' });
    assert.equal(panel.view().run, null);

    view = panel.view();
    const row = view.model.rows.find((candidate) => candidate.file === BACKFILL);
    assert.match(row?.cells[0]?.text ?? '', /^batch \d+$/);
    assert.deepEqual(
      view.model.detail?.buttons.map((button) => button.action),
      ['down', 'redo', 'downBatch'],
    );
    assert.ok(
      view.model.batches.some((batch) => batch.picked),
      'Its batch should be marked',
    );
    panel.dispose();
  });

  test('rolls back a batch from the console only after the modal, then plans and applies again (C6–C9)', async () => {
    const panel = await vscode.commands.executeCommand<ConsolePanel>('mmk.openConsole', {
      dir: workspaceDir,
    });
    assert.ok(panel, 'The console should open');
    await api.idle();
    await panel.receive({ type: 'pick', file: BACKFILL });
    const button = panel
      .view()
      .model.detail?.buttons.find((candidate) => candidate.action === 'downBatch');
    assert.ok(button?.batch, 'An applied migration should offer to roll back its batch');
    const batch = button.batch;
    assert.equal(button.label, `Roll back batch ${batch}…`);

    // Saying no runs nothing.
    api.setConfirm(() => false);
    assert.equal(await panel.receive({ type: 'action', action: 'downBatch' }), undefined);
    await api.idle();
    assert.equal(
      api.store.snapshot(workspaceDir)?.rows?.find((row) => row.file === BACKFILL)?.status,
      'applied',
    );

    const asked: string[] = [];
    api.setConfirm((message) => {
      asked.push(message);
      return true;
    });
    const rolledBack = (await panel.receive({ type: 'action', action: 'downBatch' })) as {
      title: string;
      ok: boolean;
      lines: Array<{ label: string; text: string }>;
    };
    assert.deepEqual(asked, [`Roll back batch ${batch} on local?`]);
    assert.equal(rolledBack.title, `Rolled back batch ${batch} on local`);
    assert.equal(rolledBack.ok, true);
    assert.deepEqual(
      rolledBack.lines.map((line) => [line.label, line.text]),
      [['backfill-user-status.js', 'Rolled back']],
    );
    assert.equal(panel.view().drawer?.kind, 'result');
    assert.equal(
      api.store.snapshot(workspaceDir)?.rows?.find((row) => row.file === BACKFILL)?.status,
      'pending',
    );

    // Plan, then apply: it runs as one batch and the result says so.
    const steps = (await panel.receive({ type: 'plan' })) as Array<{ file: string }>;
    assert.deepEqual(
      steps.map((step) => step.file),
      [BACKFILL],
    );
    const applied = (await panel.receive({ type: 'applyPlan' })) as {
      title: string;
      ok: boolean;
      rollBackBatch: number | null;
    };
    assert.equal(applied.title, 'Applied 1 on local');
    assert.equal(applied.ok, true);
    assert.ok(applied.rollBackBatch, 'The result should offer to roll its batch back');
    assert.equal(
      api.store.snapshot(workspaceDir)?.rows?.find((row) => row.file === BACKFILL)?.status,
      'applied',
    );

    await panel.receive({ type: 'closeDrawer' });
    assert.equal(panel.view().drawer, null);
    panel.dispose();
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

  test("names another run's lock in the pipeline, the console and the tree, then releases it", async function () {
    await vscode.commands.executeCommand('mmk.selectEnvironment', 'local');
    // Another run holding the lock on local, as mmk records it (its own tests do the same).
    const locks = client.db('mmk_local').collection<{
      _id: string;
      [field: string]: unknown;
    }>('_mmk_locks');
    const now = Date.now();
    await locks.insertOne({
      _id: 'mmk_lock',
      lockedAt: new Date(now),
      acquiredAt: new Date(now),
      expiresAt: new Date(now + 600_000),
      pid: 4242,
      host: 'deploy-runner-7',
      executedBy: 'ci',
      owner: 'another-run',
    });
    try {
      await vscode.commands.executeCommand('mmk.refresh');
      await api.idle();
      const step = (): { lock: { summary: string } | null } | undefined =>
        api.pipeline
          .view()
          .projects[0]?.model.steps.find((candidate) => candidate.name === 'local');
      if (!api.store.snapshot(workspaceDir)?.environments.local?.lock) {
        // mmk before R11 has no `lock` command, so nothing names the lock.
        assert.equal(step()?.lock, null);
        this.skip();
      }

      assert.match(
        step()?.lock?.summary ?? '',
        /^Locked by ci on deploy-runner-7 \(pid 4242\) since \d\d:\d\d$/,
      );
      assert.ok(
        api.sidebar().some((line) => line.includes('Locked by ci on deploy-runner-7')),
        'The tree should name the holder',
      );
      const panel = await vscode.commands.executeCommand<ConsolePanel>('mmk.openConsole', {
        dir: workspaceDir,
      });
      assert.ok(panel, 'The console should open');
      // The lock sits on the environment line (design A), and runs wait for it
      const line = panel.view().model.environment;
      assert.equal(line.lock?.who, 'ci on deploy-runner-7');
      assert.equal(line.lock?.process, 'pid 4242');
      assert.equal(line.canRelease, true);
      const runs = (panel.view().model.detail?.buttons ?? []).filter((button) =>
        ['up', 'down', 'redo', 'downBatch'].includes(button.action),
      );
      assert.ok(
        runs.every((button) => button.disabled === 'local is locked by ci on deploy-runner-7'),
        'Run buttons should wait for the lock',
      );

      api.setConfirm(() => true);
      await panel.receive({ type: 'unlock' });
      await api.idle();
      assert.deepEqual(api.store.snapshot(workspaceDir)?.environments.local?.lock, {
        holder: null,
        stale: false,
      });
      assert.equal(panel.view().model.environment.lock, null);
      assert.equal(step()?.lock, null);
      panel.dispose();
    } finally {
      await locks.deleteMany({});
    }
  });

  test('adds an environment from the console dialog (C13), testing it with mmk status first', async () => {
    const uri = mongo?.getUri() ?? '';
    const panel = await vscode.commands.executeCommand<ConsolePanel>('mmk.addEnvironment', {
      dir: workspaceDir,
    });
    assert.ok(panel, 'The console should open with the dialog');
    assert.equal(panel.view().dialog?.kind, 'addEnvironment');

    // Checked before mmk runs, with the same rules as before
    await panel.receive({
      type: 'saveEnvironment',
      name: 'staging',
      uri: 'http://qa.example.com',
      dbName: '',
      readOnly: true,
      color: null,
      force: false,
    });
    const errors = panel.view().dialog?.errors;
    assert.match(errors?.name ?? '', /staging/);
    assert.ok(errors?.uri, 'A connection string that isn’t mongodb:// should be refused');
    assert.equal(errors?.dbName, 'Type the database name');

    assert.deepEqual(
      await panel.receive({ type: 'testEnvironment', name: 'qa', uri, dbName: 'mmk_qa' }),
      { ok: true },
    );
    assert.equal(
      panel.view().dialog?.test.text,
      'Connected: mmk status read 3 migrations on qa, 3 of them pending.',
    );
    assert.ok(
      !JSON.stringify(panel.view()).includes(uri),
      'The connection string is never sent back to the webview',
    );

    const added = await panel.receive({
      type: 'saveEnvironment',
      name: 'qa',
      uri,
      dbName: 'mmk_qa',
      readOnly: true,
      color: 'purple',
      force: false,
    });
    assert.equal(added, 'qa');
    assert.equal(panel.view().dialog, null);
    assert.equal(api.store.selected().name, 'qa');
    assert.deepEqual(
      vscode.workspace
        .getConfiguration('mmk')
        .get<Array<{ name: string }>>('environments')
        ?.find((entry) => entry.name === 'qa'),
      { name: 'qa', readOnly: true, color: 'purple' },
    );
    assert.deepEqual(await api.environments.connection(workspaceDir, 'qa'), {
      uri,
      dbName: 'mmk_qa',
    });

    // Removed from the same dialog, after the usual confirmation
    await panel.receive({ type: 'editEnvironment', name: 'qa' });
    api.setConfirm(() => true);
    assert.equal(await panel.receive({ type: 'removeEnvironment' }), true);
    assert.equal(panel.view().dialog, null);
    assert.equal(await api.environments.connection(workspaceDir, 'qa'), null);
    assert.equal(api.store.selected().name, 'local');
    panel.dispose();
  });

  test('edits an environment in the same dialog, keeping its stored connection', async () => {
    const uri = mongo?.getUri() ?? '';
    const entry = (name: string): unknown =>
      vscode.workspace
        .getConfiguration('mmk')
        .get<Array<{ name: string }>>('environments')
        ?.find((candidate) => candidate.name === name);
    const panel = await vscode.commands.executeCommand<ConsolePanel>(
      'mmk.editEnvironment',
      'staging',
    );
    assert.ok(panel, 'The console should open with the dialog');
    assert.deepEqual(
      {
        kind: panel.view().dialog?.kind,
        name: panel.view().dialog?.name,
        readOnly: panel.view().dialog?.readOnly,
        stored: panel.view().dialog?.stored,
      },
      { kind: 'editEnvironment', name: 'staging', readOnly: true, stored: true },
    );
    assert.ok(!JSON.stringify(panel.view()).includes(uri), 'The stored string is never sent');

    // An empty connection string keeps the stored one, so nothing needs testing
    const database = panel.view().dialog?.dbName ?? '';
    assert.equal(
      await panel.receive({
        type: 'saveEnvironment',
        name: 'staging',
        uri: '',
        dbName: database,
        readOnly: true,
        color: 'orange',
        force: false,
      }),
      'staging',
    );
    assert.equal(panel.view().dialog, null);
    assert.deepEqual(entry('staging'), { name: 'staging', readOnly: true, color: 'orange' });
    assert.equal((await api.environments.connection(workspaceDir, 'staging'))?.uri, uri);

    // local: only its colour, and Automatic puts its default back
    for (const color of ['blue', null] as const) {
      await panel.receive({ type: 'editEnvironment', name: 'local' });
      assert.equal(panel.view().dialog?.local, true);
      await panel.receive({
        type: 'saveEnvironment',
        name: 'local',
        uri: '',
        dbName: '',
        readOnly: false,
        color,
        force: false,
      });
      assert.deepEqual(entry('local'), color ? { name: 'local', color } : undefined);
    }
    panel.dispose();
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
