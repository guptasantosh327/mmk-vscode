import type { WireLockStatus } from './contract.js';
import { formatClock } from './model.js';
import type { ProjectSnapshot } from './store.js';

/** A migration lock another run holds, worded for the views */
export interface HeldLock {
  /** `ci on deploy-runner-7 (pid 4242)`, plus the namespace when the holder has one */
  holder: string;
  /** `Locked by ci on deploy-runner-7 (pid 4242) since 10:32` */
  summary: string;
  /** `If that run crashed, the lock frees itself at 10:47`, or empty when mmk didn't say */
  expires: string;
}

/**
 * The lock as the views show it, or null when there's nothing to show: no lock, an mmk that
 * can't say (before `mmk lock`), or a lock mmk reports stale (its holder stopped renewing it, so
 * the next run takes it over by itself). Holder, times and staleness are mmk's; this only words
 * them.
 */
export function heldLock(
  lock: WireLockStatus | null | undefined,
  now: Date = new Date(),
): HeldLock | null {
  const holder = lock?.holder;
  if (!lock || !holder || lock.stale) {
    return null;
  }
  const namespace = holder.namespace === undefined ? '' : `, namespace "${holder.namespace}"`;
  const who = `${holder.executedBy} on ${holder.host} (pid ${holder.pid})${namespace}`;
  const since = new Date(holder.acquiredAt ?? holder.lockedAt);
  return {
    holder: who,
    summary: `Locked by ${who} since ${formatClock(since, now)}`,
    expires: holder.expiresAt
      ? `If that run crashed, the lock frees itself at ${formatClock(new Date(holder.expiresAt), now)}`
      : '',
  };
}

/**
 * The lock to show on one environment of a project. None while the project's own run is on that
 * environment: that run is the holder, and the views already say it's running.
 */
export function environmentLock(
  project: ProjectSnapshot | undefined,
  environment: string,
  now: Date = new Date(),
): HeldLock | null {
  if (!project || project.runningOn === environment) {
    return null;
  }
  return heldLock(project.environments[environment]?.lock, now);
}

/** {@link environmentLock} for each environment, by name */
export function environmentLocks(
  project: ProjectSnapshot | undefined,
  environments: readonly { name: string }[],
  now: Date = new Date(),
): Record<string, HeldLock | null> {
  return Object.fromEntries(
    environments.map((environment) => [
      environment.name,
      environmentLock(project, environment.name, now),
    ]),
  );
}
