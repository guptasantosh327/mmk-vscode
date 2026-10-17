import * as vscode from 'vscode';
import type { Deps } from '../commands/context.js';
import type { WireStatusRow } from '../mmk/contract.js';
import type { Environment } from '../mmk/environments.js';
import { findMigrationFunctions } from '../mmk/migration-functions.js';
import { formatDuration } from '../mmk/model.js';
import type { MigrationRef } from '../mmk/store.js';

/**
 * Run links above `up()` and `down()` in a migration file (designs A2, A3 and C1). Each link
 * names the environment it acts on; the other environments follow as `staging: pending`. What
 * they say comes from mmk's status row for the file on each environment.
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
    const environment = this.deps.store.selected();
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
      return [
        lens(
          upLine,
          `$(sync~spin) Running ${ref.project.running} on ${ref.project.runningOn ?? environment.name}…`,
        ),
      ];
    }
    const { row } = ref;
    if (!row) {
      const status = ref.project.environments[environment.name];
      if (status && !status.connected) {
        return [
          lens(upLine, `${environment.name} isn't set up for this project`, 'mmk.editEnvironment', [
            environment.name,
          ]),
        ];
      }
      return ref.project.error
        ? [lens(upLine, `$(error) Couldn't read status on ${environment.name}`, 'mmk.showOutput')]
        : [];
    }

    if (row.unadopted) {
      return [lens(upLine, 'Applied before this repo had a namespace · run mmk namespace adopt')];
    }
    if (environment.readOnly) {
      return this.readOnlyLinks(ref, row, environment, lines.down, upLine, lens, target);
    }

    const lenses: vscode.CodeLens[] = [];
    if (row.status === 'pending') {
      lenses.push(
        lens(upLine, `Pending on ${environment.name}`),
        lens(upLine, `Run up on ${environment.name}`, 'mmk.up', [target]),
        lens(upLine, 'Dry run', 'mmk.dryRun', [target]),
        ...this.otherEnvironments(ref, environment, upLine, lens),
      );
      if (lines.down !== null) {
        lenses.push(lens(lines.down, `Run down appears once up has run on ${environment.name}`));
      }
    } else {
      lenses.push(
        lens(upLine, appliedTitle(row, environment.name)),
        lens(upLine, 'Redo', 'mmk.redo', [target]),
        ...this.otherEnvironments(ref, environment, upLine, lens),
      );
      if (lines.down !== null) {
        lenses.push(lens(lines.down, `Run down on ${environment.name}`, 'mmk.down', [target]));
      }
    }
    return lenses;
  }

  /** C1: on a read-only environment only Dry run and Copy CLI command are offered */
  private readOnlyLinks(
    _ref: MigrationRef,
    row: WireStatusRow,
    environment: Environment,
    downLine: number | null,
    upLine: number,
    lens: (line: number, title: string, command?: string, args?: unknown[]) => vscode.CodeLens,
    target: { dir: string; file: string },
  ): vscode.CodeLens[] {
    const name = environment.name;
    const lenses = [lens(upLine, `$(lock) ${name} · read-only`, 'mmk.selectEnvironment')];
    if (row.status === 'pending') {
      lenses.push(
        lens(upLine, `Pending on ${name}`),
        lens(upLine, `Dry run on ${name}`, 'mmk.dryRun', [target]),
        lens(upLine, 'Copy CLI command', 'mmk.copyCliCommand', [target]),
      );
      if (downLine !== null) {
        lenses.push(lens(downLine, `Nothing to roll back on ${name}: it hasn't run there`));
      }
    } else {
      lenses.push(
        lens(upLine, appliedTitle(row, name)),
        lens(upLine, 'Copy CLI command', 'mmk.copyCliCommand', [target]),
      );
      if (downLine !== null) {
        lenses.push(lens(downLine, `Rolling back on ${name} is turned off: it's read-only`));
      }
    }
    return lenses;
  }

  /** `staging: pending | prod: applied`; a click selects that environment */
  private otherEnvironments(
    ref: MigrationRef,
    selected: Environment,
    line: number,
    lens: (line: number, title: string, command?: string, args?: unknown[]) => vscode.CodeLens,
  ): vscode.CodeLens[] {
    return this.deps.store
      .environments()
      .filter((environment) => environment.name !== selected.name)
      .flatMap((environment) => {
        const status = ref.project.environments[environment.name];
        if (!status || !status.connected) {
          return [];
        }
        const other = status.rows?.find((candidate) => candidate.file === ref.file);
        let state: string;
        if (status.error) {
          state = "couldn't read";
        } else if (!status.rows) {
          state = '…';
        } else if (!other || other.status === 'pending') {
          state = 'pending';
        } else {
          state = other.checksumOk === false ? 'edited since it ran' : 'applied';
        }
        return [
          lens(line, `${environment.name}: ${state}`, 'mmk.selectEnvironment', [environment.name]),
        ];
      });
  }
}

function appliedTitle(row: WireStatusRow, environment: string): string {
  if (row.checksumOk === false) {
    return `$(warning) Applied on ${environment} · batch ${row.batch ?? '?'} · edited since`;
  }
  const duration = row.duration === null ? '' : ` · ${formatDuration(row.duration)}`;
  return `$(check) Applied on ${environment} · batch ${row.batch ?? '?'}${duration}`;
}
