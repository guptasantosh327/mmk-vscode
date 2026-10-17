import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Deps } from '../commands/context.js';
import { isUnknownCommand } from '../mmk/cli.js';
import { type LintReport, parseLintReport } from '../mmk/contract.js';
import { LOCAL_ENVIRONMENT } from '../mmk/environments.js';

/** mmk's page that explains each lint rule */
const RULES_URL = 'https://mongo-migrate-kit.vercel.app/commands/lint#rules';

/**
 * `mmk lint` findings as diagnostics (source `mmk`, code = the rule). mmk reads the files on
 * disk, so it runs when a migration is saved, added or removed, never while typing. An mmk
 * without `lint` is left alone.
 */
export class LintDiagnostics implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('mmk-lint');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly signatures = new Map<string, string>();
  private readonly unsupported = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<LintReport | undefined>>();

  constructor(private readonly deps: Deps) {
    this.disposables.push(
      this.diagnostics,
      deps.store.onDidChange(() => this.sync()),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const ref = deps.store.migrationFor(document.uri.fsPath);
        if (ref) {
          this.schedule(ref.project.dir);
        }
      }),
    );
    this.sync();
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /** Lint a project now; resolves with mmk's report (for tests), or undefined when it can't */
  async lint(dir: string): Promise<LintReport | undefined> {
    const pending = this.running.get(dir);
    if (pending) {
      await pending;
    }
    const next = this.runLint(dir).finally(() => this.running.delete(dir));
    this.running.set(dir, next);
    return next;
  }

  /** Lint again when a project's config or its list of files changed */
  private sync(): void {
    for (const project of this.deps.store.snapshots()) {
      const migrationsDir = project.config?.migrationsDir;
      const rows = project.environments[LOCAL_ENVIRONMENT]?.rows;
      if (project.state.kind !== 'ready' || !migrationsDir || !rows) {
        continue;
      }
      const signature = `${migrationsDir}|${rows.map((row) => row.file).join(',')}`;
      if (this.signatures.get(project.dir) !== signature) {
        this.signatures.set(project.dir, signature);
        this.schedule(project.dir);
      }
    }
  }

  private schedule(dir: string): void {
    if (this.unsupported.has(dir)) {
      return;
    }
    const timer = this.timers.get(dir);
    if (timer) {
      clearTimeout(timer);
    }
    this.timers.set(
      dir,
      setTimeout(() => {
        this.timers.delete(dir);
        void this.lint(dir);
      }, 300),
    );
  }

  private async runLint(dir: string): Promise<LintReport | undefined> {
    const project = this.deps.store.snapshot(dir);
    const migrationsDir = project?.config?.migrationsDir;
    if (!project || !migrationsDir || this.unsupported.has(dir)) {
      return undefined;
    }
    let report: LintReport;
    try {
      const output = await this.deps.store.read(dir, ['lint'], LOCAL_ENVIRONMENT, 30_000);
      report = parseLintReport(output.value);
    } catch (error) {
      if (isUnknownCommand(error, 'lint')) {
        this.unsupported.add(dir);
        this.deps.log.debug(
          `This mongo-migrate-kit has no \`mmk lint\` command, so migrations in ${dir} aren't linted`,
        );
      } else {
        this.deps.log.warn(
          `Couldn't lint the migrations in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return undefined;
    }
    for (const file of report.files) {
      const uri = vscode.Uri.file(path.join(migrationsDir, file));
      this.diagnostics.set(
        uri,
        report.findings
          .filter((finding) => finding.file === file)
          .map((finding) => {
            const range = new vscode.Range(
              finding.line - 1,
              finding.column - 1,
              finding.endLine - 1,
              finding.endColumn - 1,
            );
            const diagnostic = new vscode.Diagnostic(
              range,
              finding.message,
              finding.severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Warning,
            );
            diagnostic.source = 'mmk';
            diagnostic.code = { value: finding.rule, target: vscode.Uri.parse(RULES_URL) };
            return diagnostic;
          }),
      );
    }
    return report;
  }
}
