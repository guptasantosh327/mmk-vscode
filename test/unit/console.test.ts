import { describe, expect, it } from 'vitest';
import { type ConsoleInput, buildConsole, isConsoleMessage } from '../../src/mmk/console.js';
import type { WireStatusRow } from '../../src/mmk/contract.js';
import { type Environment, localEnvironment } from '../../src/mmk/environments.js';
import { type MatrixInput, buildMatrix } from '../../src/mmk/matrix.js';

const LOCAL = localEnvironment();
const STAGING: Environment = { name: 'staging', readOnly: true, color: 'warning', local: false };
const PROD: Environment = { name: 'prod', readOnly: true, color: 'error', local: false };
const ENVIRONMENTS = [LOCAL, STAGING, PROD];
const NOW = new Date('2026-10-18T12:00:00.000Z');

// The scenario drawn in the console mockups (C1–C4): files on branch feat/refunds.
const INDEXES = '20261009101200-create-orders-indexes.js';
const LOYALTY = '20261011120000-add-loyalty-points.js';
const BACKFILL = '20261012164000-backfill-order-status.js';
const REFUNDS = '20261013090000-add-refunds-collection.js';
const REGION = '20261014103000-add-orders-region-field.js';

function applied(
  file: string,
  batch: number,
  appliedAt: string,
  extra: Partial<WireStatusRow> = {},
): WireStatusRow {
  return {
    file,
    status: 'applied',
    batch,
    appliedAt,
    duration: 40,
    checksumOk: true,
    ...extra,
  };
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

const REGION_ROW = { description: 'Default every order to the EU region', author: 'Asha Rao' };

const ROWS: Record<string, WireStatusRow[]> = {
  local: [
    applied(INDEXES, 1, '2026-10-09T12:00:00.000Z', { duration: 412 }),
    applied(BACKFILL, 2, '2026-10-17T12:00:00.000Z', { checksumOk: false, duration: 1200 }),
    applied(REFUNDS, 3, '2026-10-18T11:58:00.000Z', { duration: 38 }),
    pending(REGION, REGION_ROW),
  ],
  staging: [
    applied(INDEXES, 4, '2026-10-03T12:00:00.000Z'),
    applied(LOYALTY, 5, '2026-10-05T12:00:00.000Z', { fileMissing: true }),
    applied(BACKFILL, 6, '2026-10-16T12:00:00.000Z'),
    applied(REFUNDS, 7, '2026-10-18T11:00:00.000Z'),
    pending(REGION, REGION_ROW),
  ],
  prod: [
    applied(INDEXES, 3, '2026-10-04T12:00:00.000Z'),
    applied(BACKFILL, 4, '2026-10-15T12:00:00.000Z'),
    pending(REFUNDS),
    pending(REGION, REGION_ROW),
  ],
};

function input(overrides: Partial<ConsoleInput> = {}): ConsoleInput {
  const matrixInputs: MatrixInput[] = ENVIRONMENTS.map((environment) => ({
    environment,
    rows: ROWS[environment.name] ?? null,
    state: 'ok',
    database: `${environment.name}-host/orders`,
  }));
  return {
    matrix: buildMatrix(matrixInputs),
    environments: ENVIRONMENTS,
    selected: 'local',
    filter: 'all',
    picked: null,
    rows: ROWS,
    filesAreLocal: true,
    now: NOW,
    ...overrides,
  };
}

describe('buildConsole', () => {
  it('should count pending and attention per environment from mmk verdicts', () => {
    const model = buildConsole(input());

    expect(
      model.tabs.map((tab) => [tab.name, tab.readOnly, tab.selected, tab.pending, tab.attention]),
    ).toEqual([
      ['local', false, true, 1, 1],
      ['staging', true, false, 1, 1],
      ['prod', true, false, 2, 0],
    ]);
    expect(model.pending).toBe(1);
    expect(model.readOnly).toBe(false);
  });

  it('should show every file in mmk order, with each environment in words', () => {
    const model = buildConsole(input());

    expect(
      model.rows.map((row) => [row.label, row.cells.map((cell) => cell.text), row.last]),
    ).toEqual([
      ['create-orders-indexes.js', ['batch 1', 'batch 4', 'batch 3'], '9 Oct'],
      ['add-loyalty-points.js', ['—', 'no file', '—'], '—'],
      ['backfill-order-status.js', ['edited', 'batch 6', 'batch 4'], '17 Oct'],
      ['add-refunds-collection.js', ['batch 3', 'batch 7', 'pending'], '2 min ago'],
      ['add-orders-region-field.js', ['pending', 'pending', 'pending'], '—'],
    ]);
  });

  it('should pick the first migration pending on the selected environment by default', () => {
    const model = buildConsole(input());

    expect(model.rows.filter((row) => row.picked).map((row) => row.file)).toEqual([REGION]);
    expect(model.detail).toMatchObject({
      file: REGION,
      description: 'Default every order to the EU region',
      author: 'Asha Rao',
      buttons: [
        { action: 'up', label: 'Run up on local', primary: true },
        { action: 'dryRun', label: 'Plan', primary: false },
      ],
      note: 'Run down is offered once up has run here.',
      cli: ['up', REGION],
    });
    expect(
      model.detail?.records.map((record) => [record.environment, record.text, record.extra]),
    ).toEqual([
      ['local', 'Pending', ''],
      ['staging', 'Pending', 'deploys through CI'],
      ['prod', 'Pending', 'deploys through CI'],
    ]);
  });

  it('should offer down and redo for an applied migration, and mark its batch', () => {
    const model = buildConsole(input({ picked: REFUNDS }));

    expect(model.detail?.buttons.map((button) => button.action)).toEqual(['down', 'redo']);
    expect(model.detail?.cli).toEqual(['down', REFUNDS]);
    expect(model.detail?.records.map((record) => [record.text, record.extra])).toEqual([
      ['Applied in batch 3', '2 min ago · 38 ms'],
      // An hour ago: the clock time, which depends on the machine's time zone
      ['Applied in batch 7', expect.stringMatching(/^\d\d:\d\d · 40 ms$/)],
      ['Pending', 'deploys through CI'],
    ]);
    expect(model.batches.map((batch) => [batch.title, batch.picked])).toEqual([
      ['Batch 1', false],
      ['Batch 2', false],
      ['Batch 3', true],
    ]);
  });

  it('should send an edited migration to its applied version before rolling it back', () => {
    const model = buildConsole(input({ picked: BACKFILL }));

    expect(model.detail?.buttons.map((button) => button.action)).toEqual([
      'showAppliedVersion',
      'down',
    ]);
    expect(model.notice).toEqual({
      kind: 'edited',
      file: BACKFILL,
      text: "backfill-order-status.js was edited after it ran on local in batch 2. mmk won't roll it back until it matches again.",
    });
  });

  it('should offer nothing to run for a record whose file is on another branch', () => {
    const model = buildConsole(input({ picked: LOYALTY }));

    expect(model.detail).toMatchObject({
      inFiles: false,
      buttons: [],
      cli: ['status'],
      note: "Its file isn't in your branch, so there's nothing to run from here.",
    });
    expect(model.detail?.records.map((record) => record.text)).toEqual([
      'Not here',
      'Applied in batch 5, no file here',
      'Not here',
    ]);
  });

  it('should only plan and preview on a read-only environment', () => {
    const pendingOnStaging = buildConsole(input({ selected: 'staging' }));
    expect(pendingOnStaging.readOnly).toBe(true);
    expect(pendingOnStaging.notice?.kind).toBe('read-only');
    expect(pendingOnStaging.detail).toMatchObject({
      file: REGION,
      buttons: [{ action: 'dryRun', label: 'Plan on staging', primary: false }],
      cli: ['dry-run', 'up', REGION],
    });

    const appliedOnStaging = buildConsole(input({ selected: 'staging', picked: REFUNDS }));
    expect(appliedOnStaging.detail?.buttons).toEqual([]);
    expect(appliedOnStaging.detail?.cli).toEqual(['dry-run', 'down', REFUNDS]);
  });

  it('should filter by the selected environment, and count every filter', () => {
    expect(buildConsole(input({ filter: 'pending' })).rows.map((row) => row.file)).toEqual([
      REGION,
    ]);
    expect(buildConsole(input({ filter: 'attention' })).rows.map((row) => row.file)).toEqual([
      BACKFILL,
    ]);
    expect(
      buildConsole(input({ filter: 'attention', selected: 'staging' })).rows.map((row) => row.file),
    ).toEqual([LOYALTY]);

    const differences = buildConsole(input({ filter: 'diff' }));
    expect(differences.rows.map((row) => [row.label, row.note])).toEqual([
      ['add-loyalty-points.js', 'Applied on staging, file not in your branch'],
      ['backfill-order-status.js', 'Edited after it ran on local'],
      ['add-refunds-collection.js', 'On staging, not prod'],
    ]);
    expect(differences.chips.map((chip) => [chip.id, chip.count, chip.active])).toEqual([
      ['all', 5, false],
      ['pending', 1, false],
      ['attention', 1, false],
      ['diff', 3, true],
    ]);
  });

  it('should pick again when the picked migration is filtered out', () => {
    const model = buildConsole(input({ filter: 'attention', picked: REGION }));

    expect(model.detail?.file).toBe(BACKFILL);
  });

  it("should run nothing on another branch's files", () => {
    const model = buildConsole(input({ filesAreLocal: false }));

    expect(model.detail).toMatchObject({
      buttons: [],
      cli: ['status'],
      note: 'These are the files on another branch: switch Files to your branch to run one.',
    });
  });

  it('should list the latest batches oldest first, with their size and time', () => {
    const model = buildConsole(input({ picked: REGION }));

    expect(model.batches.map((batch) => [batch.title, batch.meta.split(' · ').slice(1)])).toEqual([
      ['Batch 1', ['1 migration', '412 ms']],
      ['Batch 2', ['1 migration', '1.2 s']],
      ['Batch 3', ['1 migration', '38 ms']],
    ]);
    expect(buildConsole(input({ selected: 'prod' })).batches.map((batch) => batch.batch)).toEqual([
      3, 4,
    ]);
  });

  it('should have no detail when no file is shown', () => {
    const empty = buildConsole(input({ rows: {}, matrix: buildMatrix([]) }));

    expect(empty.rows).toEqual([]);
    expect(empty.detail).toBeNull();
    expect(empty.notice).toBeNull();
  });
});

describe('isConsoleMessage', () => {
  it('should accept the messages the console sends', () => {
    for (const message of [
      { type: 'ready' },
      { type: 'source', value: 'ref' },
      { type: 'filter', value: 'diff' },
      { type: 'environment', name: 'staging' },
      { type: 'pick', file: REGION },
      { type: 'action', action: 'up' },
      { type: 'action', action: 'showAppliedVersion' },
      { type: 'copy' },
      { type: 'applyAll' },
    ]) {
      expect(isConsoleMessage(message), JSON.stringify(message)).toBe(true);
    }
  });

  it('should ignore anything else, so the webview can only ask for what the console offers', () => {
    for (const message of [
      null,
      'up',
      {},
      { type: 'run', command: 'mmk.down' },
      { type: 'action', action: 'unlock' },
      { type: 'action' },
      { type: 'filter', value: 'everything' },
      { type: 'source', value: '../main' },
      { type: 'pick', file: 42 },
      { type: 'environment' },
    ]) {
      expect(isConsoleMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});
