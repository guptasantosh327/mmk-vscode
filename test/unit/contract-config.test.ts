import { describe, expect, it } from 'vitest';
import { parseProjectConfig, runResultsOfFailure } from '../../src/mmk/contract.js';

/** What `mmk config --json` (R2) prints; the extension reads a subset of it */
const CONFIG_COMMAND_OUTPUT = {
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

describe('parseProjectConfig', () => {
  it('should keep the fields the extension reads from mmk config --json', () => {
    expect(parseProjectConfig(CONFIG_COMMAND_OUTPUT, 'config')).toEqual({
      migrationsDir: '/p/migrations',
      fileExtensions: ['.ts', '.js'],
      createExtension: 'js',
      sequential: false,
      namespace: 'billing-api',
      dbName: null,
      uri: null,
    });
  });

  it('should accept the library bridge output, which has no namespace by default', () => {
    expect(
      parseProjectConfig(
        {
          migrationsDir: '/p/migrations',
          fileExtensions: ['.js'],
          createExtension: 'ts',
          sequential: true,
          dbName: 'orders_dev',
          uri: 'mongodb://***:***@h',
        },
        'resolveConfig()',
      ),
    ).toEqual({
      migrationsDir: '/p/migrations',
      fileExtensions: ['.js'],
      createExtension: 'ts',
      sequential: true,
      dbName: 'orders_dev',
      uri: 'mongodb://***:***@h',
    });
  });

  it('should refuse a createExtension mmk does not define', () => {
    expect(() =>
      parseProjectConfig({ ...CONFIG_COMMAND_OUTPUT, createExtension: 'mjs' }, 'config'),
    ).toThrow(
      'mmk config --json returned something this extension can\'t read: the output.createExtension should be "js" or "ts"',
    );
  });

  it('should refuse fileExtensions that are not strings', () => {
    expect(() =>
      parseProjectConfig({ ...CONFIG_COMMAND_OUTPUT, fileExtensions: ['.js', 3] }, 'config'),
    ).toThrow('the output.fileExtensions should be an array of strings');
  });

  it('should refuse a missing migrationsDir', () => {
    const { migrationsDir: _omitted, ...rest } = CONFIG_COMMAND_OUTPUT;
    expect(() => parseProjectConfig(rest, 'config')).toThrow(
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
