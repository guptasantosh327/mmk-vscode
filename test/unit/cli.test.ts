import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MmkCommandError,
  type MmkInvocation,
  MmkProcessError,
  describeCommand,
  parseJsonStdout,
  runMmkJson,
  runMmkVersion,
} from '../../src/mmk/cli.js';
import { makeTree, removeTree } from './helpers/tmp.js';

/**
 * A stand-in for mmk. FAKE_MMK_MODE picks what it does, which also proves that `env` reaches
 * the process.
 */
const FAKE_MMK = `
const mode = process.env.FAKE_MMK_MODE;
const json = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\\n');
switch (mode) {
  case 'echo':
    json({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      uri: process.env.MMK_URI ?? null,
      forceColor: process.env.FORCE_COLOR ?? null,
    });
    break;
  case 'error':
    json({ error: { code: 'NOT_APPLIED', message: 'Nothing to roll back', details: { applied: [] } } });
    process.exitCode = 1;
    break;
  case 'no-json':
    process.stderr.write("error: unknown option '--json'\\n(run \`mmk --help\` for usage)\\n");
    process.exitCode = 1;
    break;
  case 'noise':
    console.log('Backfilling 3 users…');
    console.log({ done: 3 });
    json([{ file: 'a.js', status: 'applied', duration: 5, batch: 1 }]);
    break;
  case 'check':
    json([]);
    process.exitCode = 1;
    break;
  case 'stderr':
    process.stderr.write('Loaded config from mmk.config.js\\nApply');
    setTimeout(() => {
      process.stderr.write('ing a.js\\nlast line without newline');
      json([]);
    }, 50);
    break;
  case 'slow':
    setTimeout(() => json([]), 30000);
    break;
  case 'version':
    process.stdout.write('1.5.0\\n');
    break;
  case 'version-fails':
    process.stderr.write('boom\\n');
    process.exitCode = 2;
    break;
  case 'leak':
    process.stderr.write('Connecting to mongodb://alice:s3cret@db.example.com\\n');
    process.kill(process.pid, 'SIGKILL');
    break;
  default:
    process.stderr.write('unknown mode ' + mode + '\\n');
    process.exitCode = 3;
}
`;

let root: string;
let invocation: MmkInvocation;

beforeAll(() => {
  root = makeTree({ 'fake-mmk.cjs': FAKE_MMK, 'project/.keep': '' });
  invocation = {
    nodePath: process.execPath,
    script: path.join(root, 'fake-mmk.cjs'),
    cwd: path.join(root, 'project'),
  };
});

afterAll(() => {
  removeTree(root);
});

function mode(name: string): { FAKE_MMK_MODE: string } {
  return { FAKE_MMK_MODE: name };
}

