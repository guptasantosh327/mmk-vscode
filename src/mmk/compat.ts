/**
 * The oldest mongo-migrate-kit whose `--json` output this extension reads. It is the version the
 * contract tests pin: an older mmk's output shape is never guessed at. Raise it when the
 * extension starts depending on a newer mmk (see docs/MMK-REQUESTS.md).
 */
export const MIN_MMK_VERSION = '1.5.0';

/** A parsed semantic version */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers, e.g. `['beta', '1']` for `1.6.0-beta.1` */
  prerelease: string[];
}

/** Whether a project's mmk can be used, and if not, what to tell the user */
export type CompatResult =
  | { ok: true; version: string }
  | { ok: false; version: string | null; message: string };

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `1.5.0`, `v1.5.0` or `1.6.0-beta.1`; null for anything else */
export function parseVersion(text: string): Version | null {
  const match = VERSION_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Compare two versions by semver precedence: negative when `a` is older, 0 when equal */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) {
      return a[key] - b[key];
    }
  }
  // A release is newer than any of its pre-releases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1;
    }
    if (left !== right) {
      return comparePrereleaseIdentifier(left, right);
    }
  }
  return 0;
}

/**
 * Decide whether the mmk that printed `versionOutput` (from `mmk --version`) is new enough.
 * The message says what is installed and what to install instead.
 */
export function checkCompat(
  versionOutput: string,
  minimum: string = MIN_MMK_VERSION,
): CompatResult {
  const text = versionOutput.trim();
  const version = parseVersion(text);
  const min = parseVersion(minimum);
  if (!version || !min) {
    return {
      ok: false,
      version: null,
      message: `Couldn't read this project's mongo-migrate-kit version: \`mmk --version\` printed ${JSON.stringify(text.slice(0, 80))}, not a version like ${minimum}. Reinstall it: npm install --save-dev mongo-migrate-kit@latest`,
    };
  }
  if (compareVersions(version, min) < 0) {
    return {
      ok: false,
      version: text,
      message: `Update mongo-migrate-kit to ${minimum} or later. This project has ${text}, and the extension only reads the output of ${minimum} or later. Run: npm install --save-dev mongo-migrate-kit@latest`,
    };
  }
  return { ok: true, version: text };
}

/** Numeric identifiers compare as numbers and sort before alphanumeric ones */
function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left < right ? -1 : 1;
}
