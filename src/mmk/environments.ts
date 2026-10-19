import { redactMongoUri } from './redact.js';

/**
 * The environment that stands for the project's own config and `.env`. Nothing is stored for
 * it, and nothing is injected: mmk resolves its connection exactly as it does in a terminal.
 */
export const LOCAL_ENVIRONMENT = 'local';

/**
 * The colours an environment can be drawn in: VS Code's chart colours (`charts.*`), which every
 * theme defines, so they stay readable in light, dark and high-contrast themes.
 */
export const ENVIRONMENT_HUES = ['green', 'blue', 'purple', 'yellow', 'orange', 'red'] as const;

/** One of {@link ENVIRONMENT_HUES} */
export type EnvironmentHue = (typeof ENVIRONMENT_HUES)[number];

/**
 * An environment's colour in `mmk.environments`: a hue, or one of the setting's first values
 * (`default`, `warning`, `error`), which still work.
 */
export type EnvironmentColor = EnvironmentHue | 'default' | 'warning' | 'error';

/** An environment the extension reads, and writes to only when it isn't read-only */
export interface Environment {
  name: string;
  /** Read-only environments only ever run `status`, `list`, `dry-run` and `config` */
  readOnly: boolean;
  /** Its colour in the sidebar, the console and the status bar */
  color: EnvironmentColor;
  /** True for `local`: the project's own config, no stored connection */
  local: boolean;
}

/**
 * Where a non-local environment's records live. Kept in the OS keychain only, and passed to mmk
 * as `MMK_URI` / `MMK_DB`, which win over the config file and `.env`.
 */
export interface Connection {
  uri: string;
  dbName: string;
}

/** A connection string found in settings.json, where it must not be */
export interface LeakedConnection {
  environment: string;
  /** The setting key that holds it, e.g. `uri` */
  key: string;
  uri: string;
  dbName?: string;
}

