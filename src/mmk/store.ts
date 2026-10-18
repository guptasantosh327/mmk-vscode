import path from 'node:path';
import {
  type JsonOutput,
  MmkCommandError,
  type MmkInvocation,
  type RunOptions,
  describeCommand,
  runMmkJson,
  runNodeJson,
} from './cli.js';
import { type ProjectConfig, type WireStatusRow, parseStatusRows } from './contract.js';
import {
  type Connection,
  type Environment,
  LOCAL_ENVIRONMENT,
  ReadOnlyEnvironmentError,
  assertCanRun,
  connectionEnv,
  hostLabel,
  localEnvironment,
} from './environments.js';
import type { Logger } from './log.js';
import { type ConfigReaders, readProjectConfig } from './project-config.js';
import type { ProjectState } from './project.js';
import { redactMongoUri } from './redact.js';

/** A command {@link MmkStore.run} ran: its label, where, and mmk's error when it failed */
export interface FinishedRun {
  label: string;
  environment: string;
  failure: string | null;
}

/** Why the last read of a project failed. `message` is mmk's own when mmk reported it */
export interface ReadFailure {
  message: string;
  code?: string;
}

/** What mmk last said about one project on one environment */
export interface EnvironmentStatus {
  /** `mmk status --json` from the last successful read; null before one, or after a failure */
  rows: WireStatusRow[] | null;
  /** The last read's failure, or null */
  error: ReadFailure | null;
  /** True while it's being read */
  loading: boolean;
  /** False when this project has no stored connection for the environment, so it isn't read */
  connected: boolean;
  /** Where its records are read from, for display (`host/db`, no credentials); null if unknown */
  database: string | null;
  /** When the last successful read finished */
  readAt: Date | null;
}

/** What the extension knows about one project right now */
export interface ProjectSnapshot {
  /** The project's directory (mmk's cwd) */
  dir: string;
  /** Whether mmk can run here, and if not, why */
  state: ProjectState;
  /** The resolved config (see `readProjectConfig`), once read */
  config: ProjectConfig | null;
  /** The selected environment's rows (see `environments`) */
  rows: WireStatusRow[] | null;
  /** The selected environment's last read failure */
  error: ReadFailure | null;
  /** True while the selected environment (or the config) is being read */
  loading: boolean;
  /** Every environment's status, by name */
  environments: Readonly<Record<string, EnvironmentStatus>>;
  /** The command running in this project, e.g. `up 2026…-x.js`, or null */
  running: string | null;
  /** The environment `running` runs on */
  runningOn: string | null;
}

/** A migration file and the project it belongs to */
export interface MigrationRef {
  project: ProjectSnapshot;
  /** The file name, as mmk names it in commands and status rows */
  file: string;
  /** Its status row on the selected environment, when the last read had one */
  row: WireStatusRow | undefined;
}

/** Runs mmk; the real one is `runMmkJson`, tests pass a fake */
export type RunMmk = (
  invocation: MmkInvocation,
  args: readonly string[],
  options: RunOptions,
) => Promise<JsonOutput>;

/** Looks up a project's stored connection to an environment (the OS keychain) */
export type ConnectionLookup = (dir: string, environment: string) => Promise<Connection | null>;

/** Options for {@link MmkStore} */
export interface StoreOptions {
  log: Logger;
  /** Runs `mmk <args> --json`. Default: the real mmk */
  run?: RunMmk;
  /** Runs Node with a script (the config bridge for mmk 1.5). Default: the real Node */
  runNode?: ConfigReaders['library'];
  /** Each project's connection to a non-local environment. Default: none stored */
  connection?: ConnectionLookup;
  /** How long a config read may take. Default: 30 s */
  configTimeoutMs?: number;
  /** How long a status read may take. Default: 60 s */
  statusTimeoutMs?: number;
  /** How long to wait for more file changes before reading again. Default: 300 ms */
  debounceMs?: number;
}

/** Thrown by {@link MmkStore.run} when a command can't start; `message` says why */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/** One environment's reads for one project: never two at once, and at most one queued */
interface ReadSlot {
  status: EnvironmentStatus;
  inflight: Promise<void> | null;
  queued: Promise<void> | null;
}

