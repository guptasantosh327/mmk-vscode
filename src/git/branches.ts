import path from 'node:path';
import { GitError, gitText } from './git.js';

/** The repository's top folder for a path inside it, or null outside a git repository */
export async function repositoryRoot(dir: string): Promise<string | null> {
  try {
    return path.resolve(await gitText(dir, ['rev-parse', '--show-toplevel']));
  } catch (error) {
    if (error instanceof GitError) {
      return null;
    }
    throw error;
  }
}

/** The checked-out branch, e.g. `feat/refunds`; null when HEAD is detached or not in a repository */
export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const name = await gitText(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/**
 * The remote branch new work merges into: `origin/HEAD` when the clone knows it, otherwise
 * `origin/main` or `origin/master` if one exists. Null when there's none.
 */
export async function defaultRemoteRef(dir: string): Promise<string | null> {
  try {
    const head = await gitText(dir, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    if (head !== '') {
      return head;
    }
  } catch {
    // origin/HEAD isn't set in every clone; try the usual names.
  }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await gitText(dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Not there; try the next one.
    }
  }
  return null;
}

/**
 * Branches (local first, then remote) whose latest commit has `file`, other than `exclude`.
 * Used to say which branch a migration whose file isn't checked out probably came from. A file
 * deleted everywhere is on no branch, so it is never reported.
 */
export async function branchesWithFile(
  dir: string,
  file: string,
  exclude: string | null,
): Promise<string[]> {
  const root = await repositoryRoot(dir);
  if (root === null) {
    return [];
  }
  const relative = path.relative(root, file).split(path.sep).join('/');
  const listed = await gitText(root, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ]).catch(() => '');
  const refs = listed
    .split('\n')
    .map((ref) => ref.trim())
    .filter((ref) => ref !== '' && !ref.endsWith('/HEAD'));
  if (refs.length === 0) {
    return [];
  }
  const checked = await gitText(root, ['cat-file', '--batch-check'], {
    input: `${refs.map((ref) => `${ref}:${relative}`).join('\n')}\n`,
  }).catch(() => '');
  const lines = checked.split('\n');
  const found = refs.filter((_ref, index) => / blob \d+$/.test(lines[index] ?? ''));
  const local = found
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
  const remote = found
    .filter((ref) => ref.startsWith('refs/remotes/'))
    .map((ref) => ref.slice('refs/remotes/'.length));
  return [...local, ...remote].filter((name) => name !== exclude);
}
