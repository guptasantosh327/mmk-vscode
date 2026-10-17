import {
  type JsonOutput,
  type MmkInvocation,
  type RunOptions,
  isUnknownCommand,
  runMmkJson,
  runNodeJson,
} from './cli.js';
import { type ProjectConfig, parseProjectConfig } from './contract.js';

/** How a project's config was read */
export type ConfigSource = 'cli' | 'library';

/** A project's resolved config, and how it was read */
export interface ReadConfig {
  config: ProjectConfig;
  /**
   * `cli`: `mmk config --json` (request R2, mongo-migrate-kit after 1.5). `library`: the
   * project's own mongo-migrate-kit `MigratorKit.resolveConfig()`, for versions without it
   */
  via: ConfigSource;
}

/** Runs one of the two readers; tests pass fakes */
export interface ConfigReaders {
  cli: (
    invocation: MmkInvocation,
    args: readonly string[],
    options: RunOptions,
  ) => Promise<JsonOutput>;
  library: (
    invocation: MmkInvocation,
    nodeArgs: readonly string[],
    label: string,
    options: RunOptions,
  ) => Promise<JsonOutput>;
}

const DEFAULT_READERS: ConfigReaders = { cli: runMmkJson, library: runNodeJson };

/**
 * Read a project's resolved config. Nothing is resolved here: mmk always does it.
 *
 * - With an mmk that has `mmk config --json`, that command answers.
 * - With mongo-migrate-kit 1.5, which has no such command, the extension asks the project's own
 *   mongo-migrate-kit in a child process on the user's Node:
 *   `new MigratorKit({ logger: null }).resolveConfig()`, the public API every command uses to
 *   resolve flags, `MMK_*`, `.env`, the config file and defaults. Like the CLI, this needs a
 *   connection string and database name, and reports `CONFIG_INVALID` without them.
 *
 * @throws `MmkCommandError` with mmk's own error (e.g. `CONFIG_INVALID`), or `MmkProcessError`
 */
export async function readProjectConfig(
  invocation: MmkInvocation,
  packageDir: string,
  options: RunOptions = {},
  readers: ConfigReaders = DEFAULT_READERS,
): Promise<ReadConfig> {
  try {
    const output = await readers.cli(invocation, ['config'], options);
    return { config: parseProjectConfig(output.value, 'config'), via: 'cli' };
  } catch (error) {
    if (!isUnknownCommand(error, 'config')) {
      throw error;
    }
  }
  const output = await readers.library(
    invocation,
    ['-e', LIBRARY_CONFIG_SCRIPT, packageDir],
    "mongo-migrate-kit's resolveConfig()",
    options,
  );
  return { config: parseProjectConfig(output.value, 'resolveConfig()'), via: 'library' };
}

/**
 * Runs with `node -e <script> <packageDir>` in the project directory. It loads the project's own
 * mongo-migrate-kit, resolves the config with mmk's public API, and prints the same fields
 * `mmk config --json` prints, or mmk's error document. The connection string's credentials are
 * hidden before anything is printed (as mmk's `redactConnectionString` does).
 */
export const LIBRARY_CONFIG_SCRIPT = `
const path = require('node:path');
const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const hideCredentials = (uri) => {
  const at = uri.lastIndexOf('@');
  if (at === -1) return uri;
  const scheme = (/^\\s*["']?[a-z][a-z0-9+.-]*:\\/+/i.exec(uri) || [''])[0];
  const prefix = scheme.length <= at ? scheme : '';
  const userinfo = uri.slice(prefix.length, at);
  return prefix + (userinfo.includes(':') ? '***:***' : '***') + '@' + uri.slice(at + 1);
};
(async () => {
  const { MigratorKit } = require(process.argv[1]);
  const config = await new MigratorKit({ logger: null }).resolveConfig();
  print({
    migrationsDir: path.resolve(config.migrationsDir),
    fileExtensions: config.fileExtensions,
    createExtension: config.createExtension,
    sequential: config.sequential,
    ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
    dbName: config.dbName || null,
    uri: config.uri ? hideCredentials(config.uri) : null,
  });
})().catch((error) => {
  print({
    error: {
      ...(error && typeof error.code === 'string' ? { code: error.code } : {}),
      message: error instanceof Error ? error.message : String(error),
      ...(error && error.context ? { details: error.context } : {}),
    },
  });
  process.exitCode = 1;
});
`;
