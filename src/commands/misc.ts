import * as vscode from 'vscode';
import { terminalCommand } from '../mmk/cli.js';
import {
  type Deps,
  currentEnvironment,
  relativeDir,
  resolveMigration,
  resolveProject,
  shortName,
  targetsFile,
} from './context.js';

/** Register "Copy CLI command" and "Show output" */
export function registerMiscCommands(deps: Deps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mmk.copyCliCommand', (target?: unknown) =>
      copyCliCommand(deps, target),
    ),
    vscode.commands.registerCommand('mmk.showOutput', () => deps.channel.show(true)),
  ];
}

interface Choice {
  args: string[];
  detail: string;
}

/**
 * Copy the terminal command for an action on a migration (or a project), so every action can be
 * run outside the editor too. On an environment other than local, the command sets `MMK_URI`
 * and `MMK_DB`, with a placeholder where the connection string goes: it is never copied.
 */
async function copyCliCommand(deps: Deps, target: unknown): Promise<string | undefined> {
  const environment = currentEnvironment(deps);
  const status: Choice = { args: ['status'], detail: 'Show every migration and where it has run' };
  let dir: string;
  let choices: Choice[];
  if (targetsFile(target)) {
    const ref = resolveMigration(deps, target);
    if (!ref) {
      return undefined;
    }
    dir = ref.project.dir;
    const name = shortName(ref.file);
    const applied = ref.row?.status === 'applied';
    const writes: Choice[] = applied
      ? [
          { args: ['down', ref.file], detail: `Roll back ${name}` },
          { args: ['redo', ref.file], detail: `Roll back ${name}, then apply it again` },
        ]
      : [{ args: ['up', ref.file], detail: `Apply ${name}` }];
    const preview: Choice = applied
      ? { args: ['dry-run', 'down', ref.file], detail: `Preview rolling back ${name}` }
      : { args: ['dry-run', 'up', ref.file], detail: `Preview applying ${name}` };
    choices = environment.readOnly ? [preview, status] : [...writes, preview, status];
  } else {
    const project = await resolveProject(deps, target);
    if (!project) {
      return undefined;
    }
    dir = project.dir;
    const reads: Choice[] = [
      { args: ['dry-run', 'up'], detail: 'Preview what up would apply' },
      status,
      { args: ['list', '--pending'], detail: 'List only the pending migrations' },
    ];
    choices = environment.readOnly
      ? reads
      : [
          { args: ['up'], detail: 'Apply every pending migration' },
          ...reads,
          { args: ['down'], detail: 'Roll back the last batch' },
        ];
  }

  let prefix = '';
  if (!environment.local) {
    const connection = await deps.environments.connection(dir, environment.name);
    prefix = `MMK_URI='<${environment.name} connection string>' MMK_DB=${connection?.dbName ?? `<${environment.name} database>`} `;
  }
  const where = relativeDir(dir);
  const picked = await vscode.window.showQuickPick(
    choices.map((choice) => ({
      label: withPrefix(terminalCommand(choice.args, where), prefix),
      detail: `${choice.detail}${environment.local ? '' : ` on ${environment.name}`}`,
    })),
    {
      title: `mmk: Copy CLI command (${environment.name})`,
      placeHolder: environment.local
        ? 'Pick the command to copy'
        : `Pick the command to copy. Put ${environment.name}'s connection string where it says so: it isn't copied.`,
    },
  );
  if (!picked) {
    return undefined;
  }
  await vscode.env.clipboard.writeText(picked.label);
  void vscode.window.showInformationMessage(`Copied: ${picked.label}`);
  return picked.label;
}

/** Put the environment variables right before `npx`, after any `cd … &&` */
function withPrefix(command: string, prefix: string): string {
  if (prefix === '') {
    return command;
  }
  const at = command.indexOf('npx ');
  return `${command.slice(0, at)}${prefix}${command.slice(at)}`;
}
