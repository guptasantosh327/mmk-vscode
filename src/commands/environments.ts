import * as path from 'node:path';
import * as vscode from 'vscode';
import { MmkCommandError, runMmkJson } from '../mmk/cli.js';
import { parseStatusRows } from '../mmk/contract.js';
import {
  type Connection,
  ENVIRONMENT_HUES,
  type Environment,
  type EnvironmentHue,
  LOCAL_ENVIRONMENT,
  connectionEnv,
  connectionStringProblem,
  databaseFromUri,
  environmentHue,
  environmentNameProblem,
  hostLabel,
  statusBarBackground,
} from '../mmk/environments.js';
import type { ProjectSnapshot } from '../mmk/store.js';
import type { ConsolePanel } from '../views/console/panel.js';
import { type Deps, databaseLabel, resolveProject } from './context.js';

/** Arguments for "mmk: Add environment"; with all of them set, nothing is asked */
interface AddArgs {
  dir?: string;
  name?: string;
  uri?: string;
  dbName?: string;
  readOnly?: boolean;
  /** Skip the test connection (tests and scripts only) */
  skipTest?: boolean;
}

/** Register the environment commands: select (C1), add, edit and remove */
export function registerEnvironmentCommands(deps: Deps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mmk.selectEnvironment', (name?: unknown) =>
      typeof name === 'string' ? selectByName(deps, name) : pickEnvironment(deps),
    ),
    vscode.commands.registerCommand('mmk.addEnvironment', (args?: AddArgs) =>
      args?.name === undefined ? openAddDialog(args?.dir) : addEnvironment(deps, args),
    ),
    vscode.commands.registerCommand('mmk.editEnvironment', (name?: unknown) =>
      editEnvironment(deps, typeof name === 'string' ? name : undefined),
    ),
    vscode.commands.registerCommand('mmk.removeEnvironment', (name?: unknown) =>
      removeEnvironment(deps, typeof name === 'string' ? name : undefined),
    ),
    vscode.commands.registerCommand('mmk.setEnvironmentColor', (target?: unknown, hue?: unknown) =>
      setEnvironmentColor(deps, environmentNameOf(deps, target), isHue(hue) ? hue : undefined),
    ),
  ];
}

/** The environment a command argument names: a name, or the tree's environment row (the selected one) */
function environmentNameOf(deps: Deps, target: unknown): string | undefined {
  if (typeof target === 'string') {
    return target;
  }
  if (typeof target === 'object' && target !== null && 'kind' in target && target.kind === 'env') {
    return deps.store.selected().name;
  }
  return undefined;
}

function isHue(value: unknown): value is EnvironmentHue {
  return ENVIRONMENT_HUES.some((hue) => hue === value);
}

const HUE_LABELS: Record<EnvironmentHue, string> = {
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
};

/**
 * Set an environment's colour (local's too) in `mmk.environments`: the one it's drawn in, in the
 * sidebar, the console and the status bar. Returns the colour, or undefined when cancelled.
 */
async function setEnvironmentColor(
  deps: Deps,
  name?: string,
  chosen?: EnvironmentHue,
): Promise<EnvironmentHue | undefined> {
  let environment = name === undefined ? undefined : deps.store.environment(name);
  if (!environment) {
    const picked = await vscode.window.showQuickPick(
      deps.store.environments().map((candidate) => ({
        label: candidate.name,
        description: HUE_LABELS[environmentHue(candidate.color)],
        environment: candidate,
      })),
      { title: 'mmk: Change environment colour' },
    );
    environment = picked?.environment;
  }
  if (!environment) {
    return undefined;
  }
  const current = environmentHue(environment.color);
  const hue =
    chosen ??
    (
      await vscode.window.showQuickPick(
        ENVIRONMENT_HUES.map((candidate) => {
          const background = statusBarBackground(candidate);
          return {
            label: HUE_LABELS[candidate],
            description: [
              candidate === current ? 'current' : '',
              background === 'default' ? '' : `status bar: ${background} background`,
            ]
              .filter(Boolean)
              .join(' · '),
            hue: candidate,
          };
        }),
        {
          title: `mmk: Colour for ${environment.name}`,
          placeHolder: 'Shown in the sidebar, the console and the status bar',
        },
      )
    )?.hue;
  if (!hue) {
    return undefined;
  }
  await deps.environments.writeEntry({ name: environment.name, color: hue });
  deps.environments.load();
  return hue;
}

async function selectByName(deps: Deps, name: string): Promise<string | undefined> {
  if (!deps.store.environment(name)) {
    void vscode.window.showWarningMessage(
      `There's no environment called "${name}". Add it with "mmk: Add environment…".`,
    );
    return undefined;
  }
  await deps.environments.select(name);
  return name;
}

