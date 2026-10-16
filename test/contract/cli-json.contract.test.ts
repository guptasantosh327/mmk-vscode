import { existsSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MmkCommandError, runMmkVersion } from '../../src/mmk/cli.js';
import { MIN_MMK_VERSION, checkCompat } from '../../src/mmk/compat.js';
import {
  parseCreateResult,
  parseRunResults,
  parseStatusRows,
  parseUnlockResult,
} from '../../src/mmk/contract.js';
import {
  type ContractProject,
  FIXTURE_AUTHOR,
  FIXTURE_FILES,
  createProject,
  pinnedMmkVersion,
} from './harness.js';

/**
 * These tests run the real `mmk` from the pinned devDependency against an in-memory MongoDB and
 * check every JSON field the extension reads. A failure here means mongo-migrate-kit changed:
 * update src/mmk/, never loosen these tests.
 */

const [CREATE_USERS, ADD_EMAIL_INDEX, BACKFILL] = FIXTURE_FILES;

const PENDING = {
  status: 'pending',
  batch: null,
  appliedAt: null,
  duration: null,
  checksumOk: null,
};

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
});

afterAll(async () => {
  await mongo?.stop();
});

/** Run `body` with a fresh copy of the fixture project on its own database */
function withProject(dbName: string): () => ContractProject {
  let project: ContractProject | undefined;
  beforeAll(async () => {
    project = await createProject(mongo, dbName);
  });
  afterAll(() => {
    project?.cleanup();
  });
  return () => {
    if (!project) {
      throw new Error('Test setup: the project was not created');
    }
    return project;
  };
}

/** Expect `promise` to reject with mmk's error document and return the error */
async function expectFailure(promise: Promise<unknown>): Promise<MmkCommandError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(MmkCommandError);
  return error as MmkCommandError;
}

describe(`mmk --version (pinned mongo-migrate-kit ${pinnedMmkVersion()})`, () => {
  const project = withProject('contract_version');

  it('should print the pinned version, which the extension accepts', async () => {
    const printed = await runMmkVersion(project().invocation);

    expect(printed).toBe(pinnedMmkVersion());
    expect(checkCompat(printed)).toEqual({ ok: true, version: printed });
  });

  it('should pin the version MIN_MMK_VERSION names, so the minimum is the version tested', () => {
    expect(pinnedMmkVersion()).toBe(MIN_MMK_VERSION);
  });
});

