import { describe, expect, it } from 'vitest';
import type { WireStatusRow } from '../../src/mmk/contract.js';
import { type Environment, localEnvironment } from '../../src/mmk/environments.js';
import { type MatrixInput, buildMatrix } from '../../src/mmk/matrix.js';

const LOCAL = localEnvironment();
const STAGING: Environment = { name: 'staging', readOnly: true, color: 'warning', local: false };
const PROD: Environment = { name: 'prod', readOnly: true, color: 'error', local: false };

function applied(file: string, extra: Partial<WireStatusRow> = {}): WireStatusRow {
  return {
    file,
    status: 'applied',
    batch: 1,
    appliedAt: '2026-10-15T10:00:00.000Z',
    duration: 12,
    checksumOk: true,
    ...extra,
  };
}

function pending(file: string): WireStatusRow {
  return {
    file,
    status: 'pending',
    batch: null,
    appliedAt: null,
    duration: null,
    checksumOk: null,
  };
}

function input(environment: Environment, rows: WireStatusRow[]): MatrixInput {
  return { environment, rows, state: 'ok', database: `${environment.name}-host/app` };
}

// The scenario drawn in design C2 (VSMatrix): files on branch feat/refunds.
const BACKFILL = '20260914103012-backfill-invoice-currency.js';
const DROP = '20260929161544-drop-legacy-totals.js';
const REGION = '20261011090845-add-orders-region-field.js';
const PAYMENTS = '20261014170301-index-payments-by-customer.js';
const REFUNDS = '20261016101502-add-refunds-collection.js';

const MOCKUP = [
  input(LOCAL, [
    applied(BACKFILL, { checksumOk: false }),
    applied(DROP),
    pending(REGION),
    pending(PAYMENTS),
    applied(REFUNDS),
  ]),
  input(STAGING, [
    applied(BACKFILL, { checksumOk: false }),
    applied(DROP),
    applied(REGION),
    applied(PAYMENTS),
    pending(REFUNDS),
  ]),
  input(PROD, [
    applied(BACKFILL, { checksumOk: false }),
    applied(DROP),
    pending(REGION),
    pending(PAYMENTS),
    pending(REFUNDS),
  ]),
];

describe('buildMatrix', () => {
  it('should lay out the C2 example with its notes', () => {
    const model = buildMatrix(MOCKUP);

    expect(model.rows.map((row) => [row.label, row.note, row.differs])).toEqual([
      ['backfill-invoice-currency.js', 'Edited after it ran', true],
      ['drop-legacy-totals.js', '', false],
      ['add-orders-region-field.js', 'On staging, not prod', true],
      ['index-payments-by-customer.js', 'On staging, not prod', true],
      ['add-refunds-collection.js', 'Only on local so far', true],
    ]);
    expect(model.rows[0]?.stamp).toBe('20260914103012');
  });

  it('should summarize the C2 example as its chips do', () => {
    expect(buildMatrix(MOCKUP).summary).toEqual([
      "staging has 2 that prod doesn't",
      'local is missing 2 that staging has',
      '1 has run only on local',
      '1 edited after it ran',
    ]);
  });

  it("should keep each environment's verdict as mmk reported it", () => {
    const row = buildMatrix(MOCKUP).rows.find((candidate) => candidate.file === REGION);

    expect(row?.cells).toEqual({
      local: { kind: 'pending' },
      staging: { kind: 'applied', appliedAt: '2026-10-15T10:00:00.000Z', batch: 1 },
      prod: { kind: 'pending' },
    });
  });

  it('should show an applied record whose file is not in the branch', () => {
    const model = buildMatrix([
      input(LOCAL, [applied('0001-old.js', { fileMissing: true, checksumOk: null })]),
      input(STAGING, [applied('0001-old.js', { fileMissing: true, checksumOk: null })]),
    ]);

    expect(model.rows[0]).toMatchObject({
      inFiles: false,
      note: 'Applied on local and staging, file not in your branch',
      cells: { local: { kind: 'no-file' }, staging: { kind: 'no-file' } },
    });
    expect(model.summary).toEqual(['1 applied, file not in your branch']);
  });

  it('should name the ref when comparing its files', () => {
    const model = buildMatrix(
      [input(PROD, [applied('0001-old.js', { fileMissing: true, checksumOk: null })])],
      'origin/main',
    );

    expect(model.rows[0]?.note).toBe('Applied on prod, file not on origin/main');
  });

  it('should mark a record another environment has but this one has never heard of', () => {
    const model = buildMatrix([
      input(LOCAL, [pending('0001-a.js')]),
      input(STAGING, [pending('0001-a.js'), applied('0002-elsewhere.js', { fileMissing: true })]),
    ]);

    expect(model.rows[1]?.cells.local).toEqual({ kind: 'none' });
  });

  it('should say when only local is behind', () => {
    const model = buildMatrix([
      input(LOCAL, [pending('0001-a.js')]),
      input(STAGING, [applied('0001-a.js')]),
      input(PROD, [applied('0001-a.js')]),
    ]);

    expect(model.rows[0]?.note).toBe('Not on local yet');
    expect(model.summary).toEqual([
      'local is missing 1 that staging has',
      'local is missing 1 that prod has',
    ]);
  });

  it('should name only the environments where an edit happened, when it differs', () => {
    const model = buildMatrix([
      input(LOCAL, [applied('0001-a.js', { checksumOk: false })]),
      input(STAGING, [applied('0001-a.js')]),
    ]);

    expect(model.rows[0]?.note).toBe('Edited after it ran on local');
  });

  it('should flag records that need mmk namespace adopt', () => {
    const model = buildMatrix([
      input(LOCAL, [applied('0001-a.js', { unadopted: true })]),
      input(STAGING, [applied('0001-a.js')]),
    ]);

    expect(model.rows[0]?.note).toBe('Needs mmk namespace adopt on local');
  });

  it('should leave out environments it could not read, and show them as unknown', () => {
    const model = buildMatrix([
      input(LOCAL, [applied('0001-a.js')]),
      {
        environment: STAGING,
        rows: null,
        state: 'error',
        message: 'CONNECTION_FAILED',
        database: null,
      },
      { environment: PROD, rows: null, state: 'not-set-up', database: null },
    ]);

    expect(model.columns.map((column) => [column.name, column.state])).toEqual([
      ['local', 'ok'],
      ['staging', 'error'],
      ['prod', 'not-set-up'],
    ]);
    expect(model.rows[0]?.cells.staging).toEqual({ kind: 'unknown' });
    expect(model.rows[0]?.note).toBe('');
    expect(model.summary).toEqual([]);
  });

  it('should list several environments with and / or', () => {
    const qa: Environment = { name: 'qa', readOnly: true, color: 'warning', local: false };
    const model = buildMatrix([
      input(LOCAL, [applied('0001-a.js')]),
      input(qa, [applied('0001-a.js')]),
      input(STAGING, [pending('0001-a.js')]),
      input(PROD, [pending('0001-a.js')]),
    ]);

    expect(model.rows[0]?.note).toBe('On qa, not staging or prod');
  });
});
