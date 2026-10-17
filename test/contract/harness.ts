import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { type JsonOutput, type MmkInvocation, runMmkJson } from '../../src/mmk/cli.js';
import { compareVersions, parseVersion } from '../../src/mmk/compat.js';
import { locateMmk } from '../../src/mmk/locate.js';
import { type ReadConfig, readProjectConfig } from '../../src/mmk/project-config.js';

/** The repository root, whose node_modules holds the pinned mongo-migrate-kit */
export const REPO_ROOT = path.resolve(__dirname, '../..');

/** The sample project every contract test starts from */
export const FIXTURE_WORKSPACE = path.join(REPO_ROOT, 'test/fixtures/workspace');

/** The fixture's migrations, in the order mmk applies them */
export const FIXTURE_FILES = [
  '20260101000000-create-users.js',
  '20260102000000-add-email-index.js',
  '20260103000000-backfill-user-status.js',
] as const;

/** The author every fixture migration declares */
export const FIXTURE_AUTHOR = 'Fixture Author <fixture@example.com>';

/** A copy of the fixture project with its own database, run through the real mmk */
export interface ContractProject {
  dir: string;
  migrationsDir: string;
  invocation: MmkInvocation;
  /** The pinned mongo-migrate-kit package directory */
  packageDir: string;
  env: Record<string, string>;
  /** Run `mmk <args> --json` in this project, as the extension does */
  run: (args: readonly string[], env?: Record<string, string>) => Promise<JsonOutput>;
  /** Read the resolved config the way the extension does (see `readProjectConfig`) */
  readConfig: (env?: Record<string, string>) => Promise<ReadConfig>;
  /** Add a migration file to this project */
  addMigration: (file: string, source: string) => void;
  cleanup: () => void;
}

/**
 * The first mongo-migrate-kit release with the requests this extension made (R2, R3, R5, R9,
 * R10, …), counting its pre-releases: a local build of it reports `1.6.0-dev.N`. Contract tests
 * expect 1.5 behaviour below it and the new behaviour from it, so CI stays green on the pinned
 * 1.5.0 while the requests are developed through an unreleased build. Once that release is
 * pinned, delete the 1.5 branches.
 */
export const NEXT_MMK = '1.6.0-0';

/** The version of the mongo-migrate-kit installed in node_modules (the pin, under `npm ci`) */
export function installedMmkVersion(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'node_modules/mongo-migrate-kit/package.json'), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

/** True when the installed mmk is {@link NEXT_MMK} or later */
export function hasNextMmk(): boolean {
  const installed = parseVersion(installedMmkVersion());
  const next = parseVersion(NEXT_MMK);
  return installed !== null && next !== null && compareVersions(installed, next) >= 0;
}

/** The mongo-migrate-kit version package.json pins for these tests */
export function pinnedMmkVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  const version = manifest.devDependencies['mongo-migrate-kit'];
  if (!version) {
    throw new Error('package.json must pin mongo-migrate-kit in devDependencies');
  }
  return version;
}

/**
 * Copy the fixture project into a temporary folder (so `create` never writes into the repo)
 * and point it at database `dbName` on `mongo`. mmk itself runs from the repo's node_modules.
 */
export async function createProject(
  mongo: MongoMemoryServer,
  dbName: string,
): Promise<ContractProject> {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mmk-contract-')));
  cpSync(FIXTURE_WORKSPACE, dir, { recursive: true });
  const install = await locateMmk(REPO_ROOT);
  if (!install) {
    throw new Error('mongo-migrate-kit is not installed in this repo: run npm install');
  }
  const invocation: MmkInvocation = {
    nodePath: process.execPath,
    script: install.script,
    cwd: dir,
  };
  const env = { MMK_URI: mongo.getUri(), MMK_DB: dbName };
  const migrationsDir = path.join(dir, 'migrations');
  return {
    dir,
    migrationsDir,
    invocation,
    packageDir: install.packageDir,
    env,
    run: (args, extraEnv = {}) =>
      runMmkJson(invocation, args, { env: { ...env, ...extraEnv }, timeoutMs: 60_000 }),
    readConfig: (extraEnv = {}) =>
      readProjectConfig(invocation, install.packageDir, {
        env: { ...env, ...extraEnv },
        timeoutMs: 60_000,
      }),
    addMigration: (file, source) => writeFileSync(path.join(migrationsDir, file), source),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
