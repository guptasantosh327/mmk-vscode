import type { WireStatusRow } from './contract.js';
import type { Environment } from './environments.js';
import { displayName } from './naming.js';

/**
 * One cell of the matrix: what mmk's status row for a file says on one environment.
 * - `applied` / `edited`: applied, and the file matches (or no longer matches) its checksum
 * - `no-file`: applied there, but the file isn't in the files being compared (`fileMissing`)
 * - `pending`: not applied there
 * - `unadopted`: applied before the repo had a namespace (needs `mmk namespace adopt`)
 * - `none`: no file and no record there
 * - `unknown`: the environment couldn't be read
 */
export type CellState =
  | { kind: 'applied' | 'edited' | 'no-file'; appliedAt: string | null; batch: number | null }
  | { kind: 'pending' | 'unadopted' | 'none' | 'unknown' };

/** One environment's column, and whether it could be read */
export interface MatrixColumn {
  name: string;
  readOnly: boolean;
  local: boolean;
  /** `ok`, or why there are no rows */
  state: 'ok' | 'error' | 'not-set-up' | 'loading';
  /** mmk's message when `state` is `error` */
  message?: string;
  /** Where it's read from (`host/db`), for the header tooltip */
  database: string | null;
}

/** One file (or record) across every environment */
export interface MatrixRow {
  /** The file name as mmk names it */
  file: string;
  /** The name without its timestamp, for display */
  label: string;
  /** The `YYYYMMDDHHmmss` prefix, or null */
  stamp: string | null;
  cells: Record<string, CellState>;
  /** e.g. "On staging, not prod", "Only on local so far"; empty when every environment agrees */
  note: string;
  /** True when the environments don't all agree, or something needs attention */
  differs: boolean;
  /** False when no environment has the file in the files being compared */
  inFiles: boolean;
}

/** The whole matrix */
export interface MatrixModel {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  /** Summary chips: "staging has 2 that prod doesn't", "1 edited after it ran" */
  summary: string[];
}

/** What the matrix needs from one environment */
export interface MatrixInput {
  environment: Environment;
  rows: readonly WireStatusRow[] | null;
  state: MatrixColumn['state'];
  message?: string;
  database: string | null;
}

const APPLIED_KINDS = new Set<CellState['kind']>(['applied', 'edited', 'no-file']);

/**
 * Lay out each environment's `mmk status` rows side by side. Every cell is mmk's own verdict
 * for that file on that database; the notes only compare those verdicts across environments.
 */
export function buildMatrix(
  inputs: readonly MatrixInput[],
  /** What the files are, for the notes: `your branch`, or a ref such as `origin/main` */
  filesLabel = 'your branch',
): MatrixModel {
  const notIn = filesLabel === 'your branch' ? 'not in your branch' : `not on ${filesLabel}`;
  const columns: MatrixColumn[] = inputs.map((input) => ({
    name: input.environment.name,
    readOnly: input.environment.readOnly,
    local: input.environment.local,
    state: input.state,
    ...(input.message === undefined ? {} : { message: input.message }),
    database: input.database,
  }));
  const readable = inputs.filter((input) => input.state === 'ok' && input.rows !== null);

  const files = new Set<string>();
  for (const input of readable) {
    for (const row of input.rows ?? []) {
      files.add(row.file);
    }
  }

  const rows = [...files].sort().map((file): MatrixRow => {
    const cells: Record<string, CellState> = {};
    let inFiles = false;
    for (const input of inputs) {
      const row =
        input.state === 'ok' ? input.rows?.find((candidate) => candidate.file === file) : undefined;
      if (row && !row.fileMissing) {
        inFiles = true;
      }
      cells[input.environment.name] =
        input.state !== 'ok' || input.rows === null ? { kind: 'unknown' } : cellFor(row);
    }
    const shown = displayName(file);
    const stamp = /^(\d{14})-/.exec(file)?.[1] ?? null;
    const note = noteFor(inputs, cells, inFiles, notIn);
    return { file, label: shown.label, stamp, cells, note, differs: note !== '', inFiles };
  });

  return { columns, rows, summary: summarize(inputs, rows, notIn) };
}

function cellFor(row: WireStatusRow | undefined): CellState {
  if (!row) {
    return { kind: 'none' };
  }
  if (row.unadopted) {
    return { kind: 'unadopted' };
  }
  if (row.status === 'pending') {
    return { kind: 'pending' };
  }
  const kind = row.fileMissing ? 'no-file' : row.checksumOk === false ? 'edited' : 'applied';
  return { kind, appliedAt: row.appliedAt, batch: row.batch };
}