describe('status, list, dry-run, up, down, redo and create', () => {
  const project = withProject('contract_lifecycle');

  it('status: every file is pending on a new database', async () => {
    const output = await project().run(['status']);

    expect(output.exitCode).toBe(0);
    expect(output.otherStdout).toBe('');
    expect(parseStatusRows(output.value, 'status')).toEqual(
      FIXTURE_FILES.map((file) => ({ file, ...PENDING })),
    );
  });

  it('dry-run up: lists what would be applied, and applies nothing', async () => {
    const output = await project().run(['dry-run', 'up']);

    expect(parseStatusRows(output.value, 'dry-run')).toEqual(
      FIXTURE_FILES.map((file) => ({ file, ...PENDING })),
    );
    const after = await project().run(['status']);
    expect(parseStatusRows(after.value, 'status').every((row) => row.status === 'pending')).toBe(
      true,
    );
  });

  it('dry-run up <file>: lists only that file', async () => {
    const output = await project().run(['dry-run', 'up', ADD_EMAIL_INDEX]);

    expect(parseStatusRows(output.value, 'dry-run')).toEqual([
      { file: ADD_EMAIL_INDEX, ...PENDING },
    ]);
  });

  it('up <file>: applies one file in batch 1', async () => {
    const output = await project().run(['up', CREATE_USERS]);

    expect(output.exitCode).toBe(0);
    expect(parseRunResults(output.value, 'up')).toEqual([
      { file: CREATE_USERS, status: 'applied', duration: expect.any(Number), batch: 1 },
    ]);
  });

  it('status: an applied row has its batch, time, duration, checksum verdict and author', async () => {
    const before = Date.now();
    const rows = parseStatusRows((await project().run(['status'])).value, 'status');

    expect(rows).toEqual([
      {
        file: CREATE_USERS,
        status: 'applied',
        batch: 1,
        appliedAt: expect.any(String),
        duration: expect.any(Number),
        checksumOk: true,
        description: 'Create the users collection',
        author: FIXTURE_AUTHOR,
      },
      { file: ADD_EMAIL_INDEX, ...PENDING },
      { file: BACKFILL, ...PENDING },
    ]);
    const appliedAt = Date.parse(rows[0]?.appliedAt ?? '');
    expect(appliedAt).toBeLessThanOrEqual(before);
    expect(before - appliedAt).toBeLessThan(5 * 60_000);
  });

  it('status --check: prints the rows (not an error document) and exits 1 while files are pending', async () => {
    const output = await project().run(['status', '--check']);

    expect(output.exitCode).toBe(1);
    expect(parseStatusRows(output.value, 'status')).toHaveLength(3);
  });

  it('list --pending and list --applied: filter the same rows', async () => {
    const pending = parseStatusRows((await project().run(['list', '--pending'])).value, 'list');
    const applied = parseStatusRows((await project().run(['list', '--applied'])).value, 'list');

    expect(pending.map((row) => row.file)).toEqual([ADD_EMAIL_INDEX, BACKFILL]);
    expect(applied.map((row) => [row.file, row.status, row.batch])).toEqual([
      [CREATE_USERS, 'applied', 1],
    ]);
  });

  it('dry-run down: lists the last batch', async () => {
    const output = await project().run(['dry-run', 'down']);

    expect(parseStatusRows(output.value, 'dry-run')).toEqual([
      expect.objectContaining({
        file: CREATE_USERS,
        status: 'applied',
        batch: 1,
        checksumOk: true,
      }),
    ]);
  });

  it('redo <file>: reverts then re-applies the file, in a new batch', async () => {
    const output = await project().run(['redo', CREATE_USERS]);

    expect(parseRunResults(output.value, 'redo')).toEqual([
      { file: CREATE_USERS, status: 'reverted', duration: expect.any(Number) },
      { file: CREATE_USERS, status: 'applied', duration: expect.any(Number), batch: 2 },
    ]);
  });

  it('down <file>: reverts one file', async () => {
    const output = await project().run(['down', CREATE_USERS]);

    expect(parseRunResults(output.value, 'down')).toEqual([
      { file: CREATE_USERS, status: 'reverted', duration: expect.any(Number) },
    ]);
    const rows = parseStatusRows((await project().run(['status'])).value, 'status');
    expect(rows.every((row) => row.status === 'pending' && row.batch === null)).toBe(true);
  });

  it('up: applies every pending file in one batch; batch numbers are never reused', async () => {
    const output = await project().run(['up']);

    expect(parseRunResults(output.value, 'up')).toEqual(
      FIXTURE_FILES.map((file) => ({
        file,
        status: 'applied',
        duration: expect.any(Number),
        batch: 3,
      })),
    );
  });

  it('create <name>: writes a timestamped file in the migrations folder and returns its path', async () => {
    const output = await project().run(['create', 'add orders', '--js']);
    const { path: created } = parseCreateResult(output.value);

    expect(path.dirname(created)).toBe(project().migrationsDir);
    expect(path.basename(created)).toMatch(/^\d{14}-add-orders\.js$/);
    expect(existsSync(created)).toBe(true);
    const rows = parseStatusRows((await project().run(['status'])).value, 'status');
    expect(rows.at(-1)).toEqual({ file: path.basename(created), ...PENDING });
  });
});

