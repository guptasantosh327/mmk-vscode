import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MmkCommandError } from '../../src/mmk/cli.js';
import { parseConfigSummary, parseCreateResult } from '../../src/mmk/contract.js';
import { previewFileName } from '../../src/mmk/naming.js';
import { type ContractProject, createProject } from './harness.js';

/**
 * `mmk config --json` (R2), and the one piece of mmk the extension mirrors: the slug in the
 * "Create migration" preview. Run against the real mmk, like every contract test.
 */

let mongo: MongoMemoryServer;
let project: ContractProject;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  project = await createProject(mongo, 'contract_config');
});

afterAll(async () => {
  project?.cleanup();
  await mongo?.stop();
});

describe('config', () => {
  it('config: reports the resolved settings, with absolute paths and their sources', async () => {
    const output = await project.run(['config']);
    const config = parseConfigSummary(output.value);

    expect(config).toEqual({
      configFile: path.join(project.dir, 'mmk.config.js'),
      migrationsDir: project.migrationsDir,
      fileExtensions: ['.ts', '.js'],
      createExtension: 'js',
      sequential: false,
      migrationsCollection: '_mmk_migrations',
      lockCollection: '_mmk_locks',
      lockTTLSeconds: 60,
      strict: false,
      useTransaction: false,
      requireAuthor: false,
      dbName: 'contract_config',
      uri: mongo.getUri(),
      sources: expect.objectContaining({ migrationsDir: 'file', uri: 'env', dbName: 'env' }),
    });
  });

  it('config: hides the password, and never connects', async () => {
    // Port 9 refuses connections: a command that connected would fail.
    const output = await project.run(['config'], {
      MMK_URI: 'mongodb://alice:s3cret@127.0.0.1:9/app',
    });
    const config = parseConfigSummary(output.value);

    expect(config.uri).toBe('mongodb://***:***@127.0.0.1:9/app');
    expect(JSON.stringify(output.value) + output.stderr).not.toContain('s3cret');
  });

  it('config: reports a missing connection as null instead of refusing', async () => {
    const output = await project.run(['config'], { MMK_URI: '', MMK_DB: '' });
    expect(parseConfigSummary(output.value)).toMatchObject({ uri: null, dbName: null });
  });
});

describe('create names files the way the preview says', () => {
  it.each([
    'add refunds collection',
    '  Backfill: Orders → v2!! ',
    'already-slugged_name',
    'Index payments by customer',
  ])('create %j', async (name) => {
    const output = await project.run(['create', name, '--js']);
    const created = path.basename(parseCreateResult(output.value).path);
    const preview = previewFileName(name, { sequential: false, extension: 'js' });

    expect(preview).not.toBeNull();
    const stamp = /^(\d{14})-/.exec(created)?.[1];
    expect(stamp).toBeDefined();
    expect(created).toBe(preview?.replace('<timestamp>', stamp ?? ''));
  });

  it('create: refuses a name without letters or digits, as the preview does', async () => {
    expect(previewFileName('!!!', { sequential: false, extension: 'js' })).toBeNull();
    const error = await project.run(['create', '!!!', '--js']).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(MmkCommandError);
    expect((error as MmkCommandError).failure.code).toBe('INVALID_ARGUMENT');
  });
});
