import { describe, expect, it } from 'vitest';
import type { WireStatusRow } from '../../src/mmk/contract.js';
import { type Environment, localEnvironment } from '../../src/mmk/environments.js';
import type { MatrixInput } from '../../src/mmk/matrix.js';
import { buildPipeline, isPipelineMessage } from '../../src/mmk/pipeline.js';

const LOCAL = localEnvironment();
const STAGING: Environment = { name: 'staging', readOnly: true, color: 'warning', local: false };
const PROD: Environment = { name: 'prod', readOnly: true, color: 'error', local: false };
const NOW = new Date('2026-10-18T12:00:00.000Z');

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
  return { file, status: 'applied', batch, appliedAt, duration: 40, checksumOk: true, ...extra };
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

function ok(environment: Environment, rows: WireStatusRow[]): MatrixInput {
  return { environment, rows, state: 'ok', database: `${environment.name}-host/orders` };
}

const INPUTS: MatrixInput[] = [
  ok(LOCAL, [
    applied(INDEXES, 1, '2026-10-09T12:00:00.000Z'),
    applied(BACKFILL, 2, '2026-10-17T12:00:00.000Z', { checksumOk: false }),
    applied(REFUNDS, 3, '2026-10-18T11:58:00.000Z'),
    pending(REGION, REGION_ROW),
  ]),
  ok(STAGING, [
    applied(INDEXES, 4, '2026-10-03T12:00:00.000Z'),
    applied(LOYALTY, 5, '2026-10-05T12:00:00.000Z', { fileMissing: true }),
    applied(BACKFILL, 6, '2026-10-16T12:00:00.000Z'),
    applied(REFUNDS, 7, '2026-10-18T11:30:00.000Z'),
    pending(REGION, REGION_ROW),
  ]),
  ok(PROD, [
    applied(INDEXES, 3, '2026-10-04T12:00:00.000Z'),
    applied(BACKFILL, 4, '2026-10-15T12:00:00.000Z'),
    pending(REFUNDS),
    pending(REGION, REGION_ROW),
  ]),
];

describe('buildPipeline', () => {
  it('should show each environment as a step, from its own status rows', () => {
    const model = buildPipeline(INPUTS, 'local', NOW);

    expect(
      model.steps.map((step) => [
        step.name,
        step.readOnly,
        step.selected,
        step.pending,
        step.latest,
        step.note,
        step.tone,
      ]),
    ).toEqual([
      [
        'local',
        false,
        true,
        1,
        'add-refunds-collection.js · batch 3 · 2 min ago',
        '1 edited after it ran',
        'warning',
      ],
      [
        'staging',
        true,
        false,
        1,
        'add-refunds-collection.js · batch 7 · 30 min ago',
        '1 applied, file not in your branch',
        'none',
      ],
      ['prod', true, false, 2, 'backfill-order-status.js · batch 4 · 15 Oct', '', 'none'],
    ]);
  });

  it("should list the selected environment's pending migrations, with each environment's state", () => {
    const model = buildPipeline(INPUTS, 'prod', NOW);

    expect(model).toMatchObject({ selected: 'prod', readOnly: true, pending: 2, more: 0 });
    expect(
      model.items.map((item) => [item.label, item.meta, item.environments.map((env) => env.kind)]),
    ).toEqual([
      ['add-refunds-collection.js', '13 Oct', ['applied', 'applied', 'pending']],
      ['add-orders-region-field.js', '14 Oct · Asha Rao', ['pending', 'pending', 'pending']],
    ]);
    expect(model.items[1]?.description).toBe('Default every order to the EU region');
  });

  it("should show mmk's error for an environment it couldn't read, and list nothing for it", () => {
    const inputs: MatrixInput[] = [
      INPUTS[0] as MatrixInput,
      {
        environment: STAGING,
        rows: null,
        state: 'error',
        message: 'CONNECTION_FAILED: querySrv ENOTFOUND cluster0.ab12c.mongodb.net',
        database: null,
      },
      { environment: PROD, rows: null, state: 'not-set-up', database: null },
    ];

    const model = buildPipeline(inputs, 'staging', NOW);

    expect(model.steps.map((step) => [step.name, step.state, step.note, step.tone])).toEqual([
      ['local', 'ok', '1 edited after it ran', 'warning'],
      [
        'staging',
        'error',
        'CONNECTION_FAILED: querySrv ENOTFOUND cluster0.ab12c.mongodb.net',
        'error',
      ],
      ['prod', 'not-set-up', 'Not set up for this project', 'warning'],
    ]);
    expect(model).toMatchObject({ pending: 0, items: [], more: 0 });
  });

  it('should list at most five pending migrations and count the rest', () => {
    const files = Array.from({ length: 7 }, (_, index) => `2026101${index}000000-step-${index}.js`);
    const model = buildPipeline(
      [
        ok(
          LOCAL,
          files.map((file) => pending(file)),
        ),
      ],
      'local',
      NOW,
    );

    expect(model.items).toHaveLength(5);
    expect(model.more).toBe(2);
    expect(model.pending).toBe(7);
  });
});

describe('isPipelineMessage', () => {
  it('should accept what the pipeline sends, and nothing else', () => {
    for (const message of [
      { type: 'ready' },
      { type: 'select', name: 'staging' },
      { type: 'review', dir: '/work/api' },
      { type: 'pick', dir: '/work/api', file: REGION },
      { type: 'console', dir: '/work/api' },
      { type: 'create' },
      { type: 'addEnvironment' },
    ]) {
      expect(isPipelineMessage(message), JSON.stringify(message)).toBe(true);
    }
    for (const message of [
      null,
      { type: 'up', dir: '/work/api' },
      { type: 'select' },
      { type: 'pick', dir: '/work/api' },
      { type: 'review', dir: 1 },
    ]) {
      expect(isPipelineMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});
