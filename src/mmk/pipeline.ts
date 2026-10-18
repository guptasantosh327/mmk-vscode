import type { WireStatusRow } from './contract.js';
import type { CellState, MatrixInput, MatrixModel } from './matrix.js';
import { buildMatrix } from './matrix.js';
import { formatDay, formatWhen } from './model.js';
import { displayName } from './naming.js';

/** At most this many pending migrations are listed; the console has the rest */
const SHOWN_PENDING = 5;

/** One environment as a step of the pipeline (design B) */
export interface PipelineStep {
  name: string;
  readOnly: boolean;
  selected: boolean;
  state: 'ok' | 'error' | 'not-set-up' | 'loading';
  /** Where it's read from (`host/db`), when known */
  database: string | null;
  pending: number;
  /** Edited after it ran, applied without a file here, or needing `namespace adopt` */
  attention: number;
  /** The migration applied there last: `name · batch N · when`, or empty */
  latest: string;
  /** What needs saying: mmk's error as is, "not set up", or what needs attention */
  note: string;
  tone: 'none' | 'warning' | 'error';
}

/** One pending migration on the selected environment */
export interface PipelineItem {
  file: string;
  label: string;
  description: string;
  /** From the file name's timestamp, and the author when mmk reported one */
  meta: string;
  /** Its state on every environment, in pipeline order */
  environments: Array<{ name: string; kind: CellState['kind'] }>;
}

/** The pipeline view of one project */
export interface PipelineModel {
  steps: PipelineStep[];
  selected: string;
  readOnly: boolean;
  /** Pending on the selected environment */
  pending: number;
  items: PipelineItem[];
  /** Pending migrations not listed */
  more: number;
}

const ATTENTION_KINDS = new Set<CellState['kind']>(['edited', 'no-file', 'unadopted']);

/**
 * Lay out the pipeline from each environment's `mmk status` rows (through the matrix, so every
 * state is mmk's verdict). The latest migration is the applied row mmk reported with the newest
 * time; nothing here decides what is applied or pending.
 */
export function buildPipeline(
  inputs: readonly MatrixInput[],
  selected: string,
  now: Date = new Date(),
): PipelineModel {
  const matrix: MatrixModel = buildMatrix(inputs);
  const kindOn = (file: string, environment: string): CellState['kind'] =>
    matrix.rows.find((row) => row.file === file)?.cells[environment]?.kind ?? 'unknown';
  const descriptions = new Map<string, WireStatusRow>();
  for (const input of inputs) {
    for (const row of input.rows ?? []) {
      if (
        !descriptions.has(row.file) ||
        (!descriptions.get(row.file)?.description && row.description)
      ) {
        descriptions.set(row.file, row);
      }
    }
  }

  const steps = inputs.map((input): PipelineStep => {
    const name = input.environment.name;
    const pending = matrix.rows.filter((row) => row.cells[name]?.kind === 'pending').length;
    const attention = matrix.rows.filter((row) =>
      ATTENTION_KINDS.has(row.cells[name]?.kind ?? 'unknown'),
    );
    const base = {
      name,
      readOnly: input.environment.readOnly,
      selected: name === selected,
      state: input.state,
      database: input.database,
      pending,
      attention: attention.length,
    };
    if (input.state === 'error') {
      return { ...base, latest: '', note: input.message ?? `Couldn't read ${name}`, tone: 'error' };
    }
    if (input.state === 'not-set-up') {
      return { ...base, latest: '', note: 'Not set up for this project', tone: 'warning' };
    }
    if (input.state === 'loading') {
      return { ...base, latest: '', note: 'Reading…', tone: 'none' };
    }
    const edited = attention.filter((row) => row.cells[name]?.kind === 'edited').length;
    const noFile = attention.filter((row) => row.cells[name]?.kind === 'no-file').length;
    const notes = [
      edited > 0 ? `${edited} edited after ${edited === 1 ? 'it' : 'they'} ran` : '',
      noFile > 0 ? `${noFile} applied, file not in your branch` : '',
    ].filter(Boolean);
    return {
      ...base,
      latest: latestApplied(input.rows ?? [], now),
      note: notes.join(' · '),
      tone: edited > 0 ? 'warning' : 'none',
    };
  });

  const current = steps.find((step) => step.selected) ?? steps[0];
  const name = current?.name ?? selected;
  const pendingRows = matrix.rows.filter((row) => row.cells[name]?.kind === 'pending');
  const items = pendingRows.slice(0, SHOWN_PENDING).map((row): PipelineItem => {
    const record = descriptions.get(row.file);
    const date = row.stamp ? stampDate(row.stamp, now) : '';
    return {
      file: row.file,
      label: row.label,
      description: record?.description ?? '',
      meta: [date, record?.author ?? ''].filter(Boolean).join(' · '),
      environments: inputs.map((input) => ({
        name: input.environment.name,
        kind: kindOn(row.file, input.environment.name),
      })),
    };
  });

  return {
    steps,
    selected: name,
    readOnly: current?.readOnly ?? false,
    pending: current?.state === 'ok' ? pendingRows.length : 0,
    items: current?.state === 'ok' ? items : [],
    more: current?.state === 'ok' ? Math.max(0, pendingRows.length - SHOWN_PENDING) : 0,
  };
}

/** `add-refunds-collection.js · batch 3 · 2 min ago`, from the applied row mmk timed last */
function latestApplied(rows: readonly WireStatusRow[], now: Date): string {
  let latest: WireStatusRow | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.status !== 'applied' || !row.appliedAt) {
      continue;
    }
    const time = Date.parse(row.appliedAt);
    if (!Number.isNaN(time) && time >= latestTime) {
      latest = row;
      latestTime = time;
    }
  }
  if (!latest) {
    return '';
  }
  return [
    displayName(latest.file).label,
    latest.batch === null ? '' : `batch ${latest.batch}`,
    formatWhen(new Date(latestTime), now),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** `14 Oct`, from a file name's `YYYYMMDDHHmmss` prefix (display only) */
function stampDate(stamp: string, now: Date): string {
  const date = new Date(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
  );
  return Number.isNaN(date.getTime()) ? '' : formatDay(date, now);
}

/** Messages the pipeline's webview sends. Anything else is ignored */
export type PipelineMessage =
  | { type: 'ready' }
  | { type: 'select'; name: string }
  | { type: 'review'; dir: string }
  | { type: 'pick'; dir: string; file: string }
  | { type: 'console'; dir: string }
  | { type: 'create' }
  | { type: 'addEnvironment' };

/**
 * True for a message the pipeline's webview may send, checked field by field: the webview draws
 * file names and descriptions from the project, so nothing it sends is taken on trust.
 */
export function isPipelineMessage(value: unknown): value is PipelineMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
    case 'create':
    case 'addEnvironment':
      return true;
    case 'select':
      return typeof message.name === 'string';
    case 'review':
    case 'console':
      return typeof message.dir === 'string';
    case 'pick':
      return typeof message.dir === 'string' && typeof message.file === 'string';
    default:
      return false;
  }
}
