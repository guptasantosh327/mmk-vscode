import * as vscode from 'vscode';
import { type Deps, modalConfirm } from './commands/context.js';
import { registerCreateCommand } from './commands/create.js';
import { EnvironmentRegistry } from './commands/environment-registry.js';
import { registerEnvironmentCommands } from './commands/environments.js';
import { registerMiscCommands } from './commands/misc.js';
import { registerRunCommands } from './commands/run.js';
import type { LintReport } from './mmk/contract.js';
import type { Connection } from './mmk/environments.js';
import { type Logger, createLogger } from './mmk/log.js';
import { discoverProjects } from './mmk/project.js';
import { MmkStore, type ProjectSnapshot } from './mmk/store.js';
import { RollbackTests, registerRollbackCommand } from './testing/rollback.js';
import {
  AppliedProtection,
  type EditedState,
  registerAppliedCommands,
} from './views/applied-protection.js';
import { BranchWatch } from './views/branch-watch.js';
import { RunLinksProvider } from './views/codelens.js';
import { MigrationDecorations } from './views/decorations.js';
import { LintDiagnostics } from './views/lint-diagnostics.js';
import { registerMatrix } from './views/matrix/panel.js';
import { SIDEBAR_VIEW, type SidebarNode, SidebarProvider } from './views/sidebar.js';
import { StatusBar } from './views/statusbar.js';

/** Hooks for the integration tests. `activate` returns them only in VS Code's test mode */
export interface MmkTestApi {
  store: MmkStore;
  /** Resolves when no status read is in flight or scheduled */
  idle(): Promise<void>;
  /** The sidebar as text, one line per row: two spaces per level, then `label · description` */
  sidebar(): string[];
  /** Answer confirmation modals with `answer` instead of showing them */
  setConfirm(answer: (message: string) => boolean): void;
  /** The environments registry (settings and keychain) */
  environments: EnvironmentRegistry;
  /** Report migrations from other branches as after a checkout; returns the messages */
  checkBranch(root: string, branch: string | null): Promise<string[]>;
  /** Check an open migration against what ran now; its edited state, or undefined */
  checkApplied(document: vscode.TextDocument): Promise<EditedState | undefined>;
  /** The rollback tests in Test Explorer */
  rollbackTests: RollbackTests;
  /** Run `mmk lint` on a project now; mmk's report, or undefined when it can't */
  lint(dir: string): Promise<LintReport | undefined>;
}

/**
 * Activate the extension: find the workspace's mmk projects, read each one's config and status
 * through its own mmk, and show them. Nothing here writes to a database: every write is a click.
 */
export function activate(context: vscode.ExtensionContext): MmkTestApi | undefined {
  const channel = vscode.window.createOutputChannel('mmk', { log: true });
  const log = createLogger(channel);
  // The store asks the registry for stored connections; it's only called after both exist.
  const store: MmkStore = new MmkStore({
    log,
    connection: (dir: string, environment: string): Promise<Connection | null> =>
      environments.connection(dir, environment),
  });
  const environments: EnvironmentRegistry = new EnvironmentRegistry(context, store, log);
  const deps: Deps = {
    store,
    environments,
    log,
    channel,
    confirm: modalConfirm,
    created: new Set(),
  };

  const sidebar = new SidebarProvider(deps);
  const protection = new AppliedProtection(deps);
  const runLinks = new RunLinksProvider(deps, protection);
  const decorations = new MigrationDecorations(deps, protection);
  const statusBar = new StatusBar(deps);
  const watchers = new ProjectWatchers(store);
  const contextKeys = new ContextKeys();
  const branchWatch = new BranchWatch(deps);
  const rollbackTests = new RollbackTests(deps);
  const lint = new LintDiagnostics(deps);

  // Snapshots change several times per read; redraw once per burst.
  let redrawScheduled = false;
  const scheduleRedraw = (): void => {
    if (redrawScheduled) {
      return;
    }
    redrawScheduled = true;
    setTimeout(() => {
      redrawScheduled = false;
      const projects = store.snapshots();
      sidebar.refresh();
      runLinks.refresh();
      decorations.refresh();
      statusBar.update();
      watchers.sync(projects);
      contextKeys.update(projects, store.selected().readOnly);
    }, 30);
  };

  const rediscover = async (): Promise<void> => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const nodePath = vscode.workspace.getConfiguration('mmk').get<string>('nodePath');
    try {
      const states = await discoverProjects({ folders, nodePath, env: process.env });
      reportDiscovery(log, states);
      store.setProjects(states);
    } catch (error) {
      log.error(
        `Couldn't look for mmk projects: ${error instanceof Error ? error.message : String(error)}`,
      );
      store.setProjects([]);
    }
    contextKeys.discovered();
  };

  let rediscoverTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRediscover = (): void => {
    if (rediscoverTimer) {
      clearTimeout(rediscoverTimer);
    }
    rediscoverTimer = setTimeout(() => void rediscover(), 500);
  };
  const configFiles = vscode.workspace.createFileSystemWatcher(
    '**/mmk.config.{js,ts,json}',
    false,
    true,
    false,
  );

  context.subscriptions.push(
    channel,
    statusBar,
    watchers,
    environments,
    branchWatch,
    protection,
    rollbackTests,
    lint,
    registerRollbackCommand(deps, rollbackTests),
    protection.onDidChangeState(() => {
      runLinks.refresh();
      decorations.refresh();
    }),
    ...registerAppliedCommands(deps, protection),
    configFiles,
    { dispose: () => store.dispose() },
    store.onDidChange(scheduleRedraw),
    vscode.window.createTreeView(SIDEBAR_VIEW, {
      treeDataProvider: sidebar,
      showCollapseAll: true,
    }),
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
      ],
      runLinks,
    ),
    vscode.window.registerFileDecorationProvider(decorations),
    ...registerRunCommands(deps),
    ...registerMiscCommands(deps),
    ...registerEnvironmentCommands(deps),
    ...registerMatrix(deps, context.extensionUri),
    registerCreateCommand(deps),
    vscode.commands.registerCommand('mmk.refresh', async () => {
      await rediscover();
      await store.refresh(undefined, { reloadConfig: true });
      return store.snapshots();
    }),
    configFiles.onDidCreate(scheduleRediscover),
    configFiles.onDidDelete(scheduleRediscover),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRediscover),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mmk.nodePath')) {
        scheduleRediscover();
      }
    }),
  );

  environments.load();
  void rediscover();

  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return undefined;
  }
  return {
    store,
    idle: () => store.idle(),
    sidebar: () => describeTree(sidebar),
    setConfirm: (answer) => {
      deps.confirm = async (message) => answer(message);
    },
    environments,
    checkBranch: (root, branch) => branchWatch.checkAfterSwitch(root, branch),
    checkApplied: (document) => protection.check(document),
    rollbackTests,
    lint: (dir) => lint.lint(dir),
  };
}

