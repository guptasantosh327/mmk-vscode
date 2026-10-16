import type {
  ConfigSummary,
  LockInfo,
  MigrationExtension,
  MmkErrorCode,
  RunResult,
  RunResultStatus,
  StatusRow,
} from 'mongo-migrate-kit';

/**
 * The JSON form of an mmk type. `--json` output goes through `JSON.stringify`, so every `Date`
 * field arrives as an ISO 8601 string; everything else keeps its shape.
 */
export type Wire<T> = T extends Date
  ? string
  : T extends ReadonlyArray<infer U>
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/**
 * An error code from mmk. A newer mmk may return a code this extension doesn't know yet, so any
 * string is accepted while the known ones keep their autocompletion.
 */
export type ErrorCode = MmkErrorCode | (string & Record<never, never>);

/**
 * The document every `--json` command prints on failure, with exit code 1
 * (`withMigrator` and `failPreflight` in mongo-migrate-kit's `src/cli/shared.ts`).
 * mongo-migrate-kit doesn't export a type for it.
 */
export interface MmkFailure {
  /** Absent when the failure wasn't one of mmk's own errors (a crash inside mmk) */
  code?: ErrorCode;
  /** Ready to show as is: mmk says what happened and what to do, with credentials hidden */
  message: string;
  /** Structured detail, e.g. `issues` for `CONFIG_INVALID` */
  details?: Record<string, unknown>;
}

/** `mmk create <name> --json`. mongo-migrate-kit doesn't export a type for it */
export interface CreateResult {
  /** Absolute path of the new migration file */
  path: string;
}

/** `mmk unlock --json`. mongo-migrate-kit doesn't export a type for it */
export interface UnlockResult {
  /** False when no lock was held */
  released: boolean;
  /** The holder that was released, or null */
  holder: Wire<LockInfo> | null;
}

/** Thrown when mmk's JSON doesn't have a field the extension reads, or it has the wrong type */
export class ContractError extends Error {
  readonly command: string;
  readonly field: string;

  constructor(command: string, field: string, expected: string, received: unknown) {
    super(
      `mmk ${command} --json returned something this extension can't read: ${field} should be ${expected}, but it is ${describe(received)}. This project's mongo-migrate-kit may be a version this extension doesn't support yet.`,
    );
    this.name = 'ContractError';
    this.command = command;
    this.field = field;
  }
}

/** Parse the rows of `mmk status --json`, `mmk list --json` or `mmk dry-run --json` */
export function parseStatusRows(value: unknown, command: string): Wire<StatusRow>[] {
  return expectArray(command, 'the output', value).map((row, index) =>
    checkFields<Wire<StatusRow>>(command, `row ${index}`, row, STATUS_ROW_RULES),
  );
}

/** Parse the results of `mmk up --json`, `mmk down --json` or `mmk redo --json` */
export function parseRunResults(value: unknown, command: string): Wire<RunResult>[] {
  return expectArray(command, 'the output', value).map((result, index) =>
    checkFields<Wire<RunResult>>(command, `result ${index}`, result, RUN_RESULT_RULES),
  );
}

/** Parse the output of `mmk create <name> --json` */
export function parseCreateResult(value: unknown): CreateResult {
  return checkFields<CreateResult>('create', 'the output', value, {
    path: required(isString, 'a string'),
  });
}

/** Parse the output of `mmk unlock --json` */
export function parseUnlockResult(value: unknown): UnlockResult {
  const result = checkFields<{ released: boolean; holder: unknown }>(
    'unlock',
    'the output',
    value,
    {
      released: required(isBoolean, 'true or false'),
      holder: required(() => true, 'an object or null'),
    },
  );
  const holder =
    result.holder === null
      ? null
      : checkFields<Wire<LockInfo>>('unlock', 'holder', result.holder, LOCK_INFO_RULES);
  return { released: result.released, holder };
}

/** Parse the output of `mmk config --json` */
export function parseConfigSummary(value: unknown): Wire<ConfigSummary> {
  return checkFields<Wire<ConfigSummary>>('config', 'the output', value, CONFIG_SUMMARY_RULES);
}

/**
 * The results of the files that ran before a run failed (`details.results`, mmk 1.6 and later),
 * or null when mmk didn't report them.
 */
export function runResultsOfFailure(failure: MmkFailure): Wire<RunResult>[] | null {
  const results = failure.details?.results;
  if (!Array.isArray(results)) {
    return null;
  }
  try {
    return parseRunResults(results, 'run');
  } catch {
    return null;
  }
}

/**
 * The failure inside mmk's error document, or null when `value` isn't one. Only `error.message`
 * is required, because a crash that isn't one of mmk's own errors has no code.
 */
export function parseErrorDocument(value: unknown): MmkFailure | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== 'string') {
    return null;
  }
  const { code, message, details } = value.error;
  return {
    message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(isRecord(details) ? { details } : {}),
  };
}

// ─── Field rules ──────────────────────────────────────────────────────────────

/** How one field is checked */
interface FieldRule {
  check: (value: unknown) => boolean;
  expected: string;
  optional: boolean;
}

