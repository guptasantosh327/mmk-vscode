import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Deps, relativeDir, shortName } from '../commands/context.js';
import { MmkCommandError, isUnknownCommand } from '../mmk/cli.js';
import { type RollbackTestReport, parseRollbackReport } from '../mmk/contract.js';
import { LOCAL_ENVIRONMENT } from '../mmk/environments.js';
import { findMigrationFunctions } from '../mmk/migration-functions.js';
import { formatDay } from '../mmk/model.js';
import { displayName } from '../mmk/naming.js';
import {
  type FileOutcome,
  ROLLBACK_STEPS,
  isInFile,
  rollbackOutcomes,
  rollbackSummary,
  stepLabel,
} from '../mmk/rollback.js';
import { StoreError } from '../mmk/store.js';

/** What a test run reported, for the integration tests */
export interface RollbackRunRecord {
  reports: RollbackTestReport[];
  /** Every failure message given to Test Explorer: item, text and 0-based line */
  messages: Array<{ id: string; text: string; line: number | null; file: string | null }>;
}

/** What an item stands for */
type ItemData =
  | { kind: 'project'; dir: string }
  | { kind: 'file'; dir: string; file: string }
  | { kind: 'step'; dir: string; file: string; step: string };

/**
 * Rollback tests in Test Explorer (design A4): one item per migration, with the steps `up`,
 * `down` and `up again` under it. Running them runs `mmk test-rollback --json`, which does
 * everything on a temporary database and drops it; the extension only shows mmk's report.
 * Always on local: the project's own config and `.env`.
 */
