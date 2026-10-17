import type {
  LockInfo,
  MigrationExtension,
  MmkConfig,
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
 * A row of `status`, `list` or `dry-run` as it arrives. mongo-migrate-kit after 1.5 adds
 * `checksum` to `StatusRow` (request R5): the SHA-256 recorded when the file was applied. Until
 * that release is pinned, the field is added here so the code compiles against both; once it
 * is, this is plain `WireStatusRow`.
 */
export type WireStatusRow = Wire<StatusRow & { checksum?: string }>;

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
export function parseStatusRows(value: unknown, command: string): WireStatusRow[] {
  return expectArray(command, 'the output', value).map((row, index) =>
    checkFields<WireStatusRow>(command, `row ${index}`, row, STATUS_ROW_RULES),
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

/**
 * The resolved config values the extension reads. mongo-migrate-kit 1.5 exports no type for
 * them (a later release adds `ConfigSummary` with `mmk config --json`, request R2), so this is
 * declared here, taking each mirrored field's type from `MmkConfig`. It is the subset of R2's
 * `ConfigSummary` the extension needs, and both ways of reading config produce it.
 */
export interface ProjectConfig {
  /** Absolute path of the migrations folder, resolved the way every mmk command resolves it */
  migrationsDir: string;
  fileExtensions: MmkConfig['fileExtensions'];
  createExtension: MmkConfig['createExtension'];
  sequential: MmkConfig['sequential'];
  /** Absent for the default namespace */
  namespace?: string;
  /** The database name; null when none is set */
  dbName: string | null;
  /** The connection string with its credentials hidden; null when none is set */
  uri: string | null;
}

/**
 * Parse the resolved config, from `mmk config --json` or from the library bridge (same shape).
 * Fields the extension doesn't read are ignored.
 */
export function parseProjectConfig(value: unknown, command: string): ProjectConfig {
  const parsed = checkFields<ProjectConfig>(command, 'the output', value, PROJECT_CONFIG_RULES);
  return {
    migrationsDir: parsed.migrationsDir,
    fileExtensions: [...parsed.fileExtensions],
    createExtension: parsed.createExtension,
    sequential: parsed.sequential,
    ...(parsed.namespace !== undefined ? { namespace: parsed.namespace } : {}),
    dbName: parsed.dbName,
    uri: parsed.uri,
  };
}

// ─── Rollback tests (R6) and lint (R7) ─────────────────────────────────────────
//
// mongo-migrate-kit after 1.5 exports these types (`RollbackTestReport`, `LintReport`, …). Until
// that release is pinned they're declared here with mmk's names and shapes, so switching to the
// import is a one-line change; the field rules below are what the contract tests hold the real
// output to.

/** A step of a rollback test */
export type RollbackStep = 'up' | 'down' | 'up-again';

/** Why a rollback test step (or a setup step) failed */
export interface RollbackFailure {
  code?: ErrorCode;
  /** mmk's own explanation, ready to show */
  message: string;
  /** The migration's own error, e.g. `MongoServerError: index not found …` */
  cause?: string;
  /** `path:line:column` in the migration file, when mmk could tell */
  location?: string;
}

/** The rollback test of one migration file */
export interface RollbackTestResult {
  file: string;
  status: 'passed' | 'failed' | 'skipped';
  steps: Array<{ step: RollbackStep; status: 'passed' | 'failed'; duration: number }>;
  failedStep?: RollbackStep;
  error?: RollbackFailure;
  reason?: string;
}

/** `mmk test-rollback --json` */
export interface RollbackTestReport {
  /** The temporary database the tests ran in */
  database: string;
  /** The configured database, which mmk didn't touch */
  configuredDatabase: string;
  dropped: boolean;
  setup: Array<{
    file: string;
    status: 'applied' | 'failed';
    duration: number;
    error?: RollbackFailure;
  }>;
  results: RollbackTestResult[];
  passed: number;
  failed: number;
  skipped: number;
}

/** One finding of `mmk lint --json`; lines and columns are 1-based */
export interface LintFinding {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** The rule's name, e.g. `empty-down`; a newer mmk may add rules */
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

/** `mmk lint --json` */
export interface LintReport {
  files: string[];
  findings: LintFinding[];
  errors: number;
  warnings: number;
}

/** Parse `mmk test-rollback --json` */
export function parseRollbackReport(value: unknown): RollbackTestReport {
  const command = 'test-rollback';
  const report = checkFields<RollbackTestReport>(command, 'the output', value, {
    database: required(isString, 'a string'),
    configuredDatabase: required(isString, 'a string'),
    dropped: required(isBoolean, 'true or false'),
    setup: required(Array.isArray, 'an array'),
    results: required(Array.isArray, 'an array'),
    passed: required(isNumber, 'a number'),
    failed: required(isNumber, 'a number'),
    skipped: required(isNumber, 'a number'),
  });
  report.setup.forEach((setup, index) => {
    checkFields(command, `setup ${index}`, setup, {
      file: required(isString, 'a string'),
      status: required(oneOf(['applied', 'failed']), '"applied" or "failed"'),
      duration: required(isNumber, 'a number'),
      error: optional(isFailure, 'an object with a message'),
    });
  });
  report.results.forEach((result, index) => {
    checkFields(command, `result ${index}`, result, {
      file: required(isString, 'a string'),
      status: required(oneOf(['passed', 'failed', 'skipped']), '"passed", "failed" or "skipped"'),
      steps: required(Array.isArray, 'an array'),
      failedStep: optional(oneOf(ROLLBACK_STEPS), '"up", "down" or "up-again"'),
      error: optional(isFailure, 'an object with a message'),
      reason: optional(isString, 'a string'),
    });
    result.steps.forEach((step, stepIndex) => {
      checkFields(command, `result ${index}.steps ${stepIndex}`, step, {
        step: required(oneOf(ROLLBACK_STEPS), '"up", "down" or "up-again"'),
        status: required(oneOf(['passed', 'failed']), '"passed" or "failed"'),
        duration: required(isNumber, 'a number'),
      });
    });
  });
  return report;
}

/** Parse `mmk lint --json` */
export function parseLintReport(value: unknown): LintReport {
  const report = checkFields<LintReport>('lint', 'the output', value, {
    files: required(isStringArray, 'an array of strings'),
    findings: required(Array.isArray, 'an array'),
    errors: required(isNumber, 'a number'),
    warnings: required(isNumber, 'a number'),
  });
  report.findings.forEach((finding, index) => {
    checkFields('lint', `finding ${index}`, finding, {
      file: required(isString, 'a string'),
      line: required(isPositiveInteger, 'a line number'),
      column: required(isPositiveInteger, 'a column number'),
      endLine: required(isPositiveInteger, 'a line number'),
      endColumn: required(isPositiveInteger, 'a column number'),
      rule: required(isString, 'a string'),
      severity: required(oneOf(['error', 'warning']), '"error" or "warning"'),
      message: required(isString, 'a string'),
    });
  });
  return report;
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
const isPositiveInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;
const ROLLBACK_STEPS: readonly RollbackStep[] = ['up', 'down', 'up-again'];
const isFailure = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.message === 'string' &&
  (value.code === undefined || typeof value.code === 'string') &&
  (value.cause === undefined || typeof value.cause === 'string') &&
  (value.location === undefined || typeof value.location === 'string');
const isSha256 = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
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
  checksum: optional(isSha256, 'a SHA-256 hex string'),
  description: optional(isString, 'a string'),
  author: optional(isString, 'a string'),
  namespace: optional(isString, 'a string'),
  fileMissing: optional(isBoolean, 'true or false'),
  unadopted: optional(isBoolean, 'true or false'),
} satisfies Record<keyof StatusRow | 'checksum', FieldRule>;

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

const PROJECT_CONFIG_RULES = {
  migrationsDir: required(isString, 'a string'),
  fileExtensions: required(isStringArray, 'an array of strings'),
  createExtension: required(oneOf(Object.keys(MIGRATION_EXTENSIONS)), '"js" or "ts"'),
  sequential: required(isBoolean, 'true or false'),
  namespace: optional(isString, 'a string'),
  dbName: required(nullable(isString), 'a string or null'),
  uri: required(nullable(isString), 'a string or null'),
} satisfies Record<keyof ProjectConfig, FieldRule>;

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
