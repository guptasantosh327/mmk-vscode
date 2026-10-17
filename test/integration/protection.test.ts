import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as vscode from 'vscode';
import type { MmkTestApi } from '../../src/extension.js';
import { REPO_ROOT, getExtension, waitFor } from './helpers.js';

const MMK_SCRIPT = path.join(REPO_ROOT, 'node_modules/mongo-migrate-kit/dist/mmk.cjs');
const FILE = '20260101000000-create-users.js';

suite('Applied-file protection (B1, B2) in the fixture workspace', () => {
  let mongo: MongoMemoryServer | undefined;
  let workspaceDir: string;
  let uri: vscode.Uri;
  let api: MmkTestApi;
  let committed: string;
  let checksumsReported = false;

  function mmk(args: string[]): string {
    return execFileSync('node', [MMK_SCRIPT, ...args], {
      cwd: workspaceDir,
      env: process.env,
      encoding: 'utf8',
    });
  }

  function git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Asha Rao',
        GIT_AUTHOR_EMAIL: 'asha@example.com',
        GIT_COMMITTER_NAME: 'Asha Rao',
        GIT_COMMITTER_EMAIL: 'asha@example.com',
      },
    }).trim();
  }

  function diagnostics(): vscode.Diagnostic[] {
    return vscode.languages.getDiagnostics(uri).filter((item) => item.source === 'mmk');
  }

  async function runLinks(): Promise<string[]> {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
    );
    return lenses.map((lens) => lens.command?.title ?? '');
  }

  /** Type a line into the file's editor, without saving */
  async function typeEdit(editor: vscode.TextEditor, line: number): Promise<void> {
    await editor.edit((builder) => builder.insert(new vscode.Position(line, 0), '  // edited\n'));
  }

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The fixture workspace should be open');
    workspaceDir = folder.uri.fsPath;
    uri = vscode.Uri.file(path.join(workspaceDir, 'migrations', FILE));

    mongo = await MongoMemoryServer.create();
    process.env.MMK_URI = mongo.getUri();
    process.env.MMK_DB = 'mmk_protection';

    git('init', '-q', '-b', 'main');
    git('add', 'migrations', 'mmk.config.js', 'package.json');
    git('commit', '-q', '-m', 'Add the users migration');
    committed = readFileSync(uri.fsPath, 'utf8');

    const exports = await getExtension().activate();
    assert.ok(exports, 'The extension should return its test hooks in test mode');
    api = exports as MmkTestApi;
    mmk(['up', FILE]);
    await vscode.commands.executeCommand('mmk.refresh');
    await api.idle();
    const row = api.store
      .snapshot(workspaceDir)
      ?.rows?.find((candidate) => candidate.file === FILE);
    assert.equal(row?.status, 'applied');
    checksumsReported = row?.checksum !== undefined;
  });

  suiteTeardown(async () => {
    await mongo?.stop();
  });

  test('without recorded checksums (mmk before R5), it stays quiet', async function () {
    if (checksumsReported) {
      this.skip();
    }
    const editor = await vscode.window.showTextDocument(uri);
    await typeEdit(editor, 1);
    assert.equal(await api.checkApplied(editor.document), undefined);
    assert.deepEqual(diagnostics(), []);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('warns while typing in an applied file, before it is saved (B1)', async function () {
    if (!checksumsReported) {
      this.skip();
    }
    const editor = await vscode.window.showTextDocument(uri);
    const upLine = editor.document
      .getText()
      .split('\n')
      .findIndex((line) => line.includes('async up('));
    await typeEdit(editor, upLine + 1);
    assert.ok(editor.document.isDirty);

    const state = await api.checkApplied(editor.document);
    assert.ok(state, 'The edit should be noticed');
    assert.equal(state.saved, false);
    assert.deepEqual(
      state.verdict.edited.map((record) => record.environment),
      ['local'],
    );
    await waitFor(() => diagnostics().length === 1, 5000, 'the applied-edited diagnostic');
    const [diagnostic] = diagnostics();
    assert.equal(diagnostic?.code, 'applied-edited');
    assert.equal(diagnostic?.severity, vscode.DiagnosticSeverity.Warning);
    assert.equal(
      diagnostic?.message,
      'This migration already ran on local. Saving the edit changes its checksum, and mmk down will refuse to roll it back.',
    );
    assert.equal(diagnostic?.range.start.line, upLine + 1);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      new vscode.Position(upLine + 1, 2),
    );
    const text = hovers
      .flatMap((hover) => hover.contents)
      .map((content) => (typeof content === 'string' ? content : content.value))
      .join('\n');
    assert.match(text, /This migration has already run/);
    assert.match(text, /If you save this edit, its checksum changes for local:/);
    assert.match(text, /\[Show applied version\]\(command:mmk\.showAppliedVersion/);

    assert.deepEqual((await runLinks()).slice(0, 2), [
      '$(warning) Applied on local · edited since',
      'Show applied version',
    ]);
  });

  test('"Undo my edit" drops the unsaved edit and the warning', async function () {
    if (!checksumsReported) {
      this.skip();
    }
    assert.equal(await vscode.commands.executeCommand('mmk.undoAppliedEdit', uri), true);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.isDirty, false);
    assert.equal(await api.checkApplied(document), undefined);
    await waitFor(() => diagnostics().length === 0, 5000, 'the diagnostic to clear');
  });

  test('"Show applied version" diffs the commit that ran with the saved edit (B2)', async function () {
    if (!checksumsReported) {
      this.skip();
    }
    const editor = await vscode.window.showTextDocument(uri);
    await typeEdit(editor, 1);
    await editor.document.save();
    const state = await api.checkApplied(editor.document);
    assert.equal(state?.saved, true);

    const version = await vscode.commands.executeCommand<{ subject: string; commit: string }>(
      'mmk.showAppliedVersion',
      uri,
    );
    assert.equal(version?.subject, 'Add the users migration');
    assert.equal(version?.commit, git('rev-parse', 'HEAD'));

    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'A diff editor should be open');
    assert.equal(input.original.scheme, 'mmk-applied');
    assert.equal(input.modified.fsPath, uri.fsPath);
    const applied = await vscode.workspace.openTextDocument(input.original);
    assert.equal(applied.getText(), committed);
  });

  test('"Restore applied version" puts it back, and mmk agrees', async function () {
    if (!checksumsReported) {
      this.skip();
    }
    assert.equal(await vscode.commands.executeCommand('mmk.restoreAppliedVersion', uri), true);
    assert.equal(readFileSync(uri.fsPath, 'utf8'), committed);
    await waitFor(() => diagnostics().length === 0, 5000, 'the diagnostic to clear');

    await vscode.commands.executeCommand('mmk.refresh');
    await api.idle();
    const row = api.store
      .snapshot(workspaceDir)
      ?.rows?.find((candidate) => candidate.file === FILE);
    assert.equal(row?.checksumOk, true);
  });
});
