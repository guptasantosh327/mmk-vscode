import { constants, type Dirent } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The config file names mmk discovers in its working directory, in its priority order
 * (`CONFIG_FILE_NAMES` in mongo-migrate-kit's `src/core/config.ts`). mmk only looks in its cwd,
 * so the directory holding one of these is where mmk must run.
 */
export const CONFIG_FILE_NAMES = ['mmk.config.ts', 'mmk.config.js', 'mmk.config.json'] as const;

/** The npm package that provides the `mmk` binary */
export const MMK_PACKAGE = 'mongo-migrate-kit';

/** Directories never searched for projects: dependencies and build output */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage']);

/** A directory mmk runs in */
export interface ProjectRoot {
  /** Absolute directory used as mmk's cwd, where it finds its config file and `.env` */
  dir: string;
  /**
   * The config file mmk will load from `dir`, or null for a project configured only through
   * environment variables (found by its package.json depending on mongo-migrate-kit)
   */
  configFile: string | null;
}

/** Limits for {@link findProjectRoots}, so a huge folder can't stall activation */
export interface FindProjectRootsOptions {
  /** How many directory levels below the folder to search. Default: 6 */
  maxDepth?: number;
  /** Stop after reading this many directories. Default: 5000 */
  maxDirs?: number;
}

/**
 * Find every mmk project inside `folder`: each directory that has an mmk config file, and each
 * package.json that depends on mongo-migrate-kit (a project configured only through `MMK_*`
 * environment variables).
 *
 * A package.json counts only when no config-file project is above, at or below it, and no other
 * dependent package is below it: a monorepo root that only hoists the dependency, or a package
 * that calls mmk's API inside a configured project, is not a project of its own. Hidden
 * directories, `node_modules` and build output are skipped, and symlinks are not followed.
 */
export async function findProjectRoots(
  folder: string,
  options: FindProjectRootsOptions = {},
): Promise<ProjectRoot[]> {
  const maxDepth = options.maxDepth ?? 6;
  const maxDirs = options.maxDirs ?? 5000;

  const configProjects: ProjectRoot[] = [];
  const dependents: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: path.resolve(folder), depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < maxDirs) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    visited += 1;
    const entries = await readDirSafe(next.dir);
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));

    const configName = CONFIG_FILE_NAMES.find((name) => files.has(name));
    if (configName) {
      configProjects.push({ dir: next.dir, configFile: path.join(next.dir, configName) });
    } else if (files.has('package.json') && (await dependsOnMmk(next.dir))) {
      dependents.push(next.dir);
    }

    if (next.depth < maxDepth) {
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) {
          queue.push({ dir: path.join(next.dir, entry.name), depth: next.depth + 1 });
        }
      }
    }
  }

  const envOnly = dependents
    .filter(
      (dir) =>
        !configProjects.some(
          (project) => isSameOrInside(project.dir, dir) || isSameOrInside(dir, project.dir),
        ) && !dependents.some((other) => other !== dir && isSameOrInside(other, dir)),
    )
    .map((dir): ProjectRoot => ({ dir, configFile: null }));

  return [...configProjects, ...envOnly].sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Where a project's mongo-migrate-kit is installed */
export interface MmkInstall {
  /** The installed mongo-migrate-kit package directory */
  packageDir: string;
  /** The JavaScript file the `mmk` binary runs (`bin.mmk` in the package's package.json) */
  script: string;
  /** `node_modules/.bin/mmk` next to the package, when the package manager linked it */
  bin: string | null;
}

/**
 * Find the mongo-migrate-kit that `npx mmk` would run from `projectDir`, walking up through
 * parent `node_modules` folders the way Node resolves packages (monorepos hoist it).
 *
 * The extension runs the package's own script with Node rather than `node_modules/.bin/mmk`:
 * on Windows that is a `.cmd` shim that `execFile` can't start without a shell, and its
 * `#!/usr/bin/env node` line would ignore the `mmk.nodePath` setting.
 */
export async function locateMmk(projectDir: string): Promise<MmkInstall | null> {
  let dir = path.resolve(projectDir);
  for (;;) {
    const nodeModules = path.join(dir, 'node_modules');
    const packageDir = path.join(nodeModules, MMK_PACKAGE);
    const script = await binScript(packageDir);
    if (script) {
      const bin = path.join(nodeModules, '.bin', 'mmk');
      return { packageDir, script, bin: (await isFile(bin)) ? bin : null };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** How the Node.js executable that runs mmk was found, or why it wasn't */
export type NodeResolution =
  | { ok: true; path: string; source: 'setting' | 'PATH' }
  | { ok: false; message: string };

/**
 * Pick the Node.js executable that runs mmk: the `mmk.nodePath` setting when it is set,
 * otherwise `node` from `PATH` (the same one the user's terminal runs).
 */
export async function resolveNode(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<NodeResolution> {
  const setting = configured?.trim() ?? '';
  if (setting !== '') {
    if (await isExecutable(setting, platform)) {
      return { ok: true, path: setting, source: 'setting' };
    }
    return {
      ok: false,
      message: `The "mmk.nodePath" setting is ${JSON.stringify(setting)}, but there's no executable there. Fix the path, or clear the setting to use node from PATH.`,
    };
  }

  const searchPath = env.PATH ?? env.Path ?? '';
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of searchPath.split(delimiter)) {
    if (dir.trim() === '') {
      continue;
    }
    const candidate = path.join(dir, executable);
    if (await isExecutable(candidate, platform)) {
      return { ok: true, path: candidate, source: 'PATH' };
    }
  }
  return {
    ok: false,
    message:
      'Couldn\'t find Node.js on PATH, and mmk needs it to run. Install Node.js, or set "mmk.nodePath" to the node executable.',
  };
}

/** The absolute path of the package's `mmk` bin script, or null if it isn't installed there */
async function binScript(packageDir: string): Promise<string | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof manifest !== 'object' || manifest === null || !('bin' in manifest)) {
    return null;
  }
  const bin = manifest.bin;
  const relative =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null && 'mmk' in bin && typeof bin.mmk === 'string'
        ? bin.mmk
        : null;
  if (relative === null) {
    return null;
  }
  const script = path.resolve(packageDir, relative);
  return (await isFile(script)) ? script : null;
}

/** True when `dir`'s package.json lists mongo-migrate-kit in any dependency field */
async function dependsOnMmk(dir: string): Promise<boolean> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  if (typeof manifest !== 'object' || manifest === null) {
    return false;
  }
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  return fields.some((field) => {
    const deps: unknown = (manifest as Record<string, unknown>)[field];
    return typeof deps === 'object' && deps !== null && MMK_PACKAGE in deps;
  });
}

/** True when `child` is `parent` or a directory below it */
function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Directory entries, or none when the directory can't be read */
async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** True when `file` exists and is a regular file (following symlinks) */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** True when `file` is a regular file the current user may execute */
async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!(await isFile(file))) {
    return false;
  }
  try {
    await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
