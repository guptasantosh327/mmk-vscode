import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type JsonOutput, MmkCommandError, type RunOptions } from '../../src/mmk/cli.js';
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('MmkStore', () => {
  it('should read config then status for a ready project', async () => {
    const mmk = fakeMmk({ config: () => CONFIG, status: () => [PENDING_ROW] });
    const store = new MmkStore({ log: quiet, run: mmk.run });
    store.setProjects([ready()]);
    await store.idle();

    expect(mmk.calls).toEqual([['config'], ['status']]);
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

    expect(mmk.calls.map((args) => args[0])).toEqual([
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
    expect(mmk.calls.map((args) => args[0])).toEqual(['config', 'status', 'up', 'status']);
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
