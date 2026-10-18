import type { RunResult } from 'mongo-migrate-kit';
import type { Wire, WireStatusRow } from './contract.js';
import {
  ENVIRONMENT_HUES,
  type Environment,
  type EnvironmentHue,
  environmentHue,
} from './environments.js';
import type { HeldLock } from './lock-holder.js';
import type { CellState, MatrixColumn, MatrixModel, MatrixRow } from './matrix.js';
import { buildStatusModel, formatDuration, formatWhen } from './model.js';
import { displayName } from './naming.js';

/** The console's filters (design C1) */
export type ConsoleFilter = 'all' | 'pending' | 'attention' | 'diff';

/** Every filter, in the order the console shows them */
export const CONSOLE_FILTERS: readonly ConsoleFilter[] = ['all', 'pending', 'attention', 'diff'];

/** What the console can run on the selected migration: each is an existing `mmk.*` command */
export type ConsoleAction = 'up' | 'dryRun' | 'down' | 'redo' | 'downBatch' | 'showAppliedVersion';

/** Every action, for checking messages */
const CONSOLE_ACTIONS: readonly ConsoleAction[] = [
  'up',
  'dryRun',
  'down',
  'redo',
  'downBatch',
  'showAppliedVersion',
];

/** Messages the console's webview sends. Anything else is ignored */
export type ConsoleMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'source'; value: 'branch' | 'ref' }
  | { type: 'filter'; value: ConsoleFilter }
  | { type: 'environment'; name: string }
  | { type: 'pick'; file: string }
  | { type: 'action'; action: ConsoleAction }
  | { type: 'copy'; what?: 'plan' | 'lock' }
  | { type: 'open'; file: string }
  | { type: 'create' }
  | { type: 'plan' }
  | { type: 'addEnvironment' }
  | { type: 'applyPlan' }
  | { type: 'closeDrawer' }
  | { type: 'rollBack'; batch: number }
  | { type: 'unlock' }
  /** Open the dialog for an environment: the selected one unless it names another */
  | { type: 'editEnvironment'; name?: string }
  | { type: 'removeEnvironment' }
  | { type: 'showOutput' }
  | { type: 'dismissNotice' }
  | { type: 'closeDialog' }
  | { type: 'testEnvironment'; name: string; uri: string; dbName: string }
  | {
      type: 'saveEnvironment';
      name: string;
      uri: string;
      dbName: string;
      readOnly: boolean;
      /** null: the default colour for its name */
      color: EnvironmentHue | null;
      /** Save even though the connection test failed */
      force: boolean;
    };

/** Longest name, database and connection string the add dialog sends */
const MAX_FIELD = 200;
const MAX_URI = 4096;

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/**
 * True for a message the console's webview may send, checked field by field: the webview draws
 * file names and descriptions from the project, so nothing it sends is taken on trust.
 */
export function isConsoleMessage(value: unknown): value is ConsoleMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'copy':
      return message.what === undefined || message.what === 'plan' || message.what === 'lock';
    case 'ready':
    case 'refresh':
    case 'create':
    case 'plan':
    case 'addEnvironment':
    case 'applyPlan':
    case 'closeDrawer':
    case 'unlock':
    case 'showOutput':
    case 'dismissNotice':
    case 'closeDialog':
    case 'removeEnvironment':
      return true;
    case 'editEnvironment':
      return message.name === undefined || isText(message.name, MAX_FIELD);
    case 'testEnvironment':
      return (
        isText(message.name, MAX_FIELD) &&
        isText(message.uri, MAX_URI) &&
        isText(message.dbName, MAX_FIELD)
      );
    case 'saveEnvironment':
      return (
        isText(message.name, MAX_FIELD) &&
        isText(message.uri, MAX_URI) &&
        isText(message.dbName, MAX_FIELD) &&
        typeof message.readOnly === 'boolean' &&
        typeof message.force === 'boolean' &&
        (message.color === null || ENVIRONMENT_HUES.some((hue) => hue === message.color))
      );
    case 'rollBack':
      return (
        typeof message.batch === 'number' && Number.isInteger(message.batch) && message.batch > 0
      );
    case 'source':
      return message.value === 'branch' || message.value === 'ref';
    case 'filter':
      return CONSOLE_FILTERS.some((filter) => filter === message.value);
    case 'environment':
      return typeof message.name === 'string';
    case 'pick':
    case 'open':
      return typeof message.file === 'string';
    case 'action':
      return CONSOLE_ACTIONS.some((action) => action === message.action);
    default:
      return false;
  }
}

