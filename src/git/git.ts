import { execFile } from 'node:child_process';

/** git ran and exited with an error; `message` has git's own words */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string, fallback: string) {
    const said = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
    super(said ? `git ${args[0] ?? ''}: ${said}` : fallback);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

/** Options for {@link runGit} */
export interface GitOptions {
  /** Written to git's stdin, then stdin is closed */
  input?: string;
  /** Stop git after this many milliseconds. Default: 30 s */
  timeoutMs?: number;
}

/**
 * Run `git <args>` in `cwd` with `execFile` (never a shell) and return its stdout as bytes, so
 * file contents come back exactly as committed.
 * @throws {@link GitError} when git exits with an error or can't be started
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message =
            typeof error.code === 'string'
              ? `Couldn't run git: ${error.message}. Install git, or put it on PATH.`
              : `git ${args.join(' ')} failed`;
          reject(new GitError(args, stderr.toString('utf8'), message));
          return;
        }
        resolve(stdout);
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** {@link runGit}, with stdout as trimmed text */
export async function gitText(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return (await runGit(cwd, args, options)).toString('utf8').trim();
}
