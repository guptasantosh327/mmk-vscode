import type { MigrationExtension } from 'mongo-migrate-kit';

/**
 * mmk's `slugify` (`src/utils/template.ts` in mongo-migrate-kit), used **only** to preview the
 * file name in "Create migration" and to say early that a name has no letters or digits. mmk
 * still names the file: the extension opens the path `mmk create --json` returns.
 * `test/contract/naming.contract.test.ts` proves this matches the real `mmk create`.
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The file name `mmk create` will write for `name`, with a placeholder where mmk puts the
 * timestamp (or sequence number). Null when the name has no letters or digits, which mmk refuses.
 */
export function previewFileName(
  name: string,
  options: { sequential: boolean; extension: MigrationExtension },
): string | null {
  const slug = slugify(name);
  if (slug === '') {
    return null;
  }
  const prefix = options.sequential ? '<number>' : '<timestamp>';
  return `${prefix}-${slug}.${options.extension}`;
}

/** How a migration file is shown in the sidebar */
export interface DisplayName {
  /** The file name without its numeric prefix, e.g. `add-refunds-collection.js` */
  label: string;
  /** The date in a `YYYYMMDDHHmmss-` prefix, in local time; null for other prefixes */
  date: Date | null;
}

const STAMP_PREFIX = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-(.+)$/;
const NUMBER_PREFIX = /^\d+-(.+)$/;

/**
 * Split a migration file name for display: `20261016101502-add-refunds.js` shows as
 * `add-refunds.js` with the date 16 Oct 2026. Display only: the full name is always in the
 * tooltip, and every command uses the full name.
 */
export function displayName(file: string): DisplayName {
  const stamp = STAMP_PREFIX.exec(file);
  if (stamp) {
    const [, year, month, day, hours, minutes, seconds, rest] = stamp;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
    );
    return { label: rest ?? file, date: Number.isNaN(date.getTime()) ? null : date };
  }
  const numbered = NUMBER_PREFIX.exec(file);
  return { label: numbered?.[1] ?? file, date: null };
}