/** What the console is built from */
export interface ConsoleInput {
  /** Every environment's verdicts side by side (`buildMatrix`) */
  matrix: MatrixModel;
  /** The environments, `local` first */
  environments: readonly Environment[];
  /** The selected environment's name: the one every command acts on */
  selected: string;
  filter: ConsoleFilter;
  /** The migration the user picked, or null for the default */
  picked: string | null;
  /** Each environment's status rows (the same ones as the matrix), for descriptions and batches */
  rows: Readonly<Record<string, readonly WireStatusRow[] | null>>;
  /** False when the files compared are a ref's copy: nothing runs on those */
  filesAreLocal: boolean;
  /** Each environment's lock (`environmentLocks`), by name */
  locks?: Readonly<Record<string, HeldLock | null>>;
  /** Notices the user dismissed (`editedKey`): an edited migration's, until it runs again */
  dismissed?: ReadonlySet<string>;
  now?: Date;
}

/** One environment tab */
export interface ConsoleTab {
  name: string;
  /** Its colour, from `mmk.environments` or its default */
  hue: EnvironmentHue;
  readOnly: boolean;
  selected: boolean;
  state: MatrixColumn['state'];
  pending: number;
  attention: number;
  /** `Locked by …` when another run holds its migration lock, else empty */
  lock: string;
}

/** One filter chip */
export interface ConsoleChip {
  id: ConsoleFilter;
  label: string;
  count: number;
  active: boolean;
}

/** One cell of a row: mmk's verdict for the file on one environment, in words */
export interface ConsoleCell {
  environment: string;
  kind: CellState['kind'];
  text: string;
}

/** One migration in the table */
export interface ConsoleRow {
  file: string;
  label: string;
  stamp: string;
  description: string;
  cells: ConsoleCell[];
  /** When it ran on the selected environment, or `—` */
  last: string;
  /** The matrix's note ("On staging, not prod"), shown with *Only differences* */
  note: string;
  inFiles: boolean;
  picked: boolean;
}

/** The picked migration's record on one environment */
export interface ConsoleRecord {
  environment: string;
  kind: CellState['kind'];
  text: string;
  extra: string;
  selected: boolean;
}

/** One button in the detail panel */
export interface ConsoleButton {
  action: ConsoleAction;
  label: string;
  primary: boolean;
  /** The batch `downBatch` rolls back */
  batch?: number;
  /** Why it can't run now (another run holds the lock), shown greyed out with this as its title */
  disabled?: string;
}

/** The picked migration */
export interface ConsoleDetail {
  file: string;
  label: string;
  description: string;
  author: string;
  inFiles: boolean;
  records: ConsoleRecord[];
  buttons: ConsoleButton[];
  note: string;
  /** The mmk arguments of the equivalent CLI command */
  cli: string[];
}

/** One batch on the selected environment */
export interface ConsoleBatch {
  batch: number;
  title: string;
  meta: string;
  picked: boolean;
}

/** What a notice's buttons do */
export type NoticeAction = 'review' | 'dismiss' | 'retry' | 'editEnvironment' | 'showOutput';

/** A line above the table when something needs saying; several can show at once */
export interface ConsoleNotice {
  kind: 'edited' | 'unreadable' | 'not-set-up';
  text: string;
  /** mmk's own message, shown as is (`unreadable`) */
  detail?: string;
  /** The file *Review it* picks, for `edited` */
  file?: string;
  /** What *Dismiss* hides (`editedKey`s), for `edited` */
  dismiss?: string[];
  actions: NoticeAction[];
}

