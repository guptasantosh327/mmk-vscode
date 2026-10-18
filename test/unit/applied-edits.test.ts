import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AppliedRecord,
  changedLines,
  describeWhereItRan,
  judgeEdit,
  problemMessage,
} from '../../src/mmk/applied-edits.js';
import {
  bufferChecksum,
  checksumOfBytes,
  checksumOfText,
  shortChecksum,
  startsWithBom,
} from '../../src/mmk/checksum.js';
import type { WireStatusRow } from '../../src/mmk/contract.js';
import { type Environment, localEnvironment } from '../../src/mmk/environments.js';
import type { ProjectSnapshot } from '../../src/mmk/store.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('checksum', () => {
  it('should be the SHA-256 of the UTF-8 text, as mmk computes it', () => {
    expect(checksumOfText('export {};\n')).toBe(sha('export {};\n'));
    expect(checksumOfBytes(Buffer.from('café\r\n', 'utf8'))).toBe(sha('café\r\n'));
  });

  it("should decode invalid UTF-8 the way readFileSync(file, 'utf8') does", () => {
    const bytes = Buffer.from([0x61, 0xff, 0x62]);

    expect(checksumOfBytes(bytes)).toBe(sha(bytes.toString('utf8')));
    expect(checksumOfBytes(bytes)).toBe(sha('a�b'));
  });

  it('should put back the BOM VS Code drops from a document, but only once', () => {
    expect(bufferChecksum('up();\n', true)).toBe(sha('﻿up();\n'));
    expect(bufferChecksum('﻿up();\n', true)).toBe(sha('﻿up();\n'));
    expect(bufferChecksum('up();\n', false)).toBe(sha('up();\n'));
  });

  it('should spot a BOM and shorten a checksum for messages', () => {
    expect(startsWithBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe(true);
    expect(startsWithBom(Buffer.from('abc'))).toBe(false);
    expect(shortChecksum(`3f9a1c07${'a'.repeat(52)}be21`)).toBe('3f9a1c07…be21');
  });
});

const LOCAL = localEnvironment();
const STAGING: Environment = { name: 'staging', readOnly: true, color: 'warning', local: false };
const PROD: Environment = { name: 'prod', readOnly: true, color: 'error', local: false };
const FILE = '20260914103012-backfill-invoice-currency.js';
const RAN = sha('the version that ran');

function project(rows: Record<string, WireStatusRow[]>): ProjectSnapshot {
  const environments = Object.fromEntries(
    Object.entries(rows).map(([name, list]) => [
      name,
      {
        rows: list,
        error: null,
        loading: false,
        connected: true,
        database: null,
        readAt: null,
        lock: null,
      },
    ]),
  );
  return {
    dir: '/work/api',
    state: { kind: 'mmk-missing', root: { dir: '/work/api', configFile: null }, message: '' },
    config: null,
    rows: null,
    error: null,
    loading: false,
    environments,
    running: null,
    runningOn: null,
  };
}

function applied(
  checksum: string | undefined,
  appliedAt = '2026-09-15T10:00:00.000Z',
): WireStatusRow {
  return {
    file: FILE,
    status: 'applied',
    batch: 4,
    appliedAt,
    duration: 9,
    checksumOk: true,
    ...(checksum === undefined ? {} : { checksum }),
  };
}

