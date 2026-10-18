import { describe, expect, it } from 'vitest';
import type { WireLockStatus } from '../../src/mmk/contract.js';
import { environmentLock, environmentLocks, heldLock } from '../../src/mmk/lock-holder.js';
import type { ProjectSnapshot } from '../../src/mmk/store.js';

// Local times, so the clock times read the same in every time zone.
const NOW = new Date(2026, 9, 18, 10, 40);
const ACQUIRED = new Date(2026, 9, 18, 10, 32).toISOString();
const EXPIRES = new Date(2026, 9, 18, 10, 41).toISOString();

const HOLDER = {
  lockedAt: new Date(2026, 9, 18, 10, 40).toISOString(),
  pid: 4242,
  host: 'deploy-runner-7',
  executedBy: 'ci',
  acquiredAt: ACQUIRED,
  expiresAt: EXPIRES,
};

const HELD: WireLockStatus = { holder: HOLDER, stale: false };

function project(lock: WireLockStatus | null, runningOn: string | null = null): ProjectSnapshot {
  return {
    dir: '/work/billing-api',
    state: {
      kind: 'mmk-missing',
      root: { dir: '/work/billing-api', configFile: null },
      message: '',
    },
    config: null,
    rows: null,
    error: null,
    loading: false,
    environments: {
      local: {
        rows: [],
        error: null,
        loading: false,
        connected: true,
        database: null,
        readAt: null,
        lock,
      },
    },
    running: runningOn ? 'up' : null,
    runningOn,
  };
}

describe('heldLock', () => {
  it('should word the holder mmk reported, since when, and when it frees itself', () => {
    expect(heldLock(HELD, NOW)).toEqual({
      holder: 'ci on deploy-runner-7 (pid 4242)',
      summary: 'Locked by ci on deploy-runner-7 (pid 4242) since 10:32',
      expires: 'If that run crashed, the lock frees itself at 10:41',
    });
  });

  it("should name the holder's namespace, and the day when it isn't today", () => {
    const lock = heldLock(
      {
        holder: {
          ...HOLDER,
          namespace: 'billing-api',
          acquiredAt: new Date(2026, 9, 17, 23, 5).toISOString(),
        },
        stale: false,
      },
      NOW,
    );

    expect(lock?.summary).toBe(
      'Locked by ci on deploy-runner-7 (pid 4242), namespace "billing-api" since 17 Oct 23:05',
    );
  });

  it('should use when it was locked, and say nothing about expiry, for a pre-1.5 holder', () => {
    const { acquiredAt: _acquired, expiresAt: _expires, ...old } = HOLDER;

    expect(heldLock({ holder: old, stale: false }, NOW)).toEqual({
      holder: 'ci on deploy-runner-7 (pid 4242)',
      summary: 'Locked by ci on deploy-runner-7 (pid 4242) since 10:40',
      expires: '',
    });
  });

  it('should show nothing without a lock, without a holder, or when mmk says it went stale', () => {
    expect(heldLock(null, NOW)).toBeNull();
    expect(heldLock(undefined, NOW)).toBeNull();
    expect(heldLock({ holder: null, stale: false }, NOW)).toBeNull();
    expect(heldLock({ holder: HOLDER, stale: true }, NOW)).toBeNull();
  });
});

describe('environmentLock', () => {
  it("should show another run's lock", () => {
    expect(environmentLock(project(HELD), 'local', NOW)?.summary).toContain('Locked by ci');
    expect(environmentLocks(project(HELD), [{ name: 'local' }, { name: 'prod' }], NOW)).toEqual({
      local: heldLock(HELD, NOW),
      prod: null,
    });
  });

  it("should not show the lock of the project's own run on that environment", () => {
    expect(environmentLock(project(HELD, 'local'), 'local', NOW)).toBeNull();
    expect(environmentLock(undefined, 'local', NOW)).toBeNull();
  });
});