/** The line under the tabs: the selected environment, and another run's lock on it (design A) */
export interface ConsoleEnvironment {
  name: string;
  readOnly: boolean;
  /** Where it's read from (`host/db`), when known */
  database: string;
  /** `Last run 10:40`, `Nothing has run here yet`, or empty when it couldn't be read */
  lastRun: string;
  /** Another run's lock on it, when mmk reports one in force */
  lock: HeldLock | null;
  /** Writable, so *Release…* is offered (mmk.unlock asks first, naming the holder) */
  canRelease: boolean;
}

/** Everything the console shows */
export interface ConsoleModel {
  tabs: ConsoleTab[];
  chips: ConsoleChip[];
  rows: ConsoleRow[];
  detail: ConsoleDetail | null;
  /** The selected environment's latest batches, oldest first */
  batches: ConsoleBatch[];
  /** Pending on the selected environment */
  pending: number;
  readOnly: boolean;
  environment: ConsoleEnvironment;
  notices: ConsoleNotice[];
}

const APPLIED_KINDS = new Set<CellState['kind']>(['applied', 'edited', 'no-file']);
const ATTENTION_KINDS = new Set<CellState['kind']>(['edited', 'no-file', 'unadopted']);
const SHOWN_BATCHES = 3;

/**
 * Lay out the console. Every verdict is mmk's (each environment's `status` rows, through the
 * matrix); this only picks what to show and which existing commands to offer for it.
 */
export function buildConsole(input: ConsoleInput): ConsoleModel {
  const now = input.now ?? new Date();
  const selected =
    input.environments.find((environment) => environment.name === input.selected) ??
    input.environments[0];
  const name = selected?.name ?? input.selected;
  const readOnly = selected?.readOnly ?? false;
  const kindOn = (row: MatrixRow, environment: string): CellState['kind'] =>
    row.cells[environment]?.kind ?? 'unknown';

  const tests: Record<ConsoleFilter, (row: MatrixRow) => boolean> = {
    all: () => true,
    pending: (row) => kindOn(row, name) === 'pending',
    attention: (row) => ATTENTION_KINDS.has(kindOn(row, name)),
    diff: (row) => row.differs,
  };
  const visible = input.matrix.rows.filter(tests[input.filter]);
  const picked = pickRow(visible, input.picked, (row) => kindOn(row, name) === 'pending');
  const records = recordsByFile(input.rows);

  const rows = visible.map((row): ConsoleRow => {
    const cell = row.cells[name];
    return {
      file: row.file,
      label: row.label,
      stamp: row.stamp ?? '',
      description: records.get(row.file)?.description ?? '',
      cells: input.matrix.columns.map((column) => ({
        environment: column.name,
        kind: kindOn(row, column.name),
        text: cellText(row.cells[column.name]),
      })),
      last: cell && 'appliedAt' in cell && cell.appliedAt ? when(cell.appliedAt, now) : '—',
      note: row.note,
      inFiles: row.inFiles,
      picked: row === picked,
    };
  });

  const tabs = input.environments.map((environment): ConsoleTab => {
    const column = input.matrix.columns.find((candidate) => candidate.name === environment.name);
    return {
      name: environment.name,
      hue: environmentHue(environment.color),
      readOnly: environment.readOnly,
      selected: environment.name === name,
      state: column?.state ?? 'loading',
      pending: input.matrix.rows.filter((row) => kindOn(row, environment.name) === 'pending')
        .length,
      attention: input.matrix.rows.filter((row) =>
        ATTENTION_KINDS.has(kindOn(row, environment.name)),
      ).length,
      lock: input.locks?.[environment.name]?.summary ?? '',
    };
  });

  const labels: Record<ConsoleFilter, string> = {
    all: 'All',
    pending: 'Pending',
    attention: 'Needs attention',
    diff: 'Only differences',
  };
  const chips = CONSOLE_FILTERS.map(
    (id): ConsoleChip => ({
      id,
      label: labels[id],
      count: input.matrix.rows.filter(tests[id]).length,
      active: id === input.filter,
    }),
  );

  const pending = tabs.find((tab) => tab.selected)?.pending ?? 0;
  const lock = input.locks?.[name] ?? null;
  const column = input.matrix.columns.find((candidate) => candidate.name === name);
  return {
    tabs,
    chips,
    rows,
    detail: picked ? detailFor(picked, input, name, readOnly, records, now, lock) : null,
    batches: batchesOn(input.rows[name] ?? null, picked?.file ?? null, now),
    pending,
    readOnly,
    environment: {
      name,
      readOnly,
      database: column?.database ?? '',
      lastRun: lastRunOn(column?.state === 'ok' ? (input.rows[name] ?? null) : null, now),
      lock,
      canRelease: lock !== null && !readOnly,
    },
    notices: noticesFor(input.matrix, name, kindOn, input.dismissed ?? new Set()),
  };
}