type PickerItem = vscode.QuickPickItem & { run?: () => Thenable<unknown> };

/** The environment picker (design C1), from the status bar, the sidebar or the palette */
async function pickEnvironment(deps: Deps): Promise<string | undefined> {
  const selected = deps.store.selected().name;
  const projects = deps.store.snapshots();
  const items: PickerItem[] = deps.store.environments().map((environment) => ({
    label: `${environment.readOnly ? '$(lock)' : '$(circle-filled)'} ${environment.name}`,
    description: describeDatabase(projects, environment),
    detail: environmentNote(projects, environment, environment.name === selected),
    run: () => selectByName(deps, environment.name),
  }));
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(table) Compare all environments…',
      run: () => vscode.commands.executeCommand('mmk.compareEnvironments'),
    },
    {
      label: '$(add) Add environment…',
      run: () => vscode.commands.executeCommand('mmk.addEnvironment'),
    },
    {
      label: '$(settings-gear) Edit environments',
      detail:
        'Names, read-only flags and colors are in "mmk.environments"; connections stay in the keychain',
      run: () =>
        vscode.commands.executeCommand('workbench.action.openSettings', 'mmk.environments'),
    },
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: 'mmk: Select environment',
    placeHolder: 'Files always come from your working tree; records come from the environment',
  });
  await picked?.run?.();
  return deps.store.selected().name;
}

/** `cluster0.example.net/orders_staging`, or how many projects when there are several */
function describeDatabase(projects: readonly ProjectSnapshot[], environment: Environment): string {
  if (projects.length === 1) {
    return databaseLabel(projects[0], environment.name);
  }
  return `${projects.length} projects`;
}

/** `2 pending · runs allowed · current`, `read-only · 1 pending`, `read-only · protected · …` */
function environmentNote(
  projects: readonly ProjectSnapshot[],
  environment: Environment,
  current: boolean,
): string {
  const statuses = projects.map((project) => project.environments[environment.name]);
  const parts: string[] = [];
  if (environment.readOnly) {
    parts.push(
      statusBarBackground(environment.color) === 'error' ? 'read-only · protected' : 'read-only',
    );
  }
  if (statuses.length > 0 && statuses.every((status) => status && !status.connected)) {
    parts.push('not set up: run "mmk: Edit environment…"');
  } else if (statuses.some((status) => status?.error)) {
    parts.push(`couldn't read: ${statuses.find((status) => status?.error)?.error?.message ?? ''}`);
  } else if (statuses.some((status) => status?.loading && !status.rows)) {
    parts.push('reading…');
  } else {
    const pending = statuses.reduce(
      (sum, status) =>
        sum +
        (status?.rows?.filter((row) => row.status === 'pending' && !row.unadopted).length ?? 0),
      0,
    );
    parts.push(`${pending} pending`);
  }
  if (!environment.readOnly) {
    parts.push('runs allowed');
  }
  if (current) {
    parts.push('current');
  }
  return parts.join(' · ').split('\n')[0] ?? '';
}

/**
 * Open the console's *Add environment* dialog (C13) for a project: name, database, the
 * connection string (masked), read-only, colour and a connection test, in one form. Returns the
 * console, for tests.
 */
async function openAddDialog(dir: string | undefined): Promise<ConsolePanel | undefined> {
  const panel = await vscode.commands.executeCommand<ConsolePanel | undefined>(
    'mmk.openConsole',
    dir === undefined ? undefined : { dir },
  );
  await panel?.receive({ type: 'addEnvironment' });
  return panel;
}

/** Keep a new environment: its connection in the OS keychain, its name and flags in settings */
export async function saveEnvironment(
  deps: Deps,
  dir: string,
  entry: { name: string; readOnly: boolean; color?: EnvironmentHue },
  connection: Connection,
): Promise<void> {
  await deps.environments.saveConnection(dir, entry.name, connection);
  await deps.environments.writeEntry(entry);
  deps.environments.load();
}

/** What a connection test found: the migrations mmk read there, or mmk's error as is */
export type ConnectionCheck =
  | { ok: true; migrations: number; pending: number }
  | { ok: false; message: string };

/**
 * Test a connection with `mmk status --json`, the project's own mmk, as every read does. Shows
 * nothing: the caller says how it went.
 */
