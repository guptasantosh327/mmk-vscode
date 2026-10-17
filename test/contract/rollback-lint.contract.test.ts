import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MmkProcessError, isUnknownCommand } from '../../src/mmk/cli.js';
import { parseLintReport, parseRollbackReport } from '../../src/mmk/contract.js';
import { rollbackOutcomes } from '../../src/mmk/rollback.js';
import {
  type ContractProject,
  FIXTURE_FILES,
  REPO_ROOT,
  createProject,
  hasNextMmk,
} from './harness.js';

/**
 * `mmk test-rollback --json` (R6) and `mmk lint --json` (R7) from the real mmk: their shapes,
 * the A4 example, and how the extension tells an mmk that doesn't have them.
 */

const A4 = '20260104000000-index-orders-by-customer.js';
const A4_SOURCE = path.join(REPO_ROOT, 'test/fixtures/a4', A4);
const DB = 'contract_rollback';

let mongo: MongoMemoryServer;
let client: MongoClient;
let project: ContractProject;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  project = await createProject(mongo, DB);
});

afterAll(async () => {
  project?.cleanup();
  await client?.close();
  await mongo?.stop();
});

async function leftoverDatabases(): Promise<string[]> {
  const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
  return databases
    .map((database) => database.name)
    .filter((name) => name.includes('_mmk_rollback_'));
}

describe.runIf(hasNextMmk())('mmk test-rollback --json (R6)', () => {
  it('passes the fixture migrations, on a temporary database it drops', async () => {
    const output = await project.run(['test-rollback']);
    const report = parseRollbackReport(output.value);

    expect(output.exitCode).toBe(0);
    expect(report).toMatchObject({ configuredDatabase: DB, dropped: true, passed: 3, failed: 0 });
    expect(report.results.map((result) => [result.file, result.status])).toEqual(
      FIXTURE_FILES.map((file) => [file, 'passed']),
    );
    expect(await leftoverDatabases()).toEqual([]);
    expect(await client.db(DB).listCollections().toArray()).toEqual([]);
  });

  it("fails the A4 example in down(), at line 12, with mmk's message", async () => {
    copyFileSync(A4_SOURCE, path.join(project.migrationsDir, A4));
    const output = await project.run(['test-rollback', A4]);
    const report = parseRollbackReport(output.value);
    const [outcome] = rollbackOutcomes(report);

    expect(output.exitCode).toBe(1);
    expect(report.setup.map((setup) => setup.file)).toEqual([...FIXTURE_FILES]);
    expect(outcome).toMatchObject({
      file: A4,
      status: 'failed',
      failure: {
        step: 'down',
        title: 'rollback test failed in down()',
        location: { file: path.join(project.migrationsDir, A4), line: 12 },
      },
    });
    expect(outcome?.failure?.message).toContain(
      'Reason: MongoServerError: index not found with name [customerId_1_createdAt_-1]',
    );
    expect(outcome?.failure?.message).toContain(`${DB} was not touched`);
    expect(await leftoverDatabases()).toEqual([]);
  });
});

describe.runIf(hasNextMmk())('mmk lint --json (R7)', () => {
  it('finds the unnamed index nowhere in the A4 file, and nothing in the fixtures', async () => {
    copyFileSync(A4_SOURCE, path.join(project.migrationsDir, A4));
    const report = parseLintReport((await project.run(['lint'])).value);

    expect(report.files).toEqual(expect.arrayContaining([...FIXTURE_FILES, A4]));
    expect(report.errors).toBe(0);
    expect(report.findings.filter((finding) => finding.file === A4)).toEqual([]);
  });

  it('reports findings with 1-based positions, without a database', async () => {
    project.addMigration(
      '20260105000000-risky.js',
      `module.exports = {
  async up({ db }) {
    await db.collection('orders').createIndex({ customerId: 1 });
  },
  async down() {},
};
`,
    );
    const output = await project.run(['lint', '20260105000000-risky.js'], {
      MMK_URI: 'mongodb://127.0.0.1:9',
    });
    const report = parseLintReport(output.value);

    expect(report.findings.map((finding) => [finding.rule, finding.line, finding.column])).toEqual([
      ['index-without-name', 3, 35],
      ['empty-down', 5, 9],
    ]);
  });
});

describe.runIf(!hasNextMmk())('1.5: no test-rollback or lint', () => {
  it.each(['test-rollback', 'lint'])('tells that mmk has no %s command', async (command) => {
    const error = await project.run([command]).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(MmkProcessError);
    expect(isUnknownCommand(error, command)).toBe(true);
  });
});
