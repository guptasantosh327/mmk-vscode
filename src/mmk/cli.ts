import { execFile } from 'node:child_process';
import { type MmkFailure, parseErrorDocument } from './contract.js';
import { formatDuration } from './model.js';
import { redactMongoUri } from './redact.js';

/** How to run one project's mmk */
export interface MmkInvocation {
  /** The Node.js executable (see `resolveNode`) */
  nodePath: string;
  /** mmk's JavaScript entry point (see `locateMmk`) */
  script: string;
  /** The project directory: mmk discovers its config file and `.env` here */
  cwd: string;
}

/** Options for one mmk run */
export interface RunOptions {
  /**
   * Extra environment variables, merged over the extension host's environment. Connection
   * strings go here as `MMK_URI` / `MMK_DB`, never in the arguments.
   */
  env?: Readonly<Record<string, string>>;
  /** Stop mmk after this many milliseconds. Leave unset for commands that write */
  timeoutMs?: number;
  /** Stop mmk when this signal aborts */
  signal?: AbortSignal;
  /** Receives mmk's human-readable log (stderr) one line at a time, as it arrives */
  onStderrLine?: (line: string) => void;
}

/** The parsed result of a `--json` command that didn't report an error */
export interface JsonOutput {
  /** The JSON document mmk printed, not yet checked (see `contract.ts`) */
  value: unknown;
  /** 0, or 1 for `status --check` with pending migrations */
  exitCode: number;
  /** mmk's human-readable log */
  stderr: string;
  /**
   * Text printed to stdout before mmk's JSON, e.g. by a `console.log` in a migration or config
   * file. Empty when there was none.
   */
  otherStdout: string;
}

/** mmk ran and reported a failure in its error document. Show `message` as is */
export class MmkCommandError extends Error {
  readonly failure: MmkFailure;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(failure: MmkFailure, args: readonly string[], exitCode: number, stderr: string) {
    super(failure.message);
    this.name = 'MmkCommandError';
    this.failure = failure;
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Why mmk couldn't be run, or why its output couldn't be read */
export type MmkProcessFailure =
  | 'unsafe-argument'
  | 'spawn-failed'
  | 'timeout'
  | 'cancelled'
  | 'killed'
  | 'bad-output';

/** mmk couldn't be run, was stopped, or printed something other than one JSON document */
export class MmkProcessError extends Error {
  readonly kind: MmkProcessFailure;
  readonly stderr: string;

  constructor(kind: MmkProcessFailure, message: string, stderr = '') {
    super(redactMongoUri(message));
    this.name = 'MmkProcessError';
    this.kind = kind;
    this.stderr = stderr;
  }
}

/** Largest stdout or stderr accepted from one run */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Run `mmk <args> --json` and parse its JSON document.
 *
 * @throws {@link MmkCommandError} when mmk prints its error document (exit code 1)
 * @throws {@link MmkProcessError} when mmk can't start, times out, is cancelled, or prints no JSON
 */
export async function runMmkJson(
  invocation: MmkInvocation,
  args: readonly string[],
  options: RunOptions = {},
): Promise<JsonOutput> {
  const fullArgs = args.includes('--json') ? [...args] : [...args, '--json'];
  const raw = await execMmk(invocation, fullArgs, options);
  return toJsonOutput(raw, fullArgs, describeCommand(fullArgs));
}

/**
 * Run Node.js itself with `nodeArgs` in the project directory (for a script that uses the
 * project's own mongo-migrate-kit) and parse the one JSON document it prints, which follows
 * mmk's conventions, including its error document. `label` names it in messages.
 *
 * @throws {@link MmkCommandError} when the script prints an error document
 * @throws {@link MmkProcessError} when Node can't start, times out, or prints no JSON
 */
export async function runNodeJson(
  invocation: MmkInvocation,
  nodeArgs: readonly string[],
  label: string,
  options: RunOptions = {},
): Promise<JsonOutput> {
  const raw = await execNode(invocation, nodeArgs, options, label);
  return toJsonOutput(raw, [label], label);
}

/** Parse a run's stdout as one JSON document, throwing mmk's error document as an error */
function toJsonOutput(raw: RawOutput, args: readonly string[], command: string): JsonOutput {
  const parsed = parseJsonStdout(raw.stdout);
  if (!parsed) {
    throw new MmkProcessError(
      'bad-output',
      `${command} exited with code ${raw.exitCode} without printing JSON.${lastLines(raw.stderr)}`,
      raw.stderr,
    );
  }
  const failure = parseErrorDocument(parsed.value);
  if (failure) {
    throw new MmkCommandError(failure, args, raw.exitCode, raw.stderr);
  }
  return {
    value: parsed.value,
    exitCode: raw.exitCode,
    stderr: raw.stderr,
    otherStdout: parsed.other,
  };
}

/**
 * Run `mmk --version` and return what it printed, e.g. `1.5.0`. It loads no config and never
 * connects, so it is quick and safe to run on activation.
 */
export async function runMmkVersion(
  invocation: MmkInvocation,
  options: RunOptions = {},
): Promise<string> {
  const raw = await execMmk(invocation, ['--version'], options);
  if (raw.exitCode !== 0) {
    throw new MmkProcessError(
      'bad-output',
      `mmk --version exited with code ${raw.exitCode}.${lastLines(raw.stderr)}`,
      raw.stderr,
    );
  }
  return raw.stdout.trim();
}

/**
 * The command a user would type for these arguments, e.g. `mmk create 'add users'`.
 * Arguments that a shell would split or expand are single-quoted.
 */
export function describeCommand(args: readonly string[]): string {
  return ['mmk', ...args.map(quoteArgument)].join(' ');
}

/**
 * What to type in a terminal at the workspace folder to run these arguments the way the
 * extension does: `npx mmk up x.js`, preceded by `cd <folder> &&` when the project is in a
 * subfolder (`relativeDir`, empty for the workspace folder itself).
 */
export function terminalCommand(args: readonly string[], relativeDir: string): string {
  const command = `npx ${describeCommand(args)}`;
  return relativeDir === '' ? command : `cd ${quoteArgument(relativeDir)} && ${command}`;
}

/**
 * Parse mmk's stdout. mmk prints one JSON document, last; anything printed before it came from
 * user code (a `console.log` in a migration, hook or config function), which mmk doesn't
 * redirect. Returns null when there is no JSON document at the end.
 */
export function parseJsonStdout(stdout: string): { value: unknown; other: string } | null {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    return { value: JSON.parse(trimmed), other: '' };
  } catch {
    // Fall through: look for the last document that starts at the beginning of a line.
  }
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        const value: unknown = JSON.parse(lines.slice(index).join('\n'));
        return { value, other: lines.slice(0, index).join('\n').trim() };
      } catch {
        // Not the start of the document; keep looking further up.
      }
    }
  }
  return null;
}

