import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { getExtension, settle } from './helpers.js';

suite('Empty folder', () => {
  test('the extension stays inactive', async () => {
    assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'The empty folder should be open');
    await settle();

    assert.equal(getExtension().isActive, false);
  });
});
