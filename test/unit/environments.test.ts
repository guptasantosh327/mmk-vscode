import { describe, expect, it } from 'vitest';
import {
  ReadOnlyEnvironmentError,
  assertCanRun,
  connectionEnv,
  connectionKey,
  connectionStringProblem,
  databaseFromUri,
  defaultColor,
  environmentNameProblem,
  hostLabel,
  isReadCommand,
  localEnvironment,
  parseEnvironmentSettings,
  parseStoredConnection,
} from '../../src/mmk/environments.js';

describe('parseEnvironmentSettings', () => {
  it('should always start with local, writable and with the default color', () => {
    expect(parseEnvironmentSettings(undefined)).toEqual({
      environments: [{ name: 'local', readOnly: false, color: 'default', local: true }],
      problems: [],
      leaked: [],
    });
  });

  it('should make every other environment read-only unless it says otherwise', () => {
    const { environments } = parseEnvironmentSettings([
      { name: 'staging' },
      { name: 'prod' },
      { name: 'dev-cluster', readOnly: false, color: 'default' },
    ]);

    expect(environments).toEqual([
      { name: 'local', readOnly: false, color: 'default', local: true },
      { name: 'staging', readOnly: true, color: 'warning', local: false },
      { name: 'prod', readOnly: true, color: 'error', local: false },
      { name: 'dev-cluster', readOnly: false, color: 'default', local: false },
    ]);
  });

  it('should let an entry for local change its flags, and keep it first', () => {
    const { environments } = parseEnvironmentSettings([
      { name: 'staging' },
      { name: 'local', readOnly: true },
    ]);

    expect(environments.map((environment) => [environment.name, environment.readOnly])).toEqual([
      ['local', true],
      ['staging', true],
    ]);
  });

  it('should skip bad entries and say why', () => {
    const { environments, problems } = parseEnvironmentSettings([
      { readOnly: true },
      { name: 'Prod Cluster' },
      { name: 'staging' },
      { name: 'staging', readOnly: false },
      { name: 'qa', color: 'purple' },
    ]);

    expect(environments.map((environment) => environment.name)).toEqual(['local', 'staging', 'qa']);
    expect(environments[1]?.readOnly).toBe(true);
    expect(environments[2]?.color).toBe('warning');
    expect(problems).toEqual([
      'Entry 1 of "mmk.environments" has no "name", so it was skipped. Each entry looks like { "name": "staging" }.',
      expect.stringContaining('Environment "Prod Cluster" was skipped'),
      'Environment "staging" is listed twice; the first entry is used.',
      'Environment "qa": "color" should be "default", "warning" or "error", so its default is used.',
    ]);
  });

  it('should refuse a setting that is not a list', () => {
    expect(parseEnvironmentSettings({ staging: {} }).problems).toEqual([
      '"mmk.environments" should be a list, like [{ "name": "staging" }].',
    ]);
  });

  it('should find connection strings written into settings, so they can be moved', () => {
    const { leaked, environments } = parseEnvironmentSettings([
      { name: 'staging', uri: 'mongodb+srv://alice:s3cret@cluster0.example.net', dbName: 'app' },
      { name: 'prod', connectionString: 'mongodb://h:27017' },
      { name: 'qa', uri: 'not a connection string' },
    ]);

    expect(leaked).toEqual([
      {
        environment: 'staging',
        key: 'uri',
        uri: 'mongodb+srv://alice:s3cret@cluster0.example.net',
        dbName: 'app',
      },
      { environment: 'prod', key: 'connectionString', uri: 'mongodb://h:27017' },
    ]);
    expect(environments.map((environment) => environment.name)).toEqual([
      'local',
      'staging',
      'prod',
      'qa',
    ]);
  });
});

describe('defaultColor', () => {
  it.each([
    ['local', 'default'],
    ['staging', 'warning'],
    ['qa', 'warning'],
    ['prod', 'error'],
    ['production-eu', 'error'],
    ['live', 'error'],
  ])('%s → %s', (name, color) => {
    expect(defaultColor(name)).toBe(color);
  });
});

describe('environmentNameProblem', () => {
  it('should accept a new, well-formed name', () => {
    expect(environmentNameProblem(' staging ', ['local'])).toBeNull();
  });

  it.each([
    ['', 'Type a name, e.g. staging'],
    ['local', '"local" is always there'],
    ['Staging', 'Use lowercase letters'],
    ['prod', 'There is already an environment called "prod"'],
  ])('%j', (name, problem) => {
    expect(environmentNameProblem(name, ['local', 'prod'])).toContain(problem);
  });
});

