import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MmkCommandError } from '../../src/mmk/cli.js';
import { parseCreateResult, parseStatusRows } from '../../src/mmk/contract.js';
import { previewFileName } from '../../src/mmk/naming.js';
import { type ContractProject, FIXTURE_FILES, createProject, hasNextMmk } from './harness.js';

/**
 * How the extension reads a project's resolved config, and the one piece of mmk it mirrors: the
 * slug in the "Create migration" preview. Run against the real, pinned mmk, like every contract
 * test.
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

describe('reading the resolved config', () => {
  it('reads the settings mmk resolves, with an absolute migrations folder', async () => {
    const { config } = await project.readConfig();

    expect(config).toEqual({
      migrationsDir: project.migrationsDir,
      fileExtensions: ['.ts', '.js'],
      createExtension: 'js',
      sequential: false,
      dbName: 'contract_config',
      uri: mongo.getUri(),
    });
  });

  it('uses `mmk config --json` (R2) when mmk has it, and resolveConfig() on mmk 1.5', async () => {
    expect((await project.readConfig()).via).toBe(hasNextMmk() ? 'cli' : 'library');
  });

  it('names the folder that status reads and create writes to', async () => {
    const { config } = await project.readConfig();
    const rows = parseStatusRows((await project.run(['status'])).value, 'status');
    const created = parseCreateResult((await project.run(['create', 'same folder', '--js'])).value);

    expect(rows.map((row) => row.file)).toEqual([...FIXTURE_FILES]);
    expect(path.dirname(created.path)).toBe(config.migrationsDir);
  });

  it('hides the password, and never connects', async () => {
    // Port 9 refuses connections: reading the config would fail if it connected.
    const { config } = await project.readConfig({
      MMK_URI: 'mongodb://alice:s3cret@127.0.0.1:9/app',
    });

    expect(config.uri).toBe('mongodb://***:***@127.0.0.1:9/app');
  });

  it.runIf(hasNextMmk())('reads the config without a connection string (R2)', async () => {
    const { config } = await project.readConfig({ MMK_URI: '', MMK_DB: '' });

    expect(config).toMatchObject({ migrationsDir: project.migrationsDir, uri: null, dbName: null });
  });

  it.runIf(!hasNextMmk())(
    "1.5: reports a missing connection with mmk's CONFIG_INVALID",
    async () => {
      const error = await project.readConfig({ MMK_URI: '', MMK_DB: '' }).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(MmkCommandError);
      const failure = (error as MmkCommandError).failure;
      expect(failure.code).toBe('CONFIG_INVALID');
      expect(failure.details?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'uri' }),
          expect.objectContaining({ key: 'dbName' }),
        ]),
      );
    },
  );
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
