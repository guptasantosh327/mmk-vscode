// Tests the packaged extension (.vsix) the way users install it: it activates in a trusted
// workspace and stays inactive in Restricted Mode.
//
// Two VS Code behaviours rule out the @vscode/test-cli configs for this: runTests() always passes
// --disable-workspace-trust, and an extension loaded with --extensionDevelopmentPath is exempt
// from Workspace Trust. So this packages the extension, installs it into a fresh profile, and
// runs the checks from a small harness extension (test/integration/installed/harness).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
} from '@vscode/test-electron';

const EXTENSION_ID = 'guptasantosh327.mmk-vscode';
const root = resolve(import.meta.dirname, '../..');
const workspace = join(root, 'test/fixtures/workspace');
// VS Code puts an IPC socket in the user data folder, and a socket path must stay under 104
// characters: macOS's per-user temp folder is too deep for that, so use /tmp outside Windows.
const scratch = mkdtempSync(
  join(process.platform === 'win32' ? tmpdir() : '/tmp', 'mmk-vscode-installed-'),
);

// Set when this runs from a VS Code terminal or extension; it would start Code as plain Node.
const env = { ...process.env };
env.ELECTRON_RUN_AS_NODE = undefined;

/** Run a command, streaming its output; throw when it fails */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, cwd: root });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

/** A fresh profile with the .vsix installed, and Workspace Trust on without a startup prompt */
function makeProfile(name, cli, vsix) {
  const profile = join(scratch, name);
  const userData = join(profile, 'user-data');
  const extensions = join(profile, 'extensions');
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(
    join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'security.workspace.trust.enabled': true,
      'security.workspace.trust.startupPrompt': 'never',
    }),
  );
  const profileArgs = [`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`];
  run(cli, [...profileArgs, '--install-extension', vsix]);
  const listed = spawnSync(cli, [...profileArgs, '--list-extensions'], { env, encoding: 'utf8' });
  if (!listed.stdout.toLowerCase().split('\n').includes(EXTENSION_ID)) {
    throw new Error(`${EXTENSION_ID} was not installed. --list-extensions said:\n${listed.stdout}`);
  }
  return profileArgs;
}

/** Launch VS Code on the fixture workspace and run one test entry point */
function launch(executable, profileArgs, entry, extraArgs) {
  run(executable, [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    ...profileArgs,
    ...extraArgs,
    `--extensionDevelopmentPath=${join(root, 'test/integration/installed/harness')}`,
    `--extensionTestsPath=${join(root, 'out/test/integration/installed', entry)}`,
    workspace,
  ]);
}

let status = 0;
try {
  const vsix = join(scratch, 'mmk-vscode.vsix');
  run('npx', ['vsce', 'package', '--out', vsix]);
  const executable = await downloadAndUnzipVSCode({ cachePath: join(root, '.vscode-test') });
  const cli = resolveCliPathFromVSCodeExecutablePath(executable);

  launch(executable, makeProfile('trusted', cli, vsix), 'trusted.js', [
    '--disable-workspace-trust',
  ]);
  launch(executable, makeProfile('untrusted', cli, vsix), 'untrusted.js', []);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  status = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
