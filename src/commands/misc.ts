import * as path from 'node:path';
import * as vscode from 'vscode';
import { terminalCommand } from '../mmk/cli.js';
import {
  type Deps,
  LOCAL,
  databaseLabel,
  relativeDir,
  resolveMigration,
  resolveProject,
  shortName,
  targetsFile,
} from './context.js';

/** Register "Copy CLI command", "Select environment" and "Show output" */
export function registerMiscCommands(deps: Deps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mmk.copyCliCommand', (target?: unknown) =>
      copyCliCommand(deps, target),
    ),
    vscode.commands.registerCommand('mmk.selectEnvironment', () => selectEnvironment(deps)),
    vscode.commands.registerCommand('mmk.showOutput', () => deps.channel.show(true)),
  ];
}

/**
 * Copy the terminal command for an action on a migration (or a project), so every action can be
 * run outside the editor too.
 */
async function copyCliCommand(deps: Deps, target: unknown): Promise<string | undefined> {
  let dir: string;
  let choices: Array<{ args: string[]; detail: string }>;
  if (targetsFile(target)) {
    const ref = resolveMigration(deps, target);
    if (!ref) {
      return undefined;
    }
    dir = ref.project.dir;
    const name = shortName(ref.file);
    choices =
      ref.row?.status === 'applied'
        ? [
            { args: ['down', ref.file], detail: `Roll back ${name}` },
            { args: ['redo', ref.file], detail: `Roll back ${name}, then apply it again` },
            { args: ['status'], detail: 'Show every migration and where it has run' },
          ]
        : [
            { args: ['up', ref.file], detail: `Apply ${name}` },
            { args: ['dry-run', 'up', ref.file], detail: `Preview applying ${name}` },
            { args: ['status'], detail: 'Show every migration and where it has run' },
          ];
  } else {
    const project = await resolveProject(deps, target);
    if (!project) {
      return undefined;
    }
    dir = project.dir;
    choices = [
      { args: ['up'], detail: 'Apply every pending migration' },
      { args: ['dry-run', 'up'], detail: 'Preview what up would apply' },
      { args: ['status'], detail: 'Show every migration and where it has run' },
      { args: ['down'], detail: 'Roll back the last batch' },
    ];
  }

  const where = relativeDir(dir);
  const picked = await vscode.window.showQuickPick(
    choices.map((choice) => ({
      label: terminalCommand(choice.args, where),
      detail: choice.detail,
    })),
    { title: 'mmk: Copy CLI command', placeHolder: 'Pick the command to copy' },
  );
  if (!picked) {
    return undefined;
  }
  await vscode.env.clipboard.writeText(picked.label);
  void vscode.window.showInformationMessage(`Copied: ${picked.label}`);
  return picked.label;
}

/**
 * The environment picker (design C1). Until environments arrive there is only `local`: the
 * project's own config and `.env`.
 */
async function selectEnvironment(deps: Deps): Promise<void> {
  const projects = deps.store.snapshots();
  const pending = projects.reduce(
    (sum, project) =>
      sum + (project.rows?.filter((row) => row.status === 'pending' && !row.unadopted).length ?? 0),
    0,
  );
  const first = projects[0];
  const local: vscode.QuickPickItem = {
    label: `$(circle-filled) ${LOCAL}`,
    detail: `${pending} pending · runs allowed · current · from ${
      first?.config?.configFile ? path.basename(first.config.configFile) : 'your config'
    } and .env`,
  };
  if (first) {
    local.description = databaseLabel(first.config);
  }
  await vscode.window.showQuickPick([local], { title: 'mmk: Select environment' });
}
