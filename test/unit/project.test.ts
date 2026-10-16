import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeResolution } from '../../src/mmk/locate.js';
import { discoverProjects, inspectProject } from '../../src/mmk/project.js';
import { addFiles, fakeMmkInstall, makeTree, removeTree } from './helpers/tmp.js';

const NODE: NodeResolution = { ok: true, path: process.execPath, source: 'PATH' };

const trees: string[] = [];

function tree(files: Record<string, string>): string {
  const root = makeTree(files);
  trees.push(root);
  return root;
}

afterEach(() => {
  for (const root of trees.splice(0)) {
    removeTree(root);
  }
});

/** A project whose fake mmk prints `version` for `--version` */
function projectWithMmk(version: string): string {
  return tree({
    'mmk.config.js': '',
    ...fakeMmkInstall('', `process.stdout.write(${JSON.stringify(`${version}\n`)});\n`),
  });
}

describe('inspectProject', () => {
  it('should be ready when mmk is installed, runs, and is new enough', async () => {
    const dir = projectWithMmk('1.5.0');
    const root = { dir, configFile: path.join(dir, 'mmk.config.js') };

    await expect(inspectProject(root, NODE, 10_000)).resolves.toEqual({
      kind: 'ready',
      root,
      version: '1.5.0',
      install: {
        packageDir: path.join(dir, 'node_modules/mongo-migrate-kit'),
        script: path.join(dir, 'node_modules/mongo-migrate-kit/dist/mmk.cjs'),
        bin: path.join(dir, 'node_modules/.bin/mmk'),
      },
      invocation: {
        nodePath: process.execPath,
        script: path.join(dir, 'node_modules/mongo-migrate-kit/dist/mmk.cjs'),
        cwd: dir,
      },
    });
  });

  it('should turn features off for an mmk older than the minimum', async () => {
    const dir = projectWithMmk('1.4.0');

    await expect(inspectProject({ dir, configFile: null }, NODE, 10_000)).resolves.toMatchObject({
      kind: 'too-old',
      message: expect.stringContaining('Update mongo-migrate-kit to 1.5.0 or later'),
    });
  });

  it('should say how to install mongo-migrate-kit when it is missing', async () => {
    const dir = tree({ 'mmk.config.js': '' });

    await expect(inspectProject({ dir, configFile: null }, NODE, 10_000)).resolves.toEqual({
      kind: 'mmk-missing',
      root: { dir, configFile: null },
      message: `mongo-migrate-kit isn't installed for ${dir}. Install it in this project: npm install mongo-migrate-kit mongodb`,
    });
  });

  it("should pass on the reason Node.js wasn't found", async () => {
    const dir = projectWithMmk('1.5.0');
    const node: NodeResolution = { ok: false, message: 'No node here' };

    await expect(inspectProject({ dir, configFile: null }, node, 10_000)).resolves.toMatchObject({
      kind: 'node-missing',
      message: 'No node here',
    });
  });

  it('should report an mmk that fails to print its version', async () => {
    const dir = tree({
      'mmk.config.js': '',
      ...fakeMmkInstall(
        '',
        "process.stderr.write('Cannot find module mongodb\\n'); process.exit(1);\n",
      ),
    });

    await expect(inspectProject({ dir, configFile: null }, NODE, 10_000)).resolves.toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('Cannot find module mongodb'),
    });
  });
});

describe('discoverProjects', () => {
  it('should inspect a project once even when two workspace folders contain it', async () => {
    const dir = projectWithMmk('2.0.0');
    addFiles(dir, { 'apps/api/mmk.config.js': '' });

    const states = await discoverProjects({
      folders: [dir, path.join(dir, 'apps')],
      nodePath: process.execPath,
      env: {},
    });

    expect(states.map((state) => [path.relative(dir, state.root.dir), state.kind])).toEqual([
      ['', 'ready'],
      [path.join('apps', 'api'), 'ready'],
    ]);
  });

  it('should report every project when node cannot be found', async () => {
    const dir = projectWithMmk('1.5.0');

    await expect(
      discoverProjects({ folders: [dir], nodePath: path.join(dir, 'no-node'), env: {} }),
    ).resolves.toMatchObject([{ kind: 'node-missing' }]);
  });

  it('should return nothing for a folder without projects', async () => {
    const dir = tree({ 'README.md': '' });

    await expect(discoverProjects({ folders: [dir], nodePath: '', env: {} })).resolves.toEqual([]);
  });
});
