import { cpSync, rmSync } from 'node:fs';
import { defineConfig } from '@vscode/test-cli';

// Workspace Trust is tested on the packaged extension by test/integration/run-installed.mjs:
// @vscode/test-electron always passes --disable-workspace-trust, and a development extension is
// exempt from Workspace Trust anyway.
const mocha = { ui: 'tdd', timeout: 120_000 };

// The workflow tests create migration files, so they get a fresh copy of the fixture project.
// It stays under the repo (in the ignored .vscode-test folder) so mmk is found in node_modules.
const WORKSPACE_COPY = '.vscode-test/fixture-workspace';
rmSync(WORKSPACE_COPY, { recursive: true, force: true });
cpSync('test/fixtures/workspace', WORKSPACE_COPY, { recursive: true });

export default defineConfig([
  {
    label: 'workspace',
    files: 'out/test/integration/workspace.test.js',
    workspaceFolder: WORKSPACE_COPY,
    launchArgs: ['--disable-extensions'],
    mocha,
  },
  {
    label: 'empty',
    files: 'out/test/integration/empty.test.js',
    workspaceFolder: 'test/fixtures/empty',
    launchArgs: ['--disable-extensions'],
    mocha,
  },
]);