export class RollbackTests implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController(
    'mmk.rollback',
    'mmk rollback round-trip',
  );
  private readonly data = new WeakMap<vscode.TestItem, ItemData>();
  private readonly disposables: vscode.Disposable[] = [];
  private signature = '';
  /** The last run's report and messages (for tests) */
  lastRun: RollbackRunRecord = { reports: [], messages: [] };

  constructor(private readonly deps: Deps) {
    this.controller.createRunProfile(
      'Test rollback (temporary database)',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.run(request, token),
      true,
    );
    this.controller.refreshHandler = async () => {
      await deps.store.refresh(undefined, { environment: LOCAL_ENVIRONMENT });
      this.sync(true);
    };
    this.disposables.push(
      this.controller,
      deps.store.onDidChange(() => this.sync()),
    );
    this.sync();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /** The item of one migration, once its project's files are known */
  itemFor(dir: string, file: string): vscode.TestItem | undefined {
    const projects = this.deps.store.snapshots();
    const parent =
      projects.length === 1 ? this.controller.items : this.controller.items.get(dir)?.children;
    return parent?.get(fileId(dir, file));
  }

  /** Run the tests of these items now (the "Test rollback" buttons), and wait for the result */
  async runItems(items: readonly vscode.TestItem[]): Promise<RollbackRunRecord> {
    const source = new vscode.CancellationTokenSource();
    try {
      await this.run(new vscode.TestRunRequest(items), source.token);
    } finally {
      source.dispose();
    }
    return this.lastRun;
  }

  /** Rebuild the items when the projects or their migration files change */
  private sync(force = false): void {
    const projects = this.deps.store
      .snapshots()
      .filter((project) => project.state.kind === 'ready' && project.config);
    const files = projects.map((project) => ({
      dir: project.dir,
      migrationsDir: project.config?.migrationsDir ?? '',
      files: (project.environments[LOCAL_ENVIRONMENT]?.rows ?? [])
        .filter((row) => !row.fileMissing)
        .map((row) => row.file),
    }));
    const signature = JSON.stringify(files);
    if (!force && signature === this.signature) {
      return;
    }
    this.signature = signature;
    const single = files.length === 1;
    const top: vscode.TestItem[] = [];
    for (const project of files) {
      const fileItems = project.files.map((file) =>
        this.fileItem(project.dir, project.migrationsDir, file),
      );
      if (single) {
        top.push(...fileItems);
        continue;
      }
      const item = this.controller.createTestItem(
        project.dir,
        relativeDir(project.dir) || path.basename(project.dir),
        vscode.Uri.file(project.dir),
      );
      this.data.set(item, { kind: 'project', dir: project.dir });
      item.children.replace(fileItems);
      top.push(item);
    }
    this.controller.items.replace(top);
  }

  private fileItem(dir: string, migrationsDir: string, file: string): vscode.TestItem {
    const uri = vscode.Uri.file(path.join(migrationsDir, file));
    const shown = displayName(file);
    const item = this.controller.createTestItem(fileId(dir, file), shown.label, uri);
    item.description = shown.date ? formatDay(shown.date) : file;
    item.sortText = file;
    this.data.set(item, { kind: 'file', dir, file });
    let lines: { up: number | null; down: number | null } = { up: null, down: null };
    try {
      lines = findMigrationFunctions(readFileSync(uri.fsPath, 'utf8'));
    } catch {
      // A file that can't be read gets no ranges; mmk will say what's wrong when it runs.
    }
    item.range = new vscode.Range(lines.up ?? 0, 0, lines.up ?? 0, 0);
    item.children.replace(
      ROLLBACK_STEPS.map((step, index) => {
        const child = this.controller.createTestItem(
          `${fileId(dir, file)}::${step}`,
          stepLabel(step),
          uri,
        );
        // No range: Test Explorer sorts by location, which would put "up again" before "down".
        // The file's item marks up(); a failure still points at the line mmk names.
        child.sortText = String(index);
        this.data.set(child, { kind: 'step', dir, file, step });
        return child;
      }),
    );
    return item;
  }

  /** The run handler: one `mmk test-rollback` per project, or per file when only some are asked */
  private async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const plan = this.plan(request);
    const run = this.controller.createTestRun(request, 'mmk rollback round-trip');
    this.lastRun = { reports: [], messages: [] };
    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());
    try {
      for (const [dir, target] of plan) {
        const items = target.files.map((file) => this.itemFor(dir, file)).filter(isItem);
        for (const item of items) {
          run.enqueued(item);
          item.children.forEach((child) => run.enqueued(child));
        }
        const batches = target.all ? [undefined] : target.files;
        for (const file of batches) {
          if (token.isCancellationRequested) {
            break;
          }
          const batchItems = file === undefined ? items : [this.itemFor(dir, file)].filter(isItem);
          for (const item of batchItems) {
            run.started(item);
          }
          await this.runOne(run, dir, file, batchItems, abort.signal);
        }
      }
    } finally {
      cancel.dispose();
      run.end();
    }
  }

  /** Which files of which projects to test, and whether a project runs all of its files */
  private plan(request: vscode.TestRunRequest): Map<string, { all: boolean; files: string[] }> {
    const plan = new Map<string, { all: boolean; files: string[] }>();
    const projectFiles = (dir: string): string[] => {
      const rows = this.deps.store.snapshot(dir)?.environments[LOCAL_ENVIRONMENT]?.rows ?? [];
      return rows.filter((row) => !row.fileMissing).map((row) => row.file);
    };
    const excluded = new Set((request.exclude ?? []).map((item) => item.id));
    const add = (dir: string, files: string[], all: boolean): void => {
      const entry = plan.get(dir) ?? { all: false, files: [] };
      entry.all = entry.all || all;
      entry.files = [...new Set([...entry.files, ...files])].filter(
        (file) => !excluded.has(fileId(dir, file)),
      );
      plan.set(dir, entry);
    };
    if (!request.include) {
      for (const project of this.deps.store.snapshots()) {
        if (project.state.kind === 'ready') {
          add(project.dir, projectFiles(project.dir), true);
        }
      }
    } else {
      for (const item of request.include) {
        const data = this.data.get(item);
        if (!data) {
          continue;
        }
        if (data.kind === 'project') {
          add(data.dir, projectFiles(data.dir), true);
        } else {
          add(data.dir, [data.file], false);
        }
      }
    }
    for (const [dir, entry] of plan) {
      const all = projectFiles(dir);
      // Asking for every file is the same as running the whole project once.
      entry.all = entry.all || (entry.files.length === all.length && all.length > 0);
      entry.files.sort();
      if (excluded.size > 0 && entry.files.length < all.length) {
        entry.all = false;
      }
    }
    return plan;
  }

  private async runOne(
    run: vscode.TestRun,
    dir: string,
    file: string | undefined,
    items: readonly vscode.TestItem[],
    signal: AbortSignal,
  ): Promise<void> {
    const args = file === undefined ? ['test-rollback'] : ['test-rollback', file];
    let report: RollbackTestReport;
    try {
      const output = await this.deps.store.run(
        dir,
        args,
        `test-rollback${file === undefined ? '' : ` ${shortName(file)}`}`,
        LOCAL_ENVIRONMENT,
        { signal },
      );
      report = parseRollbackReport(output.value);
    } catch (error) {
      const text = isUnknownCommand(error, 'test-rollback')
        ? `Rollback tests need a newer mongo-migrate-kit: this one has no \`mmk test-rollback\` command. Update it with npm install --save-dev mongo-migrate-kit@latest.`
        : error instanceof MmkCommandError || error instanceof StoreError || error instanceof Error
          ? error.message
          : String(error);
      for (const item of items) {
        run.errored(item, new vscode.TestMessage(text));
        this.lastRun.messages.push({ id: item.id, text, line: null, file: null });
      }
      run.appendOutput(`${text.replace(/\n/g, '\r\n')}\r\n`);
      return;
    }
    this.lastRun.reports.push(report);
    for (const outcome of rollbackOutcomes(report)) {
      const item = this.itemFor(dir, outcome.file);
      if (item) {
        this.report(run, item, outcome);
      }
    }
    run.appendOutput(`${rollbackSummary(report)}\r\n`);
  }

  /** Show one file's outcome on its item and its step items */
  private report(run: vscode.TestRun, item: vscode.TestItem, outcome: FileOutcome): void {
    for (const step of outcome.steps) {
      const child = item.children.get(`${item.id}::${step.step}`);
      if (!child) {
        continue;
      }
      if (step.status === 'passed') {
        run.passed(child, step.duration);
      } else if (step.status === 'skipped') {
        run.skipped(child);
      } else {
        run.failed(child, this.message(item, outcome, child), step.duration);
      }
    }
    switch (outcome.status) {
      case 'passed':
        run.passed(item, outcome.duration);
        return;
      case 'skipped':
        run.skipped(item);
        return;
      case 'errored':
        run.errored(item, this.message(item, outcome, item));
        return;
      case 'failed':
        run.failed(item, this.message(item, outcome, item), outcome.duration);
        return;
    }
  }

  /** The A4 message: what failed, mmk's own explanation, at the line that threw */
  private message(
    item: vscode.TestItem,
    outcome: FileOutcome,
    target: vscode.TestItem,
  ): vscode.TestMessage {
    const failure = outcome.failure;
    const text = failure ? `${failure.title}\n\n${failure.message}` : 'rollback test failed';
    const message = new vscode.TestMessage(text);
    let line: number | null = null;
    if (item.uri) {
      const location = failure?.location;
      if (location && isInFile(location, item.uri.fsPath)) {
        line = location.line - 1;
        message.location = new vscode.Location(
          item.uri,
          new vscode.Position(line, Math.max(0, location.column - 1)),
        );
      } else {
        const range = target.range ?? item.range;
        if (range) {
          line = range.start.line;
          message.location = new vscode.Location(item.uri, range);
        }
      }
    }
    this.lastRun.messages.push({ id: target.id, text, line, file: item.uri?.fsPath ?? null });
    return message;
  }
}