interface Entry {
  snapshot: ProjectSnapshot;
  configStale: boolean;
  /** The config read in flight, shared by the environments' reads */
  configRead: Promise<void> | null;
  /** The environment the last config read (or attempt) used */
  configEnvironment: string | null;
  slots: Map<string, ReadSlot>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The projects in the workspace and what mmk last said about each: its resolved config and its
 * status rows on every environment. Reads are coalesced per environment (never two at once,
 * and requests made during a read get one more read after it), file-change reads are
 * debounced, and every command checks that its environment allows it. It never computes a
 * status itself.
 */
export class MmkStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly outputListeners = new Set<(dir: string, line: string) => void>();
  private readonly finishListeners = new Set<(dir: string, run: FinishedRun) => void>();
  private readonly runMmk: RunMmk;
  private readonly readers: ConfigReaders;
  private readonly connection: ConnectionLookup;
  private readonly log: Logger;
  private readonly configTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly debounceMs: number;
  private environmentList: Environment[] = [localEnvironment()];
  private selectedName: string = LOCAL_ENVIRONMENT;

  constructor(options: StoreOptions) {
    this.log = options.log;
    this.runMmk = options.run ?? runMmkJson;
    this.readers = { cli: this.runMmk, library: options.runNode ?? runNodeJson };
    this.connection = options.connection ?? (async () => null);
    this.configTimeoutMs = options.configTimeoutMs ?? 30_000;
    this.statusTimeoutMs = options.statusTimeoutMs ?? 60_000;
    this.debounceMs = options.debounceMs ?? 300;
  }

