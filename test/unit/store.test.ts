import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type JsonOutput,
  MmkCommandError,
  MmkProcessError,
  type RunOptions,
} from '../../src/mmk/cli.js';
import type { Logger } from '../../src/mmk/log.js';
import type { ProjectState } from '../../src/mmk/project.js';
import { MmkStore, StoreError } from '../../src/mmk/store.js';

const DIR = path.resolve('/work/billing-api');
const MIGRATIONS = path.join(DIR, 'migrations');

const quiet: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  mmkOutput: () => {},
};

function ready(dir = DIR): ProjectState {
  return {
    kind: 'ready',
    root: { dir, configFile: path.join(dir, 'mmk.config.js') },
    install: { packageDir: '', script: 'mmk.cjs', bin: null },
    invocation: { nodePath: 'node', script: 'mmk.cjs', cwd: dir },
    version: '1.6.0',
  };
}

const CONFIG = {
  configFile: path.join(DIR, 'mmk.config.js'),
  migrationsDir: MIGRATIONS,
  fileExtensions: ['.ts', '.js'],
  createExtension: 'js',
  sequential: false,
  migrationsCollection: '_mmk_migrations',
  lockCollection: '_mmk_locks',
  lockTTLSeconds: 60,
  strict: false,
  useTransaction: false,
  requireAuthor: false,
  dbName: 'orders_dev',
  uri: 'mongodb://localhost:27017',
  sources: {},
};

const PENDING_ROW = {
  file: '0001-a.js',
  status: 'pending',
  batch: null,
  appliedAt: null,
  duration: null,
  checksumOk: null,
};

/** A fake mmk: records every call and answers from `answers` (by first argument) */
function fakeMmk(answers: Record<string, () => Promise<unknown> | unknown>): {
  calls: string[][];
  run: (invocation: unknown, args: readonly string[], options: RunOptions) => Promise<JsonOutput>;
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_invocation, args) => {
      calls.push([...args]);
      const answer = answers[args[0] ?? ''];
      if (!answer) {
        throw new Error(`unexpected mmk ${args.join(' ')}`);
      }
      return { value: await answer(), exitCode: 0, stderr: '', otherStdout: '' };
    },
  };
}

const NO_LOCK = { holder: null, stale: false };

const HELD_LOCK = {
  holder: {
    lockedAt: '2026-10-18T10:32:00.000Z',
    pid: 4242,
    host: 'deploy-runner-7',
    executedBy: 'ci',
    acquiredAt: '2026-10-18T10:32:00.000Z',
    expiresAt: '2026-10-18T10:33:00.000Z',
  },
  stale: false,
};