/** `Last run 10:40` from an environment's latest batch, `Nothing has run here yet`, or empty */
function lastRunOn(rows: readonly WireStatusRow[] | null, now: Date): string {
  if (!rows) {
    return '';
  }
  const latest = buildStatusModel(rows).batches[0];
  if (!latest) {
    return 'Nothing has run here yet';
  }
  return latest.appliedAt ? `Last run ${formatWhen(latest.appliedAt, now)}` : '';
}

/**
 * What *Dismiss* remembers for an edited migration: that record on that environment. A new run
 * of it is a new record, so its notice shows again.
 */
export function editedKey(environment: string, file: string, appliedAt: string | null): string {
  return `${environment}\u0000${file}\u0000${appliedAt ?? ''}`;
}

/** The {@link editedKey} of every migration edited after it ran, on any environment */
export function editedKeys(matrix: MatrixModel): Set<string> {
  const keys = new Set<string>();
  for (const row of matrix.rows) {
    for (const [environment, cell] of Object.entries(row.cells)) {
      if (cell.kind === 'edited') {
        keys.add(editedKey(environment, row.file, cell.appliedAt));
      }
    }
  }
  return keys;
}

/** The row the user picked if it's shown, else the first one `preferred` likes, else the first */
function pickRow(
  rows: readonly MatrixRow[],
  file: string | null,
  preferred: (row: MatrixRow) => boolean,
): MatrixRow | undefined {
  return rows.find((row) => row.file === file) ?? rows.find(preferred) ?? rows[0];
}

/** The first status row mmk reported for each file, on any environment */
function recordsByFile(
  rows: Readonly<Record<string, readonly WireStatusRow[] | null>>,
): Map<string, WireStatusRow> {
  const byFile = new Map<string, WireStatusRow>();
  for (const list of Object.values(rows)) {
    for (const row of list ?? []) {
      const known = byFile.get(row.file);
      if (!known || (!known.description && row.description)) {
        byFile.set(row.file, row);
      }
    }
  }
  return byFile;
}

function detailFor(
  row: MatrixRow,
  input: ConsoleInput,
  environment: string,
  readOnly: boolean,
  records: Map<string, WireStatusRow>,
  now: Date,
  lock: HeldLock | null,
): ConsoleDetail {
  const cell: CellState = row.cells[environment] ?? { kind: 'unknown' };
  const record = records.get(row.file);
  const actions = waitForLock(
    actionsFor(row, cell, environment, readOnly, input.filesAreLocal),
    environment,
    readOnly,
    lock,
  );
  return {
    file: row.file,
    label: row.label,
    description: record?.description ?? '',
    author: record?.author ?? '',
    inFiles: row.inFiles,
    records: input.matrix.columns.map((column): ConsoleRecord => {
      const cell = row.cells[column.name] ?? { kind: 'unknown' };
      const status = input.rows[column.name]?.find((candidate) => candidate.file === row.file);
      return {
        environment: column.name,
        kind: cell.kind,
        text: recordText(cell),
        extra: recordExtra(cell, status, column.readOnly, now),
        selected: column.name === environment,
      };
    }),
    ...actions,
  };
}

