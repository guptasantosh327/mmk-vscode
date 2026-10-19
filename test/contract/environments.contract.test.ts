import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMmkJson } from '../../src/mmk/cli.js';
import { parseRunResults, parseStatusRows } from '../../src/mmk/contract.js';
import { type Connection, type Environment, localEnvironment } from '../../src/mmk/environments.js';
import { locateMmk } from '../../src/mmk/locate.js';
import type { Logger } from '../../src/mmk/log.js';
import type { ProjectState } from '../../src/mmk/project.js';
import { MmkStore, StoreError } from '../../src/mmk/store.js';
import { FIXTURE_FILES, FIXTURE_WORKSPACE, REPO_ROOT, hasNextMmk } from './harness.js';

/**
 * Environments through the extension's own store and the real, pinned mmk: a stored
 * connection is injected as MMK_URI / MMK_DB and wins over the config file and `.env`; a
 * read-only MongoDB user can read (request R3, mmk 1.6); and read-only environments never
 * get a write command, whatever asks for one.
 */

const ROOT = { user: 'root', password: 'root-pw' };
const READER = { user: 'reader', password: 'reader-pw' };
const STAGING_DB = 'orders_staging';
const STAGING: Environment = { name: 'staging', readOnly: true, color: 'warning', local: false };

const quiet: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  mmkOutput: () => {},
};

let server: MongoMemoryServer;
let admin: MongoClient;
let dir: string;
let state: ProjectState;

function uriFor(credentials: { user: string; password: string }, authSource: string): string {
  const { host } = new URL(server.getUri());
  return `mongodb://${credentials.user}:${credentials.password}@${host}/?authSource=${authSource}`;
}

/** A store over the real mmk, with `connections` as the keychain */
function storeWith(connections: Record<string, Connection>, selected = 'local'): MmkStore {
  const store = new MmkStore({
    log: quiet,
    connection: async (_dir, environment) => connections[environment] ?? null,
  });
  store.setEnvironments([localEnvironment(), STAGING], selected);
  store.setProjects([state]);
  return store;
}

async function applyAsRoot(dbName: string, file: string): Promise<void> {
  if (state.kind !== 'ready') {
    throw new Error('Test setup: the project is not ready');
  }
  const output = await runMmkJson(state.invocation, ['up', file], {
    env: { MMK_URI: uriFor(ROOT, 'admin'), MMK_DB: dbName },
    timeoutMs: 60_000,
  });
  expect(parseRunResults(output.value, 'up')[0]?.status).toBe('applied');
}

beforeAll(async () => {
  server = await MongoMemoryServer.create({
    auth: {
      enable: true,
      customRootName: ROOT.user,
      customRootPwd: ROOT.password,
      extraUsers: [
        {
          createUser: READER.user,
          pwd: READER.password,
          roles: [{ role: 'read', db: STAGING_DB }],
          database: STAGING_DB,
        },
      ],
    },
  });
  admin = new MongoClient(uriFor(ROOT, 'admin'));
  await admin.connect();

  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mmk-contract-env-')));
  cpSync(FIXTURE_WORKSPACE, dir, { recursive: true });
  // Local: the config file names one database and .env another. A stored connection must win
  // over both; local must use .env over the file's default the way mmk does.
  writeFileSync(
    path.join(dir, 'mmk.config.js'),
    `module.exports = { migrationsDir: './migrations', uri: ${JSON.stringify(uriFor(ROOT, 'admin'))}, dbName: 'from_file' };\n`,
  );
  writeFileSync(path.join(dir, '.env'), 'MMK_DB=from_dotenv\n');
  const install = await locateMmk(REPO_ROOT);
  if (!install) {
    throw new Error('mongo-migrate-kit is not installed in this repo: run npm install');
  }
  state = {
    kind: 'ready',
    root: { dir, configFile: path.join(dir, 'mmk.config.js') },
    install,
    invocation: { nodePath: process.execPath, script: install.script, cwd: dir },
    version: 'contract',
  };
}, 180_000);

afterAll(async () => {
  await admin?.close();
  await server?.stop();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  for (const name of [STAGING_DB, 'from_file', 'from_dotenv']) {
    await admin.db(name).dropDatabase();
  }
});

