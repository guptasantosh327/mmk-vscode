import type { RunResult } from 'mongo-migrate-kit';
import * as vscode from 'vscode';
import { type JsonOutput, MmkCommandError } from '../mmk/cli.js';
import {
  type UnlockResult,
  type Wire,
  type WireStatusRow,
  parseRunResults,
  parseStatusRows,
  parseUnlockResult,
  runResultsOfFailure,
} from '../mmk/contract.js';
import type { Environment } from '../mmk/environments.js';
import { formatStatusTable } from '../mmk/format.js';
import { formatDuration } from '../mmk/model.js';
import { StoreError } from '../mmk/store.js';
import type { ProjectSnapshot } from '../mmk/store.js';
import {
  type Deps,
  currentEnvironment,
  databaseLabel,
  resolveMigration,
  resolveProject,
  shortName,
  targetsFile,
} from './context.js';

/** Register the commands that run migrations */
export function registerRunCommands(deps: Deps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mmk.up', (target?: unknown) => runUp(deps, target)),
    vscode.commands.registerCommand('mmk.upAll', (target?: unknown) => runUpAll(deps, target)),
    vscode.commands.registerCommand('mmk.down', (target?: unknown) => runDown(deps, target)),
    vscode.commands.registerCommand('mmk.redo', (target?: unknown) => runRedo(deps, target)),
    vscode.commands.registerCommand('mmk.dryRun', (target?: unknown) => dryRun(deps, target)),
    vscode.commands.registerCommand('mmk.unlock', (target?: unknown) => unlock(deps, target)),
  ];
}

/**
 * The environment a write runs on, or undefined after telling the user why it can't. Read-only
 * environments refuse here and again in the store, so no path around the UI can write to them.
 */
function writableEnvironment(deps: Deps, action: string): Environment | undefined {
  const environment = currentEnvironment(deps);
  if (environment.readOnly) {
    void vscode.window.showWarningMessage(
      `${environment.name} is read-only, so ${action} is turned off there. Deploys to ${environment.name} go through CI. Switch to local (or another writable environment) to run it.`,
    );
    return undefined;
  }
  return environment;
}

/** Writes outside `local` always ask first, even `up` */
async function confirmRemoteWrite(
  deps: Deps,
  environment: Environment,
  project: ProjectSnapshot,
  what: string,
): Promise<boolean> {
  if (environment.local) {
    return true;
  }
  return deps.confirm(
    `${what} on ${environment.name}?`,
    `This writes to ${databaseLabel(project, environment.name)}, not your local database.`,
    'Run',
  );
}

/** Run up for one migration file */
async function runUp(deps: Deps, target: unknown): Promise<Wire<RunResult>[] | undefined> {
  const ref = resolveMigration(deps, target);
  const environment = ref && writableEnvironment(deps, 'run up');
  if (!ref || !environment) {
    return undefined;
  }
  const name = shortName(ref.file);
  if (!(await confirmRemoteWrite(deps, environment, ref.project, `Apply ${name}`))) {
    return undefined;
  }
  const output = await execute(deps, ref.project, environment, ['up', ref.file], `up ${name}`);
  if (!output) {
    return undefined;
  }
  const results = parseRunResults(output.value, 'up');
  const applied = results.find((result) => result.file === ref.file && result.status === 'applied');
  if (applied) {
    void vscode.window
      .showInformationMessage(
        `Applied on ${environment.name} in ${formatDuration(applied.duration ?? 0)}: ${name} · batch ${applied.batch ?? '?'}`,
        'Run down',
      )
      .then((choice) => {
        if (choice === 'Run down') {
          void vscode.commands.executeCommand('mmk.down', { dir: ref.project.dir, file: ref.file });
        }
      });
  } else {
    const skipped = results.find((result) => result.file === ref.file);
    void vscode.window.showInformationMessage(
      `${name} is already applied on ${environment.name}${skipped?.reason ? ` (${skipped.reason})` : ''}, so nothing ran.`,
    );
  }
  return results;
}

/** Run up for every pending migration of a project */
async function runUpAll(deps: Deps, target: unknown): Promise<Wire<RunResult>[] | undefined> {
  const project = await resolveProject(deps, target);
  const environment = project && writableEnvironment(deps, 'apply');
  if (!project || !environment) {
    return undefined;
  }
  if (!(await confirmRemoteWrite(deps, environment, project, 'Apply every pending migration'))) {
    return undefined;
  }
  const output = await execute(deps, project, environment, ['up'], 'up');
  if (!output) {
    return undefined;
  }
  const results = parseRunResults(output.value, 'up');
  const applied = results.filter((result) => result.status === 'applied');
  if (applied.length === 0) {
    void vscode.window.showInformationMessage(
      `Nothing to apply on ${environment.name}: it's up to date.`,
    );
  } else {
    const total = applied.reduce((sum, result) => sum + (result.duration ?? 0), 0);
    const batch = applied[0]?.batch;
    void vscode.window.showInformationMessage(
      `Applied ${applied.length} on ${environment.name} in ${formatDuration(total)}${batch === undefined ? '' : ` · batch ${batch}`}`,
    );
  }
  return results;
}

