import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repositoryRoot } from './branches.js';
import { GitError, runGit } from './git.js';

/** A ref's copy of a folder, in a temporary folder of its own */
export interface RefFolder {
  /** The temporary folder holding the files */
  dir: string;
  /** How many files were copied */
  files: number;
  /** Delete the temporary folder */
  dispose: () => Promise<void>;
}

/**
 * Copy the files directly inside `folder` as they are on `ref` (e.g. `origin/main`) into a new
 * temporary folder, byte for byte, without touching the working tree, the index or the
 * checkout. Only the folder's own files are copied, as mmk reads its migrations folder.
 * @throws {@link GitError} when the ref or folder can't be read
 */
export async function copyRefFolder(folder: string, ref: string): Promise<RefFolder> {
  const root = await repositoryRoot(folder);
  if (root === null) {
    throw new GitError(
      [],
      '',
      `${folder} isn't in a git repository, so there's no ${ref} to compare.`,
    );
  }
  const relative = path.relative(root, folder).split(path.sep).join('/');
  const spec = relative === '' ? `${ref}:` : `${ref}:${relative}`;
  try {
    await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new GitError(
      ['rev-parse'],
      '',
      `There's no ${ref} in this clone. Fetch it first (git fetch), then compare again.`,
    );
  }

  const listing = await runGit(root, ['ls-tree', '-z', spec]).catch((error: unknown) => {
    if (error instanceof GitError) {
      return Buffer.alloc(0);
    }
    throw error;
  });
  const blobs = parseTree(listing);
  const dir = await mkdtemp(path.join(tmpdir(), 'mmk-ref-'));
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    if (blobs.length > 0) {
      const contents = parseBatch(
        await runGit(root, ['cat-file', '--batch'], {
          input: `${blobs.map((blob) => blob.sha).join('\n')}\n`,
        }),
      );
      for (const [index, blob] of blobs.entries()) {
        const content = contents[index];
        if (content === undefined) {
          throw new GitError(['cat-file'], '', `git didn't return ${blob.name} from ${ref}.`);
        }
        await writeFile(path.join(dir, blob.name), content);
      }
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return { dir, files: blobs.length, dispose };
}

/** The regular files in `git ls-tree -z` output (no subfolders, links or submodules) */
function parseTree(listing: Buffer): Array<{ sha: string; name: string }> {
  const blobs: Array<{ sha: string; name: string }> = [];
  for (const entry of listing.toString('utf8').split('\0')) {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(entry);
    if (match?.[2] && match[3] && (match[1] === '100644' || match[1] === '100755')) {
      blobs.push({ sha: match[2], name: match[3] });
    }
  }
  return blobs;
}

/** The contents in `git cat-file --batch` output: `<sha> blob <size>\n<bytes>\n` per object */
function parseBatch(output: Buffer): Buffer[] {
  const contents: Buffer[] = [];
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) {
      break;
    }
    const header = output.subarray(offset, newline).toString('utf8');
    const size = Number(/^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1]);
    if (!Number.isInteger(size)) {
      throw new GitError(['cat-file'], '', `Unexpected git cat-file output: ${header}`);
    }
    contents.push(output.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
  return contents;
}
