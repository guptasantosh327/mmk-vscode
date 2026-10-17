import path from 'node:path';
import type { RollbackFailure, RollbackStep, RollbackTestReport } from './contract.js';

/** The steps of a rollback test, in the order they run */
export const ROLLBACK_STEPS: readonly RollbackStep[] = ['up', 'down', 'up-again'];

/** `up`, `down`, `up again`: how a step is labelled in Test Explorer */
export function stepLabel(step: RollbackStep): string {
  return step === 'up-again' ? 'up again' : step;
}

/** One step's outcome; `skipped` when it didn't run because an earlier one failed */
export interface StepOutcome {
  step: RollbackStep;
  status: 'passed' | 'failed' | 'skipped';
  duration?: number;
}

/** Where mmk says a migration threw: an absolute file and a 1-based line and column */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** One file's outcome, ready for Test Explorer */
export interface FileOutcome {
  file: string;
  status: 'passed' | 'failed' | 'skipped' | 'errored';
  /** Every step, including those that didn't run */
  steps: StepOutcome[];
  /** Total time of the steps that ran */
  duration: number;
  /** Why it failed or was skipped: the title line, then mmk's own message */
  failure?: {
    step: RollbackStep | null;
    title: string;
    message: string;
    location: SourceLocation | null;
  };
}

/**
 * Read mmk's `location` (`path:line:column`, as V8 prints a stack frame). Paths can hold
 * colons (Windows drives), so the numbers are taken from the end.
 */
export function parseLocation(location: string | undefined): SourceLocation | null {
  if (!location) {
    return null;
  }
  const match = /^(.*):(\d+):(\d+)$/.exec(location.trim());
  if (!match?.[1]) {
    return null;
  }
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
}

/** True when a location is in `file` (compared as resolved paths) */
export function isInFile(location: SourceLocation, file: string): boolean {
  return path.resolve(location.file) === path.resolve(file);
}

function failureOf(
  error: RollbackFailure | undefined,
  step: RollbackStep | null,
  title: string,
): NonNullable<FileOutcome['failure']> {
  return {
    step,
    title,
    message: error?.message ?? title,
    location: parseLocation(error?.location),
  };
}

/**
 * Each tested file's outcome from mmk's report. A file applied first (setup) that failed makes
 * the file being tested errored, with that file's error.
 */
export function rollbackOutcomes(report: RollbackTestReport): FileOutcome[] {
  const setupFailure = report.setup.find((setup) => setup.status === 'failed');
  return report.results.map((result): FileOutcome => {
    const ran = new Map(result.steps.map((step) => [step.step, step]));
    const steps = ROLLBACK_STEPS.map((step): StepOutcome => {
      const outcome = ran.get(step);
      return outcome
        ? { step, status: outcome.status, duration: outcome.duration }
        : { step, status: 'skipped' };
    });
    const duration = result.steps.reduce((sum, step) => sum + step.duration, 0);
    if (result.status === 'failed') {
      const step = result.failedStep ?? null;
      return {
        file: result.file,
        status: 'failed',
        steps,
        duration,
        failure: failureOf(
          result.error,
          step,
          step
            ? `rollback test failed in ${step === 'up-again' ? 'up() again' : `${step}()`}`
            : 'rollback test failed',
        ),
      };
    }
    if (result.status === 'skipped' && setupFailure) {
      return {
        file: result.file,
        status: 'errored',
        steps,
        duration,
        failure: failureOf(
          setupFailure.error,
          null,
          `${setupFailure.file} runs before it and failed to apply, so this wasn't tested`,
        ),
      };
    }
    if (result.status === 'skipped') {
      return {
        file: result.file,
        status: 'skipped',
        steps,
        duration,
        failure: {
          step: null,
          title: result.reason ?? 'Not run',
          message: result.reason ?? 'Not run',
          location: null,
        },
      };
    }
    return { file: result.file, status: 'passed', steps, duration };
  });
}

/**
 * The summary for the Test Results panel (design A4): "2 passed · 1 failed · on a temporary
 * database (orders_dev_mmk_rollback_…), dropped after the run; orders_dev was not touched".
 */
export function rollbackSummary(report: RollbackTestReport): string {
  const counts = [
    `${report.passed} passed`,
    ...(report.failed > 0 ? [`${report.failed} failed`] : []),
    ...(report.skipped > 0 ? [`${report.skipped} skipped`] : []),
  ].join(' · ');
  const where = report.dropped
    ? `on a temporary database (${report.database}), dropped after the run`
    : `on a temporary database (${report.database}), which mmk couldn't drop: drop it by hand`;
  return `${counts} · ${where}; ${report.configuredDatabase} was not touched`;
}