/** Roll back one applied migration file, after a modal confirmation */
async function runDown(deps: Deps, target: unknown): Promise<Wire<RunResult>[] | undefined> {
  const ref = resolveMigration(deps, target);
  const environment = ref && writableEnvironment(deps, 'rolling back');
  if (!ref || !environment) {
    return undefined;
  }
  const name = shortName(ref.file);
  const confirmed = await deps.confirm(
    `Roll back ${name} on ${environment.name}?`,
    `This runs its down() against ${databaseLabel(ref.project, environment.name)}. Afterwards it shows as pending.`,
    'Run down',
  );
  if (!confirmed) {
    return undefined;
  }
  return downOutcome(deps, ref.project, environment, ref.file, ['down', ref.file]);
}

/** Run `args` (a down) and report what it reverted */
async function downOutcome(
  deps: Deps,
  project: ProjectSnapshot,
  environment: Environment,
  file: string,
  args: string[],
): Promise<Wire<RunResult>[] | undefined> {
  const name = shortName(file);
  const output = await execute(deps, project, environment, args, `down ${name}`);
  if (!output) {
    return undefined;
  }
  const results = parseRunResults(output.value, 'down');
  const reverted = results.find((result) => result.file === file && result.status === 'reverted');
  if (reverted) {
    void vscode.window
      .showInformationMessage(
        `Rolled back on ${environment.name} in ${formatDuration(reverted.duration ?? 0)}: ${name}. It's pending again.`,
        'Run up',
      )
      .then((choice) => {
        if (choice === 'Run up') {
          void vscode.commands.executeCommand('mmk.up', { dir: project.dir, file });
        }
      });
  }
  return results;
}

/** Roll back and re-apply one migration file, after a modal confirmation */
async function runRedo(deps: Deps, target: unknown): Promise<Wire<RunResult>[] | undefined> {
  const ref = resolveMigration(deps, target);
  const environment = ref && writableEnvironment(deps, 'redo');
  if (!ref || !environment) {
    return undefined;
  }
  const name = shortName(ref.file);
  const confirmed = await deps.confirm(
    `Redo ${name} on ${environment.name}?`,
    `This runs its down(), then its up() again, against ${databaseLabel(ref.project, environment.name)}.`,
    'Redo',
  );
  if (!confirmed) {
    return undefined;
  }
  const output = await execute(deps, ref.project, environment, ['redo', ref.file], `redo ${name}`);
  if (!output) {
    return undefined;
  }
  const results = parseRunResults(output.value, 'redo');
  const applied = results.find((result) => result.status === 'applied');
  if (applied) {
    void vscode.window.showInformationMessage(
      `Redid ${name} on ${environment.name}: rolled back, then applied in ${formatDuration(applied.duration ?? 0)} · batch ${applied.batch ?? '?'}`,
    );
  }
  return results;
}

/** Preview what `up` would apply, for one file or the whole project. Allowed everywhere */
async function dryRun(deps: Deps, target: unknown): Promise<WireStatusRow[] | undefined> {
  const environment = currentEnvironment(deps);
  let project: ProjectSnapshot | undefined;
  let args: string[];
  if (targetsFile(target) || (target === undefined && isMigrationEditorOpen(deps))) {
    const ref = resolveMigration(deps, target);
    if (!ref) {
      return undefined;
    }
    project = ref.project;
    args = ['dry-run', 'up', ref.file];
  } else {
    project = await resolveProject(deps, target);
    args = ['dry-run', 'up'];
  }
  if (!project) {
    return undefined;
  }
  const output = await execute(
    deps,
    project,
    environment,
    args,
    'dry run',
    vscode.ProgressLocation.Window,
  );
  if (!output) {
    return undefined;
  }
  const rows = parseStatusRows(output.value, 'dry-run');
  for (const line of formatStatusTable(rows)) {
    deps.log.info(line);
  }
  const wouldApply = rows.filter((row) => row.status === 'pending');
  const first = rows[0];
  let message: string;
  if (wouldApply.length > 0) {
    const names = wouldApply.map((row) => shortName(row.file));
    message = `Dry run on ${environment.name}: up would apply ${wouldApply.length}: ${listNames(names)}. Nothing ran.`;
  } else if (first) {
    message = `Dry run on ${environment.name}: ${shortName(first.file)} is already applied, so up would skip it.`;
  } else {
    message = `Dry run on ${environment.name}: nothing to apply.`;
  }
  void vscode.window.showInformationMessage(message, 'Show output').then((choice) => {
    if (choice === 'Show output') {
      deps.channel.show(true);
    }
  });
  return rows;
}

