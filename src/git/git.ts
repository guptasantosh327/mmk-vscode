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

/**
 * Read many objects in one `git cat-file --batch`: each name is a SHA or `<rev>:<path>`. Returns
 * their bytes in order, or null for one git doesn't have (e.g. a path a commit deleted).
 * @throws {@link GitError} when git fails or prints something unexpected
 */
export async function readObjects(
  cwd: string,
  names: readonly string[],
): Promise<Array<Buffer | null>> {
  if (names.length === 0) {
    return [];
  }
  if (names.some((name) => /[\r\n]/.test(name))) {
    throw new GitError(
      ['cat-file'],
      '',
      "A path with a line break can't be read with git cat-file.",
    );
  }
  const output = await runGit(cwd, ['cat-file', '--batch'], { input: `${names.join('\n')}\n` });
  const contents: Array<Buffer | null> = [];
  let offset = 0;
  while (offset < output.length && contents.length < names.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) {
      break;
    }
    const header = output.subarray(offset, newline).toString('utf8');
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      contents.push(null);
      offset = newline + 1;
      continue;
    }
    const size = Number(/^[0-9a-f]+ \w+ (\d+)$/.exec(header)?.[1]);
    if (!Number.isInteger(size)) {
      throw new GitError(['cat-file'], '', `Unexpected git cat-file output: ${header}`);
    }
    contents.push(output.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
  if (contents.length !== names.length) {
    throw new GitError(['cat-file'], '', 'git cat-file returned fewer objects than asked for.');
  }
  return contents;
}
