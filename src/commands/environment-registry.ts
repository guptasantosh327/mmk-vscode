import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  type Connection,
  type EnvironmentColor,
  type EnvironmentSettings,
  LOCAL_ENVIRONMENT,
  type LeakedConnection,
  connectionKey,
  parseEnvironmentSettings,
  parseStoredConnection,
} from '../mmk/environments.js';
import type { Logger } from '../mmk/log.js';
import type { MmkStore } from '../mmk/store.js';

/** The setting that lists environments: names, read-only flags and colors, never connections */
export const ENVIRONMENTS_SETTING = 'environments';

/** workspaceState key of the selected environment */
const SELECTED_KEY = 'mmk.selectedEnvironment';

/** One entry of the `mmk.environments` setting, as written in settings.json */
export interface EnvironmentEntry {
  name: string;
  readOnly?: boolean;
  color?: EnvironmentColor;
}

/**
 * The environments of this workspace: `mmk.environments` from settings, each project's
 * connection to each of them from the OS keychain (`context.secrets`), and which one is
 * selected. Keeps the store in step when any of them change.
 */
export class EnvironmentRegistry implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reported = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: MmkStore,
    private readonly log: Logger,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`mmk.${ENVIRONMENTS_SETTING}`)) {
          this.load();
        }
      }),
      context.secrets.onDidChange((event) => {
        if (event.key.startsWith('mmk.connection:')) {
          void this.store.refresh();
        }
      }),
    );
  }

  /** Read the setting and push the environments to the store */
  load(): EnvironmentSettings {
    const settings = parseEnvironmentSettings(this.entries());
    for (const problem of settings.problems) {
      this.reportOnce(problem, () => void vscode.window.showWarningMessage(problem));
    }
    if (settings.leaked.length > 0) {
      this.offerToMoveLeaked(settings.leaked);
    }
    const selected = this.context.workspaceState.get<string>(SELECTED_KEY) ?? LOCAL_ENVIRONMENT;
    this.store.setEnvironments(settings.environments, selected);
    return settings;
  }

  /** Select an environment, and remember it for this workspace */
  async select(name: string): Promise<void> {
    this.store.select(name);
    await this.context.workspaceState.update(SELECTED_KEY, this.store.selected().name);
  }

  /** A project's stored connection to an environment, or null */
  async connection(dir: string, environment: string): Promise<Connection | null> {
    if (environment === LOCAL_ENVIRONMENT) {
      return null;
    }
    return parseStoredConnection(await this.context.secrets.get(connectionKey(dir, environment)));
  }

  /** Store a project's connection to an environment in the OS keychain */
  async saveConnection(dir: string, environment: string, connection: Connection): Promise<void> {
    await this.context.secrets.store(connectionKey(dir, environment), JSON.stringify(connection));
  }

  /** Forget a project's connection to an environment */
  async deleteConnection(dir: string, environment: string): Promise<void> {
    await this.context.secrets.delete(connectionKey(dir, environment));
  }

  /** The setting's entries as written */
  entries(): unknown[] {
    const value = vscode.workspace.getConfiguration('mmk').get<unknown>(ENVIRONMENTS_SETTING);
    return Array.isArray(value) ? value : [];
  }

  /**
   * Add an entry to the workspace's `mmk.environments`, or change the fields `entry` names in the
   * existing one, keeping its other fields and its place in the list.
   */
  async writeEntry(entry: EnvironmentEntry): Promise<void> {
    const entries = this.entries();
    const index = entries.findIndex((existing) => entryName(existing) === entry.name);
    const current = entries[index];
    if (index === -1 || typeof current !== 'object' || current === null) {
      await this.writeEntries([...entries.filter((_, at) => at !== index), entry]);
      return;
    }
    await this.writeEntries(
      entries.map((existing, at) => (at === index ? { ...current, ...entry } : existing)),
    );
  }

  /** Remove an entry from the workspace's `mmk.environments` */
  async removeEntry(name: string): Promise<void> {
    await this.writeEntries(this.entries().filter((existing) => entryName(existing) !== name));
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async writeEntries(entries: unknown[]): Promise<void> {
    await vscode.workspace
      .getConfiguration('mmk')
      .update(ENVIRONMENTS_SETTING, entries, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * settings.json is committed and shared, so a connection string there is a leak. Offer to
   * move it to the keychain and take it out of the setting.
   */
  private offerToMoveLeaked(leaked: readonly LeakedConnection[]): void {
    const names = [...new Set(leaked.map((item) => item.environment))];
    const message = `Your settings have a connection string for ${names.join(', ')} in "mmk.environments". Settings files are often committed, so connection strings belong in the OS keychain.`;
    this.reportOnce(message, () => {
      this.log.warn(message);
      void vscode.window
        .showWarningMessage(message, 'Move to keychain', 'Open settings')
        .then(async (choice) => {
          if (choice === 'Open settings') {
            await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
          } else if (choice === 'Move to keychain') {
            await this.moveLeaked(leaked);
          }
        });
    });
  }

  private async moveLeaked(leaked: readonly LeakedConnection[]): Promise<void> {
    const projects = this.store.snapshots();
    let dir = projects.length === 1 ? projects[0]?.dir : undefined;
    if (dir === undefined) {
      const picked = await vscode.window.showQuickPick(
        projects.map((project) => ({ label: path.basename(project.dir), detail: project.dir })),
        { title: 'mmk: Which project uses these connections?' },
      );
      dir = picked?.detail;
    }
    if (dir === undefined) {
      return;
    }
    for (const item of leaked) {
      if (item.dbName === undefined) {
        void vscode.window.showWarningMessage(
          `The entry for ${item.environment} has no database name, so its connection string was left in settings. Run "mmk: Edit environment…" to add it with its database.`,
        );
        continue;
      }
      await this.saveConnection(dir, item.environment, { uri: item.uri, dbName: item.dbName });
    }
    const moved = new Set(
      leaked.filter((item) => item.dbName !== undefined).map((item) => item.environment),
    );
    const cleaned = this.entries().map((entry) => {
      if (typeof entry !== 'object' || entry === null || !moved.has(entryName(entry) ?? '')) {
        return entry;
      }
      const { name, readOnly, color } = entry as Record<string, unknown>;
      return {
        name,
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(color === undefined ? {} : { color }),
      };
    });
    await this.writeEntries(cleaned);
    if (moved.size > 0) {
      void vscode.window.showInformationMessage(
        `Moved the connection strings for ${[...moved].join(', ')} to the OS keychain and took them out of settings. Rotate the password if the file was ever committed.`,
      );
    }
  }

  private reportOnce(key: string, report: () => void): void {
    if (!this.reported.has(key)) {
      this.reported.add(key);
      report();
    }
  }
}

function entryName(entry: unknown): string | undefined {
  return typeof entry === 'object' && entry !== null && 'name' in entry
    ? typeof entry.name === 'string'
      ? entry.name
      : undefined
    : undefined;
}
