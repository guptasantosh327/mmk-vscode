import type { RunResult } from 'mongo-migrate-kit';
import * as vscode from 'vscode';
import { type JsonOutput, MmkCommandError } from '../mmk/cli.js';
import type { RunOutcome } from '../mmk/console.js';
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
import { buildStatusModel, formatWhen } from '../mmk/model.js';
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
    vscode.commands.registerCommand('mmk.downBatch', (target?: unknown) =>
      runDownBatch(deps, target),
    ),
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
  // A run that applied needs no notification: the sidebar, run links and status bar show it.
  // Only one that did nothing says why.
  const results = parseRunResults(output.value, 'up');
  const applied = results.some((result) => result.file === ref.file && result.status === 'applied');
  if (!applied) {
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
  if (!results.some((result) => result.status === 'applied')) {
    void vscode.window.showInformationMessage(
      `Nothing to apply on ${environment.name}: it's up to date.`,
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

/** Run `args` (a down of `file`); the views show it pending again */
async function downOutcome(
  deps: Deps,
  project: ProjectSnapshot,
  environment: Environment,
  file: string,
  args: string[],
): Promise<Wire<RunResult>[] | undefined> {
  const output = await execute(deps, project, environment, args, `down ${shortName(file)}`);
  return output ? parseRunResults(output.value, 'down') : undefined;
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
  return output ? parseRunResults(output.value, 'redo') : undefined;
}

/**
 * Roll back one batch on the selected environment: the batch named by the argument
 * (`{ dir, batch }`), or one the user picks. Only a failure gets a notification.
 */
async function runDownBatch(deps: Deps, target: unknown): Promise<Wire<RunResult>[] | undefined> {
  const project = await resolveProject(deps, target);
  if (!project) {
    return undefined;
  }
  let batch = batchOf(target);
  if (batch === undefined) {
    const environment = currentEnvironment(deps);
    const groups = buildStatusModel(project.environments[environment.name]?.rows ?? []).batches;
    if (groups.length === 0) {
      void vscode.window.showInformationMessage(
        `Nothing to roll back on ${environment.name}: no batch has run there.`,
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      groups.map((group) => ({
        label: `Batch ${group.batch}`,
        description: `${group.rows.length} ${group.rows.length === 1 ? 'migration' : 'migrations'}${group.appliedAt ? ` · ${formatWhen(group.appliedAt)}` : ''}`,
        detail: group.rows.map((row) => shortName(row.file)).join(', '),
        batch: group.batch,
      })),
      { title: `mmk: Roll back a batch on ${environment.name}` },
    );
    if (!picked) {
      return undefined;
    }
    batch = picked.batch;
  }
  const run = await rollBackBatch(deps, project, batch);
  if (!run) {
    return undefined;
  }
  const { outcome, environment } = run;
  if (outcome.failure) {
    showFailure(deps, project, environment, outcome.failure);
    return undefined;
  }
  return [...outcome.results];
}

/** The `batch` of a `{ dir, batch }` argument */
function batchOf(target: unknown): number | undefined {
  if (typeof target !== 'object' || target === null || !('batch' in target)) {
    return undefined;
  }
  const { batch } = target;
  return typeof batch === 'number' && Number.isInteger(batch) && batch > 0 ? batch : undefined;
}

/** The applied files of one batch on an environment, newest first, as its status rows list them */
export function batchFiles(project: ProjectSnapshot, environment: string, batch: number): string[] {
  return (project.environments[environment]?.rows ?? [])
    .filter((row) => row.status === 'applied' && row.batch === batch)
    .map((row) => row.file)
    .sort((a, b) => b.localeCompare(a));
}

/**
 * Roll back one batch on the selected environment (`mmk down --batch N`), after a modal that
 * names every file in it. Refuses on a read-only environment. Returns how it ended, for the
 * caller to show, or undefined when it didn't run.
 */
export async function rollBackBatch(
  deps: Deps,
  project: ProjectSnapshot,
  batch: number,
): Promise<{ outcome: RunOutcome; files: string[]; environment: Environment } | undefined> {
  const environment = writableEnvironment(deps, 'rolling back');
  if (!environment) {
    return undefined;
  }
  const files = batchFiles(project, environment.name, batch);
  if (files.length === 0) {
    void vscode.window.showWarningMessage(
      `There's no batch ${batch} on ${environment.name}. Refresh the mmk view if it just changed.`,
    );
    return undefined;
  }
  const names = files.map(shortName);
  const confirmed = await deps.confirm(
    `Roll back batch ${batch} on ${environment.name}?`,
    `This runs down() for ${files.length === 1 ? 'its migration' : `each of its ${files.length} migrations, newest first`}, against ${databaseLabel(project, environment.name)}: ${allNames(names)}. Afterwards ${files.length === 1 ? 'it shows' : 'they show'} as pending.`,
    `Roll back batch ${batch}`,
  );
  if (!confirmed) {
    return undefined;
  }
  const outcome = await outcomeOf(
    deps,
    project,
    environment,
    ['down', '--batch', String(batch)],
    `down --batch ${batch}`,
  );
  return { outcome, files, environment };
}

/**
 * Apply every pending migration on the selected environment, as *Apply all* does (refused on a
 * read-only environment, asked first anywhere but local). Returns how it ended, for the caller
 * to show, or undefined when it didn't run.
 */
export async function applyPending(
  deps: Deps,
  project: ProjectSnapshot,
): Promise<{ outcome: RunOutcome; environment: Environment } | undefined> {
  const environment = writableEnvironment(deps, 'apply');
  if (!environment) {
    return undefined;
  }
  if (!(await confirmRemoteWrite(deps, environment, project, 'Apply every pending migration'))) {
    return undefined;
  }
  const outcome = await outcomeOf(deps, project, environment, ['up'], 'up');
  return { outcome, environment };
}

/** Run a write and keep how it ended (mmk's results, or its failure as is) without reporting it */
async function outcomeOf(
  deps: Deps,
  project: ProjectSnapshot,
  environment: Environment,
  args: string[],
  label: string,
): Promise<RunOutcome> {
  try {
    const output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `mmk: ${label} on ${environment.name}…` },
      () => deps.store.run(project.dir, args, label, environment.name),
    );
    return { results: parseRunResults(output.value, label), failure: null };
  } catch (error) {
    if (error instanceof MmkCommandError) {
      const { code, details } = error.failure;
      deps.log.error(code ? `${code}: ${error.message}` : error.message);
      const results = runResultsOfFailure(error.failure) ?? [];
      for (const result of results) {
        deps.log.info(`  ran before it stopped: ${result.file} → ${result.status}`);
      }
      const name = details?.name;
      return {
        results,
        failure: {
          code: code ?? null,
          message: error.message,
          file: typeof name === 'string' ? name : null,
        },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof StoreError)) {
      deps.log.error(message);
    }
    return { results: [], failure: { code: null, message, file: null } };
  }
}

/** A run's failure in a notification: mmk's message, and *Unlock…* when the lock is held */
function showFailure(
  deps: Deps,
  project: ProjectSnapshot,
  environment: Environment,
  failure: NonNullable<RunOutcome['failure']>,
): void {
  if (failure.code === 'LOCK_ALREADY_HELD' && !environment.readOnly) {
    void vscode.window.showErrorMessage(failure.message, 'Unlock…').then((choice) => {
      if (choice === 'Unlock…') {
        void vscode.commands.executeCommand('mmk.unlock', { dir: project.dir });
      }
    });
    return;
  }
  showErrorWithOutput(deps, failure.message);
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
  const output = await execute(deps, project, environment, args, 'dry run');
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
 * Run an mmk command in a project on an environment, and report a failure to the user. Progress
 * goes in the status bar, not a notification: the sidebar and run links show "Running…" too.
 * Returns mmk's output, or undefined when it failed (already reported).
 */
async function execute(
  deps: Deps,
  project: ProjectSnapshot,
  environment: Environment,
  args: string[],
  label: string,
): Promise<JsonOutput | undefined> {
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `mmk: ${label} on ${environment.name}…` },
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

/** Every name: `a`, `a and b`, `a, b and c` */
function allNames(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