function required(check: (value: unknown) => boolean, expected: string): FieldRule {
  return { check, expected, optional: false };
}

function optional(check: (value: unknown) => boolean, expected: string): FieldRule {
  return { check, expected, optional: true };
}

const isString = (value: unknown): boolean => typeof value === 'string';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isIsoDate = (value: unknown): boolean =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

function nullable(check: (value: unknown) => boolean): (value: unknown) => boolean {
  return (value) => value === null || check(value);
}

function oneOf(values: readonly string[]): (value: unknown) => boolean {
  return (value) => typeof value === 'string' && values.includes(value);
}

/** Every `StatusRow.status`; a `Record` so the compiler flags a value added to mmk's type */
const STATUS_ROW_STATUSES: Record<StatusRow['status'], true> = { applied: true, pending: true };

/** Every `RunResultStatus`; a `Record` so the compiler flags a value added to mmk's type */
const RUN_RESULT_STATUSES: Record<RunResultStatus, true> = {
  applied: true,
  reverted: true,
  skipped: true,
  error: true,
};

/** One rule per `StatusRow` field: `satisfies` makes the compiler flag a field added to mmk's type */
const STATUS_ROW_RULES = {
  file: required(isString, 'a string'),
  status: required(oneOf(Object.keys(STATUS_ROW_STATUSES)), '"applied" or "pending"'),
  batch: required(nullable(isNumber), 'a number or null'),
  appliedAt: required(nullable(isIsoDate), 'an ISO date string or null'),
  duration: required(nullable(isNumber), 'a number or null'),
  checksumOk: required(nullable(isBoolean), 'true, false or null'),
  description: optional(isString, 'a string'),
  author: optional(isString, 'a string'),
  namespace: optional(isString, 'a string'),
  fileMissing: optional(isBoolean, 'true or false'),
  unadopted: optional(isBoolean, 'true or false'),
} satisfies Record<keyof StatusRow, FieldRule>;

const RUN_RESULT_RULES = {
  file: required(isString, 'a string'),
  status: required(
    oneOf(Object.keys(RUN_RESULT_STATUSES)),
    `one of ${Object.keys(RUN_RESULT_STATUSES).join(', ')}`,
  ),
  duration: optional(isNumber, 'a number'),
  batch: optional(isNumber, 'a number'),
  reason: optional(isString, 'a string'),
  error: optional(isString, 'a string'),
} satisfies Record<keyof RunResult, FieldRule>;

const LOCK_INFO_RULES = {
  lockedAt: required(isIsoDate, 'an ISO date string'),
  pid: required(isNumber, 'a number'),
  host: required(isString, 'a string'),
  executedBy: required(isString, 'a string'),
  namespace: optional(isString, 'a string'),
  acquiredAt: optional(isIsoDate, 'an ISO date string'),
  expiresAt: optional(isIsoDate, 'an ISO date string'),
} satisfies Record<keyof LockInfo, FieldRule>;

/** Every `MigrationExtension`; a `Record` so the compiler flags a value added to mmk's type */
const MIGRATION_EXTENSIONS: Record<MigrationExtension, true> = { js: true, ts: true };

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const CONFIG_SUMMARY_RULES = {
  configFile: required(nullable(isString), 'a string or null'),
  migrationsDir: required(isString, 'a string'),
  fileExtensions: required(isStringArray, 'an array of strings'),
  createExtension: required(oneOf(Object.keys(MIGRATION_EXTENSIONS)), '"js" or "ts"'),
  sequential: required(isBoolean, 'true or false'),
  migrationsCollection: required(isString, 'a string'),
  lockCollection: required(isString, 'a string'),
  lockTTLSeconds: required(isNumber, 'a number'),
  strict: required(isBoolean, 'true or false'),
  useTransaction: required(isBoolean, 'true or false'),
  requireAuthor: required(isBoolean, 'true or false'),
  namespace: optional(isString, 'a string'),
  author: optional(isString, 'a string'),
  templatePath: optional(isString, 'a string'),
  dbName: required(nullable(isString), 'a string or null'),
  uri: required(nullable(isString), 'a string or null'),
  sources: required(isRecord, 'an object'),
} satisfies Record<keyof ConfigSummary, FieldRule>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectArray(command: string, field: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new ContractError(command, field, 'an array', value);
  }
  return value;
}

/**
 * Check every field of `value` against `rules` and return it typed as `T`. The rules are what
 * make the cast sound, so each caller's rules must cover every required field of `T`.
 */
function checkFields<T>(
  command: string,
  field: string,
  value: unknown,
  rules: Record<string, FieldRule>,
): T {
  if (!isRecord(value)) {
    throw new ContractError(command, field, 'an object', value);
  }
  for (const [key, rule] of Object.entries(rules)) {
    const present = Object.hasOwn(value, key);
    if (!present && rule.optional) {
      continue;
    }
    if (!present || !rule.check(value[key])) {
      throw new ContractError(command, `${field}.${key}`, rule.expected, value[key]);
    }
  }
  return value as T;
}

/** A short description of a value for an error message */
function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value.slice(0, 40))}`;
  if (typeof value === 'object') return 'an object';
  return `${typeof value} ${String(value)}`;
}
