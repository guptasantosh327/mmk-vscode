import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Deps } from '../commands/context.js';
import { type AppliedVersion, findAppliedVersion, readVersion } from '../git/applied-version.js';
import {
  type AppliedRecord,
  type EditVerdict,
  changedLines,
  describeWhereItRan,
  judgeEdit,
  listNames,
  problemMessage,
} from '../mmk/applied-edits.js';
import { bufferChecksum, checksumOfBytes, shortChecksum, startsWithBom } from '../mmk/checksum.js';
import { findMigrationFunctions } from '../mmk/migration-functions.js';
import { formatDay } from '../mmk/model.js';

/** The diagnostic code (and hover footer) for an edited applied migration */
export const APPLIED_EDITED = 'applied-edited';

/** The scheme of the read-only documents that hold the version that ran */
export const APPLIED_SCHEME = 'mmk-applied';

/** What's known about one open migration file that differs from what ran */
export interface EditedState {
  verdict: EditVerdict;
  /** True when the file on disk differs too, not only the editor's text */
  saved: boolean;
  range: vscode.Range;
}

/**
 * Applied-file protection (designs B1 and B2). While a migration that has run is edited, hash
 * the editor's text the way mmk does and compare it with the checksum each environment
 * recorded. A difference raises a warning on the changed lines, before anything is saved.
 * "Show applied version" finds the commit whose version has the recorded checksum and diffs it
 * with the working file; "Restore applied version" puts it back.
 */
