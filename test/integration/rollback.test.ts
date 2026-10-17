import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as vscode from 'vscode';
import type { MmkTestApi } from '../../src/extension.js';
import type { RollbackRunRecord } from '../../src/testing/rollback.js';
import { getExtension, waitFor } from './helpers.js';

const A4 = '20260104000000-index-orders-by-customer.js';

suite('Rollback tests and lint (A4) in the fixture workspace', () => {
  let mongo: MongoMemoryServer | undefined;
  let client: MongoClient;
  let workspaceDir: string;
  let api: MmkTestApi;
  let supported = false;

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The fixture workspace should be open');
    workspaceDir = folder.uri.fsPath;

    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    process.env.MMK_URI = mongo.getUri();
    process.env.MMK_DB = 'mmk_rollback';

    const exports = await getExtension().activate();
    assert.ok(exports, 'The extension should return its test hooks in test mode');
    api = exports as MmkTestApi;
    await vscode.commands.executeCommand('mmk.refresh');
    await api.idle();
    supported = (await api.lint(workspaceDir)) !== undefined;
  });

  suiteTeardown(async () => {
    await client?.close();
    await mongo?.stop();
  });

  test('lists every migration with its up, down and up again steps', () => {
    const files: string[] = [];
    api.rollbackTests.controller.items.forEach((item) => {
      const steps: string[] = [];
      item.children.forEach((child) => steps.push(child.label));
      files.push(`${item.label}: ${steps.join(', ')}`);
    });
    assert.deepEqual(files.sort(), [
      'add-email-index.js: up, down, up again',
      'backfill-user-status.js: up, down, up again',
      'create-users.js: up, down, up again',
      'index-orders-by-customer.js: up, down, up again',
    ]);
  });

  test("fails the A4 example in down(), with mmk's message at line 12", async () => {
    const record = await vscode.commands.executeCommand<RollbackRunRecord>('mmk.testRollback');
    if (!supported) {
      assert.match(record.messages[0]?.text ?? '', /need a newer mongo-migrate-kit/);
      return;
    }
    const [report] = record.reports;
    assert.ok(report, 'mmk should have reported');
    assert.deepEqual(
      report.results.map((result) => [result.file.replace(/^\d+-/, ''), result.status]),
      [
        ['create-users.js', 'passed'],
        ['add-email-index.js', 'passed'],
        ['backfill-user-status.js', 'passed'],
        ['index-orders-by-customer.js', 'failed'],
      ],
    );
    const down = record.messages.find((message) => message.id.endsWith(`${A4}::down`));
    assert.ok(down, record.messages.map((message) => message.id).join('\n'));
    assert.equal(down.line, 11, 'line 12, counted from 0');
    assert.equal(down.file, path.join(workspaceDir, 'migrations', A4));
    assert.match(down.text, /^rollback test failed in down\(\)\n\n/);
    assert.match(
      down.text,
      /Reason: MongoServerError: index not found with name \[customerId_1_createdAt_-1\]/,
    );
    assert.match(down.text, /mmk_rollback was not touched/);
    assert.equal(report.dropped, true);
    assert.deepEqual(await client.db('mmk_rollback').listCollections().toArray(), []);
  });

  test('runs one migration from its item, after the ones before it', async function () {
    if (!supported) {
      this.skip();
    }
    const record = await vscode.commands.executeCommand<RollbackRunRecord>('mmk.testRollback', {
      dir: workspaceDir,
      file: '20260102000000-add-email-index.js',
    });
    assert.deepEqual(
      record.reports[0]?.setup.map((setup) => setup.file),
      ['20260101000000-create-users.js'],
    );
    assert.equal(record.reports[0]?.results[0]?.status, 'passed');
  });

  test('shows lint findings as diagnostics, after a save', async function () {
    if (!supported) {
      this.skip();
    }
    const file = path.join(workspaceDir, 'migrations', '20260105000000-risky.js');
    writeFileSync(
      file,
      "module.exports = {\n  async up({ db }) {\n    await db.collection('orders').updateMany({}, { $set: { open: true } });\n  },\n  async down() {},\n};\n",
    );
    await vscode.commands.executeCommand('mmk.refresh');
    await api.idle();
    const report = await api.lint(workspaceDir);
    assert.ok(report?.files.includes('20260105000000-risky.js'));
    const uri = vscode.Uri.file(file);
    await waitFor(
      () =>
        vscode.languages.getDiagnostics(uri).filter((item) => item.source === 'mmk').length === 2,
      5000,
      'the lint diagnostics',
    );
    const diagnostics = vscode.languages
      .getDiagnostics(uri)
      .filter((item) => item.source === 'mmk')
      .map((item) => [
        typeof item.code === 'object' ? item.code.value : item.code,
        item.severity,
        item.range.start.line,
        item.range.start.character,
      ]);
    assert.deepEqual(diagnostics, [
      ['unfiltered-write', vscode.DiagnosticSeverity.Warning, 2, 34],
      ['empty-down', vscode.DiagnosticSeverity.Warning, 4, 8],
    ]);
  });
});