/** Names of the environments whose cell for a row is one of `kinds`, in column order */
function namesWhere(
  inputs: readonly MatrixInput[],
  cells: Record<string, CellState>,
  test: (cell: CellState) => boolean,
): MatrixInput[] {
  return inputs.filter((input) => {
    const cell = cells[input.environment.name];
    return cell !== undefined && test(cell);
  });
}

function noteFor(
  inputs: readonly MatrixInput[],
  cells: Record<string, CellState>,
  inFiles: boolean,
  notIn: string,
): string {
  const applied = namesWhere(inputs, cells, (cell) => APPLIED_KINDS.has(cell.kind));
  const edited = namesWhere(inputs, cells, (cell) => cell.kind === 'edited');
  const unadopted = namesWhere(inputs, cells, (cell) => cell.kind === 'unadopted');
  const pending = namesWhere(inputs, cells, (cell) => cell.kind === 'pending');

  if (edited.length > 0) {
    return edited.length === applied.length
      ? 'Edited after it ran'
      : `Edited after it ran on ${list(edited)}`;
  }
  if (!inFiles) {
    return applied.length > 0 ? `Applied on ${list(applied)}, file ${notIn}` : '';
  }
  if (unadopted.length > 0) {
    return `Needs mmk namespace adopt on ${list(unadopted)}`;
  }
  if (applied.length === 0 || pending.length === 0) {
    return '';
  }
  const appliedRemote = applied.filter((input) => !input.environment.local);
  const pendingRemote = pending.filter((input) => !input.environment.local);
  if (appliedRemote.length === 0) {
    return `Only on ${list(applied)} so far`;
  }
  if (pendingRemote.length > 0) {
    return `On ${list(appliedRemote)}, not ${list(pendingRemote, 'or')}`;
  }
  return `Not on ${list(pending)} yet`;
}

function summarize(
  inputs: readonly MatrixInput[],
  rows: readonly MatrixRow[],
  notIn: string,
): string[] {
  const summary: string[] = [];
  const isApplied = (row: MatrixRow, name: string): boolean =>
    APPLIED_KINDS.has(row.cells[name]?.kind ?? 'unknown');
  const isPending = (row: MatrixRow, name: string): boolean => row.cells[name]?.kind === 'pending';
  const readable = inputs.filter((input) => input.state === 'ok');
  const remote = readable.filter((input) => !input.environment.local);
  const local = readable.find((input) => input.environment.local);

  for (const ahead of remote) {
    for (const behind of remote) {
      if (ahead === behind) {
        continue;
      }
      const count = rows.filter(
        (row) => isApplied(row, ahead.environment.name) && isPending(row, behind.environment.name),
      ).length;
      if (count > 0) {
        summary.push(
          `${ahead.environment.name} has ${count} that ${behind.environment.name} doesn't`,
        );
      }
    }
  }
  if (local) {
    for (const other of remote) {
      const count = rows.filter(
        (row) => isPending(row, local.environment.name) && isApplied(row, other.environment.name),
      ).length;
      if (count > 0) {
        summary.push(
          `${local.environment.name} is missing ${count} that ${other.environment.name} has`,
        );
      }
    }
    const onlyLocal = rows.filter(
      (row) =>
        isApplied(row, local.environment.name) &&
        remote.length > 0 &&
        remote.every((other) => isPending(row, other.environment.name)),
    ).length;
    if (onlyLocal > 0) {
      summary.push(`${onlyLocal} ${onlyLocal === 1 ? 'has' : 'have'} run only on local`);
    }
  }
  const edited = rows.filter((row) =>
    Object.values(row.cells).some((cell) => cell.kind === 'edited'),
  ).length;
  if (edited > 0) {
    summary.push(`${edited} edited after it ran`);
  }
  const notInFiles = rows.filter((row) => !row.inFiles).length;
  if (notInFiles > 0) {
    summary.push(`${notInFiles} applied, file ${notIn}`);
  }
  return summary;
}

/** `a`, `a and b`, `a, b and c` (or `or`) */
function list(inputs: readonly MatrixInput[], word: 'and' | 'or' = 'and'): string {
  const names = inputs.map((input) => input.environment.name);
  if (names.length <= 1) {
    return names[0] ?? '';
  }
  return `${names.slice(0, -1).join(', ')} ${word} ${names.at(-1)}`;
}