/** Release a held migration lock, after a modal confirmation */
async function unlock(deps: Deps, target: unknown): Promise<UnlockResult | undefined> {
  const project = await resolveProject(deps, target);
  const environment = project && writableEnvironment(deps, 'releasing the lock');
  if (!project || !environment) {
    return undefined;
  }
  const confirmed = await deps.confirm(
    `Release the migration lock on ${environment.name}?`,
    'Only do this when the run holding it has really stopped (mmk named its host and pid). Releasing a live lock lets two runs change the database at once.',
    'Release lock',
  );
  if (!confirmed) {
    return undefined;
  }
  const output = await execute(deps, project, environment, ['unlock', '--yes'], 'unlock');
  if (!output) {
    return undefined;
  }
  const result = parseUnlockResult(output.value);
  void vscode.window.showInformationMessage(
    result.holder
      ? `Released the lock on ${environment.name} held by ${result.holder.executedBy} on ${result.holder.host} (pid ${result.holder.pid}).`
      : `No migration lock was held on ${environment.name}.`,
  );
  return result;
}

/**
 * Run an mmk command in a project on an environment with progress, and report a failure to the
 * user. Returns mmk's output, or undefined when it failed (already reported).
 */
async function execute(
  deps: Deps,
  project: ProjectSnapshot,
  environment: Environment,
  args: string[],
  label: string,
  location: vscode.ProgressLocation = vscode.ProgressLocation.Notification,
): Promise<JsonOutput | undefined> {
  try {
    return await vscode.window.withProgress(
      { location, title: `mmk: ${label} on ${environment.name}…` },
      () => deps.store.run(project.dir, args, label, environment.name),
    );
  } catch (error) {
    reportFailure(deps, project, environment, args, error);
    return undefined;
  }
}

/** Tell the user what went wrong, in mmk's words, with the next step as a button */
function reportFailure(
  deps: Deps,
  project: ProjectSnapshot,
  environment: Environment,
  args: string[],
  error: unknown,
): void {
  if (error instanceof StoreError) {
    void vscode.window.showWarningMessage(error.message);
    return;
  }
  if (!(error instanceof MmkCommandError)) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.error(message);
    showErrorWithOutput(deps, message);
    return;
  }

  const { code } = error.failure;
  deps.log.error(code ? `${code}: ${error.message}` : error.message);
  for (const result of runResultsOfFailure(error.failure) ?? []) {
    deps.log.info(`  ran before it stopped: ${result.file} → ${result.status}`);
  }

  if (code === 'LOCK_ALREADY_HELD' && !environment.readOnly) {
    void vscode.window.showErrorMessage(error.message, 'Unlock…').then((choice) => {
      if (choice === 'Unlock…') {
        void vscode.commands.executeCommand('mmk.unlock', { dir: project.dir });
      }
    });
    return;
  }

  const file = args[1];
  if (code === 'CHECKSUM_MISMATCH' && args[0] === 'down' && file !== undefined) {
    void vscode.window.showErrorMessage(error.message, 'Roll back anyway…').then(async (choice) => {
      if (choice !== 'Roll back anyway…') {
        return;
      }
      const confirmed = await deps.confirm(
        `Roll back ${shortName(file)} on ${environment.name} anyway?`,
        "The file changed after it ran, so its down() may not undo what its up() did. This is mmk's --force.",
        'Roll back anyway',
      );
      if (confirmed) {
        await downOutcome(deps, project, environment, file, ['down', file, '--force', '--yes']);
      }
    });
    return;
  }

  showErrorWithOutput(deps, error.message);
}

function showErrorWithOutput(deps: Deps, message: string): void {
  void vscode.window.showErrorMessage(message, 'Show output').then((choice) => {
    if (choice === 'Show output') {
      deps.channel.show(true);
    }
  });
}

function isMigrationEditorOpen(deps: Deps): boolean {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === 'file' && deps.store.migrationFor(uri.fsPath) !== undefined;
}

/** `a, b and c`, or the first three and how many more */
function listNames(names: string[]): string {
  if (names.length <= 3) {
    return names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}
