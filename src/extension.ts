import * as vscode from 'vscode';
import { registerShowStatusDebug } from './commands/show-status-debug.js';
import { type Logger, createLogger } from './mmk/log.js';
import { type ProjectState, discoverProjects } from './mmk/project.js';

/** Context key set when the workspace has at least one mmk project */
const HAS_PROJECT_CONTEXT = 'mmk.hasProject';

/**
 * Activate the extension: find the workspace's mmk projects, check each one's mmk version, and
 * register the commands. Nothing here runs a migration or connects to a database.
 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('mmk', { log: true });
  const log = createLogger(channel);

  let projects = refreshProjects(log);
  const refresh = (): void => {
    projects = refreshProjects(log);
  };

  context.subscriptions.push(
    channel,
    registerShowStatusDebug({ channel, log, projects: () => projects }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mmk.nodePath')) {
        refresh();
      }
    }),
  );
}

/** Discover the workspace's projects, log what was found, and warn about an outdated mmk */
async function refreshProjects(log: Logger): Promise<ProjectState[]> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const nodePath = vscode.workspace.getConfiguration('mmk').get<string>('nodePath');
  let states: ProjectState[];
  try {
    states = await discoverProjects({ folders, nodePath, env: process.env });
  } catch (error) {
    log.error(`Couldn't look for mmk projects: ${error instanceof Error ? error.message : error}`);
    states = [];
  }

  for (const state of states) {
    if (state.kind === 'ready') {
      log.info(`Found mmk ${state.version} for ${state.root.dir} (runs ${state.install.script})`);
    } else {
      log.warn(state.message);
    }
    if (state.kind === 'too-old') {
      void vscode.window.showWarningMessage(state.message);
    }
  }
  await vscode.commands.executeCommand('setContext', HAS_PROJECT_CONTEXT, states.length > 0);
  return states;
}