describe('judgeEdit', () => {
  const ENVIRONMENTS = [LOCAL, STAGING, PROD];

  it('should name every environment whose recorded checksum differs from the text', () => {
    const verdict = judgeEdit(
      project({ local: [applied(RAN)], staging: [applied(RAN)], prod: [applied(RAN)] }),
      ENVIRONMENTS,
      FILE,
      sha('edited'),
    );

    expect(verdict.edited.map((record) => record.environment)).toEqual([
      'local',
      'staging',
      'prod',
    ]);
    expect(verdict.checksumsMissing).toBe(false);
  });

  it('should find nothing edited when the text is what ran', () => {
    const verdict = judgeEdit(project({ local: [applied(RAN)] }), ENVIRONMENTS, FILE, RAN);

    expect(verdict.applied).toHaveLength(1);
    expect(verdict.edited).toEqual([]);
  });

  it('should leave out environments where it is pending or unadopted', () => {
    const verdict = judgeEdit(
      project({
        local: [{ ...applied(RAN), unadopted: true }],
        staging: [{ ...applied(undefined), status: 'pending' }],
        prod: [applied(RAN)],
      }),
      ENVIRONMENTS,
      FILE,
      sha('edited'),
    );

    expect(verdict.edited.map((record) => record.environment)).toEqual(['prod']);
  });

  it("should say when mmk doesn't report checksums (before R5)", () => {
    const verdict = judgeEdit(project({ local: [applied(undefined)] }), ENVIRONMENTS, FILE, RAN);

    expect(verdict).toEqual({ applied: [], edited: [], checksumsMissing: true });
  });

  it('should compare each environment with its own recorded version', () => {
    const verdict = judgeEdit(
      project({ local: [applied(sha('newer'))], prod: [applied(RAN)] }),
      ENVIRONMENTS,
      FILE,
      sha('newer'),
    );

    expect(verdict.edited.map((record) => record.environment)).toEqual(['prod']);
  });
});

describe('changedLines', () => {
  it('should find the lines that differ', () => {
    expect(changedLines('a\nb\nc\nd\n', 'a\nB\nC\nd\n')).toEqual({ start: 1, end: 2 });
  });

  it('should find added lines', () => {
    expect(changedLines('a\nd\n', 'a\nb\nc\nd\n')).toEqual({ start: 1, end: 2 });
  });

  it('should point at the line after a deletion', () => {
    expect(changedLines('a\nb\nc\n', 'a\nc\n')).toEqual({ start: 1, end: 1 });
  });

  it('should treat CRLF and LF lines alike and find nothing for equal text', () => {
    expect(changedLines('a\r\nb\r\n', 'a\r\nb\r\n')).toBeNull();
    expect(changedLines('a\r\nb\r\n', 'a\r\nX\r\n')).toEqual({ start: 1, end: 1 });
  });

  it('should stay inside the new text when lines were removed at the end', () => {
    expect(changedLines('a\nb\nc', 'a')).toEqual({ start: 0, end: 0 });
  });
});

describe('describeWhereItRan', () => {
  const NOW = new Date('2026-10-17T12:00:00');
  const record = (environment: string, local: boolean, appliedAt: string): AppliedRecord => ({
    environment,
    local,
    checksum: RAN,
    appliedAt,
    batch: 1,
  });

  it('should group environments by day and mention local last (design B1)', () => {
    expect(
      describeWhereItRan(
        [
          record('local', true, '2026-10-16T09:00:00'),
          record('staging', false, '2026-09-15T09:00:00'),
          record('prod', false, '2026-09-15T11:00:00'),
        ],
        NOW,
      ),
    ).toBe('It ran on staging and prod on 15 Sep, and on your local database.');
  });

  it('should give the day for local when it ran only there', () => {
    expect(describeWhereItRan([record('local', true, '2026-10-16T09:00:00')], NOW)).toBe(
      'It ran on your local database on 16 Oct.',
    );
  });

  it('should list separate days separately', () => {
    expect(
      describeWhereItRan(
        [
          record('staging', false, '2026-09-15T09:00:00'),
          record('prod', false, '2026-09-20T09:00:00'),
        ],
        NOW,
      ),
    ).toBe('It ran on staging on 15 Sep, and on prod on 20 Sep.');
  });
});

describe('problemMessage', () => {
  const records = ['local', 'staging', 'prod'].map(
    (environment): AppliedRecord => ({
      environment,
      local: environment === 'local',
      checksum: RAN,
      appliedAt: null,
      batch: 1,
    }),
  );

  it('should warn before saving (design B1)', () => {
    expect(problemMessage(records, false)).toBe(
      'This migration already ran on local, staging and prod. Saving the edit changes its checksum, and mmk down will refuse to roll it back.',
    );
  });

  it('should say what to do once the edit is saved', () => {
    expect(problemMessage(records.slice(0, 1), true)).toBe(
      'This migration ran on local, and its file changed since. mmk down will refuse to roll it back, and nothing re-runs it. Restore the version that ran, or put the change in a new migration.',
    );
  });
});