/** The parsed `mmk.environments` setting */
export interface EnvironmentSettings {
  /** `local` first, then each valid entry in the order written */
  environments: Environment[];
  /** One message per entry that was skipped, saying why */
  problems: string[];
  /** Connection strings written into settings, to move to the keychain */
  leaked: LeakedConnection[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const COLORS: ReadonlySet<string> = new Set<EnvironmentColor>([
  ...ENVIRONMENT_HUES,
  'default',
  'warning',
  'error',
]);
/** The hues an environment that isn't local or named like prod gets by default, in turn */
const DEFAULT_HUES: readonly EnvironmentHue[] = ['yellow', 'blue', 'purple', 'orange'];
const CONNECTION_KEYS = ['uri', 'url', 'connectionString', 'mongoUri', 'MMK_URI'] as const;
const DATABASE_KEYS = ['dbName', 'db', 'database', 'MMK_DB'] as const;

/**
 * Read the `mmk.environments` setting: names, read-only flags and colors only. Anything that
 * isn't `local` is read-only unless the entry says `"readOnly": false`.
 */
export function parseEnvironmentSettings(value: unknown): EnvironmentSettings {
  const problems: string[] = [];
  const leaked: LeakedConnection[] = [];
  const entries = value === undefined || value === null ? [] : value;
  if (!Array.isArray(entries)) {
    return {
      environments: [localEnvironment()],
      problems: ['"mmk.environments" should be a list, like [{ "name": "staging" }].'],
      leaked,
    };
  }

  const byName = new Map<string, Environment>();
  /** Entries without a colour of their own get one once every explicit colour is known */
  const uncoloured = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      problems.push(
        `Entry ${index + 1} of "mmk.environments" has no "name", so it was skipped. Each entry looks like { "name": "staging" }.`,
      );
      continue;
    }
    const name = entry.name.trim();
    if (!NAME_PATTERN.test(name)) {
      problems.push(
        `Environment ${JSON.stringify(name)} was skipped: a name uses lowercase letters, digits, ".", "_" or "-", starts with a letter or digit, and has at most 32 characters.`,
      );
      continue;
    }
    if (byName.has(name) && name !== LOCAL_ENVIRONMENT) {
      problems.push(`Environment "${name}" is listed twice; the first entry is used.`);
      continue;
    }
    for (const key of CONNECTION_KEYS) {
      const uri = entry[key];
      if (typeof uri === 'string' && /^mongodb(\+srv)?:\/\//i.test(uri.trim())) {
        const dbName = DATABASE_KEYS.map((dbKey) => entry[dbKey]).find(
          (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
        );
        leaked.push({
          environment: name,
          key,
          uri: uri.trim(),
          ...(dbName === undefined ? {} : { dbName }),
        });
      }
    }
    const local = name === LOCAL_ENVIRONMENT;
    const color = entry.color;
    const valid = typeof color === 'string' && COLORS.has(color);
    if (color !== undefined && !valid) {
      problems.push(
        `Environment "${name}": "color" should be green, blue, purple, yellow, orange or red, so its default is used.`,
      );
    }
    if (valid) {
      uncoloured.delete(name);
    } else {
      uncoloured.add(name);
    }
    byName.set(name, {
      name,
      readOnly: typeof entry.readOnly === 'boolean' ? entry.readOnly : !local,
      color: valid ? (color as EnvironmentColor) : 'default',
      local,
    });
  }

  const local = byName.get(LOCAL_ENVIRONMENT) ?? localEnvironment();
  byName.delete(LOCAL_ENVIRONMENT);
  const environments = [local, ...byName.values()];
  // Explicit colours are taken first; each of the others gets a default no one has yet.
  const used = environments
    .filter((environment) => !uncoloured.has(environment.name))
    .map((environment) => environmentHue(environment.color));
  for (const environment of environments) {
    if (uncoloured.has(environment.name)) {
      environment.color = defaultColor(environment.name, used);
      used.push(environmentHue(environment.color));
    }
  }
  return { environments, problems, leaked };
}

/** `local` with its defaults: writable, green */
export function localEnvironment(): Environment {
  return { name: LOCAL_ENVIRONMENT, readOnly: false, color: 'green', local: true };
}

/**
 * The colour an environment gets when the setting gives it none: green for local, red for
 * anything named like prod, else the first of yellow, blue, purple and orange that no other
 * environment has (`used`), so environments look different by default.
 */
export function defaultColor(name: string, used: readonly EnvironmentHue[] = []): EnvironmentHue {
  if (name === LOCAL_ENVIRONMENT) {
    return 'green';
  }
  if (/prod|live/.test(name)) {
    return 'red';
  }
  return DEFAULT_HUES.find((hue) => !used.includes(hue)) ?? 'yellow';
}

/** The hue an environment is drawn in; the setting's first values stand for blue, yellow and red */
/** True for a colour `mmk.environments` accepts: a hue, or `default`, `warning` or `error` */
export function isEnvironmentColor(value: unknown): value is EnvironmentColor {
  return typeof value === 'string' && COLORS.has(value);
}

export function environmentHue(color: EnvironmentColor): EnvironmentHue {
  switch (color) {
    case 'default':
      return 'blue';
    case 'warning':
      return 'yellow';
    case 'error':
      return 'red';
    default:
      return color;
  }
}

/**
 * The status bar background while an environment is selected. VS Code allows only its warning
 * and error backgrounds there: yellow and orange get the warning one, red the error one.
 */
export function statusBarBackground(color: EnvironmentColor): 'default' | 'warning' | 'error' {
  switch (environmentHue(color)) {
    case 'yellow':
    case 'orange':
      return 'warning';
    case 'red':
      return 'error';
    default:
      return 'default';
  }
}

/** Check a new environment name; returns why it can't be used, or null */
export function environmentNameProblem(name: string, existing: readonly string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'Type a name, e.g. staging';
  }
  if (trimmed === LOCAL_ENVIRONMENT) {
    return '"local" is always there: it is this project\'s own config and .env';
  }
  if (!NAME_PATTERN.test(trimmed)) {
    return 'Use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit (at most 32)';
  }
  if (existing.includes(trimmed)) {
    return `There is already an environment called "${trimmed}"`;
  }
  return null;
}

