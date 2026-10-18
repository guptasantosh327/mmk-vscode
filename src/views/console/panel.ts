import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Deps, databaseLabel, relativeDir, resolveProject } from '../../commands/context.js';
import { checkConnection, saveEnvironment } from '../../commands/environments.js';
import { applyPending, rollBackBatch } from '../../commands/run.js';
import { currentBranch, defaultRemoteRef } from '../../git/branches.js';
import { copyRefFolder } from '../../git/ref-files.js';
import { terminalCommand } from '../../mmk/cli.js';
import {
  type ConsoleAction,
  type ConsoleFilter,
  type ConsoleMessage,
  type ConsoleModel,
  type ConsoleResult,
  type PlanStep,
  buildConsole,
  buildResult,
  editedKeys,
  isConsoleMessage,
  planSteps,
} from '../../mmk/console.js';
import { parseStatusRows } from '../../mmk/contract.js';
import type { WireStatusRow } from '../../mmk/contract.js';
import {
  type Connection,
  type Environment,
  type EnvironmentHue,
  connectionStringProblem,
  environmentNameProblem,
} from '../../mmk/environments.js';
import { environmentLock, environmentLocks } from '../../mmk/lock-holder.js';
import { type MatrixInput, buildMatrix, matrixInputs } from '../../mmk/matrix.js';
import type { FinishedRun, ProjectSnapshot } from '../../mmk/store.js';

/** Where the compared files come from */
type Source = { kind: 'branch' } | { kind: 'ref'; ref: string };

/** The panel over the console: a plan (C6), a run the console started (C7) or its result (C8) */
type Drawer =
  | { kind: 'plan'; environment: string; loading: boolean; steps: PlanStep[]; error: string | null }
  | { kind: 'applying'; environment: string; files: string[] }
  | { kind: 'result'; result: ConsoleResult };

/** The drawer as the webview draws it */
export type DrawerView =
  | {
      kind: 'plan';
      environment: string;
      readOnly: boolean;
      database: string;
      files: string;
      loading: boolean;
      steps: PlanStep[];
      error: string | null;
      cli: string;
      /** Why Apply can't run now (another run holds the lock), or empty */
      locked: string;
    }
  | { kind: 'applying'; environment: string; files: string[] }
  | { kind: 'result'; result: ConsoleResult };

/** A problem with one field of the *Add environment* dialog, in words */
interface FieldErrors {
  name?: string;
  uri?: string;
  dbName?: string;
}

/** What the dialog's form starts with: never the connection string */
interface DialogFields {
  /** The environment being edited; empty when adding */
  name: string;
  /** Editing local: only its colour, since its connection is the project's config */
  local: boolean;
  dbName: string;
  readOnly: boolean;
  /** The colour its entry sets; null for its default */
  color: EnvironmentHue | null;
  /** A connection string is stored for this project, so an empty field keeps it */
  stored: boolean;
}

/**
 * The environment dialog (C13): adding one, or editing one. The connection string stays in the
 * webview's field and in the messages that test or save it: it's never part of the view sent back.
 */
interface EnvironmentDialog extends DialogFields {
  mode: 'add' | 'edit';
  test: { state: 'idle' | 'testing' | 'ok' | 'failed'; text: string };
  errors: FieldErrors;
  saving: boolean;
  /** The connection the last test passed for, so saving doesn't test it twice; kept here only */
  passed: Connection | null;
  /** The last test failed, so saving anyway is offered */
  canForce: boolean;
}

/** The dialog as the webview draws it */
export interface DialogView extends DialogFields {
  kind: 'addEnvironment' | 'editEnvironment';
  test: EnvironmentDialog['test'];
  errors: FieldErrors;
  saving: boolean;
  canForce: boolean;
}

/** At most this many lines of a run's output are kept for the console */
const OUTPUT_LINES = 400;

/** Everything the webview draws, sent over postMessage */
export interface ConsoleView {
  title: string;
  subtitle: string;
  source: 'branch' | 'ref';
  refLabel: string | null;
  loading: boolean;
  error: string | null;
  selected: string;
  filter: ConsoleFilter;
  columns: Array<{ name: string; readOnly: boolean; state: string; title: string }>;
  model: ConsoleModel;
  /** The picked migration's CLI command, as Copy CLI command would copy it */
  cli: string;
  drawer: DrawerView | null;
  /** The *Add environment* dialog, when it's open */
  dialog: DialogView | null;
  /**
   * The last command run in this project, from anywhere, with mmk's output (C7). It stays after
   * it ends, finished or failed, until the user closes it.
   */
  run: RunView | null;
}

