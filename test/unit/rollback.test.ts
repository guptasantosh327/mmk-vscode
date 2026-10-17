import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RollbackTestReport } from '../../src/mmk/contract.js';
import {
  isInFile,
  parseLocation,
  rollbackOutcomes,
  rollbackSummary,
  stepLabel,
} from '../../src/mmk/rollback.js';

const A4_MESSAGE =
  '"20261016101502-index-orders.js" failed its rollback test in down()\n  Reason: MongoServerError: index not found with name [customerId_1_createdAt_-1]';

function report(overrides: Partial<RollbackTestReport> = {}): RollbackTestReport {
  return {
    database: 'orders_dev_mmk_rollback_49eca367',
    configuredDatabase: 'orders_dev',
    dropped: true,
    setup: [],
    results: [],
    passed: 0,
    failed: 0,
    skipped: 0,
    ...overrides,
  };
}

describe('rollbackOutcomes', () => {
  it('should give every file all three steps, skipping those that never ran (A4)', () => {
    const outcomes = rollbackOutcomes(
      report({
        results: [
          {
            file: 'a.js',
            status: 'passed',
            steps: [
              { step: 'up', status: 'passed', duration: 30 },
              { step: 'down', status: 'passed', duration: 4 },
              { step: 'up-again', status: 'passed', duration: 14 },
            ],
          },
          {
            file: 'b.js',
            status: 'failed',
            steps: [
              { step: 'up', status: 'passed', duration: 12 },
              { step: 'down', status: 'failed', duration: 3 },
            ],
            failedStep: 'down',
            error: {
              code: 'MIGRATION_EXECUTION_FAILED',
              message: A4_MESSAGE,
              cause: 'MongoServerError: index not found with name [customerId_1_createdAt_-1]',
              location: '/work/shop-api/migrations/b.js:12:5',
            },
          },
          {
            file: 'c.js',
            status: 'skipped',
            steps: [],
            reason: 'Not run: b.js failed its rollback test',
          },
        ],
      }),
    );

    expect(outcomes.map((outcome) => [outcome.file, outcome.status, outcome.duration])).toEqual([
      ['a.js', 'passed', 48],
      ['b.js', 'failed', 15],
      ['c.js', 'skipped', 0],
    ]);
    expect(outcomes[1]?.steps.map((step) => [step.step, step.status])).toEqual([
      ['up', 'passed'],
      ['down', 'failed'],
      ['up-again', 'skipped'],
    ]);
    expect(outcomes[1]?.failure).toEqual({
      step: 'down',
      title: 'rollback test failed in down()',
      message: A4_MESSAGE,
      location: { file: '/work/shop-api/migrations/b.js', line: 12, column: 5 },
    });
    expect(outcomes[2]?.failure?.title).toBe('Not run: b.js failed its rollback test');
  });

  it('should name the second up() in the title', () => {
    const [outcome] = rollbackOutcomes(
      report({
        results: [
          {
            file: 'a.js',
            status: 'failed',
            steps: [],
            failedStep: 'up-again',
            error: { message: 'E11000 duplicate key' },
          },
        ],
      }),
    );
    expect(outcome?.failure?.title).toBe('rollback test failed in up() again');
    expect(outcome?.failure?.location).toBeNull();
  });

  it('should make the tested file errored when a file before it failed to apply', () => {
    const [outcome] = rollbackOutcomes(
      report({
        setup: [{ file: 'a.js', status: 'failed', duration: 2, error: { message: 'setup broke' } }],
        results: [{ file: 'b.js', status: 'skipped', steps: [], reason: 'Not run: a.js failed' }],
      }),
    );
    expect(outcome).toMatchObject({
      status: 'errored',
      failure: {
        step: null,
        title: "a.js runs before it and failed to apply, so this wasn't tested",
        message: 'setup broke',
      },
    });
  });
});

describe('parseLocation', () => {
  it('should read path:line:column, with colons in the path', () => {
    expect(parseLocation('/a/b.js:12:5')).toEqual({ file: '/a/b.js', line: 12, column: 5 });
    expect(parseLocation('C:\\work\\b.js:3:9')).toEqual({
      file: 'C:\\work\\b.js',
      line: 3,
      column: 9,
    });
  });

  it('should give null for nothing or something else', () => {
    expect(parseLocation(undefined)).toBeNull();
    expect(parseLocation('somewhere')).toBeNull();
    expect(parseLocation(':1:2')).toBeNull();
  });

  it('should compare a location with a file by resolved path', () => {
    const file = path.resolve('/work/migrations/b.js');
    expect(
      isInFile({ file: '/work/migrations/../migrations/b.js', line: 1, column: 1 }, file),
    ).toBe(true);
    expect(isInFile({ file: '/work/migrations/c.js', line: 1, column: 1 }, file)).toBe(false);
  });
});

describe('rollbackSummary', () => {
  it('should say what ran and where (A4)', () => {
    expect(rollbackSummary(report({ passed: 2, failed: 1 }))).toBe(
      '2 passed · 1 failed · on a temporary database (orders_dev_mmk_rollback_49eca367), dropped after the run; orders_dev was not touched',
    );
  });

  it('should say when the temporary database was left behind', () => {
    expect(rollbackSummary(report({ passed: 1, skipped: 2, dropped: false }))).toBe(
      "1 passed · 2 skipped · on a temporary database (orders_dev_mmk_rollback_49eca367), which mmk couldn't drop: drop it by hand; orders_dev was not touched",
    );
  });
});

describe('stepLabel', () => {
  it('should label the steps as Test Explorer shows them', () => {
    expect(['up', 'down', 'up-again'].map((step) => stepLabel(step as 'up'))).toEqual([
      'up',
      'down',
      'up again',
    ]);
  });
});