/** Check a connection string before it is stored; returns why it can't be used, or null */
export function connectionStringProblem(uri: string): string | null {
  const trimmed = uri.trim();
  if (trimmed === '') {
    return 'Paste the connection string, e.g. mongodb+srv://user:password@cluster0.example.net';
  }
  if (!/^mongodb(\+srv)?:\/\/\S+$/i.test(trimmed)) {
    return 'A MongoDB connection string starts with mongodb:// or mongodb+srv:// and has no spaces';
  }
  return null;
}

/**
 * The database named in a connection string's path (`mongodb://host/orders_staging?x=1` →
 * `orders_staging`), to pre-fill the database input. Display only: mmk reads `MMK_DB`.
 */
export function databaseFromUri(uri: string): string | null {
  const withoutScheme = uri.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const afterHosts = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1);
  const slash = afterHosts.indexOf('/');
  if (slash === -1) {
    return null;
  }
  const name = afterHosts.slice(slash + 1).replace(/[?#].*$/, '');
  try {
    const decoded = decodeURIComponent(name);
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Where records are read from, for display: `cluster0.example.net/orders_staging`. The
 * credentials are dropped, never shown. Works on mmk's masked URI and on a stored one.
 */
export function hostLabel(uri: string | null, dbName: string | null): string {
  if (!uri) {
    return 'no connection string set';
  }
  const hosts = redactMongoUri(uri)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^.*@/, '')
    .replace(/[/?].*$/, '');
  return dbName ? `${hosts}/${dbName}` : hosts;
}

/**
 * The environment variables that point mmk at `connection`, or none for `local`. mmk gives
 * `MMK_URI` / `MMK_DB` priority over its config file, and loads `.env` without overriding them.
 */
export function connectionEnv(connection: Connection | null): Record<string, string> {
  return connection ? { MMK_URI: connection.uri, MMK_DB: connection.dbName } : {};
}

/**
 * The mmk commands that never write to a database, so they may run on a read-only environment.
 * `create` only writes a file.
 */
const NO_DATABASE_WRITES = new Set(['status', 'list', 'dry-run', 'lock', 'config', 'create']);

/** True when `args` is an mmk command that never writes to a database */
export function isReadCommand(args: readonly string[]): boolean {
  return NO_DATABASE_WRITES.has(args[0] ?? '');
}

/** Thrown when a write command is asked to run on a read-only environment */
export class ReadOnlyEnvironmentError extends Error {
  readonly environment: string;

  constructor(environment: string, args: readonly string[]) {
    super(
      `${environment} is read-only, so the extension won't run "mmk ${args[0] ?? ''}" there. It only runs status, list and dry-run on ${environment}; deploys go through CI. To allow runs, set "readOnly": false for ${environment} in "mmk.environments".`,
    );
    this.name = 'ReadOnlyEnvironmentError';
    this.environment = environment;
  }
}

/**
 * Refuse a command that writes on a read-only environment. Every run goes through this, so a
 * read-only environment stays read-only whatever the UI offers.
 * @throws {@link ReadOnlyEnvironmentError}
 */
export function assertCanRun(environment: Environment, args: readonly string[]): void {
  if (environment.readOnly && !isReadCommand(args)) {
    throw new ReadOnlyEnvironmentError(environment.name, args);
  }
}

/** Parse a stored connection (JSON in the keychain); null when it isn't one */
export function parseStoredConnection(text: string | undefined): Connection | null {
  if (text === undefined) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.uri === 'string' && typeof value.dbName === 'string') {
      return { uri: value.uri, dbName: value.dbName };
    }
  } catch {
    // Not ours, or damaged: treat it as missing.
  }
  return null;
}

/** The keychain key for a project's connection to an environment */
export function connectionKey(projectDir: string, environment: string): string {
  return `mmk.connection:${environment}:${projectDir}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
