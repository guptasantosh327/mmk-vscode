import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProjectRoots, locateMmk, resolveNode } from '../../src/mmk/locate.js';
import {
  addFiles,
  dependentPackageJson,
  fakeMmkInstall,
  makeExecutable,
  makeTree,
  removeTree,
} from './helpers/tmp.js';

const trees: string[] = [];

/** A temporary tree, deleted after the test */
function tree(files: Record<string, string> = {}): string {
  const root = makeTree(files);
  trees.push(root);
  return root;
}

afterEach(() => {
  for (const root of trees.splice(0)) {
    removeTree(root);
  }
});

describe('findProjectRoots', () => {
  it('should find a single project by its config file', async () => {
    const root = tree({ 'mmk.config.js': '', 'migrations/.keep': '' });

    await expect(findProjectRoots(root)).resolves.toEqual([
      { dir: root, configFile: path.join(root, 'mmk.config.js') },
    ]);
  });

  it('should pick the config file mmk itself would load first (ts, then js, then json)', async () => {
    const root = tree({ 'mmk.config.json': '{}', 'mmk.config.ts': '', 'mmk.config.js': '' });

    await expect(findProjectRoots(root)).resolves.toEqual([
      { dir: root, configFile: path.join(root, 'mmk.config.ts') },
    ]);
  });

  it('should find every project of a monorepo, not its hoisting root', async () => {
    const root = tree({
      'package.json': dependentPackageJson('monorepo'),
      'apps/api/mmk.config.ts': '',
      'apps/billing/mmk.config.json': '{}',
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
    });

    await expect(findProjectRoots(root)).resolves.toEqual([
      { dir: path.join(root, 'apps/api'), configFile: path.join(root, 'apps/api/mmk.config.ts') },
      {
        dir: path.join(root, 'apps/billing'),
        configFile: path.join(root, 'apps/billing/mmk.config.json'),
      },
    ]);
  });

  it('should find a project configured only through environment variables', async () => {
    const root = tree({ 'package.json': dependentPackageJson('env-only') });

    await expect(findProjectRoots(root)).resolves.toEqual([{ dir: root, configFile: null }]);
  });

  it('should prefer the deepest of nested dependent packages', async () => {
    const root = tree({
      'package.json': dependentPackageJson('root'),
      'services/orders/package.json': dependentPackageJson('orders'),
    });

    await expect(findProjectRoots(root)).resolves.toEqual([
      { dir: path.join(root, 'services/orders'), configFile: null },
    ]);
  });

  it('should not count a package that uses mmk inside a configured project', async () => {
    const root = tree({
      'mmk.config.js': '',
      'packages/app/package.json': dependentPackageJson('app'),
    });

    await expect(findProjectRoots(root)).resolves.toEqual([
      { dir: root, configFile: path.join(root, 'mmk.config.js') },
    ]);
  });

  it('should ignore node_modules, build output and hidden folders', async () => {
    const root = tree({
      'node_modules/some-lib/mmk.config.js': '',
      'dist/mmk.config.js': '',
      'out/package.json': dependentPackageJson('out'),
      '.cache/mmk.config.js': '',
    });

    await expect(findProjectRoots(root)).resolves.toEqual([]);
  });

  it('should ignore a package.json that does not depend on mongo-migrate-kit, or is invalid', async () => {
    const root = tree({
      'a/package.json': JSON.stringify({ dependencies: { mongodb: '^6' } }),
      'b/package.json': '{ not json',
    });

    await expect(findProjectRoots(root)).resolves.toEqual([]);
  });

  it('should stop at the depth limit', async () => {
    const root = tree({ 'a/b/c/mmk.config.js': '' });

    await expect(findProjectRoots(root, { maxDepth: 2 })).resolves.toEqual([]);
    await expect(findProjectRoots(root, { maxDepth: 3 })).resolves.toHaveLength(1);
  });

  it('should return nothing for a folder that does not exist', async () => {
    await expect(findProjectRoots(path.join(tree(), 'missing'))).resolves.toEqual([]);
  });
});