/** What mmk 1.5 prints for a command it doesn't have */
function unknownCommand(command: string): MmkProcessError {
  return new MmkProcessError(
    'bad-output',
    'mmk printed no JSON document',
    `error: unknown command '${command}'\n(run \`mmk --help\`, or \`mmk <command> --help\`, for usage)\n`,
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('MmkStore', () => {
  it('should read config, then status and the lock side by side, for a ready project', async () => {
    const mmk = fakeMmk({ config: () => CONFIG, status: () => [PENDING_ROW], lock: () => NO_LOCK });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();

    expect(mmk.calls).toEqual([['config'], ['status'], ['lock']]);
    expect(store.snapshot(DIR)?.environments.local?.lock).toEqual(NO_LOCK);
    expect(store.snapshot(DIR)).toMatchObject({
      config: { migrationsDir: MIGRATIONS },
      rows: [PENDING_ROW],
      error: null,
      loading: false,
      running: null,
    });
  });

  it('should not run mmk for a project that is not ready', async () => {
    const mmk = fakeMmk({});
    const store = new MmkStore({ log: quiet, run: mmk.run });
    const root = { dir: DIR, configFile: null };
    store.setProjects([{ kind: 'mmk-missing', root, message: 'Install it' }]);
    await store.idle();

    expect(mmk.calls).toEqual([]);
    await expect(store.run(DIR, ['up'], 'up')).rejects.toThrow(new StoreError('Install it'));
  });

  it("should keep mmk's error message and code when a read fails", async () => {
    const mmk = fakeMmk({
      config: () => CONFIG,
      status: () => {
        throw new MmkCommandError(
          { code: 'CONNECTION_FAILED', message: 'Could not connect to mongodb://***@h' },
          ['status', '--json'],
          1,
          '',
        );
      },
    });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();

    expect(store.snapshot(DIR)).toMatchObject({
      rows: null,
      error: { code: 'CONNECTION_FAILED', message: 'Could not connect to mongodb://***@h' },
    });
  });

  it('should read once more, not once per request, when refreshes pile up during a read', async () => {
    const gate = deferred();
    let statusReads = 0;
    const mmk = fakeMmk({
      config: () => CONFIG,
      status: async () => {
        statusReads += 1;
        if (statusReads === 1) {
          await gate.promise;
        }
        return [PENDING_ROW];
      },
    });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    const first = store.refresh(DIR);
    const second = store.refresh(DIR);
    const third = store.refresh(DIR);
    gate.resolve();
    await Promise.all([first, second, third]);
    await store.idle();

    expect(statusReads).toBe(2);
  });

  it('should read the config again only when asked to', async () => {
    const mmk = fakeMmk({ config: () => CONFIG, status: () => [] });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();
    await store.refresh(DIR);
    await store.refresh(DIR, { reloadConfig: true });

    expect(mmk.calls.map((args) => args[0]).filter((command) => command !== 'lock')).toEqual([
      'config',
      'status',
      'status',
      'config',
      'status',
    ]);
  });

  it('should debounce scheduled refreshes into one read', async () => {
    const mmk = fakeMmk({ config: () => CONFIG, status: () => [] });
    const store = new MmkStore({ log: quiet, run: mmk.run, debounceMs: 20 });
    store.setProjects([ready()]);
    await store.idle();
    store.scheduleRefresh(DIR);
    store.scheduleRefresh(DIR);
    store.scheduleRefresh(DIR);
    await store.idle();

    expect(mmk.calls.filter((args) => args[0] === 'status')).toHaveLength(2);
  });

  it('should run one command at a time per project, then read the status again', async () => {
    const gate = deferred();
    const mmk = fakeMmk({
      config: () => CONFIG,
      status: () => [PENDING_ROW],
      up: async () => {
        await gate.promise;
        return [{ file: '0001-a.js', status: 'applied', duration: 5, batch: 1 }];
      },
    });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();

    const running = store.run(DIR, ['up', '0001-a.js'], 'up a.js');
    expect(store.snapshot(DIR)?.running).toBe('up a.js');
    await expect(store.run(DIR, ['down', '0001-a.js'], 'down a.js')).rejects.toThrow(
      'mmk is already running up a.js here. Wait for it to finish, then try again.',
    );
    gate.resolve();
    await expect(running).resolves.toMatchObject({ value: [{ status: 'applied' }] });
    await store.idle();

    expect(store.snapshot(DIR)?.running).toBeNull();
    expect(mmk.calls.map((args) => args[0]).filter((command) => command !== 'lock')).toEqual([
      'config',
      'status',
      'up',
      'status',
    ]);
  });

  it('should stop asking for the lock once mmk says it has no lock command (1.5)', async () => {
    const mmk = fakeMmk({
      config: () => CONFIG,
      status: () => [PENDING_ROW],
      lock: () => {
        throw unknownCommand('lock');
      },
    });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();
    await store.refresh(DIR);

    expect(mmk.calls.filter((args) => args[0] === 'lock')).toHaveLength(1);
    expect(store.snapshot(DIR)?.environments.local).toMatchObject({
      rows: [PENDING_ROW],
      error: null,
      lock: null,
    });
  });

  it("should keep the status when the lock can't be read, and try again next time", async () => {
    const mmk = fakeMmk({
      config: () => CONFIG,
      status: () => [PENDING_ROW],
      lock: () => {
        throw new MmkCommandError(
          { code: 'CONNECTION_FAILED', message: 'lock read failed' },
          ['lock'],
          1,
          '',
        );
      },
    });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();
    await store.refresh(DIR);

    expect(mmk.calls.filter((args) => args[0] === 'lock')).toHaveLength(2);
    expect(store.snapshot(DIR)?.environments.local).toMatchObject({
      rows: [PENDING_ROW],
      error: null,
      lock: null,
    });
  });

  it("should drop a run's own lock when the run ends, until the next read says", async () => {
    let lock: unknown = HELD_LOCK;
    const mmk = fakeMmk({
      config: () => CONFIG,
      status: () => [PENDING_ROW],
      lock: () => lock,
      up: () => [{ file: '0001-a.js', status: 'applied', duration: 5, batch: 1 }],
    });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();
    expect(store.snapshot(DIR)?.environments.local?.lock).toEqual(HELD_LOCK);

    lock = NO_LOCK;
    await store.run(DIR, ['up', '0001-a.js'], 'up a.js');
    expect(store.snapshot(DIR)?.environments.local?.lock).toBeNull();
    await store.idle();
    expect(store.snapshot(DIR)?.environments.local?.lock).toEqual(NO_LOCK);
  });

  it("should pass mmk's log lines of a run to output listeners, credentials hidden", async () => {
    const mmk = fakeMmk({ config: () => CONFIG, status: () => [PENDING_ROW] });
    const store = new MmkStore({
      log: quiet,
      run: async (invocation, args, options) => {
        if (args[0] === 'up') {
          options.onStderrLine?.('Running 0001-a.js');
          options.onStderrLine?.('connected to mongodb://alice:s3cret@db.example.com/orders');
          return { value: [], exitCode: 0, stderr: '', otherStdout: '' };
        }
        return mmk.run(invocation, args, options);
      },
    });
    store.setProjects([ready()]);
    await store.idle();
    const lines: Array<[string, string]> = [];
    const listening = store.onDidOutput((dir, line) => lines.push([dir, line]));

    await store.run(DIR, ['up'], 'up');
    listening.dispose();
    await store.run(DIR, ['up'], 'up');

    expect(lines).toEqual([
      [DIR, 'Running 0001-a.js'],
      [DIR, 'connected to mongodb://***:***@db.example.com/orders'],
    ]);
  });

  it('should clear the running command when it fails, and pass the error on', async () => {
    const failure = new MmkCommandError(
      { code: 'LOCK_ALREADY_HELD', message: 'Held by pid 7' },
      ['up'],
      1,
      '',
    );
    const mmk = fakeMmk({
      config: () => CONFIG,
      status: () => [],
      up: () => {
        throw failure;
      },
    });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();

    await expect(store.run(DIR, ['up'], 'up')).rejects.toBe(failure);
    expect(store.snapshot(DIR)?.running).toBeNull();
  });

  it("should tell finish listeners how each run ended, with mmk's message hidden of credentials", async () => {
    let fail = false;
    const mmk = fakeMmk({
      config: () => CONFIG,
      status: () => [],
      up: () => {
        if (fail) {
          throw new MmkCommandError(
            {
              code: 'CONNECTION_FAILED',
              message: 'Could not connect to mongodb://alice:s3cret@db.example.com',
            },
            ['up'],
            1,
            '',
          );
        }
        return [];
      },
    });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();
    const runs: unknown[] = [];
    store.onDidFinishRun((dir, run) => runs.push([dir, run]));

    await store.run(DIR, ['up'], 'up 0001-a.js');
    fail = true;
    await expect(store.run(DIR, ['up'], 'up')).rejects.toThrow();

    expect(runs).toEqual([
      [DIR, { label: 'up 0001-a.js', environment: 'local', failure: null }],
      [
        DIR,
        {
          label: 'up',
          environment: 'local',
          failure: 'Could not connect to mongodb://***:***@db.example.com',
        },
      ],
    ]);
  });

  it('should find the project and status row for a file in its migrations folder only', async () => {
    const mmk = fakeMmk({ config: () => CONFIG, status: () => [PENDING_ROW] });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();

    expect(store.migrationFor(path.join(MIGRATIONS, '0001-a.js'))).toMatchObject({
      file: '0001-a.js',
      row: PENDING_ROW,
      project: { dir: DIR },
    });
    expect(store.migrationFor(path.join(MIGRATIONS, '0009-new.js'))?.row).toBeUndefined();
    expect(store.migrationFor(path.join(MIGRATIONS, 'nested', '0001-a.js'))).toBeUndefined();
    expect(store.migrationFor(path.join(DIR, 'src', 'index.js'))).toBeUndefined();
  });

  it('should keep what it knows about a project that stays, and drop one that goes', async () => {
    const other = path.resolve('/work/orders-api');
    const mmk = fakeMmk({ config: () => CONFIG, status: () => [PENDING_ROW] });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready(), ready(other)]);
    await store.idle();
    store.setProjects([ready()]);

    expect(store.snapshots().map((project) => project.dir)).toEqual([DIR]);
    expect(store.snapshot(DIR)?.rows).toEqual([PENDING_ROW]);
  });

  it('should tell listeners about every change', async () => {
    const mmk = fakeMmk({ config: () => CONFIG, status: () => [] });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    let changes = 0;
    const listener = store.onDidChange(() => {
      changes += 1;
    });
    store.setProjects([ready()]);
    await store.idle();
    listener.dispose();
    const seen = changes;
    await store.refresh(DIR);

    expect(seen).toBeGreaterThan(0);
    expect(changes).toBe(seen);
  });
});

