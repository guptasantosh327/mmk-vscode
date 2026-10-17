import { cpSync, rmSync } from 'node:fs';
import { defineConfig } from '@vscode/test-cli';

// Workspace Trust is tested on the packaged extension by test/integration/run-installed.mjs:
// @vscode/test-electron always passes --disable-workspace-trust, and a development extension is
// exempt from Workspace Trust anyway.
const mocha = { ui: 'tdd', timeout: 120_000 };

// The workflow tests create migration files, so they get a fresh copy of the fixture project.
// It stays under the repo (in the ignored .vscode-test folder) so mmk is found in node_modules.
const WORKSPACE_COPY = '.vscode-test/fixture-workspace';
const ENVIRONMENTS_COPY = '.vscode-test/fixture-environments';
for (const copy of [WORKSPACE_COPY, ENVIRONMENTS_COPY]) {
  rmSync(copy, { recursive: true, force: true });
  cpSync('test/fixtures/workspace', copy, { recursive: true });
}

// Connection strings go to VS Code's secret storage. Keep the test instances off the OS
// keychain where VS Code supports it (basic storage on Linux).
const secrets = ['--password-store=basic'];

export default defineConfig([
  {
    label: 'workspace',
    files: 'out/test/integration/workspace.test.js',
    workspaceFolder: WORKSPACE_COPY,
    launchArgs: ['--disable-extensions', ...secrets],
    mocha,
  },
  {
    label: 'environments',
    files: 'out/test/integration/environments.test.js',
    workspaceFolder: ENVIRONMENTS_COPY,
    launchArgs: ['--disable-extensions', ...secrets],
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