describe('a stored connection', () => {
  it('wins over the config file and .env, which still decide local', async () => {
    await applyAsRoot(STAGING_DB, FIXTURE_FILES[0]);
    await applyAsRoot('from_dotenv', FIXTURE_FILES[1]);
    const store = storeWith({ staging: { uri: uriFor(ROOT, 'admin'), dbName: STAGING_DB } });
    await store.idle();
    const snapshot = store.snapshot(dir);

    const applied = (name: string): string[] =>
      (snapshot?.environments[name]?.rows ?? [])
        .filter((row) => row.status === 'applied')
        .map((row) => row.file);
    expect(applied('staging')).toEqual([FIXTURE_FILES[0]]);
    expect(applied('local')).toEqual([FIXTURE_FILES[1]]);
    expect(snapshot?.environments.staging?.database).toMatch(/\/orders_staging$/);
    expect(snapshot?.environments.local?.database).toMatch(/\/from_dotenv$/);
  });

  it('never shows its credentials', async () => {
    const store = storeWith({ staging: { uri: uriFor(ROOT, 'admin'), dbName: STAGING_DB } });
    await store.idle();

    expect(JSON.stringify(store.snapshot(dir))).not.toContain(ROOT.password);
  });

  it('reads files from another folder with status --dir, for the ref comparison', async () => {
    await applyAsRoot(STAGING_DB, FIXTURE_FILES[0]);
    const other = realpathSync(mkdtempSync(path.join(tmpdir(), 'mmk-contract-ref-')));
    try {
      writeFileSync(
        path.join(other, '20260109000000-only-on-main.js'),
        'module.exports = { async up() {}, async down() {} };\n',
      );
      const store = storeWith({ staging: { uri: uriFor(ROOT, 'admin'), dbName: STAGING_DB } });
      await store.idle();

      const output = await store.read(dir, ['status', '--dir', other], 'staging');
      const rows = parseStatusRows(output.value, 'status');

      expect(rows.map((row) => [row.file, row.status, row.fileMissing ?? false])).toEqual([
        [FIXTURE_FILES[0], 'applied', true],
        ['20260109000000-only-on-main.js', 'pending', false],
      ]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('a read-only MongoDB user', () => {
  beforeEach(async () => {
    await applyAsRoot(STAGING_DB, FIXTURE_FILES[0]);
  });

  it.runIf(hasNextMmk())('can read status on a read-only environment (R3)', async () => {
    const store = storeWith({ staging: { uri: uriFor(READER, STAGING_DB), dbName: STAGING_DB } });
    await store.idle();
    const staging = store.snapshot(dir)?.environments.staging;

    expect(staging?.error).toBeNull();
    expect(staging?.lock).toEqual({ holder: null, stale: false });
    expect(staging?.rows?.map((row) => [row.file, row.status])).toEqual([
      [FIXTURE_FILES[0], 'applied'],
      [FIXTURE_FILES[1], 'pending'],
      [FIXTURE_FILES[2], 'pending'],
    ]);
    const dryRun = await store.run(dir, ['dry-run', 'up'], 'dry run', 'staging');
    expect(parseStatusRows(dryRun.value, 'dry-run')).toHaveLength(2);
  });

  it.runIf(!hasNextMmk())(
    "1.5: can't read, and mmk says why: it creates an index on connect",
    async () => {
      const store = storeWith({ staging: { uri: uriFor(READER, STAGING_DB), dbName: STAGING_DB } });
      await store.idle();
      const staging = store.snapshot(dir)?.environments.staging;

      expect(staging?.rows).toBeNull();
      expect(staging?.lock).toBeNull();
      expect(staging?.error?.code).toBe('CONNECTION_FAILED');
      expect(staging?.error?.message).toContain('not authorized');
      expect(staging?.error?.message).not.toContain(READER.password);
    },
  );
});

describe('a read-only environment', () => {
  it('never gets a write command, even with credentials that could write', async () => {
    const store = storeWith(
      { staging: { uri: uriFor(ROOT, 'admin'), dbName: STAGING_DB } },
      'staging',
    );
    await store.idle();

    for (const args of [
      ['up'],
      ['up', FIXTURE_FILES[0]],
      ['down'],
      ['redo'],
      ['unlock', '--yes'],
    ]) {
      await expect(store.run(dir, args, args.join(' '))).rejects.toBeInstanceOf(StoreError);
    }
    const records = await admin.db(STAGING_DB).collection('_mmk_migrations').countDocuments();
    expect(records).toBe(0);
  });
});
