import { describe, expect, it } from 'vitest';
import { parseConfigSummary, runResultsOfFailure } from '../../src/mmk/contract.js';

const SUMMARY = {
  configFile: '/p/mmk.config.js',
  migrationsDir: '/p/migrations',
  fileExtensions: ['.ts', '.js'],
  createExtension: 'js',
  sequential: false,
  migrationsCollection: '_mmk_migrations',
  lockCollection: '_mmk_locks',
  lockTTLSeconds: 60,
  strict: false,
  useTransaction: false,
  requireAuthor: false,
  namespace: 'billing-api',
  dbName: null,
  uri: null,
  sources: { migrationsDir: 'file' },
};

describe('parseConfigSummary', () => {
  it('should accept mmk config --json output, with nulls for what is not set', () => {
    expect(parseConfigSummary(SUMMARY)).toEqual(SUMMARY);
  });

  it('should refuse a createExtension mmk does not define', () => {
    expect(() => parseConfigSummary({ ...SUMMARY, createExtension: 'mjs' })).toThrow(
      'mmk config --json returned something this extension can\'t read: the output.createExtension should be "js" or "ts"',
    );
  });

  it('should refuse fileExtensions that are not strings', () => {
    expect(() => parseConfigSummary({ ...SUMMARY, fileExtensions: ['.js', 3] })).toThrow(
      'the output.fileExtensions should be an array of strings',
    );
  });

  it('should refuse a missing migrationsDir', () => {
    const { migrationsDir: _omitted, ...rest } = SUMMARY;
    expect(() => parseConfigSummary(rest)).toThrow(
      'the output.migrationsDir should be a string, but it is missing',
    );
  });
});

describe('runResultsOfFailure', () => {
  it('should read the results mmk lists before a failure', () => {
    expect(
      runResultsOfFailure({
        code: 'MIGRATION_EXECUTION_FAILED',
        message: 'boom',
        details: {
          name: 'b.js',
          results: [
            { file: 'a.js', status: 'applied', duration: 3, batch: 1 },
            { file: 'b.js', status: 'error', error: 'boom' },
          ],
        },
      }),
    ).toEqual([
      { file: 'a.js', status: 'applied', duration: 3, batch: 1 },
      { file: 'b.js', status: 'error', error: 'boom' },
    ]);
  });

  it('should return null when mmk listed none, or listed something unreadable', () => {
    expect(runResultsOfFailure({ message: 'boom' })).toBeNull();
    expect(runResultsOfFailure({ message: 'boom', details: { results: 'nope' } })).toBeNull();
    expect(
      runResultsOfFailure({ message: 'boom', details: { results: [{ file: 1 }] } }),
    ).toBeNull();
  });
});