export class AppliedProtection
  implements vscode.HoverProvider, vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('mmk');
  private readonly states = new Map<string, EditedState>();
  private readonly versions = new Map<string, AppliedVersion>();
  private readonly searching = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly told = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Fires when an edited state changes, for run links and Explorer badges */
  readonly onDidChangeState = this.changed.event;

  constructor(private readonly deps: Deps) {
    this.disposables.push(
      this.diagnostics,
      this.changed,
      vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document, 0)),
      vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document, 150)),
      vscode.workspace.onDidSaveTextDocument((document) => this.schedule(document, 0)),
      vscode.workspace.onDidCloseTextDocument((document) => this.clear(document.uri)),
      deps.store.onDidChange(() => this.scheduleAll()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateDiffContext()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateDiffContext()),
    );
    this.scheduleAll();
  }

  /** The edited state of a file, or undefined when it matches what ran (or never ran) */
  state(uri: vscode.Uri): EditedState | undefined {
    return this.states.get(uri.toString());
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /** Check every open document again (after mmk's status changed) */
  scheduleAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document, 50);
    }
  }

  /** Check a document now; resolves when its diagnostic is up to date (for tests) */
  async check(document: vscode.TextDocument): Promise<EditedState | undefined> {
    await this.update(document);
    return this.state(document.uri);
  }

  private schedule(document: vscode.TextDocument, delayMs: number): void {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const key = document.uri.toString();
    const pending = this.timers.get(key);
    if (pending) {
      clearTimeout(pending);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.update(document);
      }, delayMs),
    );
  }

  private async update(document: vscode.TextDocument): Promise<void> {
    const ref = document.isClosed ? undefined : this.deps.store.migrationFor(document.uri.fsPath);
    if (!ref) {
      this.clear(document.uri);
      return;
    }
    let disk: Buffer | null = null;
    try {
      disk = await readFile(document.uri.fsPath);
    } catch {
      disk = null;
    }
    const textChecksum =
      document.isDirty || disk === null
        ? bufferChecksum(document.getText(), disk !== null && startsWithBom(disk))
        : checksumOfBytes(disk);
    const verdict = judgeEdit(ref.project, this.deps.store.environments(), ref.file, textChecksum);

    if (verdict.applied.length === 0 && verdict.checksumsMissing && document.isDirty) {
      this.tellChecksumsMissing(ref.project.dir, ref.project.state);
    }
    if (verdict.edited.length === 0) {
      this.clear(document.uri);
      return;
    }

    const saved =
      disk !== null && verdict.edited.some((record) => record.checksum !== checksumOfBytes(disk));
    const range = await this.changedRange(document, disk, verdict.edited);
    const state: EditedState = { verdict, saved, range };
    const diagnostic = new vscode.Diagnostic(
      range,
      problemMessage(verdict.edited, saved),
      vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = 'mmk';
    diagnostic.code = APPLIED_EDITED;
    this.diagnostics.set(document.uri, [diagnostic]);
    const before = this.states.get(document.uri.toString());
    this.states.set(document.uri.toString(), state);
    if (
      !before ||
      before.saved !== saved ||
      before.verdict.edited.length !== verdict.edited.length
    ) {
      this.changed.fire();
    }
  }

  /**
   * The changed lines: against the file on disk when that is still the version that ran (an
   * unsaved edit), else against the version found in git. Until git answers, the line of `up`.
   */
  private async changedRange(
    document: vscode.TextDocument,
    disk: Buffer | null,
    edited: readonly AppliedRecord[],
  ): Promise<vscode.Range> {
    const text = document.getText();
    let base: string | undefined;
    if (disk !== null && edited.some((record) => record.checksum === checksumOfBytes(disk))) {
      base = stripBom(disk.toString('utf8'));
    } else {
      const known = this.versions.get(versionKey(document.uri.fsPath, edited[0]?.checksum ?? ''));
      if (known) {
        base = stripBom(known.content.toString('utf8'));
      } else {
        this.searchInBackground(document, edited[0]?.checksum);
      }
    }
    const lines = base === undefined ? null : changedLines(base, text);
    const start = lines?.start ?? findMigrationFunctions(text).up ?? 0;
    const end = lines?.end ?? start;
    const last = Math.min(end, document.lineCount - 1);
    return new vscode.Range(start, 0, last, document.lineAt(last).range.end.character);
  }

  private searchInBackground(document: vscode.TextDocument, checksum: string | undefined): void {
    if (checksum === undefined) {
      return;
    }
    const key = versionKey(document.uri.fsPath, checksum);
    if (this.searching.has(key)) {
      return;
    }
    this.searching.add(key);
    void this.findVersion(document.uri.fsPath, checksum).then((found) => {
      if (found) {
        this.schedule(document, 0);
      }
    });
  }

  /** The commit whose version of `file` has `checksum`, cached once found */
  async findVersion(file: string, checksum: string): Promise<AppliedVersion | null> {
    const key = versionKey(file, checksum);
    const cached = this.versions.get(key);
    if (cached) {
      return cached;
    }
    try {
      const found = await findAppliedVersion(file, checksum);
      if (found) {
        this.versions.set(key, found);
      }
      return found;
    } catch (error) {
      this.deps.log.warn(
        `Couldn't search git for the version of ${path.basename(file)} that ran: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      this.searching.delete(key);
    }
  }

  private clear(uri: vscode.Uri): void {
    this.diagnostics.delete(uri);
    if (this.states.delete(uri.toString())) {
      this.changed.fire();
    }
  }

  private tellChecksumsMissing(dir: string, state: { kind: string; version?: string }): void {
    if (this.told.has(dir)) {
      return;
    }
    this.told.add(dir);
    const version = state.kind === 'ready' && 'version' in state ? ` ${state.version}` : '';
    void vscode.window.showInformationMessage(
      `This migration has already run. mmk for VS Code can warn while you edit it, but mongo-migrate-kit${version} doesn't report the checksum each migration ran with. Update mongo-migrate-kit to get the warning.`,
    );
  }

  /** The B1 hover over the changed lines */
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const state = this.states.get(document.uri.toString());
    if (!state || !state.range.contains(position)) {
      return undefined;
    }
    const names = listNames(state.verdict.edited.map((record) => record.environment));
    const count = state.verdict.edited.length;
    const forAll = count === 1 ? `for ${names}` : count === 2 ? 'for both' : `for all ${count}`;
    const args = encodeURIComponent(JSON.stringify([document.uri.toString()]));
    const lines = [
      '**This migration has already run**',
      '',
      `${describeWhereItRan(state.verdict.edited)} ${state.saved ? 'Its file changed since, so its checksum no longer matches' : 'If you save this edit, its checksum changes'} ${forAll}:`,
      '',
      '- `mmk down` will refuse to roll it back',
      '- `mmk status` will mark it as changed',
      '- Nothing re-runs it: the databases keep the old result',
      '',
      "To change the data that's there now, write a new migration instead.",
      '',
      `[Show applied version](command:mmk.showAppliedVersion?${args}) · [Undo my edit](command:mmk.undoAppliedEdit?${args}) · [Create a new migration](command:mmk.createMigration)`,
    ];
    const markdown = new vscode.MarkdownString(lines.join('\n'));
    markdown.isTrusted = {
      enabledCommands: ['mmk.showAppliedVersion', 'mmk.undoAppliedEdit', 'mmk.createMigration'],
    };
    return new vscode.Hover(markdown, state.range);
  }

  /** Read-only content of an `mmk-applied:` document: the file as it is in a commit */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const root = query.get('root');
    const commit = query.get('commit');
    const file = query.get('file');
    if (!root || !commit || !file) {
      return '';
    }
    const content = await readVersion(root, commit, file);
    return content ? stripBom(content.toString('utf8')) : '';
  }

  /** Keep `mmk.inAppliedDiff` true while a diff against the version that ran is active */
  private updateDiffContext(): void {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const active =
      input instanceof vscode.TabInputTextDiff && input.original.scheme === APPLIED_SCHEME;
    void vscode.commands.executeCommand('setContext', 'mmk.inAppliedDiff', active);
  }
}