describe('MmkStore with environments', () => {
  const STAGING = { name: 'staging', readOnly: true, color: 'warning', local: false } as const;
  const DEV = { name: 'dev', readOnly: false, color: 'warning', local: false } as const;
  const LOCAL = { name: 'local', readOnly: false, color: 'default', local: true } as const;
  const STAGING_CONNECTION = { uri: 'mongodb://reader:pw@staging.example.net', dbName: 'app' };
  const APPLIED_ROW = {
    file: '0001-a.js',
    status: 'applied',
    batch: 1,
    appliedAt: '2026-10-15T10:00:00.000Z',
    duration: 3,
    checksumOk: true,
  };

  /** A fake mmk that answers status by the MMK_DB it was given, and records each env */
  function envMmk(byDb: Record<string, unknown[]>): {
    calls: Array<{ args: string[]; env: Readonly<Record<string, string>> }>;
    run: (invocation: unknown, args: readonly string[], options: RunOptions) => Promise<JsonOutput>;
  } {
    const calls: Array<{ args: string[]; env: Readonly<Record<string, string>> }> = [];
    return {
      calls,
      run: async (_invocation, args, options) => {
        const env = options.env ?? {};
        calls.push({ args: [...args], env });
        let value: unknown;
        if (args[0] === 'config') {
          value = CONFIG;
        } else if (args[0] === 'status') {
          value = byDb[env.MMK_DB ?? 'local'] ?? [];
        } else {
          value = [];
        }
        return { value, exitCode: 0, stderr: '', otherStdout: '' };
      },
    };
  }

  const connections = async (_dir: string, environment: string) =>
    environment === 'staging' || environment === 'dev'
      ? { ...STAGING_CONNECTION, dbName: environment }
      : null;

  it('should read each environment with its own MMK_URI and MMK_DB, and local with neither', async () => {
    const mmk = envMmk({ local: [PENDING_ROW], staging: [APPLIED_ROW] });
    const store = new MmkStore({ log: quiet, run: mmk.run, connection: connections });
    store.setEnvironments([LOCAL, STAGING], 'local');
    store.setProjects([ready()]);
    await store.idle();

    const statusCalls = mmk.calls.filter((call) => call.args[0] === 'status');
    expect(statusCalls.map((call) => call.env)).toEqual(
      expect.arrayContaining([{}, { MMK_URI: STAGING_CONNECTION.uri, MMK_DB: 'staging' }]),
    );
    const snapshot = store.snapshot(DIR);
    expect(snapshot?.rows).toEqual([PENDING_ROW]);
    expect(snapshot?.environments.staging).toMatchObject({
      rows: [APPLIED_ROW],
      connected: true,
      database: 'staging.example.net/staging',
    });
  });

  it('should show the selected environment, and keep the selection when told to', async () => {
    const mmk = envMmk({ local: [PENDING_ROW], staging: [APPLIED_ROW] });
    const store = new MmkStore({ log: quiet, run: mmk.run, connection: connections });
    store.setEnvironments([LOCAL, STAGING], 'staging');
    store.setProjects([ready()]);
    await store.idle();

    expect(store.selected().name).toBe('staging');
    expect(store.snapshot(DIR)?.rows).toEqual([APPLIED_ROW]);
    store.select('local');
    expect(store.snapshot(DIR)?.rows).toEqual([PENDING_ROW]);
    store.select('nope');
    expect(store.selected().name).toBe('local');
  });

  it('should fall back to local when the selected environment is gone', () => {
    const store = new MmkStore({ log: quiet, run: envMmk({}).run });
    store.setEnvironments([LOCAL], 'staging');

    expect(store.selected().name).toBe('local');
  });

  it('should not read an environment this project has no connection for', async () => {
    const mmk = envMmk({ local: [PENDING_ROW] });
    const store = new MmkStore({ log: quiet, run: mmk.run, connection: async () => null });
    store.setEnvironments([LOCAL, STAGING], 'local');
    store.setProjects([ready()]);
    await store.idle();

    expect(store.snapshot(DIR)?.environments.staging).toMatchObject({
      connected: false,
      rows: null,
      error: null,
    });
    expect(mmk.calls.filter((call) => call.args[0] === 'status')).toHaveLength(1);
  });

  it('should refuse a write on a read-only environment without running mmk', async () => {
    const mmk = envMmk({});
    const store = new MmkStore({ log: quiet, run: mmk.run, connection: connections });
    store.setEnvironments([LOCAL, STAGING], 'staging');
    store.setProjects([ready()]);
    await store.idle();
    const before = mmk.calls.length;

    for (const args of [['up'], ['down', '0001-a.js'], ['redo'], ['unlock', '--yes']]) {
      await expect(store.run(DIR, args, args[0] ?? '')).rejects.toThrow(
        /^staging is read-only, so the extension won't run "mmk /,
      );
    }
    // Naming the environment explicitly makes no difference.
    await expect(store.run(DIR, ['up'], 'up', 'staging')).rejects.toBeInstanceOf(StoreError);
    expect(mmk.calls.length).toBe(before);
  });

  it('should run a read on a read-only environment with its connection', async () => {
    const mmk = envMmk({});
    const store = new MmkStore({ log: quiet, run: mmk.run, connection: connections });
    store.setEnvironments([LOCAL, STAGING], 'staging');
    store.setProjects([ready()]);
    await store.idle();

    await store.run(DIR, ['dry-run', 'up'], 'dry run');

    expect(mmk.calls.find((call) => call.args[0] === 'dry-run')?.env).toEqual({
      MMK_URI: STAGING_CONNECTION.uri,
      MMK_DB: 'staging',
    });
  });

  it('should run a write on a writable environment with its connection', async () => {
    const mmk = envMmk({});
    const store = new MmkStore({ log: quiet, run: mmk.run, connection: connections });
    store.setEnvironments([LOCAL, DEV], 'dev');
    store.setProjects([ready()]);
    await store.idle();

    await store.run(DIR, ['up'], 'up');

    expect(mmk.calls.find((call) => call.args[0] === 'up')?.env).toEqual({
      MMK_URI: STAGING_CONNECTION.uri,
      MMK_DB: 'dev',
    });
  });

  it('should refuse to run on an environment with no stored connection', async () => {
    const store = new MmkStore({ log: quiet, run: envMmk({}).run, connection: async () => null });
    store.setEnvironments([LOCAL, DEV], 'dev');
    store.setProjects([ready()]);
    await store.idle();

    await expect(store.run(DIR, ['up'], 'up')).rejects.toThrow(
      'There\'s no connection string for dev in billing-api. Run "mmk: Add environment…" or "mmk: Edit environment…" to set it.',
    );
  });

  it('should refuse writes through read(), even on a writable environment', async () => {
    const store = new MmkStore({ log: quiet, run: envMmk({}).run, connection: connections });
    store.setEnvironments([LOCAL, DEV], 'dev');
    store.setProjects([ready()]);
    await store.idle();

    await expect(store.read(DIR, ['up'], 'dev')).rejects.toBeInstanceOf(StoreError);
    await expect(store.read(DIR, ['status', '--dir', '/tmp/x'], 'dev')).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it("should read the config with another environment's connection when local has none", async () => {
    const calls: Array<{ args: string[]; env: Readonly<Record<string, string>> }> = [];
    const run = async (
      _invocation: unknown,
      args: readonly string[],
      options: RunOptions,
    ): Promise<JsonOutput> => {
      const env = options.env ?? {};
      calls.push({ args: [...args], env });
      if (args[0] === 'config' && env.MMK_URI === undefined) {
        throw new MmkCommandError(
          { code: 'CONFIG_INVALID', message: 'uri is required but was not set' },
          ['config', '--json'],
          1,
          '',
        );
      }
      return {
        value: args[0] === 'config' ? CONFIG : [],
        exitCode: 0,
        stderr: '',
        otherStdout: '',
      };
    };
    const store = new MmkStore({ log: quiet, run, connection: connections });
    store.setEnvironments([LOCAL, STAGING], 'local');
    store.setProjects([ready()]);
    await store.idle();

    const configCalls = calls.filter((call) => call.args[0] === 'config');
    expect(configCalls.map((call) => call.env.MMK_DB ?? 'local')).toEqual(['local', 'staging']);
    expect(store.snapshot(DIR)?.config?.migrationsDir).toBe(MIGRATIONS);
    expect(store.snapshot(DIR)?.environments.staging?.error).toBeNull();
    expect(store.snapshot(DIR)?.environments.local?.error?.code).toBe('CONFIG_INVALID');
  });

  it('should label local from the config, and the others from their connection', async () => {
    const store = new MmkStore({ log: quiet, run: envMmk({}).run, connection: connections });
    store.setEnvironments([LOCAL, STAGING], 'local');
    store.setProjects([ready()]);
    await store.idle();

    expect(store.snapshot(DIR)?.environments.local?.database).toBe('localhost:27017/orders_dev');
    expect(store.snapshot(DIR)?.environments.staging?.database).toBe('staging.example.net/staging');
  });
});
