import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findAppliedVersion, readVersion } from '../../src/git/applied-version.js';
import {
  branchesWithFile,
  currentBranch,
  defaultRemoteRef,
  repositoryRoot,
} from '../../src/git/branches.js';
import { GitError } from '../../src/git/git.js';
import { copyRefFolder } from '../../src/git/ref-files.js';
import { checksumOfText } from '../../src/mmk/checksum.js';
import { addFiles, makeTree, removeTree } from './helpers/tmp.js';

let repo: string;
let migrations: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

const CRLF = 'export async function up() {}\r\nexport async function down() {}\r\n';
const BOM = '﻿export async function up() {}\nexport async function down() {}\n';

beforeAll(() => {
  repo = makeTree({
    'api/migrations/0001-a.js': 'a on main\n',
    'api/migrations/0002-crlf.js': CRLF,
    'api/migrations/0003-bom.js': BOM,
    'api/migrations/nested/ignored.js': 'not a migration\n',
    'api/package.json': '{}',
  });
  migrations = path.join(repo, 'api', 'migrations');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-q', '-m', 'main');
  // A remote-tracking ref, as a clone would have it.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'feat/refunds');
  addFiles(repo, { 'api/migrations/0004-refunds.js': 'refunds\n' });
  writeFileSync(path.join(migrations, '0001-a.js'), 'a edited on the branch\n');
  git('add', '.');
  git('commit', '-q', '-m', 'refunds');
  git('checkout', '-q', '-b', 'feat/other', 'main');
});

afterAll(() => {
  removeTree(repo);
});

describe('branches', () => {
  it('should find the repository root and the checked-out branch', async () => {
    expect(await repositoryRoot(migrations)).toBe(repo);
    expect(await currentBranch(migrations)).toBe('feat/other');
  });

  it('should return null outside a repository', async () => {
    const outside = makeTree({ 'x.txt': '' });
    try {
      expect(await repositoryRoot(outside)).toBeNull();
      expect(await currentBranch(outside)).toBeNull();
      expect(await defaultRemoteRef(outside)).toBeNull();
    } finally {
      removeTree(outside);
    }
  });

  it('should find origin/main when origin/HEAD is not set', async () => {
    expect(await defaultRemoteRef(migrations)).toBe('origin/main');
  });

  it("should prefer origin/HEAD when it's set", async () => {
    git('update-ref', 'refs/remotes/origin/trunk', 'main');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    try {
      expect(await defaultRemoteRef(migrations)).toBe('origin/trunk');
    } finally {
      git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
      git('update-ref', '-d', 'refs/remotes/origin/trunk');
    }
  });

  it('should name the branches whose tip has a file, local ones first', async () => {
    const file = path.join(migrations, '0004-refunds.js');

    expect(await branchesWithFile(migrations, file, 'feat/other')).toEqual(['feat/refunds']);
    expect(
      await branchesWithFile(migrations, path.join(migrations, '0001-a.js'), 'feat/other'),
    ).toEqual(['feat/refunds', 'main', 'origin/main']);
  });

  it('should name no branch for a file that is on none', async () => {
    expect(await branchesWithFile(migrations, path.join(migrations, '0099-gone.js'), null)).toEqual(
      [],
    );
  });
});

describe('copyRefFolder', () => {
  it("should copy a ref's migrations byte for byte, without the subfolders", async () => {
    const copy = await copyRefFolder(migrations, 'feat/refunds');
    try {
      expect(copy.files).toBe(4);
      expect(readdirSync(copy.dir).sort()).toEqual([
        '0001-a.js',
        '0002-crlf.js',
        '0003-bom.js',
        '0004-refunds.js',
      ]);
      expect(readFileSync(path.join(copy.dir, '0001-a.js'), 'utf8')).toBe(
        'a edited on the branch\n',
      );
      expect(readFileSync(path.join(copy.dir, '0002-crlf.js'), 'utf8')).toBe(CRLF);
      expect(readFileSync(path.join(copy.dir, '0003-bom.js'), 'utf8')).toBe(BOM);
    } finally {
      await copy.dispose();
    }
    expect(existsSync(copy.dir)).toBe(false);
  });

  it('should leave the working tree and the checkout alone', async () => {
    const before = git('status', '--porcelain');
    const copy = await copyRefFolder(migrations, 'origin/main');
    await copy.dispose();

    expect(git('status', '--porcelain')).toBe(before);
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('feat/other');
    expect(copy.files).toBe(3);
  });

  it('should copy nothing when the folder is not on the ref', async () => {
    addFiles(repo, { 'web/migrations/0001-x.js': 'x\n' });
    const copy = await copyRefFolder(path.join(repo, 'web', 'migrations'), 'main');
    try {
      expect(copy.files).toBe(0);
      expect(readdirSync(copy.dir)).toEqual([]);
    } finally {
      await copy.dispose();
      removeTree(path.join(repo, 'web'));
    }
  });

  it('should say to fetch when the ref does not exist', async () => {
    await expect(copyRefFolder(migrations, 'origin/nope')).rejects.toThrow(
      "There's no origin/nope in this clone. Fetch it first (git fetch), then compare again.",
    );
    await expect(copyRefFolder(migrations, 'origin/nope')).rejects.toBeInstanceOf(GitError);
  });
});

