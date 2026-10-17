import * as vscode from 'vscode';
import type { Deps } from '../commands/context.js';

/**
 * Explorer badges on migration files: `●` pending on the selected environment, `!` edited after
 * it ran (mmk's verdicts)
 */
export class MigrationDecorations implements vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;

  constructor(private readonly deps: Deps) {}

  /** Redraw every badge (after the store changed) */
  refresh(): void {
    this.changed.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const row = this.deps.store.migrationFor(uri.fsPath)?.row;
    if (!row || row.unadopted) {
      return undefined;
    }
    if (row.status === 'pending') {
      return new vscode.FileDecoration(
        '●',
        `Pending on ${this.deps.store.selected().name} (mmk)`,
        new vscode.ThemeColor('charts.blue'),
      );
    }
    if (row.checksumOk === false) {
      return new vscode.FileDecoration(
        '!',
        'Edited after it ran (mmk)',
        new vscode.ThemeColor('list.warningForeground'),
      );
    }
    return undefined;
  }
}
