import path from 'node:path';
import { checksumOfBytes } from '../mmk/checksum.js';
import { repositoryRoot } from './branches.js';
import { gitText, readObjects } from './git.js';

/** The commit whose version of a migration file is the one that ran */
export interface AppliedVersion {
  commit: string;
  shortCommit: string;
  author: string;
  /** The commit's author date, ISO 8601 */
  date: string;
  subject: string;
  /** The repository's top folder */
  root: string;
  /** The file's path in that commit, relative to `root` with `/` (it may have moved since) */
  path: string;
  /** The file's bytes in that commit */
  content: Buffer;
}

/**
 * Find the version of `file` that mmk ran: walk its history (following renames, newest first),
 * hash each version the way mmk does, and return the first whose SHA-256 is `checksum`. Null
 * when no commit has it (e.g. it ran before it was committed) or `file` isn't in a repository.
 */
export async function findAppliedVersion(
  file: string,
  checksum: string,
): Promise<AppliedVersion | null> {
  const root = await repositoryRoot(path.dirname(file));
  if (root === null) {
    return null;
  }
  const relative = path.relative(root, file).split(path.sep).join('/');
  let log: string;
  try {
    log = await gitText(root, [
      '-c',
      'core.quotePath=false',
      'log',
      '--follow',
      '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s',
      '--name-only',
      '--',
      relative,
    ]);
  } catch {
    return null;
  }
  const commits = log
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .flatMap((record) => {
      const [header = '', ...names] = record.split('\n').map((line) => line.trim());
      const [commit, shortCommit, author, date, subject] = header.split('\x1f');
      const name = names.find((line) => line !== '');
      return commit && name
        ? [
            {
              commit,
              shortCommit: shortCommit ?? commit.slice(0, 7),
              author: author ?? '',
              date: date ?? '',
              subject: subject ?? '',
              path: name,
            },
          ]
        : [];
    });
  if (commits.length === 0) {
    return null;
  }
  const contents = await readObjects(
    root,
    commits.map((entry) => `${entry.commit}:${entry.path}`),
  );
  for (const [index, entry] of commits.entries()) {
    const content = contents[index];
    if (content && checksumOfBytes(content) === checksum) {
      return { ...entry, root, content };
    }
  }
  return null;
}

/** One version of a file from git, for the `mmk-applied:` documents */
export async function readVersion(
  root: string,
  commit: string,
  file: string,
): Promise<Buffer | null> {
  const [content] = await readObjects(root, [`${commit}:${file}`]);
  return content ?? null;
}