/** A command mmk is running, or ran, in this project */
export interface RunView {
  label: string;
  environment: string;
  lines: string[];
  state: 'running' | 'done' | 'failed';
  /** mmk's error as is, when it failed */
  message: string | null;
}

/**
 * Register the migration console (design C1–C4): "mmk: Open migration console", and "Compare
 * all environments", which opens it with *Only differences*. Both return the panel, for tests.
 */
export function registerConsole(
  deps: Deps,
  extensionUri: vscode.Uri,
  /** Workspace state, where dismissed notices are kept */
  state: vscode.Memento,
): vscode.Disposable[] {
  const panels = new Map<string, ConsolePanel>();
  const open = async (
    target: unknown,
    filter?: ConsoleFilter,
  ): Promise<ConsolePanel | undefined> => {
    const project = await resolveProject(deps, target);
    if (!project) {
      return undefined;
    }
    let panel = panels.get(project.dir);
    if (panel) {
      panel.reveal();
    } else {
      panel = new ConsolePanel(deps, extensionUri, project.dir, state, () =>
        panels.delete(project.dir),
      );
      panels.set(project.dir, panel);
    }
    if (filter) {
      panel.setFilter(filter);
    }
    return panel;
  };
  return [
    vscode.commands.registerCommand('mmk.openConsole', (target?: unknown) => open(target)),
    vscode.commands.registerCommand('mmk.compareEnvironments', (target?: unknown) =>
      open(target, 'diff'),
    ),
    deps.store.onDidChange(() => {
      for (const panel of panels.values()) {
        panel.storeChanged();
      }
    }),
    deps.store.onDidOutput((dir, line) => panels.get(dir)?.output(line)),
    deps.store.onDidFinishRun((dir, run) => panels.get(dir)?.finished(run)),
    { dispose: () => [...panels.values()].map((panel) => panel.dispose()) },
  ];
}

/**
 * The migration console: every migration of a project against every environment's changelog,
 * the picked one's records and actions, and the selected environment's batches. It runs mmk only
 * through the store's reads and the existing commands, so the read-only rule, the confirmations
 * and the results are the same as everywhere else.
 */