describe('runMmkJson', () => {
  it('should run the script with Node in the project directory and append --json', async () => {
    const output = await runMmkJson(invocation, ['status'], { env: mode('echo') });

    expect(output.exitCode).toBe(0);
    expect(output.otherStdout).toBe('');
    expect(output.value).toMatchObject({
      args: ['status', '--json'],
      cwd: invocation.cwd,
      forceColor: '0',
    });
  });

  it('should not add a second --json', async () => {
    const output = await runMmkJson(invocation, ['list', '--json', '--pending'], {
      env: mode('echo'),
    });

    expect(output.value).toMatchObject({ args: ['list', '--json', '--pending'] });
  });

  it('should pass MMK_URI through the environment', async () => {
    const output = await runMmkJson(invocation, ['status'], {
      env: { ...mode('echo'), MMK_URI: 'mongodb://localhost:27017' },
    });

    expect(output.value).toMatchObject({ uri: 'mongodb://localhost:27017' });
  });

  it("should throw mmk's error document as an MmkCommandError with its message as is", async () => {
    const run = runMmkJson(invocation, ['down', 'a.js'], { env: mode('error') });

    await expect(run).rejects.toBeInstanceOf(MmkCommandError);
    await expect(run).rejects.toMatchObject({
      message: 'Nothing to roll back',
      exitCode: 1,
      args: ['down', 'a.js', '--json'],
      failure: { code: 'NOT_APPLIED', message: 'Nothing to roll back', details: { applied: [] } },
    });
  });

  it('should return a non-error document even when mmk exits with code 1', async () => {
    const output = await runMmkJson(invocation, ['status', '--check'], { env: mode('check') });

    expect(output).toMatchObject({ value: [], exitCode: 1 });
  });

  it('should report a run that printed no JSON, quoting the end of its log', async () => {
    const run = runMmkJson(invocation, ['status'], { env: mode('no-json') });

    await expect(run).rejects.toBeInstanceOf(MmkProcessError);
    await expect(run).rejects.toMatchObject({
      kind: 'bad-output',
      message:
        "mmk status --json exited with code 1 without printing JSON. mmk said: error: unknown option '--json' / (run `mmk --help` for usage)",
    });
  });

  it('should read the JSON after console.log output from user code, and return that output', async () => {
    const output = await runMmkJson(invocation, ['up'], { env: mode('noise') });

    expect(output.value).toEqual([{ file: 'a.js', status: 'applied', duration: 5, batch: 1 }]);
    expect(output.otherStdout).toBe('Backfilling 3 users…\n{ done: 3 }');
  });

  it('should stream stderr to onStderrLine one whole line at a time', async () => {
    const lines: string[] = [];
    const output = await runMmkJson(invocation, ['up'], {
      env: mode('stderr'),
      onStderrLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      'Loaded config from mmk.config.js',
      'Applying a.js',
      'last line without newline',
    ]);
    expect(output.stderr).toBe(
      'Loaded config from mmk.config.js\nApplying a.js\nlast line without newline',
    );
  });

  it('should stop mmk after the timeout and say so', async () => {
    const started = Date.now();
    const run = runMmkJson(invocation, ['status'], { env: mode('slow'), timeoutMs: 300 });

    await expect(run).rejects.toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining(
        "mmk status --json didn't finish within 300 ms, so it was stopped.",
      ),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('should stop mmk when the signal aborts', async () => {
    const controller = new AbortController();
    const run = runMmkJson(invocation, ['up'], { env: mode('slow'), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    await expect(run).rejects.toMatchObject({
      kind: 'cancelled',
      message: 'mmk up --json was cancelled.',
    });
  });

  it('should report a Node executable that cannot be started', async () => {
    const missing = { ...invocation, nodePath: path.join(root, 'no-such-node') };

    await expect(runMmkJson(missing, ['status'], { env: mode('echo') })).rejects.toMatchObject({
      kind: 'spawn-failed',
      message: expect.stringContaining(`Couldn't start ${missing.nodePath} to run mmk`),
    });
  });

  it('should mask credentials in the message when mmk is killed', async () => {
    const run = runMmkJson(invocation, ['status'], { env: mode('leak') });

    await expect(run).rejects.toMatchObject({ kind: 'killed' });
    await expect(run).rejects.toSatisfy(
      (error: Error) =>
        !error.message.includes('s3cret') && error.message.includes('mongodb://***:***@'),
    );
  });

  it.each([['--uri'], ['--uri=mongodb://alice:s3cret@host']])(
    'should refuse to put a connection string in the arguments (%s)',
    async (arg) => {
      const run = runMmkJson(invocation, ['status', arg, 'mongodb://h'], { env: mode('echo') });

      await expect(run).rejects.toMatchObject({ kind: 'unsafe-argument' });
      await expect(run).rejects.toSatisfy((error: Error) => !error.message.includes('s3cret'));
    },
  );
});

describe('runMmkVersion', () => {
  it('should return the printed version without the newline', async () => {
    await expect(runMmkVersion(invocation, { env: mode('version') })).resolves.toBe('1.5.0');
  });

  it('should report a failing --version', async () => {
    await expect(runMmkVersion(invocation, { env: mode('version-fails') })).rejects.toMatchObject({
      kind: 'bad-output',
      message: 'mmk --version exited with code 2. mmk said: boom',
    });
  });
});

describe('parseJsonStdout', () => {
  it('should return null for empty output', () => {
    expect(parseJsonStdout('  \n')).toBeNull();
  });

  it('should return null when no line starts a JSON document', () => {
    expect(parseJsonStdout('hello\nworld\n')).toBeNull();
  });

  it('should skip a console.log line that looks like JSON but is not', () => {
    expect(parseJsonStdout('[progress] 50%\n{\n  "path": "/x.js"\n}\n')).toEqual({
      value: { path: '/x.js' },
      other: '[progress] 50%',
    });
  });

  it('should parse an empty array printed after other output', () => {
    expect(parseJsonStdout('note\n[]\n')).toEqual({ value: [], other: 'note' });
  });
});

describe('describeCommand', () => {
  it('should print simple arguments as they are', () => {
    expect(describeCommand(['down', '20260101000000-a.js', '--json'])).toBe(
      'mmk down 20260101000000-a.js --json',
    );
  });

  it('should quote arguments a shell would split or expand', () => {
    expect(describeCommand(['create', "add users' index"])).toBe(
      "mmk create 'add users'\\'' index'",
    );
    expect(describeCommand(['create', '$HOME'])).toBe("mmk create '$HOME'");
  });
});
