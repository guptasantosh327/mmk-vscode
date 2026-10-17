import { describe, expect, it } from 'vitest';
import type { WireStatusRow } from '../../src/mmk/contract.js';
import { buildStatusModel, formatDay, formatDuration, formatWhen } from '../../src/mmk/model.js';

function applied(
  file: string,
  batch: number,
  appliedAt: string,
  extra: Partial<WireStatusRow> = {},
): WireStatusRow {
  return { file, status: 'applied', batch, appliedAt, duration: 10, checksumOk: true, ...extra };
}

function pending(file: string, extra: Partial<WireStatusRow> = {}): WireStatusRow {
  return {
    file,
    status: 'pending',
    batch: null,
    appliedAt: null,
    duration: null,
    checksumOk: null,
    ...extra,
  };
}

describe('buildStatusModel', () => {
  it('should group pending rows and applied rows by batch, newest batch first', () => {
    const model = buildStatusModel([
      applied('0001-a.js', 1, '2026-10-01T10:00:00.000Z'),
      applied('0002-b.js', 2, '2026-10-02T10:00:00.000Z'),
      applied('0003-c.js', 2, '2026-10-02T10:00:05.000Z'),
      pending('0004-d.js'),
      pending('0005-e.js'),
    ]);

    expect(model.pending.map((row) => row.file)).toEqual(['0004-d.js', '0005-e.js']);
    expect(model.appliedCount).toBe(3);
    expect(model.batches.map((group) => [group.batch, group.rows.map((row) => row.file)])).toEqual([
      [2, ['0003-c.js', '0002-b.js']],
      [1, ['0001-a.js']],
    ]);
    expect(model.batches[0]?.appliedAt).toEqual(new Date('2026-10-02T10:00:05.000Z'));
  });

  it('should list a file whose checksum mmk says changed under edited, and still in its batch', () => {
    const model = buildStatusModel([
      applied('0001-a.js', 1, '2026-10-01T10:00:00.000Z', { checksumOk: false }),
    ]);
    expect(model.edited.map((row) => row.file)).toEqual(['0001-a.js']);
    expect(model.batches[0]?.rows.map((row) => row.file)).toEqual(['0001-a.js']);
  });

  it('should keep unadopted rows apart from pending ones', () => {
    const model = buildStatusModel([
      pending('0001-a.js', { unadopted: true }),
      pending('0002-b.js'),
    ]);
    expect(model.unadopted.map((row) => row.file)).toEqual(['0001-a.js']);
    expect(model.pending.map((row) => row.file)).toEqual(['0002-b.js']);
  });

  it('should keep an applied record without a file, and a batch without a time', () => {
    const model = buildStatusModel([
      {
        ...applied('0001-gone.js', 1, '2026-10-01T10:00:00.000Z'),
        checksumOk: null,
        fileMissing: true,
      },
      { ...applied('0002-b.js', 2, ''), appliedAt: null },
    ]);
    expect(model.batches.map((group) => [group.batch, group.appliedAt])).toEqual([
      [2, null],
      [1, new Date('2026-10-01T10:00:00.000Z')],
    ]);
  });

  it('should be empty for no rows', () => {
    expect(buildStatusModel([])).toEqual({
      pending: [],
      edited: [],
      unadopted: [],
      batches: [],
      appliedCount: 0,
    });
  });
});

describe('formatWhen', () => {
  const now = new Date(2026, 9, 16, 14, 30, 0);

  it.each([
    [new Date(2026, 9, 16, 14, 29, 30), 'just now'],
    [new Date(2026, 9, 16, 14, 5, 0), '25 min ago'],
    [new Date(2026, 9, 16, 9, 7, 0), '09:07'],
    [new Date(2026, 9, 13, 18, 0, 0), '13 Oct'],
    [new Date(2025, 0, 2, 8, 0, 0), '2 Jan 2025'],
  ])('should show %s as %j', (date, text) => {
    expect(formatWhen(date, now)).toBe(text);
  });

  it('should show a date in the future as a day, not as minutes ago', () => {
    expect(formatWhen(new Date(2026, 9, 20, 9, 0, 0), now)).toBe('20 Oct');
  });

  it('should add the year only when it differs', () => {
    expect(formatDay(new Date(2026, 4, 1), now)).toBe('1 May');
    expect(formatDay(new Date(2024, 4, 1), now)).toBe('1 May 2024');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [412, '412 ms'],
    [1000, '1 s'],
    [1234, '1.2 s'],
    [59_999, '60 s'],
    [125_000, '2 min 5 s'],
  ])('should show %d ms as %j', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
