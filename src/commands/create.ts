import * as path from 'node:path';
import type { MigrationExtension } from 'mongo-migrate-kit';
import * as vscode from 'vscode';
import { MmkCommandError } from '../mmk/cli.js';
import { type ProjectConfig, parseCreateResult } from '../mmk/contract.js';
import { LOCAL_ENVIRONMENT } from '../mmk/environments.js';
import { previewFileName } from '../mmk/naming.js';
import { StoreError } from '../mmk/store.js';
import { type Deps, resolveProject } from './context.js';

/** Arguments for "mmk: Create migration"; all optional. With `name`, no input box is shown */
interface CreateArgs {
  dir?: string;
  name?: string;
  extension?: MigrationExtension;
}

/** Register "mmk: Create migration" */
export function registerCreateCommand(deps: Deps): vscode.Disposable {
  return vscode.commands.registerCommand('mmk.createMigration', (args?: CreateArgs) =>
    createMigration(deps, args),
  );
}

/** Ask for a name, run `mmk create`, and open the file mmk wrote. Returns its path */
async function createMigration(deps: Deps, args: CreateArgs = {}): Promise<string | undefined> {
  const project = await resolveProject(
    deps,
    args.dir === undefined ? undefined : { dir: args.dir },
  );
  if (!project) {
    return undefined;
  }
  if (project.state.kind !== 'ready') {
    void vscode.window.showWarningMessage(project.state.message);
    return undefined;
  }
  if (!project.config) {
    await deps.store.refresh(project.dir);
  }
  const config = deps.store.snapshot(project.dir)?.config;
  if (!config) {
    const failure = deps.store.snapshot(project.dir)?.error?.message;
    void vscode.window.showErrorMessage(
      failure ?? "Couldn't read this project's mmk config. Check the mmk output for details.",
    );
    return undefined;
  }

  const answer =
    args.name === undefined
      ? await askName(config, project.state.root.configFile)
      : { name: args.name, extension: args.extension ?? config.createExtension };
  if (!answer) {
    return undefined;
  }

  let created: string;
  try {
    const output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'mmk: creating migration…' },
      () =>
        deps.store.run(
          project.dir,
          ['create', answer.name, `--${answer.extension}`],
          `create ${answer.name}`,
          // create writes a file and never connects, so it needs no environment's connection
          LOCAL_ENVIRONMENT,
        ),
    );
    created = parseCreateResult(output.value).path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MmkCommandError || !(error instanceof StoreError)) {
      deps.log.error(message);
    }
    void vscode.window.showErrorMessage(message);
    return undefined;
  }

  deps.created.add(created);
  await vscode.window.showTextDocument(vscode.Uri.file(created));
  return created;
}

/** The input box from design A1: the name, a preview of the file, and a JS/TS toggle */
function askName(
  config: ProjectConfig,
  configFile: string | null,
): Promise<{ name: string; extension: MigrationExtension } | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(config.migrationsDir));
  const shownDir = folder
    ? path.relative(folder.uri.fsPath, config.migrationsDir)
    : config.migrationsDir;
  const configName = configFile ? path.basename(configFile) : "mmk's defaults";

  return new Promise((resolve) => {
    const input = vscode.window.createInputBox();
    let extension: MigrationExtension = config.createExtension;
    let accepted = false;

    const update = (): void => {
      input.buttons = [
        {
          iconPath: new vscode.ThemeIcon('arrow-swap'),
          tooltip: extension === 'ts' ? 'Use JavaScript' : 'Use TypeScript',
        },
      ];
      const language =
        extension === 'ts'
          ? 'TypeScript: runs on Node 22.18+ or with a TypeScript loader'
          : 'JavaScript';
      const origin =
        extension === config.createExtension ? ` (createExtension in ${configName})` : '';
      const file = previewFileName(input.value, { sequential: config.sequential, extension });
      if (input.value.trim() === '') {
        input.validationMessage = undefined;
        input.prompt = `Type a name to see the file it creates · ${language}${origin}`;
      } else if (file === null) {
        input.validationMessage =
          'The name needs letters or digits: mmk builds the file name from them';
      } else {
        input.validationMessage = undefined;
        input.prompt = `Creates ${path.join(shownDir, file)} · ${language}${origin}`;
      }
    };

    input.title = 'mmk: Create migration';
    input.placeholder = 'Migration name, e.g. add refunds collection';
    input.onDidChangeValue(update);
    input.onDidTriggerButton(() => {
      extension = extension === 'ts' ? 'js' : 'ts';
      update();
    });
    input.onDidAccept(() => {
      if (previewFileName(input.value, { sequential: config.sequential, extension }) === null) {
        return;
      }
      accepted = true;
      resolve({ name: input.value.trim(), extension });
      input.hide();
    });
    input.onDidHide(() => {
      input.dispose();
      if (!accepted) {
        resolve(undefined);
      }
    });
    update();
    input.show();
  });
}
