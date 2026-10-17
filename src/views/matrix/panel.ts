import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Deps, relativeDir, resolveProject } from '../../commands/context.js';
import { currentBranch, defaultRemoteRef } from '../../git/branches.js';
import { copyRefFolder } from '../../git/ref-files.js';
import { parseStatusRows } from '../../mmk/contract.js';
import type { WireStatusRow } from '../../mmk/contract.js';
import { type CellState, type MatrixInput, buildMatrix } from '../../mmk/matrix.js';
import { formatDay } from '../../mmk/model.js';
import type { ProjectSnapshot } from '../../mmk/store.js';

/** Where the compared files come from */
type Source = { kind: 'branch' } | { kind: 'ref'; ref: string };

/** A cell as the webview shows it */
interface CellView {
  kind: CellState['kind'];
  label: string;
  date: string;
  title: string;
}

/** Everything the webview draws, sent over postMessage */
interface MatrixView {
  title: string;
  subtitle: string;
  source: 'branch' | 'ref';
  refLabel: string | null;
  loading: boolean;
  error: string | null;
  columns: Array<{ name: string; readOnly: boolean; state: string; title: string }>;
  rows: Array<{
    file: string;
    label: string;
    stamp: string;
    cells: CellView[];
    note: string;
    differs: boolean;
    openable: boolean;
  }>;
  summary: string[];
  footer: string;
}

/** Messages from the webview */
type Incoming =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'source'; value: 'branch' | 'ref' }
  | { type: 'open'; file: string }
  | { type: 'select'; environment: string };

/** Register "mmk: Compare all environments" (design C2) */
export function registerMatrix(deps: Deps, extensionUri: vscode.Uri): vscode.Disposable[] {
  const panels = new Map<string, MatrixPanel>();
  return [
    vscode.commands.registerCommand('mmk.compareEnvironments', async (target?: unknown) => {
      const project = await resolveProject(deps, target);
      if (!project) {
        return undefined;
      }
      const existing = panels.get(project.dir);
      if (existing) {
        existing.reveal();
        return existing;
      }
      const panel = new MatrixPanel(deps, extensionUri, project.dir, () =>
        panels.delete(project.dir),
      );
      panels.set(project.dir, panel);
      return panel;
    }),
    deps.store.onDidChange(() => {
      for (const panel of panels.values()) {
        panel.storeChanged();
      }
    }),
    { dispose: () => [...panels.values()].map((panel) => panel.dispose()) },
  ];
}

/**
 * The environments matrix: the files of your branch (or of the default remote branch) against
 * every environment's changelog. Read-only: it only runs `mmk status`.
 */
