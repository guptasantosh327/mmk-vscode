import path from 'node:path';
import type { ConfigSummary, StatusRow } from 'mongo-migrate-kit';
import {
  type JsonOutput,
  MmkCommandError,
  type MmkInvocation,
  type RunOptions,
  describeCommand,
  runMmkJson,
} from './cli.js';
import { type Wire, parseConfigSummary, parseStatusRows } from './contract.js';
import type { Logger } from './log.js';
import type { ProjectState } from './project.js';

/** Why the last read of a project failed. `message` is mmk's own when mmk reported it */
export interface ReadFailure {
  message: string;
  code?: string;
}

/** What the extension knows about one project right now */
export interface ProjectSnapshot {
  /** The project's directory (mmk's cwd) */
  dir: string;
  /** Whether mmk can run here, and if not, why */
  state: ProjectState;
  /** `mmk config --json`, once read */
  config: Wire<ConfigSummary> | null;
  /** `mmk status --json` from the last successful read; null before one, or after a failure */
  rows: Wire<StatusRow>[] | null;
  /** The last read's failure, or null */
  error: ReadFailure | null;
  /** True while config or status is being read */
  loading: boolean;
  /** The command running in this project, e.g. `up 2026…-x.js`, or null */
  running: string | null;
}

/** A migration file and the project it belongs to */
export interface MigrationRef {
  project: ProjectSnapshot;
  /** The file name, as mmk names it in commands and status rows */
  file: string;
  /** Its status row, when the last read had one */
  row: Wire<StatusRow> | undefined;
}

/** Runs mmk; the real one is `runMmkJson`, tests pass a fake */
export type RunMmk = (
  invocation: MmkInvocation,
  args: readonly string[],
  options: RunOptions,
) => Promise<JsonOutput>;

/** Options for {@link MmkStore} */
export interface StoreOptions {
  log: Logger;
  run?: RunMmk;
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

interface Entry {
  snapshot: ProjectSnapshot;
  configStale: boolean;
  inflight: Promise<void> | null;
  queued: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The projects in the workspace and what mmk last said about each: its resolved config and its
 * status rows. Reads are coalesced (never two at once per project, and requests made during a
 * read get one more read after it) and file-change reads are debounced. It never computes a
 * status itself.
 */
export class MmkStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly runMmk: RunMmk;
  private readonly log: Logger;
  private readonly configTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly debounceMs: number;

  constructor(options: StoreOptions) {
    this.log = options.log;
    this.runMmk = options.run ?? runMmkJson;
    this.configTimeoutMs = options.configTimeoutMs ?? 30_000;
    this.statusTimeoutMs = options.statusTimeoutMs ?? 60_000;
    this.debounceMs = options.debounceMs ?? 300;
  }

  /** Replace the project list (after discovery), keeping what's known about projects that stay */
  setProjects(states: readonly ProjectState[]): void {
    const next = new Map<string, Entry>();
    for (const state of states) {
      const dir = state.root.dir;
      const existing = this.entries.get(dir);
      const entry: Entry = existing ?? {
        snapshot: {
          dir,
          state,
          config: null,
          rows: null,
          error: null,
          loading: false,
          running: null,
        },
        configStale: true,
        inflight: null,
        queued: null,
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
    }
    this.emit();
    for (const entry of this.entries.values()) {
      void this.request(entry);
    }
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
   * Read config and status again, now. Resolves when a read that started after this call has
   * finished. Without `dir`, refreshes every project.
   */
  async refresh(dir?: string, options: { reloadConfig?: boolean } = {}): Promise<void> {
    const targets = dir === undefined ? [...this.entries.values()] : [this.entries.get(dir)];
    await Promise.all(
      targets.map((entry) => {
        if (!entry) {
          return Promise.resolve();
        }
        if (options.reloadConfig) {
          entry.configStale = true;
        }
        return this.request(entry);
      }),
    );
  }

  /** Read again after file changes settle (debounced) */
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
      void this.request(entry);
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
   * Run an mmk command in a project, logging mmk's output, then read the status again. One
   * command at a time per project.
   * @throws {@link StoreError} when the project can't run mmk or is already running something
   * @throws the runner's errors (`MmkCommandError`, `MmkProcessError`) as they are
   */
  async run(dir: string, args: readonly string[], label: string): Promise<JsonOutput> {
    const entry = this.entries.get(dir);
    if (!entry) {
      throw new StoreError(`No mmk project at ${dir}. Refresh the mmk view and try again.`);
    }
    const { state } = entry.snapshot;
    if (state.kind !== 'ready') {
      throw new StoreError(state.message);
    }
    if (entry.snapshot.running) {
      throw new StoreError(
        `mmk is already running ${entry.snapshot.running} here. Wait for it to finish, then try again.`,
      );
    }
    this.update(entry, { running: label });
    this.log.info(`$ ${describeCommand([...args, '--json'])}    (in ${dir})`);
    try {
      return await this.runMmk(state.invocation, args, {
        onStderrLine: (line) => this.log.mmkOutput(line),
      });
    } finally {
      this.update(entry, { running: null });
      void this.request(entry);
    }
  }

  /** Resolves when no read is in flight or scheduled (for tests) */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.entries.values()].filter(
        (entry) => entry.inflight || entry.queued || entry.timer,
      );
      if (busy.length === 0) {
        return;
      }
      await Promise.all(
        busy.map((entry) => entry.queued ?? entry.inflight ?? delay(this.debounceMs)),
      );
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

  /** Start a read, or queue one more after the read in flight */
  private request(entry: Entry): Promise<void> {
    if (!entry.inflight) {
      entry.inflight = this.read(entry).finally(() => {
        entry.inflight = null;
      });
      return entry.inflight;
    }
    if (!entry.queued) {
      entry.queued = entry.inflight.then(() => {
        entry.queued = null;
        return this.request(entry);
      });
    }
    return entry.queued;
  }

  /** Read config (when stale) and status. Never throws: a failure is kept on the snapshot */
  private async read(entry: Entry): Promise<void> {
    const { state } = entry.snapshot;
    if (state.kind !== 'ready') {
      return;
    }
    this.update(entry, { loading: true });
    const debugLines = (line: string): void => this.log.mmkOutput(line, 'debug');
    try {
      if (entry.configStale || !entry.snapshot.config) {
        this.log.debug(`$ mmk config --json    (in ${entry.snapshot.dir})`);
        const output = await this.runMmk(state.invocation, ['config'], {
          timeoutMs: this.configTimeoutMs,
          onStderrLine: debugLines,
        });
        entry.configStale = false;
        this.update(entry, { config: parseConfigSummary(output.value) });
      }
      this.log.debug(`$ mmk status --json    (in ${entry.snapshot.dir})`);
      const output = await this.runMmk(state.invocation, ['status'], {
        timeoutMs: this.statusTimeoutMs,
        onStderrLine: debugLines,
      });
      this.update(entry, { rows: parseStatusRows(output.value, 'status'), error: null });
    } catch (error) {
      const failure = toFailure(error);
      this.log.warn(
        `Couldn't read ${entry.snapshot.dir}: ${failure.code ? `${failure.code}: ` : ''}${failure.message}`,
      );
      this.update(entry, { rows: null, error: failure });
    } finally {
      this.update(entry, { loading: false });
    }
  }

  private update(entry: Entry, changes: Partial<ProjectSnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...changes };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
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
