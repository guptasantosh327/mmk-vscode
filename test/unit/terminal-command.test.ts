import { describe, expect, it } from 'vitest';
import { terminalCommand } from '../../src/mmk/cli.js';
import { type LogSink, createLogger } from '../../src/mmk/log.js';

describe('terminalCommand', () => {
  it('should run through npx at the workspace folder', () => {
    expect(terminalCommand(['up', '20261016101502-add-refunds.js'], '')).toBe(
      'npx mmk up 20261016101502-add-refunds.js',
    );
  });

  it('should cd into a project in a subfolder first', () => {
    expect(terminalCommand(['status'], 'apps/billing api')).toBe(
      "cd 'apps/billing api' && npx mmk status",
    );
  });

  it('should quote a name a shell would split', () => {
    expect(terminalCommand(['create', 'add refunds'], 'apps/api')).toBe(
      "cd apps/api && npx mmk create 'add refunds'",
    );
  });
});

describe('Logger.mmkOutput level', () => {
  it('should log background reads at debug level', () => {
    const lines: string[] = [];
    const sink: LogSink = {
      trace: () => {},
      debug: (message) => lines.push(`debug ${message}`),
      info: (message) => lines.push(`info ${message}`),
      warn: () => {},
      error: () => {},
    };
    const log = createLogger(sink);
    log.mmkOutput('Loaded config from mmk.config.js', 'debug');
    log.mmkOutput('✔ Applied a.js');

    expect(lines).toEqual(['debug   Loaded config from mmk.config.js', 'info   ✔ Applied a.js']);
  });
});