/** Raw result of one mmk process */
interface RawOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run mmk with `execFile` (never a shell) and collect its output */
function execMmk(
  invocation: MmkInvocation,
  args: readonly string[],
  options: RunOptions,
): Promise<RawOutput> {
  assertSafeArguments(args);
  return execNode(invocation, [invocation.script, ...args], options, describeCommand(args));
}

/** Run Node.js with `nodeArgs` in the project directory and collect its output */
function execNode(
  invocation: MmkInvocation,
  nodeArgs: readonly string[],
  options: RunOptions,
  command: string,
): Promise<RawOutput> {
  return new Promise((resolve, reject) => {
    const lines = options.onStderrLine ? lineSplitter(options.onStderrLine) : undefined;
    const child = execFile(
      invocation.nodePath,
      [...nodeArgs],
      {
        cwd: invocation.cwd,
        env: { ...process.env, ...options.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? 0,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        lines?.flush();
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        if (error.name === 'AbortError' || options.signal?.aborted) {
          reject(new MmkProcessError('cancelled', `${command} was cancelled.`, stderr));
          return;
        }
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(
            new MmkProcessError(
              'bad-output',
              `${command} printed more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB, so it was stopped.`,
              stderr,
            ),
          );
          return;
        }
        if (typeof error.code === 'string') {
          reject(
            new MmkProcessError(
              'spawn-failed',
              `Couldn't start ${invocation.nodePath} to run mmk: ${error.message}. Check the "mmk.nodePath" setting, or that node is on PATH.`,
              stderr,
            ),
          );
          return;
        }
        if (error.killed && options.timeoutMs !== undefined) {
          reject(
            new MmkProcessError(
              'timeout',
              `${command} didn't finish within ${formatDuration(options.timeoutMs)}, so it was stopped. Check that the database is reachable, then try again.${lastLines(stderr)}`,
              stderr,
            ),
          );
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }
        reject(
          new MmkProcessError(
            'killed',
            `${command} was stopped by ${error.signal ?? 'a signal'} before it finished.${lastLines(stderr)}`,
            stderr,
          ),
        );
      },
    );
    if (lines) {
      child.stderr?.on('data', (chunk: unknown) => lines.push(String(chunk)));
    }
  });
}

/**
 * True when mmk refused `command` because this version doesn't have it (commander's
 * `unknown command '<name>'`). The way to tell an older mmk from a newer one without guessing
 * from its version number.
 */
export function isUnknownCommand(error: unknown, command: string): boolean {
  return (
    error instanceof MmkProcessError &&
    error.kind === 'bad-output' &&
    error.stderr.includes(`unknown command '${command}'`)
  );
}

/**
 * Refuse arguments that would put a connection string on the command line, where every user
 * on the machine can read it (`ps`). Connection strings go in `MMK_URI` instead.
 */
function assertSafeArguments(args: readonly string[]): void {
  if (args.some((arg) => arg === '--uri' || arg.startsWith('--uri='))) {
    throw new MmkProcessError(
      'unsafe-argument',
      'Refused to pass --uri to mmk: arguments are visible to other users on this machine. The connection string goes in the MMK_URI environment variable instead.',
    );
  }
}

/** Buffers chunks and calls `onLine` once per complete line */
function lineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let pending = '';
  return {
    push: (chunk) => {
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        onLine(part);
      }
    },
    flush: () => {
      if (pending !== '') {
        onLine(pending);
        pending = '';
      }
    },
  };
}

/** The last few lines of mmk's log, for an error message */
function lastLines(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? '' : ` mmk said: ${lines.slice(-3).join(' / ')}`;
}

/** Quote an argument the way a POSIX shell needs it, only when it needs it */
function quoteArgument(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