/** The actions that take the migration lock, so they can't run while another run holds it */
const LOCKING_ACTIONS = new Set<ConsoleAction>(['up', 'down', 'redo', 'downBatch']);

/**
 * While another run holds a writable environment's lock, its run buttons stay visible but greyed
 * out, saying why (design A). *Plan* and *Show applied version* still work: they don't take it.
 */
function waitForLock(
  actions: Pick<ConsoleDetail, 'buttons' | 'note' | 'cli'>,
  environment: string,
  readOnly: boolean,
  lock: HeldLock | null,
): Pick<ConsoleDetail, 'buttons' | 'note' | 'cli'> {
  if (!lock || readOnly || !actions.buttons.some((button) => LOCKING_ACTIONS.has(button.action))) {
    return actions;
  }
  const reason = `${environment} is locked by ${lock.who}`;
  return {
    ...actions,
    buttons: actions.buttons.map((button) =>
      LOCKING_ACTIONS.has(button.action) ? { ...button, disabled: reason } : button,
    ),
    note: `Runs wait for the lock: ${lock.who} has held it since ${lock.since}. Plan still works; it doesn't take the lock.`,
  };
}

/** The buttons, the note under them and the CLI command, for one migration on one environment */
function actionsFor(
  row: MatrixRow,
  cell: CellState,
  environment: string,
  readOnly: boolean,
  filesAreLocal: boolean,
): Pick<ConsoleDetail, 'buttons' | 'note' | 'cli'> {
  const { kind } = cell;
  const status = { buttons: [], cli: ['status'] };
  if (!filesAreLocal) {
    return {
      ...status,
      note: 'These are the files on another branch: switch Files to your branch to run one.',
    };
  }
  if (!row.inFiles) {
    return {
      ...status,
      note: "Its file isn't in your branch, so there's nothing to run from here.",
    };
  }
  if (readOnly) {
    const preview = APPLIED_KINDS.has(kind) ? 'down' : 'up';
    return {
      buttons:
        kind === 'pending'
          ? [{ action: 'dryRun', label: `Plan on ${environment}`, primary: false }]
          : [],
      note: `${environment} is read-only: the extension only runs status, list and dry-run there. Deploys go through CI.`,
      cli: ['dry-run', preview, row.file],
    };
  }
  switch (kind) {
    case 'pending':
      return {
        buttons: [
          { action: 'up', label: `Run up on ${environment}`, primary: true },
          { action: 'dryRun', label: 'Plan', primary: false },
        ],
        note: 'Run down is offered once up has run here.',
        cli: ['up', row.file],
      };
    case 'applied':
      return {
        buttons: [
          { action: 'down', label: 'Run down…', primary: false },
          { action: 'redo', label: 'Redo…', primary: false },
          ...('batch' in cell && cell.batch !== null
            ? [
                {
                  action: 'downBatch' as const,
                  label: `Roll back batch ${cell.batch}…`,
                  primary: false,
                  batch: cell.batch,
                },
              ]
            : []),
        ],
        note: 'Each one asks before it runs.',
        cli: ['down', row.file],
      };
    case 'edited':
      return {
        buttons: [
          { action: 'showAppliedVersion', label: 'Show applied version', primary: false },
          { action: 'down', label: 'Run down…', primary: false },
        ],
        note: 'The file changed after it ran. mmk refuses to roll it back unless you force it, so compare it first.',
        cli: ['down', row.file],
      };
    case 'unadopted':
      return {
        ...status,
        note: `It ran on ${environment} before this repo had a namespace: run mmk namespace adopt first.`,
      };
    case 'unknown':
      return { ...status, note: `${environment} couldn't be read.` };
    default:
      return { ...status, note: `Nothing to run on ${environment}.` };
  }
}

