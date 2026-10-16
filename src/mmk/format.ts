import type { StatusRow } from 'mongo-migrate-kit';
import type { Wire } from './contract.js';

/** Column headings, in the same order as mmk's own `status` table */
const HEADINGS = ['Migration', 'Status', 'Batch', 'Applied At', 'Checksum', 'Author'] as const;

/**
 * Render status rows as a plain-text table for the output channel, one string per line. Shows
 * exactly what mmk returned: dates stay as mmk's ISO strings, and nothing is recomputed.
 */
export function formatStatusTable(rows: readonly Wire<StatusRow>[]): string[] {
  if (rows.length === 0) {
    return ['No migrations found'];
  }
  const cells = rows.map((row) => [
    row.fileMissing ? `${row.file} (no file)` : row.file,
    row.unadopted ? 'unadopted' : row.status,
    row.batch === null ? '' : String(row.batch),
    row.appliedAt ?? '',
    row.checksumOk === null ? '—' : row.checksumOk ? 'ok' : 'MISMATCH',
    row.author ?? '',
  ]);
  const widths = HEADINGS.map((heading, column) =>
    Math.max(heading.length, ...cells.map((line) => (line[column] ?? '').length)),
  );
  const render = (line: readonly string[]): string =>
    line
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [render(HEADINGS), render(widths.map((width) => '─'.repeat(width))), ...cells.map(render)];
}