describe('locateMmk', () => {
  it("should find mongo-migrate-kit in the project's own node_modules", async () => {
    const root = tree({ 'mmk.config.js': '', ...fakeMmkInstall() });

    await expect(locateMmk(root)).resolves.toEqual({
      packageDir: path.join(root, 'node_modules/mongo-migrate-kit'),
      script: path.join(root, 'node_modules/mongo-migrate-kit/dist/mmk.cjs'),
      bin: path.join(root, 'node_modules/.bin/mmk'),
    });
  });

  it('should walk up to a monorepo root where the package is hoisted', async () => {
    const root = tree({ 'apps/api/mmk.config.js': '', ...fakeMmkInstall() });

    await expect(locateMmk(path.join(root, 'apps/api'))).resolves.toMatchObject({
      script: path.join(root, 'node_modules/mongo-migrate-kit/dist/mmk.cjs'),
    });
  });

  it('should prefer the nearest install over a hoisted one', async () => {
    const root = tree({ ...fakeMmkInstall(), ...fakeMmkInstall('apps/api/') });

    await expect(locateMmk(path.join(root, 'apps/api'))).resolves.toMatchObject({
      script: path.join(root, 'apps/api/node_modules/mongo-migrate-kit/dist/mmk.cjs'),
    });
  });

  it('should accept a string bin field and a missing .bin link', async () => {
    const root = tree({
      'node_modules/mongo-migrate-kit/package.json': JSON.stringify({ bin: './cli.js' }),
      'node_modules/mongo-migrate-kit/cli.js': '',
    });

    await expect(locateMmk(root)).resolves.toEqual({
      packageDir: path.join(root, 'node_modules/mongo-migrate-kit'),
      script: path.join(root, 'node_modules/mongo-migrate-kit/cli.js'),
      bin: null,
    });
  });

  it('should skip an install whose bin script is missing', async () => {
    const root = tree({
      'node_modules/mongo-migrate-kit/package.json': JSON.stringify({ bin: { mmk: 'gone.cjs' } }),
    });

    await expect(locateMmk(root)).resolves.toBeNull();
  });

  it('should return null when mongo-migrate-kit is not installed', async () => {
    const root = tree({ 'mmk.config.js': '', 'node_modules/other/package.json': '{}' });

    await expect(locateMmk(root)).resolves.toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('resolveNode', () => {
  it('should use the mmk.nodePath setting when it points at an executable', async () => {
    const root = tree({ 'bin/node': '' });
    const node = path.join(root, 'bin/node');
    makeExecutable(node);

    await expect(resolveNode(`  ${node} `, { PATH: '' })).resolves.toEqual({
      ok: true,
      path: node,
      source: 'setting',
    });
  });

  it('should explain a setting that points at nothing', async () => {
    const result = await resolveNode('/no/such/node', { PATH: process.env.PATH });

    expect(result).toEqual({
      ok: false,
      message:
        'The "mmk.nodePath" setting is "/no/such/node", but there\'s no executable there. Fix the path, or clear the setting to use node from PATH.',
    });
  });

  it('should find node on PATH, skipping entries without an executable node', async () => {
    const root = tree({ 'not-executable/node': '', 'real/node': '' });
    makeExecutable(path.join(root, 'real/node'));
    const searchPath = [
      '',
      path.join(root, 'empty'),
      path.join(root, 'not-executable'),
      path.join(root, 'real'),
    ].join(':');

    await expect(resolveNode(undefined, { PATH: searchPath })).resolves.toEqual({
      ok: true,
      path: path.join(root, 'real/node'),
      source: 'PATH',
    });
  });

  it('should treat an empty setting as unset', async () => {
    const root = tree({ node: '' });
    makeExecutable(path.join(root, 'node'));

    await expect(resolveNode('  ', { PATH: root })).resolves.toMatchObject({ source: 'PATH' });
  });

  it('should explain when node is not on PATH', async () => {
    await expect(resolveNode(undefined, { PATH: tree() })).resolves.toEqual({
      ok: false,
      message:
        'Couldn\'t find Node.js on PATH, and mmk needs it to run. Install Node.js, or set "mmk.nodePath" to the node executable.',
    });
  });

  it('should look for node.exe on Windows, using the Path variable', async () => {
    const root = tree({ 'node.exe': '' });
    addFiles(root, { node: '' });

    await expect(resolveNode(undefined, { Path: `C:\\nope;${root}` }, 'win32')).resolves.toEqual({
      ok: true,
      path: path.join(root, 'node.exe'),
      source: 'PATH',
    });
  });
});
