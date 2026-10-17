import type { Environment } from './environments.js';
import { formatDay } from './model.js';
import type { ProjectSnapshot } from './store.js';

/** Where a file has run, with the checksum mmk recorded there */
export interface AppliedRecord {
  environment: string;
  local: boolean;
  /** SHA-256 recorded when it was applied (`StatusRow.checksum`, request R5) */
  checksum: string;
  appliedAt: string | null;
  batch: number | null;
}

/** How a file's current text compares with every environment it ran on */
export interface EditVerdict {
  /** Every environment where it's applied and mmk reported the recorded checksum */
  applied: AppliedRecord[];
  /** Those whose recorded checksum isn't the text's */
  edited: AppliedRecord[];
  /** It's applied somewhere mmk didn't report a checksum (mmk before R5) */
  checksumsMissing: boolean;
}

/**
 * Compare a text's checksum with the checksum each environment recorded for `file`. Only mmk's
 * rows decide what is applied; the extension only hashes the text it has (see `checksum.ts`).
 */
export function judgeEdit(
  project: ProjectSnapshot,
  environments: readonly Environment[],
  file: string,
  textChecksum: string,
): EditVerdict {
  const applied: AppliedRecord[] = [];
  let checksumsMissing = false;
  for (const environment of environments) {
    const row = project.environments[environment.name]?.rows?.find(
      (candidate) => candidate.file === file,
    );
    if (row?.status !== 'applied' || row.unadopted) {
      continue;
    }
    if (row.checksum === undefined) {
      checksumsMissing = true;
      continue;
    }
    applied.push({
      environment: environment.name,
      local: environment.local,
      checksum: row.checksum,
      appliedAt: row.appliedAt,
      batch: row.batch,
    });
  }
  return {
    applied,
    edited: applied.filter((record) => record.checksum !== textChecksum),
    checksumsMissing,
  };
}

/**
 * The lines of `after` that differ from `before` (0-based, inclusive), by trimming the lines the
 * two have in common at the start and the end. A pure deletion gives the line after it. Null
 * when they're the same.
 */
export function changedLines(before: string, after: string): { start: number; end: number } | null {
  if (before === after) {
    return null;
  }
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let fromEnd = 0;
  while (
    fromEnd < a.length - start &&
    fromEnd < b.length - start &&
    a[a.length - 1 - fromEnd] === b[b.length - 1 - fromEnd]
  ) {
    fromEnd += 1;
  }
  const last = b.length - 1;
  const end = Math.max(start, b.length - 1 - fromEnd);
  return { start: Math.min(start, last), end: Math.min(end, last) };
}

/** `local`, `local and staging`, `local, staging and prod` */
export function listNames(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Where it ran, for the hover (design B1): "It ran on prod and staging on 15 Sep, and on your
 * local database." Environments are grouped by the day they ran.
 */
export function describeWhereItRan(records: readonly AppliedRecord[], now = new Date()): string {
  const remote = records.filter((record) => !record.local);
  const local = records.some((record) => record.local);
  const byDay = new Map<string, string[]>();
  for (const record of remote) {
    const day = record.appliedAt ? formatDay(new Date(record.appliedAt), now) : '';
    byDay.set(day, [...(byDay.get(day) ?? []), record.environment]);
  }
  const parts = [...byDay.entries()].map(([day, names]) =>
    day === '' ? `on ${listNames(names)}` : `on ${listNames(names)} on ${day}`,
  );
  if (local) {
    const localRecord = records.find((record) => record.local);
    const day = localRecord?.appliedAt ? formatDay(new Date(localRecord.appliedAt), now) : '';
    parts.push(
      parts.length === 0 && day !== ''
        ? `on your local database on ${day}`
        : 'on your local database',
    );
  }
  if (parts.length === 0) {
    return 'It has run.';
  }
  return parts.length === 1
    ? `It ran ${parts[0]}.`
    : `It ran ${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}.`;
}

/**
 * The Problems text (design B1). `saved` means the file on disk already differs, not only the
 * editor's text.
 */
export function problemMessage(edited: readonly AppliedRecord[], saved: boolean): string {
  const names = listNames(edited.map((record) => record.environment));
  return saved
    ? `This migration ran on ${names}, and its file changed since. mmk down will refuse to roll it back, and nothing re-runs it. Restore the version that ran, or put the change in a new migration.`
    : `This migration already ran on ${names}. Saving the edit changes its checksum, and mmk down will refuse to roll it back.`;
}
