import * as vscode from 'vscode';
import { type Deps, LOCAL } from '../commands/context.js';
import { findMigrationFunctions } from '../mmk/migration-functions.js';
import { formatDuration } from '../mmk/model.js';

/**
 * Run links above `up()` and `down()` in a migration file (designs A2 and A3). Each link names
 * the environment it acts on. What they say comes from mmk's status row for the file.
 */
export class RunLinksProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly deps: Deps) {}

  /** Redraw the links (after the store changed) */
  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== 'file') {
      return [];
    }
    const ref = this.deps.store.migrationFor(document.uri.fsPath);
    if (!ref) {
      return [];
    }
    const lines = findMigrationFunctions(document.getText());
    const upLine = lines.up ?? 0;
    const target = { dir: ref.project.dir, file: ref.file };
    const lens = (
      line: number,
      title: string,
      command = '',
      args: unknown[] = [],
    ): vscode.CodeLens =>
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command, arguments: args });

    if (ref.project.running) {
      return [lens(upLine, `$(sync~spin) Running ${ref.project.running} on ${LOCAL}…`)];
    }
    const { row } = ref;
    if (!row) {
      return ref.project.error
        ? [lens(upLine, `$(error) Couldn't read status on ${LOCAL}`, 'mmk.showOutput')]
        : [];
    }

    const lenses: vscode.CodeLens[] = [];
    if (row.unadopted) {
      lenses.push(
        lens(upLine, 'Applied before this repo had a namespace · run mmk namespace adopt'),
      );
    } else if (row.status === 'pending') {
      lenses.push(
        lens(upLine, `Pending on ${LOCAL}`),
        lens(upLine, `Run up on ${LOCAL}`, 'mmk.up', [target]),
        lens(upLine, 'Dry run', 'mmk.dryRun', [target]),
      );
      if (lines.down !== null) {
        lenses.push(lens(lines.down, `Run down appears once up has run on ${LOCAL}`));
      }
    } else {
      const head =
        row.checksumOk === false
          ? `$(warning) Applied on ${LOCAL} · batch ${row.batch ?? '?'} · edited since`
          : `$(check) Applied on ${LOCAL} · batch ${row.batch ?? '?'}${row.duration === null ? '' : ` · ${formatDuration(row.duration)}`}`;
      lenses.push(lens(upLine, head), lens(upLine, 'Redo', 'mmk.redo', [target]));
      if (lines.down !== null) {
        lenses.push(lens(lines.down, `Run down on ${LOCAL}`, 'mmk.down', [target]));
      }
    }
    return lenses;
  }
}