/** Register "mmk: Test rollback" for a file, the active editor, or every migration */
export function registerRollbackCommand(deps: Deps, tests: RollbackTests): vscode.Disposable {
  return vscode.commands.registerCommand('mmk.testRollback', async (target?: unknown) => {
    let dir: string | undefined;
    let file: string | undefined;
    if (target instanceof vscode.Uri) {
      const ref = deps.store.migrationFor(target.fsPath);
      dir = ref?.project.dir;
      file = ref?.file;
    } else if (typeof target === 'object' && target !== null && 'dir' in target) {
      dir = String(target.dir);
      file = 'file' in target && typeof target.file === 'string' ? target.file : undefined;
    } else {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const ref = uri?.scheme === 'file' ? deps.store.migrationFor(uri.fsPath) : undefined;
      dir = ref?.project.dir;
      file = ref?.file;
    }
    if (dir !== undefined && file !== undefined) {
      const item = tests.itemFor(dir, file);
      if (!item) {
        void vscode.window.showWarningMessage(
          `${shortName(file)} isn't in Test Explorer yet. Refresh the mmk view and try again.`,
        );
        return undefined;
      }
      return tests.runItems([item]);
    }
    const all: vscode.TestItem[] = [];
    tests.controller.items.forEach((item) => all.push(item));
    return tests.runItems(all);
  });
}

function fileId(dir: string, file: string): string {
  return `${dir}::${file}`;
}

function isItem(item: vscode.TestItem | undefined): item is vscode.TestItem {
  return item !== undefined;
}