/** Register the commands of B1 and B2 */
export function registerAppliedCommands(
  deps: Deps,
  protection: AppliedProtection,
): vscode.Disposable[] {
  return [
    vscode.workspace.registerTextDocumentContentProvider(APPLIED_SCHEME, protection),
    vscode.languages.registerHoverProvider(
      [
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
      ],
      protection,
    ),
    vscode.commands.registerCommand('mmk.showAppliedVersion', (target?: unknown) =>
      showAppliedVersion(deps, protection, target),
    ),
    vscode.commands.registerCommand('mmk.restoreAppliedVersion', (target?: unknown) =>
      restoreAppliedVersion(deps, protection, target),
    ),
    vscode.commands.registerCommand('mmk.undoAppliedEdit', (target?: unknown) =>
      undoAppliedEdit(deps, protection, target),
    ),
  ];
}

/** The working file a command acts on: an argument, the diff's right side, or the active editor */
function targetFile(target: unknown): vscode.Uri | undefined {
  if (target instanceof vscode.Uri) {
    return target;
  }
  if (typeof target === 'string') {
    return vscode.Uri.parse(target);
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputTextDiff && input.original.scheme === APPLIED_SCHEME) {
    return input.modified;
  }
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === 'file' ? uri : undefined;
}

/**
 * The checksum to look for: the selected environment's when it ran there, else the first
 * environment's. Says so when environments ran different versions.
 */
function chooseRecord(deps: Deps, records: readonly AppliedRecord[]): AppliedRecord | undefined {
  const selected = deps.store.selected().name;
  return records.find((record) => record.environment === selected) ?? records[0];
}

