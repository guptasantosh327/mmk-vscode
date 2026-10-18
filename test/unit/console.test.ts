import { describe, expect, it } from 'vitest';
import {
  type ConsoleInput,
  type ResultInput,
  buildConsole,
  buildResult,
  isConsoleMessage,
  planSteps,
} from '../../src/mmk/console.js';
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

    expect(model.tabs.map((tab) => tab.hue)).toEqual(['green', 'yellow', 'red']);

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

    expect(
      model.detail?.buttons.map((button) => [button.action, button.label, button.batch]),
    ).toEqual([
      ['down', 'Run down…', undefined],
      ['redo', 'Redo…', undefined],
      ['downBatch', 'Roll back batch 3…', 3],
    ]);
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
      actions: ['review'],
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
      { type: 'applyPlan' },
      { type: 'rollBack', batch: 3 },
      { type: 'unlock' },
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
      { type: 'applyAll' },
      { type: 'rollBack', batch: 0 },
      { type: 'rollBack', batch: 2.5 },
      { type: 'rollBack', batch: '3' },
    ]) {
      expect(isConsoleMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});

describe('buildConsole notices', () => {
  function unreadable(environment: Environment, state: 'error' | 'not-set-up'): ConsoleInput {
    const matrixInputs: MatrixInput[] = ENVIRONMENTS.map((candidate) =>
      candidate === environment
        ? {
            environment: candidate,
            rows: null,
            state,
            ...(state === 'error'
              ? { message: 'Could not connect to MongoDB at mongodb://***:***@db.example.com' }
              : {}),
            database: null,
          }
        : {
            environment: candidate,
            rows: ROWS[candidate.name] ?? null,
            state: 'ok',
            database: null,
          },
    );
    return input({ matrix: buildMatrix(matrixInputs), selected: environment.name });
  }

  it("should show mmk's own message for an environment it couldn't read", () => {
    expect(buildConsole(unreadable(STAGING, 'error')).notice).toEqual({
      kind: 'unreadable',
      text: "Couldn't read staging. mmk said:",
      detail: 'Could not connect to MongoDB at mongodb://***:***@db.example.com',
      actions: ['retry', 'editEnvironment', 'showOutput'],
    });
    // local's connection comes from the project's config, so there's nothing to edit here
    expect(buildConsole(unreadable(LOCAL, 'error')).notice?.actions).toEqual([
      'retry',
      'showOutput',
    ]);
  });

  const HELD = {
    holder: 'ci on deploy-runner-7 (pid 4242)',
    summary: 'Locked by ci on deploy-runner-7 (pid 4242) since 11:40',
    expires: 'If that run crashed, the lock frees itself at 11:41',
  };

  it('should say who holds the lock on a writable environment, and offer to release it', () => {
    const model = buildConsole(input({ locks: { local: HELD } }));

    expect(model.notice).toEqual({
      kind: 'locked',
      text: "Locked by ci on deploy-runner-7 (pid 4242) since 11:40. Until it's released, a run on local fails with LOCK_ALREADY_HELD. If that run crashed, the lock frees itself at 11:41.",
      actions: ['unlock', 'retry'],
    });
    expect(model.tabs.map((tab) => [tab.name, tab.lock])).toEqual([
      ['local', HELD.summary],
      ['staging', ''],
      ['prod', ''],
    ]);
  });

  it('should say a run is in progress on a read-only environment, without offering to release it', () => {
    expect(buildConsole(input({ selected: 'prod', locks: { prod: HELD } })).notice).toEqual({
      kind: 'locked',
      text: 'Locked by ci on deploy-runner-7 (pid 4242) since 11:40: a run is in progress on prod. If that run crashed, the lock frees itself at 11:41.',
      actions: ['retry'],
    });
  });

  it('should offer to set up an environment this project has no connection for', () => {
    expect(buildConsole(unreadable(PROD, 'not-set-up')).notice).toMatchObject({
      kind: 'not-set-up',
      actions: ['editEnvironment'],
    });
  });
});

describe('planSteps', () => {
  it('should list what dry-run up would apply, in its order', () => {
    expect(
      planSteps([applied(INDEXES, 1, '2026-10-09T12:00:00.000Z'), ...(ROWS.local ?? []).slice(3)]),
    ).toEqual([
      {
        file: REGION,
        label: 'add-orders-region-field.js',
        description: 'Default every order to the EU region',
        author: 'Asha Rao',
      },
    ]);
  });
});