export class MatrixPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private source: Source = { kind: 'branch' };
  /** Rows read with `status --dir <ref copy>`, by environment */
  private refRows: Map<string, { rows: WireStatusRow[] | null; error: string | null }> | null =
    null;
  private loading = false;
  private error: string | null = null;
  private branch: string | null = null;
  private defaultRef: string | null = null;
  private updatedAt = new Date();
  private redrawTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: Deps,
    private readonly extensionUri: vscode.Uri,
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
    const media = vscode.Uri.joinPath(extensionUri, 'media', 'matrix');
    this.panel = vscode.window.createWebviewPanel(
      'mmk.matrix',
      `mmk: Environments — ${path.basename(dir)}`,
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
      this.panel.webview.onDidReceiveMessage((message: Incoming) => void this.receive(message)),
    );
    void this.loadGit();
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** The store read something new: redraw (only the branch view follows it live) */
  storeChanged(): void {
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
    }
    this.redrawTimer = setTimeout(() => this.post(), 50);
  }

  dispose(): void {
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.panel.dispose();
    this.onDispose();
  }

  /** The view model as the webview gets it; for tests */
  view(): MatrixView {
    return this.buildView();
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

  private async receive(message: Incoming): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post();
        return;
      case 'refresh':
        await this.refresh();
        return;
      case 'source':
        if (message.value === 'ref' && this.defaultRef) {
          this.source = { kind: 'ref', ref: this.defaultRef };
          this.refRows = null;
          await this.refresh();
        } else {
          this.source = { kind: 'branch' };
          this.post();
        }
        return;
      case 'open': {
        const config = this.deps.store.snapshot(this.dir)?.config;
        if (config && this.source.kind === 'branch') {
          await vscode.window.showTextDocument(
            vscode.Uri.file(path.join(config.migrationsDir, path.basename(message.file))),
          );
        }
        return;
      }
      case 'select':
        await this.deps.environments.select(message.environment);
        return;
    }
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
    void this.panel.webview.postMessage({ type: 'model', view: this.buildView() });
  }

  private buildView(): MatrixView {
    const project = this.deps.store.snapshot(this.dir);
    const environments = this.deps.store.environments();
    const filesLabel = this.source.kind === 'ref' ? this.source.ref : 'your branch';
    const inputs: MatrixInput[] = environments.map((environment) =>
      this.input(project, environment.name, environment),
    );
    const model = buildMatrix(inputs, filesLabel);
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
    const readOnly = environments.filter((environment) => environment.readOnly);
    const missing = readOnly
      .map((environment) => ({
        name: environment.name,
        count: model.rows.filter((row) => row.cells[environment.name]?.kind === 'pending').length,
      }))
      .filter((item) => item.count > 0);
    return {
      title: `Environments${project ? ` · ${relativeDir(project.dir) || path.basename(project.dir)}` : ''}`,
      subtitle: `${files}, compared with each database's changelog · read-only · updated ${clock(updated)}`,
      source: this.source.kind,
      refLabel: this.defaultRef,
      loading: this.loading || inputs.some((input) => input.state === 'loading'),
      error: this.error,
      columns: model.columns.map((column) => ({
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
      rows: model.rows.map((row) => ({
        file: row.file,
        label: row.label,
        stamp: row.stamp ?? '',
        cells: model.columns.map((column) =>
          cellView(row.cells[column.name] ?? { kind: 'unknown' }, column.name, filesLabel),
        ),
        note: row.note,
        differs: row.differs,
        openable: this.source.kind === 'branch' && row.inFiles,
      })),
      summary: model.summary,
      footer: [
        'Each database is read with one query on its changelog (mmk status).',
        readOnly.length > 0
          ? `${list(readOnly.map((environment) => environment.name))} ${readOnly.length === 1 ? 'is' : 'are'} read-only here${missing.length > 0 ? `: to apply the ${missing.map((item) => `${item.count} that ${item.name} is missing`).join(' and the ')}, merge and let CI deploy` : ''}.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  private input(
    project: ProjectSnapshot | undefined,
    name: string,
    environment: MatrixInput['environment'],
  ): MatrixInput {
    const status = project?.environments[name];
    const database = status?.database ?? null;
    if (this.source.kind === 'ref') {
      const read = this.refRows?.get(name);
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
    if (!status || status.connected === false) {
      return { environment, rows: null, state: 'not-set-up', database };
    }
    if (status.error) {
      return { environment, rows: null, state: 'error', message: status.error.message, database };
    }
    if (!status.rows) {
      return { environment, rows: null, state: 'loading', database };
    }
    return { environment, rows: status.rows, state: 'ok', database };
  }

  private html(codicons: vscode.Uri, media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'matrix.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'matrix.js'));
    const icons = webview.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${icons}">
<link rel="stylesheet" href="${css}">
<title>mmk: Environments</title>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function cellView(cell: CellState, environment: string, filesLabel: string): CellView {
  const date = 'appliedAt' in cell && cell.appliedAt ? shortDate(cell.appliedAt) : '';
  const batch = 'batch' in cell && cell.batch !== null ? ` in batch ${cell.batch}` : '';
  switch (cell.kind) {
    case 'applied':
      return {
        kind: cell.kind,
        label: 'Applied',
        date,
        title: `Applied on ${environment}${batch}`,
      };
    case 'edited':
      return {
        kind: cell.kind,
        label: 'Edited',
        date,
        title: `Applied on ${environment}${batch}, and the file changed after it ran`,
      };
    case 'no-file':
      return {
        kind: cell.kind,
        label:
          filesLabel === 'your branch'
            ? 'Applied, file not in your branch'
            : `Applied, not on ${filesLabel}`,
        date,
        title: `Applied on ${environment}${batch}, but the file isn't in ${filesLabel}`,
      };
    case 'pending':
      return {
        kind: cell.kind,
        label: 'Pending',
        date: '',
        title: `Not applied on ${environment}`,
      };
    case 'unadopted':
      return {
        kind: cell.kind,
        label: 'Needs adopt',
        date: '',
        title: `Applied on ${environment} before this repo had a namespace: run mmk namespace adopt`,
      };
    case 'none':
      return {
        kind: cell.kind,
        label: '—',
        date: '',
        title: `No file and no record on ${environment}`,
      };
    case 'unknown':
      return { kind: cell.kind, label: '?', date: '', title: `${environment} wasn't read` };
  }
}

/** `today`, or `13 Oct` (with the year when it isn't this one) */
function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toDateString() === new Date().toDateString() ? 'today' : formatDay(date);
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function list(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
