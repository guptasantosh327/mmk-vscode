import { describe, expect, it } from 'vitest';
import { formatStatusTable } from '../../src/mmk/format.js';

describe('formatStatusTable', () => {
  it('should say so when there are no migrations', () => {
    expect(formatStatusTable([])).toEqual(['No migrations found']);
  });

  it('should print one aligned line per row with the same columns as mmk status', () => {
    const lines = formatStatusTable([
      {
        file: '20260101000000-create-users.js',
        status: 'applied',
        batch: 1,
        appliedAt: '2026-10-16T10:31:00.000Z',
        duration: 42,
        checksumOk: true,
        author: 'Ada',
      },
      {
        file: '20260102000000-add-email-index.js',
        status: 'applied',
        batch: 12,
        appliedAt: '2026-10-16T10:32:00.000Z',
        duration: 3,
        checksumOk: false,
      },
      {
        file: '20260103000000-backfill.js',
        status: 'pending',
        batch: null,
        appliedAt: null,
        duration: null,
        checksumOk: null,
      },
    ]);

    expect(lines).toEqual([
      'Migration                          Status   Batch  Applied At                Checksum  Author',
      '─────────────────────────────────  ───────  ─────  ────────────────────────  ────────  ──────',
      '20260101000000-create-users.js     applied  1      2026-10-16T10:31:00.000Z  ok        Ada',
      '20260102000000-add-email-index.js  applied  12     2026-10-16T10:32:00.000Z  MISMATCH',
      '20260103000000-backfill.js         pending                                   —',
    ]);
  });

  it('should flag records without a file and records not yet adopted into the namespace', () => {
    const [, , missing, unadopted] = formatStatusTable([
      {
        file: 'old.js',
        status: 'applied',
        batch: 1,
        appliedAt: '2026-01-01T00:00:00.000Z',
        duration: 1,
        checksumOk: null,
        fileMissing: true,
      },
      {
        file: 'mine.js',
        status: 'applied',
        batch: 2,
        appliedAt: '2026-01-02T00:00:00.000Z',
        duration: 1,
        checksumOk: true,
        unadopted: true,
      },
    ]);

    expect(missing).toMatch(/^old\.js \(no file\)\s+applied/);
    expect(unadopted).toMatch(/^mine\.js\s+unadopted/);
  });
});
