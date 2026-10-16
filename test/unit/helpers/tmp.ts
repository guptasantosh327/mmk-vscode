import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Files to create, by path relative to the tree's root */
export type TreeSpec = Record<string, string>;

/** Create a temporary directory holding `files`, and return its real absolute path */
export function makeTree(files: TreeSpec = {}): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mmk-vscode-test-')));
  addFiles(root, files);
  return root;
}

/** Add `files` under `root`, creating directories as needed */
export function addFiles(root: string, files: TreeSpec): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** Make a file executable by its owner */
export function makeExecutable(file: string): void {
  chmodSync(file, 0o755);
}

/** Delete a temporary tree */
export function removeTree(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Files for a fake mongo-migrate-kit install under `<prefix>node_modules`, whose `mmk` script
 * runs `script`.
 */
export function fakeMmkInstall(
  prefix = '',
  script = "process.stdout.write('1.5.0\\n');\n",
): TreeSpec {
  return {
    [`${prefix}node_modules/mongo-migrate-kit/package.json`]: JSON.stringify({
      name: 'mongo-migrate-kit',
      version: '1.5.0',
      bin: { mmk: 'dist/mmk.cjs' },
    }),
    [`${prefix}node_modules/mongo-migrate-kit/dist/mmk.cjs`]: script,
    [`${prefix}node_modules/.bin/mmk`]: '#!/bin/sh\n',
  };
}

/** A package.json that depends on mongo-migrate-kit */
export function dependentPackageJson(name: string): string {
  return JSON.stringify({ name, devDependencies: { 'mongo-migrate-kit': '^1.5.0' } });
}