export class ConsolePanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private source: Source = { kind: 'branch' };
  private filter: ConsoleFilter = 'all';
  private picked: string | null = null;
  /** Rows read with `status --dir <ref copy>`, by environment */
  private refRows: Map<string, { rows: WireStatusRow[] | null; error: string | null }> | null =
    null;
  private loading = false;
  private error: string | null = null;
  private branch: string | null = null;
  private defaultRef: string | null = null;
  private updatedAt = new Date();
  /** Each environment's database name, for the CLI command (null for local) */
  private readonly databases = new Map<string, string | null>();
  private redrawTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private drawer: Drawer | null = null;
  /** The last command run in this project, kept until the user closes it */
  private run: RunView | null = null;
  private dialog: EnvironmentDialog | null = null;
  /** Every migration edited after it ran, as of the last view (`editedKeys`) */
  private edited = new Set<string>();

  constructor(
    private readonly deps: Deps,
    extensionUri: vscode.Uri,
    private readonly dir: string,
    private readonly state: vscode.Memento,
    private readonly onDispose: () => void,
  ) {
    const codicons = vscode.Uri.joinPath(
      extensionUri,
      'node_modules',
      '@vscode',
      'codicons',
      'dist',
    );
    const media = vscode.Uri.joinPath(extensionUri, 'media', 'console');
    this.panel = vscode.window.createWebviewPanel(
      'mmk.console',
      `Migrations — ${path.basename(dir)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [codicons, media],
        retainContextWhenHidden: false,
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'mmk.svg');
    this.panel.webview.html = this.html(codicons, media);
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (isConsoleMessage(message)) {
          void this.receive(message);
        }
      }),
    );
    void this.loadGit();
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Show only the migrations one filter keeps */
  setFilter(filter: ConsoleFilter): void {
    this.filter = filter;
    this.post();
  }

  /** A line of mmk's output from the command running in this project */
  output(line: string): void {
    this.startRun();
    if (this.run?.state !== 'running') {
      return;
    }
    this.run.lines.push(line);
    if (this.run.lines.length > OUTPUT_LINES) {
      this.run.lines.splice(0, this.run.lines.length - OUTPUT_LINES);
    }
    this.redraw();
  }

  /** A command in this project ended: keep it on screen, finished or failed */
  finished(run: FinishedRun): void {
    if (this.run?.state === 'running' && this.run.label === run.label) {
      this.run.state = run.failure === null ? 'done' : 'failed';
      this.run.message = run.failure;
      this.redraw();
    }
  }

  /** The store read something new: redraw (only the branch view follows it live) */
  storeChanged(): void {
    this.startRun();
    this.redraw();
  }

  /** Follow a command that has just started in this project */
  private startRun(): void {
    const project = this.deps.store.snapshot(this.dir);
    if (
      !project?.running ||
      (this.run?.state === 'running' && this.run.label === project.running)
    ) {
      return;
    }
    this.run = {
      label: project.running,
      environment: project.runningOn ?? this.deps.store.selected().name,
      lines: [],
      state: 'running',
      message: null,
    };
  }

  private redraw(): void {
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
    }
    this.redrawTimer = setTimeout(() => this.post(), 50);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.panel.dispose();
    this.onDispose();
  }

  /** The view as the webview gets it; for tests */
  view(): ConsoleView {
    return this.buildView();
  }

  /** Handle one message from the webview (integration tests send them too) */
  async receive(message: ConsoleMessage): Promise<unknown> {
    switch (message.type) {
      case 'ready':
        this.post();
        return undefined;
      case 'refresh':
        return this.refresh();
      case 'source':
        if (message.value === 'ref' && this.defaultRef) {
          this.source = { kind: 'ref', ref: this.defaultRef };
          this.refRows = null;
          return this.refresh();
        }
        this.source = { kind: 'branch' };
        this.post();
        return undefined;
      case 'filter':
        this.setFilter(message.value);
        return undefined;
      case 'environment':
        await this.deps.environments.select(message.name);
        return undefined;
      case 'pick':
        this.picked = message.file;
        this.post();
        return undefined;
      case 'action':
        return this.runAction(message.action);
      case 'copy':
        return this.copy(message.what);
      case 'open':
        return this.open(message.file);
      case 'create':
        return vscode.commands.executeCommand('mmk.createMigration');
      case 'plan':
        return this.plan();
      case 'applyPlan':
        return this.applyPlan();
      case 'rollBack':
        return this.rollBack(message.batch);
      case 'closeDrawer':
        this.drawer = null;
        if (this.run?.state !== 'running') {
          this.run = null;
        }
        this.post();
        return undefined;
      case 'unlock': {
        const released = await vscode.commands.executeCommand('mmk.unlock', { dir: this.dir });
        if (released !== undefined) {
          this.drawer = null;
          this.post();
        }
        return released;
      }
      case 'editEnvironment':
        return this.openEditDialog(message.name ?? this.deps.store.selected().name);
      case 'removeEnvironment':
        return this.removeEnvironment();
      case 'showOutput':
        return vscode.commands.executeCommand('mmk.showOutput');
      case 'addEnvironment':
        this.dialog = openDialog('add', {
          name: '',
          local: false,
          dbName: '',
          readOnly: true,
          color: null,
          stored: false,
        });
        this.post();
        return undefined;
      case 'closeDialog':
        if (!this.dialog?.saving) {
          this.dialog = null;
          this.post();
        }
        return undefined;
      case 'testEnvironment':
        return this.testEnvironment(message.name, { uri: message.uri, dbName: message.dbName });
      case 'saveEnvironment':
        return this.saveEnvironment(message);
      case 'dismissNotice':
        return this.dismissNotice();
    }
  }

  /** Open the dialog on an environment, filled in from settings and the keychain */
  private async openEditDialog(name: string): Promise<undefined> {
    const environment = this.deps.store.environment(name);
    if (!environment) {
      return undefined;
    }
    const stored = environment.local
      ? null
      : await this.deps.environments.connection(this.dir, environment.name);
    this.dialog = openDialog('edit', {
      name: environment.name,
      local: environment.local,
      dbName: stored?.dbName ?? '',
      readOnly: environment.readOnly,
      color: this.deps.environments.entryHue(environment.name),
      stored: stored !== null,
    });
    this.post();
    return undefined;
  }

  /** Remove the environment the dialog edits: `mmk.removeEnvironment` asks first */
  private async removeEnvironment(): Promise<boolean> {
    const dialog = this.dialog;
    if (dialog?.mode !== 'edit' || dialog.local || dialog.saving) {
      return false;
    }
    const removed = await vscode.commands.executeCommand<boolean>(
      'mmk.removeEnvironment',
      dialog.name,
    );
    if (removed && this.dialog === dialog) {
      this.dialog = null;
      this.post();
    }
    return removed === true;
  }

  /**
   * The connection the dialog's fields name, checked the way the old prompts checked them. When
   * editing, an empty connection string keeps the stored one.
   */
  private async dialogConnection(
    dialog: EnvironmentDialog,
    fields: Connection,
  ): Promise<{ connection: Connection; errors: FieldErrors }> {
    let uri = fields.uri.trim();
    if (uri === '' && dialog.mode === 'edit' && dialog.stored) {
      uri = (await this.deps.environments.connection(this.dir, dialog.name))?.uri ?? '';
    }
    const uriProblem =
      uri === '' && dialog.mode === 'edit'
        ? 'Paste the connection string: none is stored for this project yet'
        : connectionStringProblem(uri);
    const errors: FieldErrors = {
      ...(uriProblem === null ? {} : { uri: uriProblem }),
      ...(fields.dbName.trim() === '' ? { dbName: 'Type the database name' } : {}),
    };
    return { connection: { uri, dbName: fields.dbName.trim() }, errors };
  }

  /** Test the dialog's connection with `mmk status`, and say what mmk read or its error */
  private async testEnvironment(
    name: string,
    fields: Connection,
  ): Promise<ConnectionCheckView | undefined> {
    const dialog = this.dialog;
    const project = this.deps.store.snapshot(this.dir);
    if (!dialog || dialog.saving || dialog.local || !project) {
      return undefined;
    }
    const { connection, errors } = await this.dialogConnection(dialog, fields);
    dialog.errors = errors;
    if (Object.keys(errors).length > 0) {
      dialog.test = { state: 'idle', text: '' };
      this.post();
      return undefined;
    }
    const label = (dialog.mode === 'edit' ? dialog.name : name.trim()) || connection.dbName;
    dialog.test = { state: 'testing', text: `Testing ${label} with mmk status…` };
    this.post();
    const check = await checkConnection(this.deps, project, label, connection);
    if (this.dialog !== dialog) {
      return undefined;
    }
    dialog.test = check.ok
      ? { state: 'ok', text: connectedText(label, check.migrations, check.pending) }
      : { state: 'failed', text: check.message };
    dialog.passed = check.ok ? connection : null;
    dialog.canForce = !check.ok;
    this.post();
    return check.ok ? { ok: true } : { ok: false };
  }

  /**
   * Save the dialog: check every field, test a new or changed connection unless it just passed
   * (or the user saves anyway), then keep it like the commands do. A new environment is
   * switched to.
   */
  private async saveEnvironment(
    message: Extract<ConsoleMessage, { type: 'saveEnvironment' }>,
  ): Promise<string | undefined> {
    const dialog = this.dialog;
    const project = this.deps.store.snapshot(this.dir);
    if (!dialog || dialog.saving || !project) {
      return undefined;
    }
    if (dialog.mode === 'edit') {
      return this.saveEdit(dialog, project, message);
    }
    const existing = this.deps.store.environments().map((environment) => environment.name);
    const nameProblem = environmentNameProblem(message.name, existing);
    const { connection, errors } = await this.dialogConnection(dialog, message);
    dialog.errors = { ...(nameProblem === null ? {} : { name: nameProblem }), ...errors };
    if (Object.keys(dialog.errors).length > 0) {
      this.post();
      return undefined;
    }
    const name = message.name.trim();
    if (!(await this.testBeforeSaving(dialog, project, name, connection, message.force))) {
      return undefined;
    }
    await saveEnvironment(
      this.deps,
      this.dir,
      { name, readOnly: message.readOnly, ...(message.color ? { color: message.color } : {}) },
      connection,
    );
    this.dialog = null;
    await this.deps.environments.select(name);
    this.post();
    return name;
  }

  /**
   * Save changes to an environment: local's colour, or another's connection (tested when it
   * changed), read-only flag and colour. Allowing runs asks first, as it always has.
   */
  private async saveEdit(
    dialog: EnvironmentDialog,
    project: ProjectSnapshot,
    message: Extract<ConsoleMessage, { type: 'saveEnvironment' }>,
  ): Promise<string | undefined> {
    const environment = this.deps.store.environment(dialog.name);
    if (!environment) {
      this.dialog = null;
      this.post();
      return undefined;
    }
    if (dialog.local) {
      dialog.saving = true;
      await this.deps.environments.updateEntry(dialog.name, { color: message.color });
      this.deps.environments.load();
      this.dialog = null;
      this.post();
      return dialog.name;
    }
    const { connection, errors } = await this.dialogConnection(dialog, message);
    dialog.errors = errors;
    if (Object.keys(errors).length > 0) {
      this.post();
      return undefined;
    }
    const stored = await this.deps.environments.connection(this.dir, dialog.name);
    const changed = stored?.uri !== connection.uri || stored.dbName !== connection.dbName;
    if (
      changed &&
      !(await this.testBeforeSaving(dialog, project, dialog.name, connection, message.force))
    ) {
      return undefined;
    }
    if (environment.readOnly && !message.readOnly) {
      const allowed = await this.deps.confirm(
        `Allow runs on ${dialog.name}?`,
        `Run links and the console will offer up, down and redo on ${dialog.name}. Each still asks first.`,
        'Allow runs',
      );
      if (!allowed) {
        dialog.saving = false;
        this.post();
        return undefined;
      }
    }
    dialog.saving = true;
    this.post();
    if (changed) {
      await this.deps.environments.saveConnection(this.dir, dialog.name, connection);
    }
    await this.deps.environments.updateEntry(dialog.name, {
      readOnly: message.readOnly,
      color: message.color,
    });
    this.deps.environments.load();
    this.dialog = null;
    this.post();
    return dialog.name;
  }

  /**
   * Test a connection before saving it, unless the last test passed for it or the user saves
   * anyway. Leaves the dialog saving when it may go on; says what failed when it may not.
   */
  private async testBeforeSaving(
    dialog: EnvironmentDialog,
    project: ProjectSnapshot,
    name: string,
    connection: Connection,
    force: boolean,
  ): Promise<boolean> {
    const tested =
      dialog.passed?.uri === connection.uri && dialog.passed.dbName === connection.dbName;
    dialog.saving = true;
    if (tested || force) {
      return true;
    }
    dialog.test = { state: 'testing', text: `Testing ${name} with mmk status…` };
    this.post();
    const check = await checkConnection(this.deps, project, name, connection);
    if (this.dialog !== dialog) {
      return false;
    }
    if (!check.ok) {
      dialog.saving = false;
      dialog.test = { state: 'failed', text: check.message };
      dialog.canForce = true;
      this.post();
      return false;
    }
    dialog.test = { state: 'ok', text: connectedText(name, check.migrations, check.pending) };
    dialog.passed = connection;
    return true;
  }

  /** Hide the edited notice for the migrations it names, until one of them runs again */
  private async dismissNotice(): Promise<string[]> {
    const keys = this.buildView().model.notices.flatMap((notice) => notice.dismiss ?? []);
    if (keys.length === 0) {
      return [];
    }
    // Keep only what is still edited somewhere, so the list doesn't grow forever.
    const kept = this.dismissedKeys().filter((key) => this.edited.has(key));
    await this.state.update(this.dismissedKey(), [...new Set([...kept, ...keys])]);
    this.post();
    return keys;
  }

  private dismissedKey(): string {
    return `mmk.dismissedNotices:${this.dir}`;
  }

  private dismissedKeys(): string[] {
    const stored: unknown = this.state.get(this.dismissedKey());
    return Array.isArray(stored)
      ? stored.filter((key): key is string => typeof key === 'string')
      : [];
  }

  /** Show what `up` would apply on the selected environment: mmk's dry run, nothing written */
  private async plan(): Promise<PlanStep[] | undefined> {
    const environment = this.deps.store.selected().name;
    this.drawer = { kind: 'plan', environment, loading: true, steps: [], error: null };
    if (this.run?.state !== 'running') {
      this.run = null;
    }
    this.post();
    let drawer: Drawer;
    try {
      const output = await this.deps.store.read(this.dir, ['dry-run', 'up'], environment);
      drawer = {
        kind: 'plan',
        environment,
        loading: false,
        steps: planSteps(parseStatusRows(output.value, 'dry-run')),
        error: null,
      };
    } catch (error) {
      drawer = {
        kind: 'plan',
        environment,
        loading: false,
        steps: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.drawer?.kind === 'plan' && this.drawer.environment === environment) {
      this.drawer = drawer;
      this.post();
    }
    return drawer.kind === 'plan' ? drawer.steps : undefined;
  }

  /**
   * Apply the plan on screen: `up` on the environment it was made for, with the same checks and
   * questions as *Apply all*, then show the result.
   */
  private async applyPlan(): Promise<ConsoleResult | undefined> {
    const plan = this.drawer;
    const project = this.deps.store.snapshot(this.dir);
    if (
      plan?.kind !== 'plan' ||
      plan.loading ||
      plan.steps.length === 0 ||
      !project ||
      this.deps.store.selected().name !== plan.environment
    ) {
      return undefined;
    }
    const files = plan.steps.map((step) => step.file);
    this.drawer = { kind: 'applying', environment: plan.environment, files };
    this.post();
    const run = await applyPending(this.deps, project);
    if (!run) {
      this.drawer = plan;
      this.post();
      return undefined;
    }
    return this.showResult({
      kind: 'up',
      environment: run.environment.name,
      files,
      batch: null,
      outcome: run.outcome,
    });
  }

  /** Roll back a batch on the selected environment (it asks first), then show the result */
  private async rollBack(batch: number): Promise<ConsoleResult | undefined> {
    const project = this.deps.store.snapshot(this.dir);
    if (!project) {
      return undefined;
    }
    const run = await rollBackBatch(this.deps, project, batch);
    if (!run) {
      return undefined;
    }
    return this.showResult({
      kind: 'downBatch',
      environment: run.environment.name,
      files: run.files,
      batch,
      outcome: run.outcome,
    });
  }

  /** Wait for the status read that follows every run, then show how the run came out */
  private async showResult(
    input: Omit<Parameters<typeof buildResult>[0], 'after'>,
  ): Promise<ConsoleResult> {
    await this.deps.store.idle();
    const after = this.deps.store.snapshot(this.dir)?.environments[input.environment]?.rows ?? null;
    const result = buildResult({ ...input, after });
    this.drawer = { kind: 'result', result };
    this.run = null;
    this.post();
    return result;
  }

  /**
   * Run one of the buttons the detail panel shows, on the picked migration. Only a button the
   * model offers runs, and the command checks the environment again.
   */
  private async runAction(action: ConsoleAction): Promise<unknown> {
    const detail = this.buildView().model.detail;
    if (!detail?.buttons.some((button) => button.action === action && !button.disabled)) {
      return undefined;
    }
    if (action === 'showAppliedVersion') {
      const file = this.fileUri(detail.file);
      return file ? vscode.commands.executeCommand('mmk.showAppliedVersion', file) : undefined;
    }
    if (action === 'downBatch') {
      const batch = detail.buttons.find((button) => button.action === 'downBatch')?.batch;
      return batch === undefined ? undefined : this.rollBack(batch);
    }
    return vscode.commands.executeCommand(`mmk.${action}`, { dir: this.dir, file: detail.file });
  }

  private async copy(what?: 'plan' | 'lock'): Promise<string | undefined> {
    const view = this.buildView();
    const cli =
      what === 'lock'
        ? this.cli(this.deps.store.selected(), ['lock'])
        : what === 'plan'
          ? view.drawer?.kind === 'plan'
            ? view.drawer.cli
            : ''
          : view.cli;
    if (!cli) {
      return undefined;
    }
    await vscode.env.clipboard.writeText(cli);
    void vscode.window.showInformationMessage(`Copied: ${cli}`);
    return cli;
  }

  private async open(file: string): Promise<void> {
    const uri = this.source.kind === 'branch' ? this.fileUri(file) : undefined;
    if (uri) {
      await vscode.window.showTextDocument(uri);
    }
  }

  /** The file in the project's migrations folder, when it's one mmk knows */
  private fileUri(file: string): vscode.Uri | undefined {
    const config = this.deps.store.snapshot(this.dir)?.config;
    const known = this.deps.store.snapshot(this.dir)?.rows?.some((row) => row.file === file);
    return config && known
      ? vscode.Uri.file(path.join(config.migrationsDir, path.basename(file)))
      : undefined;
  }

  private async loadGit(): Promise<void> {
    const project = this.deps.store.snapshot(this.dir);
    const folder = project?.config?.migrationsDir ?? this.dir;
    [this.branch, this.defaultRef] = await Promise.all([
      currentBranch(folder),
      defaultRemoteRef(folder),
    ]);
    this.post();
  }

  /** Read every environment again: the store's reads, or `status --dir` on the ref's files */
  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.post();
    try {
      await this.loadGit();
      if (this.source.kind === 'branch') {
        await this.deps.store.refresh(this.dir);
      } else {
        await this.readRef(this.source.ref);
      }
      this.updatedAt = new Date();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.post();
    }
  }

  /** Copy the ref's migrations folder to a temporary folder, read each environment against it */
  private async readRef(ref: string): Promise<void> {
    const project = this.deps.store.snapshot(this.dir);
    const folder = project?.config?.migrationsDir;
    if (!project || !folder) {
      throw new Error("This project's config hasn't been read yet. Refresh the mmk view first.");
    }
    const copy = await copyRefFolder(folder, ref);
    try {
      const rows = new Map<string, { rows: WireStatusRow[] | null; error: string | null }>();
      await Promise.all(
        this.deps.store.environments().map(async (environment) => {
          if (project.environments[environment.name]?.connected === false) {
            rows.set(environment.name, { rows: null, error: null });
            return;
          }
          try {
            const output = await this.deps.store.read(
              this.dir,
              ['status', '--dir', copy.dir],
              environment.name,
            );
            rows.set(environment.name, {
              rows: parseStatusRows(output.value, 'status'),
              error: null,
            });
          } catch (error) {
            rows.set(environment.name, {
              rows: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
      this.refRows = rows;
      this.deps.log.info(`Compared ${copy.files} file(s) from ${ref} with every environment`);
    } finally {
      await copy.dispose();
    }
  }

  private post(): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: 'model', view: this.buildView() });
    }
  }

  private buildView(): ConsoleView {
    const project = this.deps.store.snapshot(this.dir);
    const environments = this.deps.store.environments();
    const selected = this.deps.store.selected();
    const filesLabel = this.source.kind === 'ref' ? this.source.ref : 'your branch';
    const inputs = environments.map((environment) => this.input(project, environment));
    const matrix = buildMatrix(inputs, filesLabel);
    this.edited = editedKeys(matrix);
    const model = buildConsole({
      matrix,
      environments,
      selected: selected.name,
      filter: this.filter,
      picked: this.picked,
      rows: Object.fromEntries(inputs.map((input) => [input.environment.name, input.rows])),
      filesAreLocal: this.source.kind === 'branch',
      locks: environmentLocks(project, environments),
      dismissed: new Set(this.dismissedKeys()),
    });
    const readAt = environments
      .map((environment) => project?.environments[environment.name]?.readAt)
      .filter((value): value is Date => value instanceof Date);
    const updated =
      this.source.kind === 'branch' && readAt.length > 0
        ? new Date(Math.min(...readAt.map((date) => date.getTime())))
        : this.updatedAt;
    const files =
      this.source.kind === 'ref'
        ? `Files on ${this.source.ref}`
        : this.branch
          ? `Files on branch ${this.branch}`
          : 'Files in your working tree';
    return {
      title: project ? relativeDir(project.dir) || path.basename(project.dir) : 'Migrations',
      subtitle: `${files}, records from each environment's changelog · updated ${clock(updated)}`,
      source: this.source.kind,
      refLabel: this.defaultRef,
      loading: this.loading || inputs.some((input) => input.state === 'loading'),
      error: this.error,
      selected: selected.name,
      filter: this.filter,
      columns: matrix.columns.map((column) => ({
        name: column.name,
        readOnly: column.readOnly,
        state: column.state,
        title:
          column.state === 'error'
            ? `Couldn't read ${column.name}: ${column.message ?? ''}`
            : column.state === 'not-set-up'
              ? `${column.name} isn't set up for this project: run "mmk: Edit environment…"`
              : `${column.name}: ${column.database ?? ''}${column.readOnly ? ' (read-only)' : ''}`,
      })),
      model,
      cli: model.detail ? this.cli(selected, model.detail.cli) : '',
      drawer: this.drawerView(project, files),
      dialog: this.dialog
        ? {
            kind: this.dialog.mode === 'add' ? 'addEnvironment' : 'editEnvironment',
            name: this.dialog.name,
            local: this.dialog.local,
            dbName: this.dialog.dbName,
            readOnly: this.dialog.readOnly,
            color: this.dialog.color,
            stored: this.dialog.stored,
            test: this.dialog.test,
            errors: this.dialog.errors,
            saving: this.dialog.saving,
            canForce: this.dialog.canForce,
          }
        : null,
      run: this.run ? { ...this.run, lines: [...this.run.lines] } : null,
    };
  }

  private drawerView(project: ProjectSnapshot | undefined, files: string): DrawerView | null {
    const drawer = this.drawer;
    if (drawer?.kind !== 'plan') {
      return drawer;
    }
    const environment = this.deps.store.environment(drawer.environment);
    const readOnly = environment?.readOnly ?? true;
    const lock = environmentLock(project, drawer.environment);
    return {
      ...drawer,
      readOnly,
      database: databaseLabel(project, drawer.environment),
      files,
      cli: environment ? this.cli(environment, readOnly ? ['dry-run', 'up'] : ['up']) : '',
      locked: lock && !readOnly ? `${drawer.environment} is locked by ${lock.who}` : '',
    };
  }

  /**
   * The CLI command, as Copy CLI command writes it: on another environment, `MMK_URI` holds a
   * placeholder (the connection string is never copied) and `MMK_DB` the database.
   */
  private cli(environment: Environment, args: readonly string[]): string {
    const command = terminalCommand(args, relativeDir(this.dir));
    if (environment.local) {
      return command;
    }
    if (!this.databases.has(environment.name)) {
      this.databases.set(environment.name, null);
      void this.deps.environments.connection(this.dir, environment.name).then((connection) => {
        this.databases.set(environment.name, connection?.dbName ?? null);
        this.post();
      });
    }
    const database = this.databases.get(environment.name) ?? `<${environment.name} database>`;
    const prefix = `MMK_URI='<${environment.name} connection string>' MMK_DB=${database} `;
    const at = command.indexOf('npx ');
    return `${command.slice(0, at)}${prefix}${command.slice(at)}`;
  }

  private input(project: ProjectSnapshot | undefined, environment: Environment): MatrixInput {
    const status = project?.environments[environment.name];
    const database = status?.database ?? null;
    if (this.source.kind === 'ref') {
      const read = this.refRows?.get(environment.name);
      if (status?.connected === false) {
        return { environment, rows: null, state: 'not-set-up', database };
      }
      if (!read) {
        return { environment, rows: null, state: 'loading', database };
      }
      return read.error !== null
        ? { environment, rows: null, state: 'error', message: read.error, database }
        : { environment, rows: read.rows, state: 'ok', database };
    }
    const [input] = matrixInputs(project, [environment]);
    return input ?? { environment, rows: null, state: 'loading', database };
  }

  private html(codicons: vscode.Uri, media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'console.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'console.js'));
    const icons = webview.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${icons}">
<link rel="stylesheet" href="${css}">
<title>Migrations</title>
</head>
<body>
<main id="app" aria-live="polite"></main>
<div id="dialog"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** A dialog that has just opened: nothing tested, nothing wrong yet */
function openDialog(mode: 'add' | 'edit', fields: DialogFields): EnvironmentDialog {
  return {
    mode,
    ...fields,
    test: { state: 'idle', text: '' },
    errors: {},
    saving: false,
    passed: null,
    canForce: false,
  };
}

/** What the dialog's connection test found, for tests: never the connection itself */
interface ConnectionCheckView {
  ok: boolean;
}

/** `Connected: mmk status read 8 migrations on qa, 3 of them pending.` */
function connectedText(name: string, migrations: number, pending: number): string {
  if (migrations === 0) {
    return `Connected: mmk status found no migrations on ${name} yet.`;
  }
  const count = `${migrations} ${migrations === 1 ? 'migration' : 'migrations'}`;
  return `Connected: mmk status read ${count} on ${name}, ${pending} of them pending.`;
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
