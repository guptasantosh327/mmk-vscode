import type { WireStatusRow } from './contract.js';
import type { Environment } from './environments.js';
import type { CellState, MatrixColumn, MatrixModel, MatrixRow } from './matrix.js';
import { buildStatusModel, formatDuration, formatWhen } from './model.js';

/** The console's filters (design C1) */
export type ConsoleFilter = 'all' | 'pending' | 'attention' | 'diff';

/** Every filter, in the order the console shows them */
export const CONSOLE_FILTERS: readonly ConsoleFilter[] = ['all', 'pending', 'attention', 'diff'];

/** What the console can run on the selected migration: each is an existing `mmk.*` command */
export type ConsoleAction = 'up' | 'dryRun' | 'down' | 'redo' | 'showAppliedVersion';

/** Every action, for checking messages */
const CONSOLE_ACTIONS: readonly ConsoleAction[] = [
  'up',
  'dryRun',
  'down',
  'redo',
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
  | { type: 'copy' }
  | { type: 'open'; file: string }
  | { type: 'create' }
  | { type: 'plan' }
  | { type: 'applyAll' }
  | { type: 'addEnvironment' };

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
    case 'ready':
    case 'refresh':
    case 'copy':
    case 'create':
    case 'plan':
    case 'applyAll':
    case 'addEnvironment':
      return true;
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
  now?: Date;
}

/** One environment tab */
export interface ConsoleTab {
  name: string;
  readOnly: boolean;
  selected: boolean;
  state: MatrixColumn['state'];
  pending: number;
  attention: number;
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

/** A line above the table when something needs saying */
export interface ConsoleNotice {
  kind: 'edited' | 'read-only';
  text: string;
  /** The file *Review it* picks, for `edited` */
  file?: string;
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
  notice: ConsoleNotice | null;
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
      readOnly: environment.readOnly,
      selected: environment.name === name,
      state: column?.state ?? 'loading',
      pending: input.matrix.rows.filter((row) => kindOn(row, environment.name) === 'pending')
        .length,
      attention: input.matrix.rows.filter((row) =>
        ATTENTION_KINDS.has(kindOn(row, environment.name)),
      ).length,
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
  return {
    tabs,
    chips,
    rows,
    detail: picked ? detailFor(picked, input, name, readOnly, records, now) : null,
    batches: batchesOn(input.rows[name] ?? null, picked?.file ?? null, now),
    pending,
    readOnly,
    notice: noticeFor(input.matrix.rows, name, readOnly, kindOn),
  };
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
): ConsoleDetail {
  const kind = row.cells[environment]?.kind ?? 'unknown';
  const record = records.get(row.file);
  const actions = actionsFor(row, kind, environment, readOnly, input.filesAreLocal);
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

/** The buttons, the note under them and the CLI command, for one migration on one environment */
function actionsFor(
  row: MatrixRow,
  kind: CellState['kind'],
  environment: string,
  readOnly: boolean,
  filesAreLocal: boolean,
): Pick<ConsoleDetail, 'buttons' | 'note' | 'cli'> {
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

function noticeFor(
  rows: readonly MatrixRow[],
  environment: string,
  readOnly: boolean,
  kindOn: (row: MatrixRow, environment: string) => CellState['kind'],
): ConsoleNotice | null {
  if (readOnly) {
    return {
      kind: 'read-only',
      text: `${environment} is read-only. The extension only runs status, list and dry-run there; deploys go through CI.`,
    };
  }
  const edited = rows.filter((row) => kindOn(row, environment) === 'edited');
  const first = edited[0];
  if (!first) {
    return null;
  }
  const cell = first.cells[environment];
  const batch = cell && 'batch' in cell && cell.batch !== null ? ` in batch ${cell.batch}` : '';
  return {
    kind: 'edited',
    file: first.file,
    text:
      edited.length === 1
        ? `${first.label} was edited after it ran on ${environment}${batch}. mmk won't roll it back until it matches again.`
        : `${edited.length} migrations were edited after they ran on ${environment}. mmk won't roll them back until they match again.`,
  };
}

function when(iso: string, now: Date): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : formatWhen(date, now);
}
