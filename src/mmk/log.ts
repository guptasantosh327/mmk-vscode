import { redactMongoUri } from './redact.js';

/**
 * Where log lines go. VS Code's `LogOutputChannel` satisfies this, and tests pass a plain
 * object, which keeps this module free of `vscode` imports.
 */
export interface LogSink {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The extension's logger: every line is masked before it reaches the sink */
export interface Logger extends LogSink {
  /** Log mmk's own human-readable output (its stderr in `--json` mode), line by line */
  mmkOutput(text: string): void;
}

/** Matches ANSI colour and cursor escape sequences */
// biome-ignore lint/suspicious/noControlCharactersInRegex: every ANSI escape starts with ESC
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * Create a logger that masks MongoDB credentials in every message before writing it to `sink`.
 * Nothing the extension logs should bypass this.
 */
export function createLogger(sink: LogSink): Logger {
  return {
    trace: (message) => sink.trace(redactMongoUri(message)),
    debug: (message) => sink.debug(redactMongoUri(message)),
    info: (message) => sink.info(redactMongoUri(message)),
    warn: (message) => sink.warn(redactMongoUri(message)),
    error: (message) => sink.error(redactMongoUri(message)),
    mmkOutput: (text) => {
      for (const line of text.replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
        if (line.trim() !== '') {
          sink.info(redactMongoUri(`  ${line}`));
        }
      }
    },
  };
}