/** Log what discovery found, and warn when a project's mmk is too old (features stay off) */
function reportDiscovery(log: Logger, states: Awaited<ReturnType<typeof discoverProjects>>): void {
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
}

/**
 * Watches each project's migrations folder (read again when a file changes) and its config files
 * and `.env` (read the config again too). Follows `migrationsDir` when mmk's config changes it.
 */
class ProjectWatchers implements vscode.Disposable {
  private readonly byDir = new Map<
    string,
    { migrationsDir: string | undefined; watchers: vscode.Disposable[] }
  >();

  constructor(private readonly store: MmkStore) {}

  sync(projects: readonly ProjectSnapshot[]): void {
    const seen = new Set<string>();
    for (const project of projects) {
      seen.add(project.dir);
      const migrationsDir = project.config?.migrationsDir;
      const existing = this.byDir.get(project.dir);
      if (existing && existing.migrationsDir === migrationsDir) {
        continue;
      }
      this.disposeDir(project.dir);
      const watchers: vscode.Disposable[] = [];
      const config = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(project.dir),
          '{mmk.config.ts,mmk.config.js,mmk.config.json,.env}',
        ),
      );
      const reloadConfig = (): void =>
        this.store.scheduleRefresh(project.dir, { reloadConfig: true });
      watchers.push(
        config,
        config.onDidChange(reloadConfig),
        config.onDidCreate(reloadConfig),
        config.onDidDelete(reloadConfig),
      );
      if (migrationsDir !== undefined) {
        const files = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(migrationsDir), '*'),
        );
        const reread = (): void => this.store.scheduleRefresh(project.dir);
        watchers.push(
          files,
          files.onDidChange(reread),
          files.onDidCreate(reread),
          files.onDidDelete(reread),
        );
      }
      this.byDir.set(project.dir, { migrationsDir, watchers });
    }
    for (const dir of [...this.byDir.keys()]) {
      if (!seen.has(dir)) {
        this.disposeDir(dir);
      }
    }
  }

  dispose(): void {
    for (const dir of [...this.byDir.keys()]) {
      this.disposeDir(dir);
    }
  }

  private disposeDir(dir: string): void {
    for (const watcher of this.byDir.get(dir)?.watchers ?? []) {
      watcher.dispose();
    }
    this.byDir.delete(dir);
  }
}

/** The `when`-clause keys the view's welcome content and menus use */
class ContextKeys {
  private values = new Map<string, unknown>();

  /** Discovery has run at least once, so "no project" is a real answer */
  discovered(): void {
    this.set('mmk.discovered', true);
  }

  update(projects: readonly ProjectSnapshot[], readOnly: boolean): void {
    this.set('mmk.hasProject', projects.length > 0);
    this.set('mmk.readOnly', readOnly);
    const only = projects.length === 1 ? projects[0] : undefined;
    this.set('mmk.problem', only && only.state.kind !== 'ready' ? only.state.kind : '');
  }

  private set(key: string, value: unknown): void {
    if (this.values.get(key) !== value) {
      this.values.set(key, value);
      void vscode.commands.executeCommand('setContext', key, value);
    }
  }
}

/** The sidebar as indented text, for tests */
function describeTree(provider: SidebarProvider): string[] {
  const lines: string[] = [];
  const walk = (node: SidebarNode | undefined, depth: number): void => {
    for (const child of provider.getChildren(node)) {
      const item = provider.getTreeItem(child);
      const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
      const description =
        typeof item.description === 'string' && item.description !== ''
          ? ` · ${item.description}`
          : '';
      lines.push(`${'  '.repeat(depth)}${label}${description}`);
      walk(child, depth + 1);
    }
  };
  walk(undefined, 0);
  return lines;
}
