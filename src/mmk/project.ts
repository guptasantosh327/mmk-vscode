import { type MmkInvocation, runMmkVersion } from './cli.js';
import { checkCompat } from './compat.js';
import {
  type MmkInstall,
  type NodeResolution,
  type ProjectRoot,
  findProjectRoots,
  locateMmk,
  resolveNode,
} from './locate.js';

/** A project found in the workspace, and whether the extension can run its mmk */
export type ProjectState =
  | {
      kind: 'ready';
      root: ProjectRoot;
      install: MmkInstall;
      invocation: MmkInvocation;
      /** What `mmk --version` printed */
      version: string;
    }
  | {
      /** mmk can't be used for this project; `message` says why and what to do */
      kind: 'mmk-missing' | 'node-missing' | 'too-old' | 'failed';
      root: ProjectRoot;
      message: string;
    };

/** Inputs for {@link discoverProjects} */
export interface DiscoverOptions {
  /** Absolute paths of the workspace folders */
  folders: readonly string[];
  /** The `mmk.nodePath` setting */
  nodePath: string | undefined;
  /** The environment whose `PATH` is searched for node */
  env: NodeJS.ProcessEnv;
  /** How long `mmk --version` may take. Default: 15 s */
  versionTimeoutMs?: number;
}

/**
 * Find every mmk project in the workspace folders and check each one: is mongo-migrate-kit
 * installed, can Node.js run it, and is it new enough. Only runs `mmk --version`, which never
 * loads the project's config or connects to a database.
 */
export async function discoverProjects(options: DiscoverOptions): Promise<ProjectState[]> {
  const roots = (
    await Promise.all(options.folders.map((folder) => findProjectRoots(folder)))
  ).flat();
  const unique = [...new Map(roots.map((root) => [root.dir, root])).values()];
  if (unique.length === 0) {
    return [];
  }
  const node = await resolveNode(options.nodePath, options.env);
  return Promise.all(
    unique.map((root) => inspectProject(root, node, options.versionTimeoutMs ?? 15_000)),
  );
}

/** Check one project root */
export async function inspectProject(
  root: ProjectRoot,
  node: NodeResolution,
  versionTimeoutMs: number,
): Promise<ProjectState> {
  const install = await locateMmk(root.dir);
  if (!install) {
    return {
      kind: 'mmk-missing',
      root,
      message: `mongo-migrate-kit isn't installed for ${root.dir}. Install it in this project: npm install mongo-migrate-kit mongodb`,
    };
  }
  if (!node.ok) {
    return { kind: 'node-missing', root, message: node.message };
  }
  const invocation: MmkInvocation = { nodePath: node.path, script: install.script, cwd: root.dir };
  let printed: string;
  try {
    printed = await runMmkVersion(invocation, { timeoutMs: versionTimeoutMs });
  } catch (error) {
    return {
      kind: 'failed',
      root,
      message: `Couldn't run mmk for ${root.dir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const compat = checkCompat(printed);
  if (!compat.ok) {
    return { kind: 'too-old', root, message: compat.message };
  }
  return { kind: 'ready', root, install, invocation, version: compat.version };
}
