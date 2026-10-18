import type { WireLockStatus } from './contract.js';
import { formatClock } from './model.js';
import type { ProjectSnapshot } from './store.js';

/** A migration lock another run holds, worded for the views */
export interface HeldLock {
  /** The user who holds it: `ci` */
  user: string;
  /** `ci on deploy-runner-7` */
  who: string;
  /** `pid 4242`, plus the namespace when the holder has one */
  process: string;
  /** When it was taken: `10:32` */
  since: string;
  /** How long it has been held: `4 min` */
  age: string;
  /** When it frees itself if that run crashed (`10:37`), or empty when mmk didn't say */
  frees: string;
  /** `Locked by ci on deploy-runner-7 (pid 4242) since 10:32`, for tooltips and the tree */
  summary: string;
  /** `If that run crashed, the lock frees itself by 10:37`, or empty when mmk didn't say */
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
  const who = `${holder.executedBy} on ${holder.host}`;
  const process = `pid ${holder.pid}${namespace}`;
  const taken = new Date(holder.acquiredAt ?? holder.lockedAt);
  const since = formatClock(taken, now);
  const frees = holder.expiresAt ? formatClock(new Date(holder.expiresAt), now) : '';
  return {
    user: holder.executedBy,
    who,
    process,
    since,
    age: formatAge(now.getTime() - taken.getTime()),
    frees,
    summary: `Locked by ${who} (${process}) since ${since}`,
    expires: frees ? `If that run crashed, the lock frees itself by ${frees}` : '',
  };
}

/** `just now`, `4 min`, `2 h 5 min`, `3 days` */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
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
