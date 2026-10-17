import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Environment } from '../mmk/environments.js';
import type { Logger } from '../mmk/log.js';
import type { MigrationRef, MmkStore, ProjectSnapshot } from '../mmk/store.js';
import type { EnvironmentRegistry } from './environment-registry.js';

/** Asks the user to confirm a write; returns true only for an explicit yes */
export type Confirm = (message: string, detail: string, action: string) => Promise<boolean>;

/** What every command and view needs */
export interface Deps {
  store: MmkStore;
  /** The environments from settings and their connections in the keychain */
  environments: EnvironmentRegistry;
  log: Logger;
  channel: vscode.LogOutputChannel;
  /** Ask before `down`, `redo`, `--force` and `unlock`. Integration tests replace it */
  confirm: Confirm;
  /** Migration files created in this session (absolute paths), shown as "new" */
  created: Set<string>;
}

/** A modal confirmation: nothing runs unless the user picks `action` */
export async function modalConfirm(
  message: string,
  detail: string,
  action: string,
): Promise<boolean> {
  return (
    (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action
  );
}

/** A command argument that names a project, and optionally one of its migration files */
export interface DirTarget {
  dir: string;
  file?: string;
}

function isDirTarget(value: unknown): value is DirTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dir' in value &&
    typeof value.dir === 'string' &&
    (!('file' in value) || value.file === undefined || typeof value.file === 'string')
  );
}

/** True when a command argument points at one migration file rather than a whole project */
export function targetsFile(target: unknown): boolean {
  return target instanceof vscode.Uri || (isDirTarget(target) && target.file !== undefined);
}

/**
 * The migration a command acts on: a file `Uri` (run links, Explorer), a sidebar item, or the
 * active editor. Tells the user when there isn't one.
 */
export function resolveMigration(deps: Deps, target: unknown): MigrationRef | undefined {
  let file: string | undefined;
  if (target instanceof vscode.Uri) {
    file = target.fsPath;
  } else if (isDirTarget(target) && target.file !== undefined) {
    const migrationsDir = deps.store.snapshot(target.dir)?.config?.migrationsDir;
    file = migrationsDir === undefined ? undefined : path.join(migrationsDir, target.file);
  } else {
    const uri = vscode.window.activeTextEditor?.document.uri;
    file = uri?.scheme === 'file' ? uri.fsPath : undefined;
  }

  const ref = file === undefined ? undefined : deps.store.migrationFor(file);
  if (!ref) {
    void vscode.window.showWarningMessage(
      file === undefined
        ? 'Open a migration file, or pick one in the mmk view, first.'
        : `${path.basename(file)} isn't in a migrations folder mmk knows. Refresh the mmk view if you just moved it.`,
    );
  }
  return ref;
}

/**
 * The project a command acts on: the one named by the argument, the only one there is, or the
 * one the user picks.
 */
export async function resolveProject(
  deps: Deps,
  target: unknown,
): Promise<ProjectSnapshot | undefined> {
  if (isDirTarget(target)) {
    return deps.store.snapshot(target.dir);
  }
  const projects = deps.store.snapshots();
  if (projects.length === 0) {
    void vscode.window.showInformationMessage(
      'No mmk project in this workspace. mmk looks for mmk.config.js, .ts or .json, or a package.json that depends on mongo-migrate-kit.',
    );
    return undefined;
  }
  if (projects.length === 1) {
    return projects[0];
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: relativeDir(project.dir) || path.basename(project.dir),
      ...(project.state.kind === 'ready' ? {} : { description: project.state.message }),
      project,
    })),
    { title: 'mmk: Pick a project' },
  );
  return picked?.project;
}

/** A project's folder relative to its workspace folder; empty for the workspace folder itself */
export function relativeDir(dir: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
  return folder ? path.relative(folder.uri.fsPath, dir) : dir;
}

/**
 * Where a project's records on an environment are read from, for display:
 * `localhost:27017/orders_dev`, with no credentials. For `local` it comes from mmk's resolved
 * config, for the others from the stored connection.
 */
export function databaseLabel(project: ProjectSnapshot | undefined, environment: string): string {
  const status = project?.environments[environment];
  if (status && !status.connected) {
    return 'not set up for this project';
  }
  return status?.database ?? (environment === 'local' ? "this project's config" : 'not read yet');
}

/** The environment commands act on: the selected one */
export function currentEnvironment(deps: Deps): Environment {
  return deps.store.selected();
}

/** The file name for messages: without the timestamp, as the sidebar shows it */
export function shortName(file: string): string {
  return file.replace(/^\d+-/, '');
}
