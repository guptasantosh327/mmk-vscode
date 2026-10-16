import { describe, expect, it } from 'vitest';
import {
  MIN_MMK_VERSION,
  type Version,
  checkCompat,
  compareVersions,
  parseVersion,
} from '../../src/mmk/compat.js';

function version(text: string): Version {
  const parsed = parseVersion(text);
  if (!parsed) {
    throw new Error(`Test setup: ${text} should parse`);
  }
  return parsed;
}

describe('parseVersion', () => {
  it('should parse a plain release', () => {
    expect(parseVersion('1.5.0')).toEqual({ major: 1, minor: 5, patch: 0, prerelease: [] });
  });

  it('should accept surrounding whitespace and a leading v', () => {
    expect(parseVersion('  v2.10.3\n')).toEqual({ major: 2, minor: 10, patch: 3, prerelease: [] });
  });

  it('should keep pre-release identifiers and ignore build metadata', () => {
    expect(parseVersion('1.6.0-beta.1+sha.abc')).toEqual({
      major: 1,
      minor: 6,
      patch: 0,
      prerelease: ['beta', '1'],
    });
  });

  it.each(['', '1.5', '1.5.0.0', 'one.two.three', 'error: unknown option', '1.5.0 extra'])(
    'should return null for %j',
    (text) => {
      expect(parseVersion(text)).toBeNull();
    },
  );
});

describe('compareVersions', () => {
  it.each([
    ['1.4.9', '1.5.0'],
    ['1.5.0', '1.5.1'],
    ['1.9.0', '1.10.0'],
    ['1.99.99', '2.0.0'],
    ['1.6.0-beta.1', '1.6.0'],
    ['1.6.0-alpha', '1.6.0-beta'],
    ['1.6.0-beta.2', '1.6.0-beta.10'],
    ['1.6.0-beta', '1.6.0-beta.1'],
    ['1.6.0-1', '1.6.0-alpha'],
  ])('should order %s before %s', (older, newer) => {
    expect(compareVersions(version(older), version(newer))).toBeLessThan(0);
    expect(compareVersions(version(newer), version(older))).toBeGreaterThan(0);
  });

  it('should treat equal versions as equal', () => {
    expect(compareVersions(version('1.5.0'), version('v1.5.0'))).toBe(0);
    expect(compareVersions(version('1.6.0-rc.1'), version('1.6.0-rc.1'))).toBe(0);
  });
});

describe('checkCompat', () => {
  it('should accept the minimum version itself', () => {
    expect(checkCompat(`${MIN_MMK_VERSION}\n`)).toEqual({ ok: true, version: MIN_MMK_VERSION });
  });

  it('should accept a newer version', () => {
    expect(checkCompat('3.0.0', '1.5.0')).toEqual({ ok: true, version: '3.0.0' });
  });

  it('should refuse an older version and say what to install', () => {
    const result = checkCompat('1.4.0', '1.5.0');

    expect(result.ok).toBe(false);
    expect(result.version).toBe('1.4.0');
    if (!result.ok) {
      expect(result.message).toContain('Update mongo-migrate-kit to 1.5.0 or later');
      expect(result.message).toContain('This project has 1.4.0');
      expect(result.message).toContain('npm install --save-dev mongo-migrate-kit@latest');
    }
  });

  it('should refuse a pre-release of the minimum version', () => {
    expect(checkCompat('1.5.0-beta.1', '1.5.0').ok).toBe(false);
  });

  it("should refuse mmk's unbundled development sentinel", () => {
    expect(checkCompat('0.0.0-dev', '1.5.0').ok).toBe(false);
  });

  it('should refuse output that is not a version and quote it', () => {
    const result = checkCompat("error: unknown option '--version'");

    expect(result).toMatchObject({ ok: false, version: null });
    if (!result.ok) {
      expect(result.message).toContain('"error: unknown option \'--version\'"');
    }
  });
});