export async function checkConnection(
  deps: Deps,
  project: ProjectSnapshot,
  name: string,
  connection: Connection,
): Promise<ConnectionCheck> {
  if (project.state.kind !== 'ready') {
    return { ok: false, message: project.state.message };
  }
  try {
    const output = await runMmkJson(project.state.invocation, ['status'], {
      env: connectionEnv(connection),
      timeoutMs: 60_000,
      onStderrLine: (line) => deps.log.mmkOutput(line, 'debug'),
    });
    const rows = parseStatusRows(output.value, 'status');
    return {
      ok: true,
      migrations: rows.length,
      pending: rows.filter((row) => row.status === 'pending').length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.warn(
      `Testing ${name}: ${error instanceof MmkCommandError && error.failure.code ? `${error.failure.code}: ` : ''}${message}`,
    );
    return { ok: false, message };
  }
}

/**
 * Add an environment from a command's arguments (scripts and tests): any missing value is asked
 * for, the connection is tested, then kept in the OS keychain; settings get only the name and
 * flags. Returns the name, or undefined when cancelled.
 */
async function addEnvironment(deps: Deps, args: AddArgs): Promise<string | undefined> {
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
  const existing = deps.store.environments().map((environment) => environment.name);
  const name =
    args.name ??
    (await vscode.window.showInputBox({
      title: 'mmk: Add environment (1/4) · name',
      prompt: 'A short name for the database, e.g. staging or prod',
      placeHolder: 'staging',
      validateInput: (value) => environmentNameProblem(value, existing),
      ignoreFocusOut: true,
    }));
  if (name === undefined) {
    return undefined;
  }
  const problem = environmentNameProblem(name, existing);
  if (problem !== null) {
    void vscode.window.showWarningMessage(problem);
    return undefined;
  }

  const connection = await askConnection(deps, project, name.trim(), args);
  if (!connection) {
    return undefined;
  }
  const readOnly = args.readOnly ?? (await askReadOnly(name.trim(), true));
  if (readOnly === undefined) {
    return undefined;
  }

  await saveEnvironment(deps, project.dir, { name: name.trim(), readOnly }, connection);
  void vscode.window
    .showInformationMessage(
      `Added ${name.trim()} (${hostLabel(connection.uri, connection.dbName)}${readOnly ? ', read-only' : ''}). Its connection string is in the OS keychain, not in settings.`,
      'Switch to it',
      'Compare all environments',
    )
    .then(async (choice) => {
      if (choice === 'Switch to it') {
        await deps.environments.select(name.trim());
      } else if (choice === 'Compare all environments') {
        await vscode.commands.executeCommand('mmk.compareEnvironments');
      }
    });
  return name.trim();
}

/**
 * Ask for a connection string and database, then test them with `mmk status --json` (the
 * project's own mmk, as every read does). Returns them, or undefined when cancelled.
 */
async function askConnection(
  deps: Deps,
  project: ProjectSnapshot,
  name: string,
  args: AddArgs,
  current?: Connection,
): Promise<Connection | undefined> {
  for (;;) {
    const uri =
      args.uri ??
      (await vscode.window.showInputBox({
        title: `mmk: ${name} (2/4) · connection string`,
        prompt: `Stored in the OS keychain for ${path.basename(project.dir)} and passed to mmk as MMK_URI. Never written to settings or logs.`,
        placeHolder: 'mongodb+srv://user:password@cluster0.example.net',
        password: true,
        ignoreFocusOut: true,
        validateInput: connectionStringProblem,
      }));
    if (uri === undefined) {
      return undefined;
    }
    if (connectionStringProblem(uri) !== null) {
      void vscode.window.showWarningMessage(connectionStringProblem(uri) ?? '');
      return undefined;
    }
    const dbName =
      args.dbName ??
      (await vscode.window.showInputBox({
        title: `mmk: ${name} (3/4) · database`,
        prompt: 'The database whose changelog mmk reads (MMK_DB)',
        value: databaseFromUri(uri) ?? current?.dbName ?? '',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() === '' ? 'Type the database name' : null),
      }));
    if (dbName === undefined || dbName.trim() === '') {
      return undefined;
    }
    const connection = { uri: uri.trim(), dbName: dbName.trim() };
    if (args.skipTest) {
      return connection;
    }
    const outcome = await testConnection(deps, project, name, connection);
    if (outcome.ok) {
      return connection;
    }
    if (args.uri !== undefined) {
      void vscode.window.showErrorMessage(outcome.message);
      return undefined;
    }
    const choice = await vscode.window.showErrorMessage(
      `Couldn't read ${name}: ${outcome.message}`,
      { modal: true },
      'Change connection string',
      'Save anyway',
    );
    if (choice === 'Save anyway') {
      return connection;
    }
    if (choice !== 'Change connection string') {
      return undefined;
    }
  }
}