describe('unlock', () => {
  const project = withProject('contract_unlock');

  it('unlock: reports that no lock was held', async () => {
    const output = await project().run(['unlock', '--yes']);

    expect(parseUnlockResult(output.value)).toEqual({ released: false, holder: null });
  });

  it('unlock: releases a held lock and describes its holder', async () => {
    const marker = path.join(project().dir, 'slow-started');
    const release = path.join(project().dir, 'slow-release');
    project().addMigration(
      '20260104000000-slow.js',
      `const fs = require('node:fs');
module.exports = {
  async up() {
    fs.writeFileSync(${JSON.stringify(marker)}, 'started');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
  async down() {},
};
`,
    );
    const running = project()
      .run(['up', '20260104000000-slow.js'])
      .catch((error: unknown) => error);
    try {
      await waitFor(() => existsSync(marker), 20_000);

      const result = parseUnlockResult((await project().run(['unlock', '--yes'])).value);

      expect(result).toEqual({
        released: true,
        holder: {
          lockedAt: expect.any(String),
          pid: expect.any(Number),
          host: hostname(),
          executedBy: userInfo().username,
          acquiredAt: expect.any(String),
          expiresAt: expect.any(String),
        },
      });
    } finally {
      writeFileSync(release, '');
      await running;
    }
  });
});

describe('error document', () => {
  const project = withProject('contract_errors');

  it('up <missing file>: MIGRATION_FILE_NOT_FOUND with exit code 1', async () => {
    const error = await expectFailure(project().run(['up', '20991231000000-missing.js']));

    expect(error.exitCode).toBe(1);
    expect(error.failure.code).toBe('MIGRATION_FILE_NOT_FOUND');
    expect(error.failure.message).toContain('20991231000000-missing.js');
    expect(error.message).toBe(error.failure.message);
  });

  it('down <pending file>: NOT_APPLIED', async () => {
    const error = await expectFailure(project().run(['down', CREATE_USERS]));

    expect(error.failure.code).toBe('NOT_APPLIED');
  });

  it('dry-run <bad direction>: INVALID_ARGUMENT, checked before connecting', async () => {
    const error = await expectFailure(project().run(['dry-run', 'sideways']));

    expect(error.exitCode).toBe(1);
    expect(error.failure).toEqual({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining("dry-run direction must be 'up' or 'down'"),
      details: { direction: 'sideways' },
    });
  });

  it('missing database name: CONFIG_INVALID with the issues in details', async () => {
    const error = await expectFailure(project().run(['status'], { MMK_DB: '' }));

    expect(error.failure.code).toBe('CONFIG_INVALID');
    expect(error.failure.details).toEqual({ issues: expect.any(Array) });
    expect(error.failure.details?.issues).toContainEqual(
      expect.objectContaining({ key: 'dbName' }),
    );
  });

  it('unreachable server: CONNECTION_FAILED, with the password hidden', async () => {
    const error = await expectFailure(
      project().run(['status'], { MMK_URI: 'mongodb://alice:s3cret@127.0.0.1:9/app' }),
    );

    expect(error.failure.code).toBe('CONNECTION_FAILED');
    expect(error.failure.message).not.toContain('s3cret');
    expect(error.stderr).not.toContain('s3cret');
  });

  it('a migration that throws: MIGRATION_EXECUTION_FAILED with the file and direction in details', async () => {
    project().addMigration(
      '20260105000000-throws.js',
      `module.exports = {
  async up() {
    throw new Error('boom from up');
  },
  async down() {},
};
`,
    );

    const error = await expectFailure(project().run(['up', '20260105000000-throws.js']));

    expect(error.failure.code).toBe('MIGRATION_EXECUTION_FAILED');
    expect(error.failure.details).toMatchObject({
      name: '20260105000000-throws.js',
      direction: 'up',
      cause: 'boom from up',
    });
  });
});

describe('stdout from user code', () => {
  const project = withProject('contract_stdout');

  it("up: a migration's console.log comes before the JSON, which still parses", async () => {
    project().addMigration(
      '20260106000000-noisy.js',
      `module.exports = {
  async up() {
    console.log('Backfilled 3 users');
  },
  async down() {},
};
`,
    );

    const output = await project().run(['up', '20260106000000-noisy.js']);

    expect(output.otherStdout).toBe('Backfilled 3 users');
    expect(parseRunResults(output.value, 'up')).toEqual([
      {
        file: '20260106000000-noisy.js',
        status: 'applied',
        duration: expect.any(Number),
        batch: 1,
      },
    ]);
  });
});

/** Poll `condition` until it holds, failing after `timeoutMs` */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
