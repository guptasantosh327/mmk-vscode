import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Deps, LOCAL, databaseLabel, relativeDir } from '../commands/context.js';

/** `mmk: local · 3 pending` in the status bar; a click opens the environment picker */
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

    const ready = projects.filter((project) => project.state.kind === 'ready');
    const running = projects.find((project) => project.running)?.running;
    const pending = projects.reduce(
      (sum, project) =>
        sum +
        (project.rows?.filter((row) => row.status === 'pending' && !row.unadopted).length ?? 0),
      0,
    );
    const unread = ready.filter((project) => !project.rows);

    if (ready.length === 0) {
      this.item.text = '$(warning) mmk';
    } else if (running) {
      this.item.text = `$(sync~spin) mmk: ${LOCAL} · running ${running}`;
    } else if (unread.length === ready.length && unread.some((project) => project.loading)) {
      this.item.text = `$(sync~spin) mmk: ${LOCAL}`;
    } else if (unread.length === ready.length) {
      this.item.text = `$(warning) mmk: ${LOCAL} · can't read status`;
    } else {
      this.item.text = `$(layers) mmk: ${LOCAL} · ${pending === 0 ? 'up to date' : `${pending} pending`}`;
    }

    const lines = projects.map((project) => {
      const name = relativeDir(project.dir) || path.basename(project.dir);
      if (project.state.kind !== 'ready') {
        return `**${name}**: ${project.state.message}`;
      }
      if (project.error) {
        return `**${name}**: ${project.error.message}`;
      }
      const count = project.rows?.filter(
        (row) => row.status === 'pending' && !row.unadopted,
      ).length;
      return `**${name}**: ${count === undefined ? 'reading…' : `${count} pending`} on ${LOCAL} (${databaseLabel(project.config)})`;
    });
    this.item.tooltip = new vscode.MarkdownString(
      [...lines, '', 'Click to see environments'].join('  \n'),
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