function cellText(cell: CellState | undefined): string {
  switch (cell?.kind) {
    case 'applied':
      return cell.batch === null ? 'applied' : `batch ${cell.batch}`;
    case 'edited':
      return 'edited';
    case 'no-file':
      return 'no file';
    case 'pending':
      return 'pending';
    case 'unadopted':
      return 'needs adopt';
    case 'none':
      return '—';
    default:
      return '?';
  }
}

function recordText(cell: CellState): string {
  const batch = 'batch' in cell && cell.batch !== null ? ` batch ${cell.batch}` : '';
  switch (cell.kind) {
    case 'applied':
      return `Applied${batch ? ` in${batch}` : ''}`;
    case 'edited':
      return `Edited after${batch || ' it ran'}`;
    case 'no-file':
      return `Applied${batch ? ` in${batch}` : ''}, no file here`;
    case 'pending':
      return 'Pending';
    case 'unadopted':
      return 'Needs mmk namespace adopt';
    case 'none':
      return 'Not here';
    case 'unknown':
      return "Couldn't be read";
  }
}

function recordExtra(
  cell: CellState,
  status: WireStatusRow | undefined,
  readOnly: boolean,
  now: Date,
): string {
  if (cell.kind === 'pending') {
    return readOnly ? 'deploys through CI' : '';
  }
  if (!APPLIED_KINDS.has(cell.kind) || !('appliedAt' in cell)) {
    return '';
  }
  const parts = [
    cell.appliedAt ? when(cell.appliedAt, now) : '',
    status?.duration === null || status?.duration === undefined
      ? ''
      : formatDuration(status.duration),
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The latest batches on an environment, oldest first, from its own status rows */
function batchesOn(
  rows: readonly WireStatusRow[] | null,
  pickedFile: string | null,
  now: Date,
): ConsoleBatch[] {
  if (!rows) {
    return [];
  }
  return buildStatusModel(rows)
    .batches.slice(0, SHOWN_BATCHES)
    .reverse()
    .map((group): ConsoleBatch => {
      const total = group.rows.reduce((sum, row) => sum + (row.duration ?? 0), 0);
      const count = `${group.rows.length} ${group.rows.length === 1 ? 'migration' : 'migrations'}`;
      return {
        batch: group.batch,
        title: `Batch ${group.batch}`,
        meta: [
          group.appliedAt ? formatWhen(group.appliedAt, now) : '',
          count,
          formatDuration(total),
        ]
          .filter(Boolean)
          .join(' · '),
        picked: group.rows.some((row) => row.file === pickedFile),
      };
    });
}

/**
 * The notices above the table, all at once. An environment that can't be read says only that.
 * The lock isn't one: it's on the environment line. Read-only isn't either: the line says it.
 */
function noticesFor(
  matrix: MatrixModel,
  environment: string,
  kindOn: (row: MatrixRow, environment: string) => CellState['kind'],
  dismissed: ReadonlySet<string>,
): ConsoleNotice[] {
  const column = matrix.columns.find((candidate) => candidate.name === environment);
  if (column?.state === 'error') {
    return [
      {
        kind: 'unreadable',
        text: `Couldn't read ${environment}. mmk said:`,
        detail: column.message ?? '',
        actions: column.local
          ? ['retry', 'showOutput']
          : ['retry', 'editEnvironment', 'showOutput'],
      },
    ];
  }
  if (column?.state === 'not-set-up') {
    return [
      {
        kind: 'not-set-up',
        text: `${environment} isn't set up for this project: it has no connection string in your keychain yet.`,
        actions: ['editEnvironment'],
      },
    ];
  }
  const keyOf = (row: MatrixRow): string => {
    const cell = row.cells[environment];
    return editedKey(environment, row.file, cell && 'appliedAt' in cell ? cell.appliedAt : null);
  };
  const edited = matrix.rows.filter(
    (row) => kindOn(row, environment) === 'edited' && !dismissed.has(keyOf(row)),
  );
  const first = edited[0];
  if (!first) {
    return [];
  }
  const cell = first.cells[environment];
  const batch = cell && 'batch' in cell && cell.batch !== null ? ` in batch ${cell.batch}` : '';
  return [
    {
      kind: 'edited',
      file: first.file,
      dismiss: edited.map(keyOf),
      actions: ['review', 'dismiss'],
      text:
        edited.length === 1
          ? `${first.label} was edited after it ran on ${environment}${batch}. mmk won't roll it back until it matches again.`
          : `${edited.length} migrations were edited after they ran on ${environment}. mmk won't roll them back until they match again.`,
    },
  ];
}

function when(iso: string, now: Date): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : formatWhen(date, now);
}

/** One migration a plan would run */
export interface PlanStep {
  file: string;
  label: string;
  description: string;
  author: string;
}

/** The migrations `dry-run up` says up would apply, in the order mmk would run them */
export function planSteps(rows: readonly WireStatusRow[]): PlanStep[] {
  return rows
    .filter((row) => row.status === 'pending')
    .map((row) => ({
      file: row.file,
      label: displayName(row.file).label,
      description: row.description ?? '',
      author: row.author ?? '',
    }));
}

/** How a run the console started ended: mmk's results, or its failure as is */
export interface RunOutcome {
  /** What mmk reported; on a failure, what ran before it (R10), else nothing */
  results: readonly Wire<RunResult>[];
  /** mmk's failure: its code, its message as is, and the file it names */
  failure: { code: string | null; message: string; file: string | null } | null;
}

/** What the result panel is built from */
export interface ResultInput {
  kind: 'up' | 'downBatch';
  environment: string;
  /** The files the run was about: the plan's, or the batch's (newest first) */
  files: readonly string[];
  /** The batch rolled back, for `downBatch` */
  batch: number | null;
  outcome: RunOutcome;
  /** The environment's status rows, read after the run */
  after: readonly WireStatusRow[] | null;
}

/** One file of a run */
export interface ResultLine {
  file: string;
  label: string;
  state: 'done' | 'failed' | 'not-run';
  text: string;
  duration: string;
}

/** What the result panel offers next */
export type ResultAction = 'open' | 'rollBack' | 'unlock' | 'showOutput' | 'close';

/** The result panel (design C8) */
export interface ConsoleResult {
  kind: 'up' | 'downBatch';
  environment: string;
  ok: boolean;
  title: string;
  subtitle: string;
  lines: ResultLine[];
  /** mmk's failure as is */
  failure: { code: string | null; message: string } | null;
  /** Where the environment stands now, from its status read after the run */
  standing: string;
  actions: ResultAction[];
  /** The file *Open the file* opens: the one mmk says failed */
  openFile: string | null;
  /** The batch *Roll back batch N…* rolls back */
  rollBackBatch: number | null;
}

/**
 * Lay out a run's result: each file's outcome from mmk's results, and when mmk stopped early
 * without listing what ran before (mmk 1.5, before R10), from the status read after the run.
 */
export function buildResult(input: ResultInput): ConsoleResult {
  const { kind, environment, outcome } = input;
  const byFile = new Map(outcome.results.map((result) => [result.file, result]));
  const after = new Map((input.after ?? []).map((row) => [row.file, row]));
  const failedFile = outcome.failure?.file ?? null;

  const lines = input.files.map((file): ResultLine => {
    const label = displayName(file).label;
    const result = byFile.get(file);
    const row = after.get(file);
    if (result && (result.status === 'applied' || result.status === 'reverted')) {
      return {
        file,
        label,
        state: 'done',
        text:
          result.status === 'applied'
            ? `Applied${result.batch === undefined ? '' : ` in batch ${result.batch}`}`
            : 'Rolled back',
        duration: result.duration === undefined ? '' : formatDuration(result.duration),
      };
    }
    if (result?.status === 'skipped') {
      return {
        file,
        label,
        state: 'not-run',
        text: result.reason ? `Skipped: ${result.reason}` : 'Skipped',
        duration: '',
      };
    }
    if (file === failedFile) {
      return {
        file,
        label,
        state: 'failed',
        text: `Failed in ${kind === 'up' ? 'up()' : 'down()'}`,
        duration: '',
      };
    }
    if (row && kind === 'up' && row.status === 'applied') {
      return {
        file,
        label,
        state: 'done',
        text: `Applied in batch ${row.batch ?? '?'}`,
        duration: '',
      };
    }
    if (row && kind === 'downBatch' && row.status === 'pending') {
      return { file, label, state: 'done', text: 'Rolled back', duration: '' };
    }
    return {
      file,
      label,
      state: 'not-run',
      text: kind === 'up' ? 'Still pending' : 'Still applied',
      duration: '',
    };
  });

  const done = lines.filter((line) => line.state === 'done');
  const notRun = lines.filter((line) => line.state !== 'done');
  const total = outcome.results.reduce((sum, result) => sum + (result.duration ?? 0), 0);
  const appliedBatch =
    outcome.results.find((result) => result.status === 'applied')?.batch ??
    done.map((line) => after.get(line.file)?.batch).find((batch) => typeof batch === 'number') ??
    null;

  let title: string;
  if (outcome.failure) {
    title =
      done.length > 0
        ? `Stopped after ${done.length} of ${lines.length} on ${environment}`
        : `Nothing ran on ${environment}`;
  } else if (kind === 'downBatch') {
    title = `Rolled back batch ${input.batch ?? '?'} on ${environment}`;
  } else {
    title =
      done.length > 0
        ? `Applied ${done.length} on ${environment}`
        : `Nothing to apply on ${environment}`;
  }

  const names = (list: readonly ResultLine[]): string => joinNames(list.map((line) => line.label));
  let standing: string;
  if (kind === 'up') {
    standing = [
      done.length > 0
        ? `${names(done)} ${done.length === 1 ? 'is' : 'are'} applied${appliedBatch === null ? '' : ` in batch ${appliedBatch}`}`
        : '',
      notRun.length > 0
        ? `${names(notRun)} ${notRun.length === 1 ? 'is' : 'are'} still pending`
        : '',
    ]
      .filter(Boolean)
      .join('; ');
  } else {
    standing = [
      done.length > 0 ? `${names(done)} ${done.length === 1 ? 'is' : 'are'} pending again` : '',
      notRun.length > 0
        ? `${names(notRun)} ${notRun.length === 1 ? 'is' : 'are'} still applied`
        : '',
    ]
      .filter(Boolean)
      .join('; ');
  }

  const actions: ResultAction[] = [];
  if (outcome.failure?.code === 'LOCK_ALREADY_HELD') {
    actions.push('unlock');
  } else if (failedFile) {
    actions.push('open');
  }
  if (kind === 'up' && done.length > 0 && appliedBatch !== null) {
    actions.push('rollBack');
  }
  actions.push(outcome.failure ? 'showOutput' : 'close');

  return {
    kind,
    environment,
    ok: outcome.failure === null,
    title,
    subtitle:
      outcome.results.length > 0
        ? [
            appliedBatch === null || kind !== 'up' ? '' : `Batch ${appliedBatch}`,
            formatDuration(total),
          ]
            .filter(Boolean)
            .join(' · ')
        : '',
    lines,
    failure: outcome.failure
      ? { code: outcome.failure.code, message: outcome.failure.message }
      : null,
    standing: standing ? `${standing}.` : '',
    actions,
    openFile: failedFile,
    rollBackBatch: kind === 'up' && done.length > 0 ? appliedBatch : null,
  };
}

/** `a`, `a and b`, `a, b and c` */
function joinNames(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