describe('findAppliedVersion', () => {
  let history: string;
  const file = (): string => path.join(history, 'migrations', '0002-backfill.js');
  const run = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: history,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Asha Rao',
        GIT_AUTHOR_EMAIL: 'asha@example.com',
        GIT_AUTHOR_DATE: '2026-09-12T10:00:00Z',
        GIT_COMMITTER_NAME: 'Asha Rao',
        GIT_COMMITTER_EMAIL: 'asha@example.com',
      },
    }).trim();

  const V0 = 'export async function up() { /* v0 */ }\r\nexport async function down() {}\r\n';
  const V1 = 'export async function up() { /* v1 */ }\r\nexport async function down() {}\r\n';
  const V2 = '﻿export async function up() { /* v2 */ }\nexport async function down() {}\n';
  const V3 = 'export async function up() { /* v3 */ }\nexport async function down() {}\n';

  beforeAll(() => {
    history = makeTree({ 'migrations/0002-old-name.js': V0 });
    run('init', '-q', '-b', 'main');
    run('config', 'core.autocrlf', 'false');
    run('add', '.');
    run('commit', '-q', '-m', 'v0');
    writeFileSync(path.join(history, 'migrations', '0002-old-name.js'), V1);
    run('commit', '-q', '-am', 'v1');
    run('mv', 'migrations/0002-old-name.js', 'migrations/0002-backfill.js');
    run('commit', '-q', '-m', 'rename');
    writeFileSync(file(), V2);
    run('commit', '-q', '-am', 'v2, renamed');
    writeFileSync(file(), V3);
    run('commit', '-q', '-am', 'v3');
    writeFileSync(file(), 'export async function up() { /* uncommitted */ }\n');
  });

  afterAll(() => {
    removeTree(history);
  });

  it('should find the commit whose version has the checksum, through a rename', async () => {
    const found = await findAppliedVersion(file(), checksumOfText(V0));

    expect(found).toMatchObject({
      author: 'Asha Rao',
      date: '2026-09-12T10:00:00Z',
      subject: 'v0',
      path: 'migrations/0002-old-name.js',
      root: history,
    });
    expect(found?.content.toString('utf8')).toBe(V0);
    expect(found?.shortCommit).toBe(found?.commit.slice(0, found.shortCommit.length));
  });

  it('should take the newest commit with that version: here the rename', async () => {
    expect(await findAppliedVersion(file(), checksumOfText(V1))).toMatchObject({
      subject: 'rename',
      path: 'migrations/0002-backfill.js',
    });
  });

  it('should hash each version as mmk does: a BOM kept, CRLF as it is', async () => {
    expect((await findAppliedVersion(file(), checksumOfText(V2)))?.subject).toBe('v2, renamed');
    expect((await findAppliedVersion(file(), checksumOfText(V3)))?.subject).toBe('v3');
  });

  it('should find nothing for a version that was never committed', async () => {
    expect(await findAppliedVersion(file(), checksumOfText('not in history'))).toBeNull();
  });

  it('should read one version back for the applied document', async () => {
    const found = await findAppliedVersion(file(), checksumOfText(V2));

    expect(
      (await readVersion(history, found?.commit ?? '', found?.path ?? ''))?.toString('utf8'),
    ).toBe(V2);
    expect(await readVersion(history, found?.commit ?? '', 'migrations/nope.js')).toBeNull();
  });
});
