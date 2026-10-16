import type { StatusRow } from 'mongo-migrate-kit';
import * as vscode from 'vscode';
import { MmkCommandError, describeCommand, runMmkJson } from '../mmk/cli.js';
import { type Wire, parseStatusRows } from '../mmk/contract.js';
import { formatStatusTable } from '../mmk/format.js';
import type { Logger } from '../mmk/log.js';
import type { ProjectState } from '../mmk/project.js';

/** Command ID of "mmk: Show status (debug)" */
export const SHOW_STATUS_DEBUG = 'mmk.debug.showStatus';

/** How long a status read may take before it is stopped */
const STATUS_TIMEOUT_MS = 60_000;

/** What the command returns for each project it read, so tests can compare it with the CLI */
export interface DebugStatus {
  dir: string;
  rows: Wire<StatusRow>[];
}

/** Everything the command needs from the extension */
export interface ShowStatusDebugDeps {
  channel: vscode.LogOutputChannel;
  log: Logger;
  projects: () => Promise<ProjectState[]>;
}

/**
 * Register the temporary "mmk: Show status (debug)" command: runs `mmk status --json` in each
 * project and prints the rows to the "mmk" output channel. It only reads.
 */
export function registerShowStatusDebug(deps: ShowStatusDebugDeps): vscode.Disposable {
  return vscode.commands.registerCommand(SHOW_STATUS_DEBUG, () => showStatus(deps));
}

async function showStatus(deps: ShowStatusDebugDeps): Promise<DebugStatus[]> {
  const { channel, log } = deps;
  const states = await deps.projects();
  channel.show(true);
  if (states.length === 0) {
    const message =
      'No mmk project in this workspace. mmk looks for mmk.config.js, mmk.config.ts or mmk.config.json, or a package.json that depends on mongo-migrate-kit.';
    log.info(message);
    void vscode.window.showInformationMessage(message);
    return [];
  }

  const results: DebugStatus[] = [];
  for (const state of states) {
    if (state.kind !== 'ready') {
      log.warn(state.message);
      void vscode.window.showWarningMessage(state.message);
      continue;
    }
    const args = ['status', '--json'];
    log.info(`$ ${describeCommand(args)}    (in ${state.root.dir}, mmk ${state.version})`);
    try {
      const output = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'mmk: reading status' },
        () =>
          runMmkJson(state.invocation, args, {
            timeoutMs: STATUS_TIMEOUT_MS,
            onStderrLine: (line) => log.mmkOutput(line),
          }),
      );
      if (output.otherStdout !== '') {
        log.mmkOutput(output.otherStdout);
      }
      const rows = parseStatusRows(output.value, 'status');
      for (const line of formatStatusTable(rows)) {
        log.info(line);
      }
      results.push({ dir: state.root.dir, rows });
    } catch (error) {
      reportFailure(log, error);
    }
  }
  return results;
}

/** Log a failed run and tell the user. mmk's own message is shown as is */
function reportFailure(log: Logger, error: unknown): void {
  if (error instanceof MmkCommandError) {
    const code = error.failure.code;
    log.error(code ? `${code}: ${error.message}` : error.message);
    void vscode.window.showErrorMessage(error.message);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error(message);
  void vscode.window.showErrorMessage(message);
}
