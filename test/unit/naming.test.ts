import { describe, expect, it } from 'vitest';
import { displayName, previewFileName, slugify } from '../../src/mmk/naming.js';

describe('slugify', () => {
  it.each([
    ['add refunds collection', 'add-refunds-collection'],
    ['  Add Users Index  ', 'add-users-index'],
    ['backfill: orders → v2!!', 'backfill-orders-v2'],
    ['already-slugged_name', 'already-slugged-name'],
    ['---', ''],
    ['日本語', ''],
    ['', ''],
  ])('should turn %j into %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe('previewFileName', () => {
  it('should show a timestamp placeholder and the extension', () => {
    expect(previewFileName('Add refunds', { sequential: false, extension: 'js' })).toBe(
      '<timestamp>-add-refunds.js',
    );
  });

  it('should show a number placeholder for sequential naming', () => {
    expect(previewFileName('add refunds', { sequential: true, extension: 'ts' })).toBe(
      '<number>-add-refunds.ts',
    );
  });

  it('should return null when the name has no letters or digits', () => {
    expect(previewFileName(' -- ', { sequential: false, extension: 'js' })).toBeNull();
  });
});

describe('displayName', () => {
  it('should drop a timestamp prefix and read its date', () => {
    expect(displayName('20261016101502-add-refunds-collection.js')).toEqual({
      label: 'add-refunds-collection.js',
      date: new Date(2026, 9, 16, 10, 15, 2),
    });
  });

  it('should drop a sequence number without inventing a date', () => {
    expect(displayName('0003-add-index.ts')).toEqual({ label: 'add-index.ts', date: null });
  });

  it('should leave other names as they are', () => {
    expect(displayName('seed-users.js')).toEqual({ label: 'seed-users.js', date: null });
  });
});
