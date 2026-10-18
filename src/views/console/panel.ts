import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Deps, databaseLabel, relativeDir, resolveProject } from '../../commands/context.js';
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
  isConsoleMessage,
  planSteps,
} from '../../mmk/console.js';
import { parseStatusRows } from '../../mmk/contract.js';
import type { WireStatusRow } from '../../mmk/contract.js';
import type { Environment } from '../../mmk/environments.js';
import { environmentLocks } from '../../mmk/lock-holder.js';
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
    }
  | { kind: 'applying'; environment: string; files: string[] }
  | { kind: 'result'; result: ConsoleResult };

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
export function registerConsole(deps: Deps, extensionUri: vscode.Uri): vscode.Disposable[] {
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
      panel = new ConsolePanel(deps, extensionUri, project.dir, () => panels.delete(project.dir));
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

  constructor(
    private readonly deps: Deps,
    extensionUri: vscode.Uri,
    private readonly dir: string,
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
        return vscode.commands.executeCommand(
          'mmk.editEnvironment',
          this.deps.store.selected().name,
        );
      case 'showOutput':
        return vscode.commands.executeCommand('mmk.showOutput');
      case 'addEnvironment':
        return vscode.commands.executeCommand('mmk.addEnvironment');
    }
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
    if (!detail?.buttons.some((button) => button.action === action)) {
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

  private async copy(what?: 'plan'): Promise<string | undefined> {
    const view = this.buildView();
    const cli = what === 'plan' ? (view.drawer?.kind === 'plan' ? view.drawer.cli : '') : view.cli;
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
    const model = buildConsole({
      matrix,
      environments,
      selected: selected.name,
      filter: this.filter,
      picked: this.picked,
      rows: Object.fromEntries(inputs.map((input) => [input.environment.name, input.rows])),
      filesAreLocal: this.source.kind === 'branch',
      locks: environmentLocks(project, environments),
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
    return {
      ...drawer,
      readOnly,
      database: databaseLabel(project, drawer.environment),
      files,
      cli: environment ? this.cli(environment, readOnly ? ['dry-run', 'up'] : ['up']) : '',
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
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
