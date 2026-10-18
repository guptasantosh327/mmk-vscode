import { describe, expect, it } from 'vitest';
import {
  ContractError,
  parseCreateResult,
  parseErrorDocument,
  parseLockStatus,
  parseRunResults,
  parseStatusRows,
  parseUnlockResult,
} from '../../src/mmk/contract.js';

const APPLIED_ROW = {
  file: '20260101000000-create-users.js',
  status: 'applied',
  batch: 1,
  appliedAt: '2026-10-16T10:31:00.000Z',
  duration: 42,
  checksumOk: true,
  description: 'Create the users collection',
  author: 'Ada <ada@example.com>',
};

const PENDING_ROW = {
  file: '20260102000000-add-email-index.js',
  status: 'pending',
  batch: null,
  appliedAt: null,
  duration: null,
  checksumOk: null,
};

describe('parseStatusRows', () => {
  it('should accept applied and pending rows as mmk prints them', () => {
    const rows = [APPLIED_ROW, PENDING_ROW];

    expect(parseStatusRows(rows, 'status')).toEqual(rows);
  });

  it('should accept the optional namespace, fileMissing and unadopted flags', () => {
    const row = { ...APPLIED_ROW, namespace: 'billing', fileMissing: true, unadopted: true };

    expect(parseStatusRows([row], 'status')).toEqual([row]);
  });

  it('should accept an empty list', () => {
    expect(parseStatusRows([], 'list')).toEqual([]);
  });

  it('should keep fields this extension does not read yet', () => {
    const row = { ...APPLIED_ROW, recordedBy: 'a field from a newer mmk' };

    expect(parseStatusRows([row], 'status')).toEqual([row]);
  });

  it('should accept the recorded checksum (R5) and refuse one that is not a SHA-256', () => {
    const checksum = 'a'.repeat(64);

    expect(parseStatusRows([{ ...APPLIED_ROW, checksum }], 'status')[0]?.checksum).toBe(checksum);
    expect(() => parseStatusRows([{ ...APPLIED_ROW, checksum: 'abc123' }], 'status')).toThrow(
      'row 0.checksum should be a SHA-256 hex string, but it is the string "abc123"',
    );
  });

  it('should refuse output that is not an array', () => {
    expect(() => parseStatusRows({ rows: [] }, 'status')).toThrow(
      "mmk status --json returned something this extension can't read: the output should be an array, but it is an object",
    );
  });

  it('should name the row and field that has the wrong type', () => {
    const rows = [APPLIED_ROW, { ...PENDING_ROW, batch: '2' }];

    expect(() => parseStatusRows(rows, 'status')).toThrow(
      'row 1.batch should be a number or null, but it is the string "2"',
    );
  });

  it('should refuse a missing required field', () => {
    const { checksumOk: _omitted, ...row } = PENDING_ROW;

    expect(() => parseStatusRows([row], 'list')).toThrow(
      "mmk list --json returned something this extension can't read: row 0.checksumOk should be true, false or null, but it is missing",
    );
  });

  it('should refuse a status mmk does not define', () => {
    expect(() => parseStatusRows([{ ...PENDING_ROW, status: 'reverted' }], 'status')).toThrow(
      'row 0.status should be "applied" or "pending"',
    );
  });

  it('should refuse an appliedAt that is not a date', () => {
    expect(() => parseStatusRows([{ ...APPLIED_ROW, appliedAt: 'yesterday' }], 'status')).toThrow(
      'row 0.appliedAt should be an ISO date string or null',
    );
  });

  it('should refuse an optional field with the wrong type', () => {
    expect(() => parseStatusRows([{ ...APPLIED_ROW, fileMissing: 'yes' }], 'status')).toThrow(
      'row 0.fileMissing should be true or false',
    );
  });

  it('should throw a ContractError naming the command and field', () => {
    try {
      parseStatusRows([null], 'dry-run');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect(error).toMatchObject({ command: 'dry-run', field: 'row 0' });
    }
  });
});

