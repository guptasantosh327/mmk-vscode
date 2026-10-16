import type { StatusRow } from 'mongo-migrate-kit';
import type { Wire } from './contract.js';

/** One batch of applied migrations, newest file first */
export interface BatchGroup {
  batch: number;
  /** When the batch's newest migration was applied; null when mmk reported no time */
  appliedAt: Date | null;
  rows: Wire<StatusRow>[];
}

/** The sidebar's groups, built only from what `mmk status --json` reported */
export interface StatusModel {
  /** `status: 'pending'`, in mmk's order */
  pending: Wire<StatusRow>[];
  /** Applied, but mmk's checksum verdict says the file changed since (`checksumOk: false`) */
  edited: Wire<StatusRow>[];
  /** Applied before this repo had a namespace (`unadopted`): needs `mmk namespace adopt` */
  unadopted: Wire<StatusRow>[];
  /** Applied migrations grouped by batch, newest batch first */
  batches: BatchGroup[];
  /** Number of applied migrations across all batches */
  appliedCount: number;
}

/** Group status rows for the sidebar. Every verdict comes from mmk's row as is */
export function buildStatusModel(rows: readonly Wire<StatusRow>[]): StatusModel {
  const pending: Wire<StatusRow>[] = [];
  const edited: Wire<StatusRow>[] = [];
  const unadopted: Wire<StatusRow>[] = [];
  const byBatch = new Map<number, Wire<StatusRow>[]>();

  for (const row of rows) {
    if (row.unadopted) {
      unadopted.push(row);
    } else if (row.status === 'pending') {
      pending.push(row);
    } else {
      if (row.checksumOk === false) {
        edited.push(row);
      }
      const batch = row.batch ?? 0;
      byBatch.set(batch, [...(byBatch.get(batch) ?? []), row]);
    }
  }

  const batches = [...byBatch.entries()]
    .sort(([a], [b]) => b - a)
    .map(([batch, batchRows]): BatchGroup => {
      const sorted = [...batchRows].sort((a, b) => b.file.localeCompare(a.file));
      const times = sorted
        .map((row) => (row.appliedAt ? Date.parse(row.appliedAt) : Number.NaN))
        .filter((time) => !Number.isNaN(time));
      return {
        batch,
        appliedAt: times.length > 0 ? new Date(Math.max(...times)) : null,
        rows: sorted,
      };
    });

  return {
    pending,
    edited,
    unadopted,
    batches,
    appliedCount: batches.reduce((sum, group) => sum + group.rows.length, 0),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A short date for the sidebar: `just now`, `5 min ago`, `10:31` (today), `13 Oct` (this year)
 * or `13 Oct 2025`. Local time.
 */
export function formatWhen(date: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) {
    return 'just now';
  }
  if (elapsed >= 0 && elapsed < 60 * 60_000) {
    return `${Math.floor(elapsed / 60_000)} min ago`;
  }
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return formatDay(date, now);
}

/** `13 Oct`, with the year when it isn't the current one */
export function formatDay(date: Date, now: Date = new Date()): string {
  const day = `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/** `412 ms`, `1.2 s`, `2 min 5 s` */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${Number((ms / 1000).toFixed(1))} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
