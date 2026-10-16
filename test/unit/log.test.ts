import { describe, expect, it } from 'vitest';
import { type LogSink, createLogger } from '../../src/mmk/log.js';

type Level = keyof LogSink;

/** A sink that records every call */
function recordingSink(): { sink: LogSink; lines: Array<[Level, string]> } {
  const lines: Array<[Level, string]> = [];
  const record =
    (level: Level) =>
    (message: string): void => {
      lines.push([level, message]);
    };
  return {
    lines,
    sink: {
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
}

describe('createLogger', () => {
  it('should mask credentials at every level before they reach the sink', () => {
    const { sink, lines } = recordingSink();
    const log = createLogger(sink);
    const uri = 'mongodb://alice:s3cret@db.example.com/app';

    log.trace(uri);
    log.debug(uri);
    log.info(uri);
    log.warn(uri);
    log.error(`failed: ${uri}`);

    expect(lines.map(([level]) => level)).toEqual(['trace', 'debug', 'info', 'warn', 'error']);
    for (const [, message] of lines) {
      expect(message).not.toContain('s3cret');
      expect(message).toContain('mongodb://***:***@db.example.com/app');
    }
  });

  it('should log mmk output one indented info line per non-blank line', () => {
    const { sink, lines } = recordingSink();
    createLogger(sink).mmkOutput('Loaded config\n\n   \r\n✔ Applied  a.js   [12ms]\r\n');

    expect(lines).toEqual([
      ['info', '  Loaded config'],
      ['info', '  ✔ Applied  a.js   [12ms]'],
    ]);
  });

  it('should strip colour codes and mask credentials in mmk output', () => {
    const { sink, lines } = recordingSink();
    createLogger(sink).mmkOutput('\u001b[31m✖ CONNECTION_FAILED: mongodb://u:pw@h\u001b[39m');

    expect(lines).toEqual([['info', '  ✖ CONNECTION_FAILED: mongodb://***:***@h']]);
  });
});
