import { defineConfig } from '@vscode/test-cli';

// Workspace Trust is tested on the packaged extension by test/integration/run-installed.mjs:
// @vscode/test-electron always passes --disable-workspace-trust, and a development extension is
// exempt from Workspace Trust anyway.
const mocha = { ui: 'tdd', timeout: 120_000 };

export default defineConfig([
  {
    label: 'workspace',
    files: 'out/test/integration/workspace.test.js',
    workspaceFolder: 'test/fixtures/workspace',
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