describe('parseRunResults', () => {
  it('should accept every result status', () => {
    const results = [
      { file: 'a.js', status: 'applied', duration: 12, batch: 3 },
      { file: 'b.js', status: 'reverted', duration: 4, batch: 3 },
      { file: 'c.js', status: 'skipped', reason: 'Already applied' },
      { file: 'd.js', status: 'error', duration: 1, error: 'boom' },
    ];

    expect(parseRunResults(results, 'up')).toEqual(results);
  });

  it('should refuse an unknown status', () => {
    expect(() => parseRunResults([{ file: 'a.js', status: 'done' }], 'up')).toThrow(
      'result 0.status should be one of applied, reverted, skipped, error',
    );
  });
});

describe('parseCreateResult', () => {
  it('should return the path', () => {
    expect(parseCreateResult({ path: '/p/migrations/1-x.js' })).toEqual({
      path: '/p/migrations/1-x.js',
    });
  });

  it('should refuse a missing path', () => {
    expect(() => parseCreateResult({})).toThrow('the output.path should be a string');
  });
});

describe('parseUnlockResult', () => {
  it('should accept no holder', () => {
    expect(parseUnlockResult({ released: false, holder: null })).toEqual({
      released: false,
      holder: null,
    });
  });

  it('should accept a released holder', () => {
    const holder = {
      lockedAt: '2026-10-16T10:31:00.000Z',
      pid: 4242,
      host: 'ci-runner',
      executedBy: 'deploy',
      namespace: 'billing',
      acquiredAt: '2026-10-16T10:30:00.000Z',
      expiresAt: '2026-10-16T10:32:00.000Z',
    };

    expect(parseUnlockResult({ released: true, holder })).toEqual({ released: true, holder });
  });

  it('should refuse a holder without a pid', () => {
    expect(() =>
      parseUnlockResult({
        released: true,
        holder: { lockedAt: '2026-10-16T10:31:00.000Z', host: 'h', executedBy: 'u' },
      }),
    ).toThrow('holder.pid should be a number, but it is missing');
  });
});

describe('parseLockStatus', () => {
  const holder = {
    lockedAt: '2026-10-16T10:31:30.000Z',
    pid: 4242,
    host: 'deploy-runner-7',
    executedBy: 'ci',
    acquiredAt: '2026-10-16T10:31:00.000Z',
    expiresAt: '2026-10-16T10:32:30.000Z',
  };

  it('should accept no lock, a held one and a stale one', () => {
    expect(parseLockStatus({ holder: null, stale: false })).toEqual({ holder: null, stale: false });
    expect(parseLockStatus({ holder, stale: false })).toEqual({ holder, stale: false });
    expect(parseLockStatus({ holder, stale: true })).toEqual({ holder, stale: true });
  });

  it('should refuse output without stale, or a holder without a pid', () => {
    expect(() => parseLockStatus({ holder: null })).toThrow(
      'stale should be true or false, but it is missing',
    );
    expect(() => parseLockStatus({ holder: { ...holder, pid: undefined }, stale: false })).toThrow(
      'holder.pid should be a number, but it is missing',
    );
  });
});

describe('parseErrorDocument', () => {
  it('should read code, message and details', () => {
    expect(
      parseErrorDocument({
        error: { code: 'CONFIG_INVALID', message: 'dbName is missing', details: { issues: [] } },
      }),
    ).toEqual({ code: 'CONFIG_INVALID', message: 'dbName is missing', details: { issues: [] } });
  });

  it('should accept a failure without a code', () => {
    expect(parseErrorDocument({ error: { message: 'Something broke' } })).toEqual({
      message: 'Something broke',
    });
  });

  it('should keep a code this extension does not know yet', () => {
    expect(parseErrorDocument({ error: { code: 'BRAND_NEW', message: 'm' } })).toEqual({
      code: 'BRAND_NEW',
      message: 'm',
    });
  });

  it.each([
    ['an array of rows', [{ error: { message: 'x' } }]],
    ['null', null],
    ['an error without a message', { error: { code: 'X' } }],
    ['an error that is a string', { error: 'boom' }],
    ['a result object', { released: false, holder: null }],
  ])('should return null for %s', (_label, value) => {
    expect(parseErrorDocument(value)).toBeNull();
  });
});