  /** Replace the project list (after discovery), keeping what's known about projects that stay */
  setProjects(states: readonly ProjectState[]): void {
    const next = new Map<string, Entry>();
    for (const state of states) {
      const dir = state.root.dir;
      const entry: Entry = this.entries.get(dir) ?? {
        snapshot: {
          dir,
          state,
          config: null,
          rows: null,
          error: null,
          loading: false,
          environments: {},
          running: null,
          runningOn: null,
        },
        configStale: true,
        configRead: null,
        configEnvironment: null,
        slots: new Map(),
        timer: null,
      };
      entry.snapshot = { ...entry.snapshot, state };
      entry.configStale = true;
      next.set(dir, entry);
    }
    for (const [dir, entry] of this.entries) {
      if (!next.has(dir) && entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.entries.clear();
    for (const [dir, entry] of next) {
      this.entries.set(dir, entry);
      this.syncSlots(entry);
    }
    this.emit();
    for (const entry of this.entries.values()) {
      void this.requestAll(entry);
    }
  }

  /**
   * Replace the environments (from settings, `local` first) and pick the selected one, then
   * read every environment again: a connection may have changed with them.
   */
  setEnvironments(environments: readonly Environment[], selected: string): void {
    const list = environments.some((environment) => environment.local)
      ? [...environments]
      : [localEnvironment(), ...environments];
    this.environmentList = list;
    this.selectedName = list.some((environment) => environment.name === selected)
      ? selected
      : LOCAL_ENVIRONMENT;
    for (const entry of this.entries.values()) {
      this.syncSlots(entry);
    }
    this.emit();
    for (const entry of this.entries.values()) {
      void this.requestAll(entry);
    }
  }

  /** Select the environment the sidebar, run links and commands act on */
  select(name: string): void {
    if (!this.environmentList.some((environment) => environment.name === name)) {
      return;
    }
    this.selectedName = name;
    for (const entry of this.entries.values()) {
      this.rebuild(entry);
    }
    this.emit();
  }

  /** The selected environment */
  selected(): Environment {
    return this.environment(this.selectedName) ?? localEnvironment();
  }

  /** Every environment, `local` first */
  environments(): Environment[] {
    return [...this.environmentList];
  }

  /** One environment by name */
  environment(name: string): Environment | undefined {
    return this.environmentList.find((environment) => environment.name === name);
  }

  /** Every project, in directory order */
  snapshots(): ProjectSnapshot[] {
    return [...this.entries.values()]
      .map((entry) => entry.snapshot)
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }

  /** One project by directory */
  snapshot(dir: string): ProjectSnapshot | undefined {
    return this.entries.get(dir)?.snapshot;
  }

  /** Call `listener` whenever any snapshot changes. Returns a disposable */
  onDidChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * Call `listener` with each line mmk writes to stderr (its own log) while a command started by
   * {@link MmkStore.run} runs in a project, credentials hidden. Returns a disposable.
   */
  onDidOutput(listener: (dir: string, line: string) => void): { dispose: () => void } {
    this.outputListeners.add(listener);
    return { dispose: () => this.outputListeners.delete(listener) };
  }

  /**
   * Call `listener` when a command started by {@link MmkStore.run} ends, with mmk's error message
   * (credentials hidden) when it failed. Returns a disposable.
   */
  onDidFinishRun(listener: (dir: string, run: FinishedRun) => void): { dispose: () => void } {
    this.finishListeners.add(listener);
    return { dispose: () => this.finishListeners.delete(listener) };
  }

  /**
   * Read config and status again, now. Resolves when reads that started after this call have
   * finished. Without `dir`, refreshes every project; without `environment`, every environment.
   */
  async refresh(
    dir?: string,
    options: { reloadConfig?: boolean; environment?: string } = {},
  ): Promise<void> {
    const targets = dir === undefined ? [...this.entries.values()] : [this.entries.get(dir)];
    await Promise.all(
      targets.map((entry) => {
        if (!entry) {
          return Promise.resolve();
        }
        if (options.reloadConfig) {
          entry.configStale = true;
        }
        return options.environment === undefined
          ? this.requestAll(entry)
          : this.request(entry, options.environment);
      }),
    );
  }

  /** Read every environment again after file changes settle (debounced) */
  scheduleRefresh(dir: string, options: { reloadConfig?: boolean } = {}): void {
    const entry = this.entries.get(dir);
    if (!entry) {
      return;
    }
    if (options.reloadConfig) {
      entry.configStale = true;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.requestAll(entry);
    }, this.debounceMs);
  }

  /** The project a file belongs to as a migration: it sits directly in that project's migrations folder */
  migrationFor(file: string): MigrationRef | undefined {
    const dir = path.dirname(file);
    for (const entry of this.entries.values()) {
      const migrationsDir = entry.snapshot.config?.migrationsDir;
      if (migrationsDir !== undefined && path.relative(migrationsDir, dir) === '') {
        const name = path.basename(file);
        return {
          project: entry.snapshot,
          file: name,
          row: entry.snapshot.rows?.find((row) => row.file === name),
        };
      }
    }
    return undefined;
  }

  /**
   * Run an mmk command in a project on an environment (default: the selected one), logging
   * mmk's output, then read that environment's status again. One command at a time per project.
   * @throws {@link StoreError} when the project can't run mmk, is already running something, or
   *   the environment is read-only and the command writes, or has no stored connection
   * @throws the runner's errors (`MmkCommandError`, `MmkProcessError`) as they are
   */
  async run(
    dir: string,
    args: readonly string[],
    label: string,
    environmentName: string = this.selectedName,
  ): Promise<JsonOutput> {
    const entry = this.entries.get(dir);
    if (!entry) {
      throw new StoreError(`No mmk project at ${dir}. Refresh the mmk view and try again.`);
    }
    const { state } = entry.snapshot;
    if (state.kind !== 'ready') {
      throw new StoreError(state.message);
    }
    const environment = this.environment(environmentName);
    if (!environment) {
      throw new StoreError(
        `There's no environment called "${environmentName}". Check "mmk.environments" in your settings.`,
      );
    }
    try {
      assertCanRun(environment, args);
    } catch (error) {
      throw new StoreError(
        error instanceof ReadOnlyEnvironmentError ? error.message : String(error),
      );
    }
    if (entry.snapshot.running) {
      throw new StoreError(
        `mmk is already running ${entry.snapshot.running} here. Wait for it to finish, then try again.`,
      );
    }
    const connection = environment.local ? null : await this.connection(dir, environment.name);
    if (!environment.local && !connection) {
      throw new StoreError(noConnectionMessage(environment.name, dir));
    }
    this.update(entry, { running: label, runningOn: environment.name });
    this.log.info(
      `$ ${describeCommand([...args, '--json'])}    (in ${dir}${environment.local ? '' : `, on ${environment.name}`})`,
    );
    let failure: string | null = null;
    try {
      return await this.runMmk(state.invocation, args, {
        env: connectionEnv(connection),
        onStderrLine: (line) => {
          this.log.mmkOutput(line);
          const shown = redactMongoUri(line);
          for (const listener of this.outputListeners) {
            listener(dir, shown);
          }
        },
      });
    } catch (error) {
      failure = redactMongoUri(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      for (const listener of this.finishListeners) {
        listener(dir, { label, environment: environment.name, failure });
      }
      this.update(entry, { running: null, runningOn: null });
      void this.request(entry, environment.name);
    }
  }

  /**
   * Run a read command once on an environment and return its JSON, without keeping it, e.g.
   * `status --dir <folder>` for files from another branch. Refuses commands that write.
   * @throws like {@link MmkStore.run}
   */
  async read(
    dir: string,
    args: readonly string[],
    environmentName: string,
    timeoutMs: number = this.statusTimeoutMs,
  ): Promise<JsonOutput> {
    const entry = this.entries.get(dir);
    const environment = this.environment(environmentName);
    if (!entry || entry.snapshot.state.kind !== 'ready' || !environment) {
      throw new StoreError(`Can't read ${environmentName} for ${dir}. Refresh the mmk view.`);
    }
    try {
      assertCanRun({ ...environment, readOnly: true }, args);
    } catch (error) {
      throw new StoreError(error instanceof Error ? error.message : String(error));
    }
    const connection = environment.local ? null : await this.connection(dir, environment.name);
    if (!environment.local && !connection) {
      throw new StoreError(noConnectionMessage(environment.name, dir));
    }
    this.log.debug(
      `$ ${describeCommand([...args, '--json'])}    (in ${dir}${environment.local ? '' : `, on ${environment.name}`})`,
    );
    return this.runMmk(entry.snapshot.state.invocation, args, {
      env: connectionEnv(connection),
      timeoutMs,
      onStderrLine: (line) => this.log.mmkOutput(line, 'debug'),
    });
  }

  /** Resolves when no read is in flight or scheduled (for tests) */
  async idle(): Promise<void> {
    for (;;) {
      const busy: Promise<unknown>[] = [];
      for (const entry of this.entries.values()) {
        if (entry.timer) {
          busy.push(delay(this.debounceMs));
        }
        for (const slot of entry.slots.values()) {
          const pending = slot.queued ?? slot.inflight;
          if (pending) {
            busy.push(pending);
          }
        }
      }
      if (busy.length === 0) {
        return;
      }
      await Promise.all(busy);
    }
  }

  /** Stop pending timers */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.listeners.clear();
  }

  /** Give an entry one slot per environment, dropping slots of removed environments */
  private syncSlots(entry: Entry): void {
    const names = new Set(this.environmentList.map((environment) => environment.name));
    for (const name of [...entry.slots.keys()]) {
      if (!names.has(name)) {
        entry.slots.delete(name);
      }
    }
    for (const name of names) {
      if (!entry.slots.has(name)) {
        entry.slots.set(name, {
          status: {
            rows: null,
            error: null,
            loading: false,
            connected: true,
            database: null,
            readAt: null,
          },
          inflight: null,
          queued: null,
        });
      }
    }
    this.rebuild(entry);
  }

  private requestAll(entry: Entry): Promise<void> {
    return Promise.all([...entry.slots.keys()].map((name) => this.request(entry, name))).then(
      () => undefined,
    );
  }

  /** Start a read of one environment, or queue one more after the read in flight */
  private request(entry: Entry, name: string): Promise<void> {
    const slot = entry.slots.get(name);
    if (!slot) {
      return Promise.resolve();
    }
    if (!slot.inflight) {
      slot.inflight = this.readEnvironment(entry, name).finally(() => {
        slot.inflight = null;
      });
      return slot.inflight;
    }
    if (!slot.queued) {
      slot.queued = slot.inflight.then(() => {
        slot.queued = null;
        return this.request(entry, name);
      });
    }
    return slot.queued;
  }

  /** Read one environment's status (and the config when stale). Never throws */
  private async readEnvironment(entry: Entry, name: string): Promise<void> {
    const { state } = entry.snapshot;
    const environment = this.environment(name);
    if (state.kind !== 'ready' || !environment) {
      return;
    }
    const connection = environment.local ? null : await this.connection(entry.snapshot.dir, name);
    if (!environment.local && !connection) {
      this.setStatus(entry, name, {
        rows: null,
        error: null,
        loading: false,
        connected: false,
        database: null,
      });
      return;
    }
    this.setStatus(entry, name, {
      loading: true,
      connected: true,
      ...(connection ? { database: hostLabel(connection.uri, connection.dbName) } : {}),
    });
    const debugLines = (line: string): void => this.log.mmkOutput(line, 'debug');
    try {
      if (entry.configStale || !entry.snapshot.config) {
        try {
          await this.loadConfig(entry, name, connection);
        } catch (error) {
          // Another environment's read of the config failed (e.g. local has no connection
          // string, which mmk 1.5's config bridge needs): try once more with this one's.
          if (entry.snapshot.config || !connection || entry.configEnvironment === name) {
            throw error;
          }
          await this.loadConfig(entry, name, connection);
        }
      }
      this.log.debug(
        `$ mmk status --json    (in ${entry.snapshot.dir}${environment.local ? '' : `, on ${name}`})`,
      );
      const output = await this.runMmk(state.invocation, ['status'], {
        env: connectionEnv(connection),
        timeoutMs: this.statusTimeoutMs,
        onStderrLine: debugLines,
      });
      this.setStatus(entry, name, {
        rows: parseStatusRows(output.value, 'status'),
        error: null,
        readAt: new Date(),
      });
    } catch (error) {
      const failure = toFailure(error);
      this.log.warn(
        `Couldn't read ${entry.snapshot.dir} on ${name}: ${failure.code ? `${failure.code}: ` : ''}${failure.message}`,
      );
      this.setStatus(entry, name, { rows: null, error: failure });
    } finally {
      this.setStatus(entry, name, { loading: false });
    }
  }

  /**
   * Read the project's config, sharing one read between environments. It is read with the
   * environment asking first, so a project whose only connection is a stored one still gets
   * its migrations folder from mmk 1.5's config bridge (which needs a connection string).
   */
  private async loadConfig(
    entry: Entry,
    name: string,
    connection: Connection | null,
  ): Promise<void> {
    if (!entry.configRead) {
      entry.configRead = (async () => {
        const { state } = entry.snapshot;
        if (state.kind !== 'ready') {
          return;
        }
        entry.configEnvironment = name;
        this.log.debug(`$ mmk config --json    (in ${entry.snapshot.dir})`);
        const { config, via } = await readProjectConfig(
          state.invocation,
          state.install.packageDir,
          {
            env: connectionEnv(connection),
            timeoutMs: this.configTimeoutMs,
            onStderrLine: (line) => this.log.mmkOutput(line, 'debug'),
          },
          this.readers,
        );
        if (via === 'library') {
          this.log.debug(
            "  This mmk has no `config` command, so the config came from mongo-migrate-kit's resolveConfig()",
          );
        }
        entry.configStale = false;
        this.update(entry, { config });
        const local = entry.slots.get(LOCAL_ENVIRONMENT);
        if (local && name === LOCAL_ENVIRONMENT) {
          local.status = { ...local.status, database: localDatabase(config) };
        }
      })().finally(() => {
        entry.configRead = null;
      });
    }
    await entry.configRead;
  }

  private setStatus(entry: Entry, name: string, changes: Partial<EnvironmentStatus>): void {
    const slot = entry.slots.get(name);
    if (!slot) {
      return;
    }
    slot.status = { ...slot.status, ...changes };
    this.rebuild(entry);
    this.emit();
  }

  /** Recompute the snapshot's per-environment view and the selected environment's shortcuts */
  private rebuild(entry: Entry): void {
    const environments: Record<string, EnvironmentStatus> = {};
    for (const [name, slot] of entry.slots) {
      environments[name] = slot.status;
    }
    const selected = environments[this.selectedName];
    entry.snapshot = {
      ...entry.snapshot,
      environments,
      rows: selected?.rows ?? null,
      error: selected?.error ?? null,
      loading: (selected?.loading ?? false) || entry.configRead !== null,
    };
  }

  private update(entry: Entry, changes: Partial<ProjectSnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...changes };
    this.rebuild(entry);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** The local database label from mmk's resolved config (its URI is already masked) */
function localDatabase(config: ProjectConfig): string | null {
  return config.uri ? hostLabel(config.uri, config.dbName) : null;
}

/** What to say when a project has no stored connection for an environment */
export function noConnectionMessage(environment: string, dir: string): string {
  return `There's no connection string for ${environment} in ${path.basename(dir)}. Run "mmk: Add environment…" or "mmk: Edit environment…" to set it.`;
}

/** Turn a thrown error into what the sidebar shows; mmk's message stays as is */
function toFailure(error: unknown): ReadFailure {
  if (error instanceof MmkCommandError) {
    return {
      message: error.message,
      ...(error.failure.code !== undefined ? { code: error.failure.code } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
