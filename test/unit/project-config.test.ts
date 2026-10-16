import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type JsonOutput,
  MmkCommandError,
  type MmkInvocation,
  MmkProcessError,
  runNodeJson,
} from '../../src/mmk/cli.js';
import { type ConfigReaders, readProjectConfig } from '../../src/mmk/project-config.js';
import { makeTree, removeTree } from './helpers/tmp.js';

const CONFIG = {
  migrationsDir: '/p/migrations',
  fileExtensions: ['.ts', '.js'],
  createExtension: 'js',
  sequential: false,
  dbName: 'orders_dev',
  uri: 'mongodb://localhost:27017',
};

const INVOCATION: MmkInvocation = { nodePath: 'node', script: 'mmk.cjs', cwd: '/p' };

function output(value: unknown): JsonOutput {
  return { value, exitCode: 0, stderr: '', otherStdout: '' };
}

/** commander's answer when a command doesn't exist, as mmk 1.5 gives for `config` */
const UNKNOWN_COMMAND = new MmkProcessError(
  'bad-output',
  'mmk config --json exited with code 1 without printing JSON.',
  "error: unknown command 'config'\n(run `mmk --help`, or `mmk <command> --help`, for usage)\n",
);

describe('readProjectConfig', () => {
  it('should use mmk config --json when the project’s mmk has it', async () => {
    const calls: string[] = [];
    const readers: ConfigReaders = {
      cli: async (_invocation, args) => {
        calls.push(`cli ${args.join(' ')}`);
        return output({ ...CONFIG, sources: {} });
      },
      library: async () => {
        calls.push('library');
        return output(CONFIG);
      },
    };

    await expect(readProjectConfig(INVOCATION, '/pkg', {}, readers)).resolves.toEqual({
      config: CONFIG,
      via: 'cli',
    });
    expect(calls).toEqual(['cli config']);
  });

  it('should ask mongo-migrate-kit’s resolveConfig() when mmk has no config command', async () => {
    let libraryArgs: readonly string[] = [];
    const readers: ConfigReaders = {
      cli: async () => {
        throw UNKNOWN_COMMAND;
      },
      library: async (_invocation, nodeArgs) => {
        libraryArgs = nodeArgs;
        return output(CONFIG);
      },
    };

    await expect(readProjectConfig(INVOCATION, '/pkg', {}, readers)).resolves.toEqual({
      config: CONFIG,
      via: 'library',
    });
    expect(libraryArgs[0]).toBe('-e');
    expect(libraryArgs[2]).toBe('/pkg');
  });

  it("should pass on mmk's own errors from the config command", async () => {
    const invalid = new MmkCommandError(
      { code: 'CONFIG_INVALID', message: 'bad' },
      ['config'],
      1,
      '',
    );
    const readers: ConfigReaders = {
      cli: async () => {
        throw invalid;
      },
      library: async () => output(CONFIG),
    };

    await expect(readProjectConfig(INVOCATION, '/pkg', {}, readers)).rejects.toBe(invalid);
  });

  it('should pass on a timeout instead of trying the library', async () => {
    const timeout = new MmkProcessError('timeout', 'mmk config --json did not finish');
    const readers: ConfigReaders = {
      cli: async () => {
        throw timeout;
      },
      library: async () => output(CONFIG),
    };

    await expect(readProjectConfig(INVOCATION, '/pkg', {}, readers)).rejects.toBe(timeout);
  });
});

/**
 * The bridge script itself, run with this Node against a stand-in mongo-migrate-kit whose
 * MigratorKit.resolveConfig() returns what FAKE_CONFIG says (the contract tests use the real one).
 */
describe('the resolveConfig() bridge script', () => {
  const FAKE_PACKAGE = `
module.exports.MigratorKit = class {
  constructor(flags) { this.flags = flags; }
  async resolveConfig() {
    if (process.env.FAKE_FAIL) {
      const error = new Error('dbName is missing');
      error.code = 'CONFIG_INVALID';
      error.context = { issues: [{ key: 'dbName' }] };
      throw error;
    }
    if (this.flags.logger !== null) throw new Error('expected logger: null');
    return JSON.parse(process.env.FAKE_CONFIG);
  }
};
`;
  let root: string;
  let packageDir: string;
  let project: string;

  beforeAll(() => {
    root = makeTree({
      'node_modules/mongo-migrate-kit/package.json': JSON.stringify({ main: 'index.cjs' }),
      'node_modules/mongo-migrate-kit/index.cjs': FAKE_PACKAGE,
      'project/.keep': '',
    });
    packageDir = path.join(root, 'node_modules/mongo-migrate-kit');
    project = path.join(root, 'project');
  });

  afterAll(() => {
    removeTree(root);
  });

  function run(env: Record<string, string>): Promise<JsonOutput> {
    const readers: ConfigReaders = {
      cli: async () => {
        throw UNKNOWN_COMMAND;
      },
      library: (invocation, nodeArgs, label, options) =>
        runNodeJson(invocation, nodeArgs, label, { ...options, env }),
    };
    return readProjectConfig(
      { nodePath: process.execPath, script: 'unused', cwd: project },
      packageDir,
      {},
      readers,
    ).then((result) => output(result));
  }

  it('should print the resolved values, with an absolute folder and the password hidden', async () => {
    const result = await run({
      FAKE_CONFIG: JSON.stringify({
        migrationsDir: './db/migrations',
        fileExtensions: ['.js'],
        createExtension: 'ts',
        sequential: true,
        namespace: 'billing',
        dbName: 'orders_dev',
        uri: 'mongodb+srv://alice:s3cret@cluster0.example.net/app',
        mongoClientOptions: { tls: true },
      }),
    });

    expect(result.value).toEqual({
      config: {
        migrationsDir: path.join(project, 'db/migrations'),
        fileExtensions: ['.js'],
        createExtension: 'ts',
        sequential: true,
        namespace: 'billing',
        dbName: 'orders_dev',
        uri: 'mongodb+srv://***:***@cluster0.example.net/app',
      },
      via: 'library',
    });
  });

  it('should hide a username alone, and report an empty uri and database as null', async () => {
    const withUser = await run({
      FAKE_CONFIG: JSON.stringify({ ...CONFIG, uri: 'mongodb://alice@h:27017' }),
    });
    expect(withUser.value).toMatchObject({ config: { uri: 'mongodb://***@h:27017' } });

    const empty = await run({ FAKE_CONFIG: JSON.stringify({ ...CONFIG, uri: '', dbName: '' }) });
    expect(empty.value).toMatchObject({ config: { uri: null, dbName: null } });
  });

  it("should turn mmk's error into its error document, with the code and details", async () => {
    const failure = await run({ FAKE_FAIL: '1' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MmkCommandError);
    expect(failure).toMatchObject({
      message: 'dbName is missing',
      failure: { code: 'CONFIG_INVALID', details: { issues: [{ key: 'dbName' }] } },
    });
  });
});