/** The records of a file wherever it ran, judged against its current text */
async function verdictFor(
  deps: Deps,
  uri: vscode.Uri,
): Promise<{ file: string; verdict: EditVerdict } | undefined> {
  const ref = deps.store.migrationFor(uri.fsPath);
  if (!ref) {
    void vscode.window.showWarningMessage(
      `${path.basename(uri.fsPath)} isn't a migration mmk knows. Open a migration file first.`,
    );
    return undefined;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  let disk: Buffer | null = null;
  try {
    disk = await readFile(uri.fsPath);
  } catch {
    disk = null;
  }
  const checksum = bufferChecksum(document.getText(), disk !== null && startsWithBom(disk));
  return {
    file: ref.file,
    verdict: judgeEdit(ref.project, deps.store.environments(), ref.file, checksum),
  };
}

/** B2: open the version that ran next to the working file */
async function showAppliedVersion(
  deps: Deps,
  protection: AppliedProtection,
  target: unknown,
): Promise<AppliedVersion | undefined> {
  const uri = targetFile(target);
  if (!uri) {
    void vscode.window.showWarningMessage('Open a migration file first.');
    return undefined;
  }
  const judged = await verdictFor(deps, uri);
  if (!judged) {
    return undefined;
  }
  const { verdict } = judged;
  if (verdict.applied.length === 0) {
    void vscode.window.showInformationMessage(
      verdict.checksumsMissing
        ? "This mongo-migrate-kit doesn't report the checksum each migration ran with, so the version that ran can't be found. Update mongo-migrate-kit."
        : `${path.basename(uri.fsPath)} hasn't run on any environment yet, so there's no applied version.`,
    );
    return undefined;
  }
  const record = chooseRecord(deps, verdict.edited.length > 0 ? verdict.edited : verdict.applied);
  if (!record) {
    return undefined;
  }
  const version = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'mmk: looking for the version that ran…' },
    () => protection.findVersion(uri.fsPath, record.checksum),
  );
  const same = verdict.applied.filter((candidate) => candidate.checksum === record.checksum);
  const where = listNames(same.map((candidate) => candidate.environment));
  if (!version) {
    void vscode.window.showWarningMessage(
      `The version that ran on ${where} isn't in this file's git history: no commit of ${path.basename(uri.fsPath)} has SHA-256 ${shortChecksum(record.checksum)}. It may have run before it was committed.`,
    );
    return undefined;
  }
  const left = vscode.Uri.from({
    scheme: APPLIED_SCHEME,
    path: `/${path.posix.basename(version.path)}`,
    query: new URLSearchParams({
      root: version.root,
      commit: version.commit,
      file: version.path,
    }).toString(),
  });
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    uri,
    `${path.basename(uri.fsPath).replace(/^\d+-/, '')} (applied ↔ working tree)`,
  );
  const others = verdict.applied.filter((candidate) => candidate.checksum !== record.checksum);
  // A reference date in another year makes formatDay always include the year: "12 Sep 2026".
  const date = version.date ? formatDay(new Date(version.date), new Date(0)) : '';
  void vscode.window
    .showInformationMessage(
      `Found the version that ran: commit ${version.shortCommit} · ${date} · ${version.author}. Its SHA-256 (${shortChecksum(record.checksum)}) matches the checksum mmk recorded on ${where}.${others.length > 0 ? ` ${listNames(others.map((other) => other.environment))} ran a different version.` : ''} Why it matters: the data on ${where} was written by the left-hand up(), but a rollback would run the right-hand down().`,
      'Restore applied version',
      'Create a new migration',
    )
    .then(async (choice) => {
      if (choice === 'Restore applied version') {
        await vscode.commands.executeCommand('mmk.restoreAppliedVersion', uri);
      } else if (choice === 'Create a new migration') {
        await vscode.commands.executeCommand('mmk.createMigration');
      }
    });
  return version;
}

/** B2: replace the working file's text with the version that ran, and save it */
async function restoreAppliedVersion(
  deps: Deps,
  protection: AppliedProtection,
  target: unknown,
): Promise<boolean> {
  const uri = targetFile(target);
  if (!uri) {
    void vscode.window.showWarningMessage('Open a migration file first.');
    return false;
  }
  const judged = await verdictFor(deps, uri);
  const record = judged && chooseRecord(deps, judged.verdict.edited);
  if (!judged || !record) {
    void vscode.window.showInformationMessage(
      `${path.basename(uri.fsPath)} already matches the version that ran.`,
    );
    return false;
  }
  const version = await protection.findVersion(uri.fsPath, record.checksum);
  if (!version) {
    void vscode.window.showWarningMessage(
      `The version that ran isn't in git history (SHA-256 ${shortChecksum(record.checksum)}), so it can't be restored.`,
    );
    return false;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(0, 0, document.lineCount, 0),
    stripBom(version.content.toString('utf8')),
  );
  if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save())) {
    void vscode.window.showErrorMessage(`Couldn't restore ${path.basename(uri.fsPath)}.`);
    return false;
  }
  const after = await protection.check(document);
  const where = listNames(
    judged.verdict.applied
      .filter((candidate) => candidate.checksum === record.checksum)
      .map((candidate) => candidate.environment),
  );
  void vscode.window.showInformationMessage(
    after
      ? `Restored the version from commit ${version.shortCommit}, but it still differs from what ran on ${listNames(after.verdict.edited.map((item) => item.environment))}.`
      : `Restored the version that ran. The file matches its checksum again on ${where}, and the warning is gone. Put your fix in a new migration.`,
  );
  return after === undefined;
}

/**
 * B1's "Undo my edit": when the file on disk is still the version that ran, drop the unsaved
 * edit; otherwise restore the version that ran from git.
 */
async function undoAppliedEdit(
  deps: Deps,
  protection: AppliedProtection,
  target: unknown,
): Promise<boolean> {
  const uri = targetFile(target);
  if (!uri) {
    return false;
  }
  const state = protection.state(uri);
  if (state && !state.saved) {
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    return true;
  }
  return restoreAppliedVersion(deps, protection, uri);
}

function stripBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text;
}

function versionKey(file: string, checksum: string): string {
  return `${file}|${checksum}`;
}