describe('buildResult', () => {
  const A = '20261014103000-add-orders-region-field.js';
  const B = '20261015111500-index-payments-by-customer.js';
  const C = '20261016094500-index-orders-by-customer-date.js';

  function result(overrides: Partial<ResultInput>): ReturnType<typeof buildResult> {
    return buildResult({
      kind: 'up',
      environment: 'local',
      files: [A, B, C],
      batch: null,
      outcome: { results: [], failure: null },
      after: null,
      ...overrides,
    });
  }

  it('should report a run that applied everything, with its batch and time', () => {
    const report = result({
      outcome: {
        results: [
          { file: A, status: 'applied', duration: 412, batch: 4 },
          { file: B, status: 'applied', duration: 806, batch: 4 },
          { file: C, status: 'applied', duration: 22, batch: 4 },
        ],
        failure: null,
      },
    });

    expect(report).toMatchObject({
      ok: true,
      title: 'Applied 3 on local',
      subtitle: 'Batch 4 · 1.2 s',
      standing:
        'add-orders-region-field.js, index-payments-by-customer.js and index-orders-by-customer-date.js are applied in batch 4.',
      actions: ['rollBack', 'close'],
      rollBackBatch: 4,
      openFile: null,
      failure: null,
    });
    expect(report.lines.map((line) => [line.state, line.text, line.duration])).toEqual([
      ['done', 'Applied in batch 4', '412 ms'],
      ['done', 'Applied in batch 4', '806 ms'],
      ['done', 'Applied in batch 4', '22 ms'],
    ]);
  });

  it('should say what ran before a failure from the status read after it (mmk 1.5, no R10)', () => {
    const report = result({
      outcome: {
        results: [],
        failure: { code: 'MIGRATION_EXECUTION_FAILED', message: 'E11000 duplicate key', file: C },
      },
      after: [
        applied(A, 4, '2026-10-18T11:59:00.000Z'),
        applied(B, 4, '2026-10-18T11:59:00.000Z'),
        pending(C),
      ],
    });

    expect(report).toMatchObject({
      ok: false,
      title: 'Stopped after 2 of 3 on local',
      failure: { code: 'MIGRATION_EXECUTION_FAILED', message: 'E11000 duplicate key' },
      standing:
        'add-orders-region-field.js and index-payments-by-customer.js are applied in batch 4; index-orders-by-customer-date.js is still pending.',
      actions: ['open', 'rollBack', 'showOutput'],
      openFile: C,
      rollBackBatch: 4,
    });
    expect(report.lines.map((line) => [line.state, line.text])).toEqual([
      ['done', 'Applied in batch 4'],
      ['done', 'Applied in batch 4'],
      ['failed', 'Failed in up()'],
    ]);
  });

  it('should offer to release the lock when mmk found it held, and say nothing ran', () => {
    const report = result({
      outcome: {
        results: [],
        failure: {
          code: 'LOCK_ALREADY_HELD',
          message: 'Migration lock is held by asha',
          file: null,
        },
      },
      after: [pending(A), pending(B), pending(C)],
    });

    expect(report).toMatchObject({
      title: 'Nothing ran on local',
      actions: ['unlock', 'showOutput'],
      rollBackBatch: null,
      openFile: null,
    });
    expect(report.lines.every((line) => line.text === 'Still pending')).toBe(true);
  });

  it('should report a batch rolled back, and what is pending again', () => {
    const report = result({
      kind: 'downBatch',
      files: [B, A],
      batch: 4,
      outcome: {
        results: [
          { file: B, status: 'reverted', duration: 30 },
          { file: A, status: 'reverted', duration: 12 },
        ],
        failure: null,
      },
    });

    expect(report).toMatchObject({
      ok: true,
      title: 'Rolled back batch 4 on local',
      standing: 'index-payments-by-customer.js and add-orders-region-field.js are pending again.',
      actions: ['close'],
      rollBackBatch: null,
    });
    expect(report.lines.map((line) => line.text)).toEqual(['Rolled back', 'Rolled back']);
  });

  it("should show mmk's reason for a file it skipped", () => {
    const report = result({
      files: [A],
      outcome: {
        results: [{ file: A, status: 'skipped', reason: 'already applied' }],
        failure: null,
      },
    });

    expect(report.lines).toEqual([
      expect.objectContaining({ state: 'not-run', text: 'Skipped: already applied' }),
    ]);
    expect(report.title).toBe('Nothing to apply on local');
  });
});