/** "Testing connection…" → "Connected · 44 applied, 1 pending", or mmk's own error message */
async function testConnection(
  deps: Deps,
  project: ProjectSnapshot,
  name: string,
  connection: Connection,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const check = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `mmk: testing the connection to ${name}…`,
    },
    () => checkConnection(deps, project, name, connection),
  );
  if (!check.ok) {
    return check;
  }
  void vscode.window.showInformationMessage(
    `Connected to ${name} · ${check.migrations - check.pending} applied, ${check.pending} pending`,
  );
  return { ok: true };
}

/** Read-only is on by default for anything but local */
async function askReadOnly(name: string, recommended: boolean): Promise<boolean | undefined> {
  const readOnlyItem = {
    label: `$(lock) Read-only${recommended ? ' (recommended)' : ''}`,
    detail: `Only status, list and dry-run run on ${name}. Deploys go through CI.`,
    value: true,
  };
  const writable = {
    label: '$(play) Allow runs',
    detail: `Run up, down and redo on ${name}, each after a confirmation.`,
    value: false,
  };
  const picked = await vscode.window.showQuickPick([readOnlyItem, writable], {
    title: `mmk: ${name} (4/4) · read-only?`,
    ignoreFocusOut: true,
  });
  return picked?.value;
}

/** Pick a non-local environment by name, or undefined */
async function pickRemote(deps: Deps, title: string): Promise<Environment | undefined> {
  const remote = deps.store.environments().filter((environment) => !environment.local);
  if (remote.length === 0) {
    void vscode.window.showInformationMessage(
      'There are no environments besides local yet. Add one with "mmk: Add environment…".',
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    remote.map((environment) => ({
      label: environment.name,
      description: environment.readOnly ? 'read-only' : 'runs allowed',
      environment,
    })),
    { title },
  );
  return picked?.environment;
}

/** Change an environment's connection or read-only flag, or remove it */
async function editEnvironment(deps: Deps, name?: string): Promise<void> {
  const environment =
    name === undefined
      ? await pickRemote(deps, 'mmk: Edit environment')
      : deps.store.environment(name);
  if (!environment || environment.local) {
    return;
  }
  const action = await vscode.window.showQuickPick(
    [
      { label: '$(key) Change connection string…', id: 'connection' },
      { label: '$(symbol-color) Change colour…', id: 'color' },
      environment.readOnly
        ? { label: '$(unlock) Allow runs…', id: 'writable' }
        : { label: '$(lock) Make read-only', id: 'readOnly' },
      { label: '$(trash) Remove…', id: 'remove' },
    ],
    { title: `mmk: Edit ${environment.name}` },
  );
  if (action?.id === 'connection') {
    const project = await resolveProject(deps, undefined);
    if (!project) {
      return;
    }
    const current = await deps.environments.connection(project.dir, environment.name);
    const connection = await askConnection(
      deps,
      project,
      environment.name,
      {},
      current ?? undefined,
    );
    if (connection) {
      await deps.environments.saveConnection(project.dir, environment.name, connection);
      void vscode.window.showInformationMessage(
        `Saved ${environment.name}'s connection for ${path.basename(project.dir)} in the OS keychain.`,
      );
    }
  } else if (action?.id === 'color') {
    await setEnvironmentColor(deps, environment.name);
  } else if (action?.id === 'readOnly') {
    await deps.environments.writeEntry({ name: environment.name, readOnly: true });
  } else if (action?.id === 'writable') {
    const confirmed = await deps.confirm(
      `Allow runs on ${environment.name}?`,
      `Run links and the sidebar will offer up, down and redo on ${environment.name}. Each still asks first.`,
      'Allow runs',
    );
    if (confirmed) {
      await deps.environments.writeEntry({ name: environment.name, readOnly: false });
    }
  } else if (action?.id === 'remove') {
    await removeEnvironment(deps, environment.name);
  }
}

/** Remove an environment from settings and its connections from the keychain */
async function removeEnvironment(deps: Deps, name?: string): Promise<boolean> {
  const environment =
    name === undefined
      ? await pickRemote(deps, 'mmk: Remove environment')
      : deps.store.environment(name);
  if (!environment || environment.local) {
    return false;
  }
  const confirmed = await deps.confirm(
    `Remove ${environment.name}?`,
    `Its connection strings are deleted from the OS keychain and its entry from "mmk.environments". The database itself isn't touched.`,
    'Remove',
  );
  if (!confirmed) {
    return false;
  }
  for (const project of deps.store.snapshots()) {
    await deps.environments.deleteConnection(project.dir, environment.name);
  }
  if (deps.store.selected().name === environment.name) {
    await deps.environments.select(LOCAL_ENVIRONMENT);
  }
  await deps.environments.removeEntry(environment.name);
  deps.environments.load();
  return true;
}