describe('connectionStringProblem', () => {
  it('should accept mongodb:// and mongodb+srv:// strings', () => {
    expect(connectionStringProblem('mongodb://localhost:27017')).toBeNull();
    expect(connectionStringProblem(' mongodb+srv://u:p@c.example.net/app ')).toBeNull();
  });

  it('should refuse anything else, without echoing it', () => {
    expect(connectionStringProblem('')).toContain('Paste the connection string');
    expect(connectionStringProblem('postgres://u:secret@h')).not.toContain('secret');
    expect(connectionStringProblem('mongodb://has space')).toContain('has no spaces');
  });
});

describe('databaseFromUri', () => {
  it.each([
    ['mongodb://h:27017/orders_staging?retryWrites=true', 'orders_staging'],
    ['mongodb+srv://alice:p%2Fw@cluster0.example.net/app', 'app'],
    ['mongodb://alice:pa/ss@h/app', 'app'],
    ['mongodb://h1,h2/my%20db', 'my db'],
    ['mongodb://h:27017', null],
    ['mongodb://h:27017/', null],
    ['mongodb://h:27017/?ssl=true', null],
  ])('%s → %s', (uri, database) => {
    expect(databaseFromUri(uri)).toBe(database);
  });
});

describe('hostLabel', () => {
  it('should show hosts and database, never credentials', () => {
    expect(hostLabel('mongodb+srv://alice:s3cret@cluster0.example.net/x?y=1', 'orders')).toBe(
      'cluster0.example.net/orders',
    );
    expect(hostLabel('mongodb://***:***@127.0.0.1:27017', null)).toBe('127.0.0.1:27017');
    expect(hostLabel(null, 'orders')).toBe('no connection string set');
  });
});

describe('connectionEnv', () => {
  it('should pass a stored connection as MMK_URI and MMK_DB, and nothing for local', () => {
    expect(connectionEnv({ uri: 'mongodb://h', dbName: 'app' })).toEqual({
      MMK_URI: 'mongodb://h',
      MMK_DB: 'app',
    });
    expect(connectionEnv(null)).toEqual({});
  });
});

describe('read-only enforcement', () => {
  const staging = { name: 'staging', readOnly: true, color: 'warning', local: false } as const;

  it.each([['status'], ['list', '--pending'], ['dry-run', 'up'], ['config'], ['create', 'x']])(
    'should allow %j',
    (...args) => {
      expect(isReadCommand(args)).toBe(true);
      expect(() => assertCanRun(staging, args)).not.toThrow();
    },
  );

  it.each([
    ['up'],
    ['down', 'x.js'],
    ['redo'],
    ['unlock', '--yes'],
    ['import'],
    ['namespace', 'adopt'],
    // Anything not known to be read-only is refused, including commands a newer mmk adds.
    ['some-future-command'],
  ])('should refuse %j on a read-only environment', (...args) => {
    expect(isReadCommand(args)).toBe(false);
    expect(() => assertCanRun(staging, args)).toThrow(ReadOnlyEnvironmentError);
  });

  it('should say where runs are allowed and how to change it', () => {
    expect(() => assertCanRun(staging, ['up'])).toThrow(
      'staging is read-only, so mmk for VS Code won\'t run "mmk up" there. It only runs status, list and dry-run on staging; deploys go through CI. To allow runs, set "readOnly": false for staging in "mmk.environments".',
    );
  });

  it('should allow every command on a writable environment', () => {
    expect(() => assertCanRun(localEnvironment(), ['down', 'x.js'])).not.toThrow();
  });
});

describe('stored connections', () => {
  it('should read back what was stored, and ignore anything else', () => {
    expect(parseStoredConnection('{"uri":"mongodb://h","dbName":"app"}')).toEqual({
      uri: 'mongodb://h',
      dbName: 'app',
    });
    expect(parseStoredConnection(undefined)).toBeNull();
    expect(parseStoredConnection('mongodb://h')).toBeNull();
    expect(parseStoredConnection('{"uri":"mongodb://h"}')).toBeNull();
  });

  it('should key a connection by environment and project', () => {
    expect(connectionKey('/work/api', 'staging')).toBe('mmk.connection:staging:/work/api');
  });
});
