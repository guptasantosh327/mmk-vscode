import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Deps, databaseLabel, relativeDir } from '../commands/context.js';
import { statusBarBackground } from '../mmk/environments.js';

/**
 * `mmk: local · 3 pending` in the status bar; a click opens the environment picker. Its
 * background follows the environment's colour: warning for yellow and orange, error for red.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly deps: Deps) {
    this.item = vscode.window.createStatusBarItem(
      'mmk.status',
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.name = 'mmk';
    this.item.command = 'mmk.selectEnvironment';
  }

  /** Show what the store knows now */
  update(): void {
    const projects = this.deps.store.snapshots();
    if (projects.length === 0) {
      this.item.hide();
      return;
    }

    const environment = this.deps.store.selected();
    const name = environment.readOnly ? `${environment.name} · read-only` : environment.name;
    const ready = projects.filter((project) => project.state.kind === 'ready');
    const running = projects.find((project) => project.running);
    const pending = projects.reduce(
      (sum, project) =>
        sum +
        (project.rows?.filter((row) => row.status === 'pending' && !row.unadopted).length ?? 0),
      0,
    );
    const unread = ready.filter((project) => !project.rows);
    const notSetUp = ready.every(
      (project) => project.environments[environment.name]?.connected === false,
    );

    if (ready.length === 0) {
      this.item.text = '$(warning) mmk';
    } else if (running?.running) {
      this.item.text = `$(sync~spin) mmk: ${running.runningOn ?? environment.name} · running ${running.running}`;
    } else if (notSetUp) {
      this.item.text = `$(warning) mmk: ${name} · not set up`;
    } else if (unread.length === ready.length && unread.some((project) => project.loading)) {
      this.item.text = `$(sync~spin) mmk: ${name}`;
    } else if (unread.length === ready.length) {
      this.item.text = `$(warning) mmk: ${name} · can't read status`;
    } else {
      this.item.text = `$(layers) mmk: ${name} · ${pending === 0 ? 'up to date' : `${pending} pending`}`;
    }

    const background = statusBarBackground(environment.color);
    this.item.backgroundColor =
      background === 'default'
        ? undefined
        : new vscode.ThemeColor(`statusBarItem.${background}Background`);

    const lines = projects.map((project) => {
      const label = relativeDir(project.dir) || path.basename(project.dir);
      if (project.state.kind !== 'ready') {
        return `**${label}**: ${project.state.message}`;
      }
      if (project.error) {
        return `**${label}**: ${project.error.message}`;
      }
      const count = project.rows?.filter(
        (row) => row.status === 'pending' && !row.unadopted,
      ).length;
      return `**${label}**: ${count === undefined ? 'reading…' : `${count} pending`} on ${environment.name} (${databaseLabel(project, environment.name)})`;
    });
    const note = environment.readOnly
      ? [`${environment.name} is read-only: only status, list and dry-run run there.`]
      : [];
    this.item.tooltip = new vscode.MarkdownString(
      [...lines, ...note, '', 'Click to switch environments or compare them'].join('  \n'),
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
