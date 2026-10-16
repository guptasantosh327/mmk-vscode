import { describe, expect, it } from 'vitest';
import { findMigrationFunctions } from '../../src/mmk/migration-functions.js';

describe('findMigrationFunctions', () => {
  it('should find ESM function exports', () => {
    const text = [
      "export const description = 'x';",
      '',
      'export async function up({ db }) {',
      "  await db.createCollection('a');",
      '}',
      '',
      'export async function down({ db }) {',
      "  await db.collection('a').drop();",
      '}',
    ].join('\n');
    expect(findMigrationFunctions(text)).toEqual({ up: 2, down: 6 });
  });

  it('should find TypeScript exports with type annotations', () => {
    const text = [
      "import type { MigrationContext } from 'mongo-migrate-kit';",
      'export async function up({ db }: MigrationContext): Promise<void> {',
      '}',
      'export const down = async ({ db }: MigrationContext): Promise<void> => {};',
    ].join('\n');
    expect(findMigrationFunctions(text)).toEqual({ up: 1, down: 3 });
  });

  it('should find CommonJS methods in module.exports', () => {
    const text = [
      'module.exports = {',
      "  description: 'x',",
      '  async up({ db }) {',
      '  },',
      '  async down({ db }) {',
      '  },',
      '};',
    ].join('\n');
    expect(findMigrationFunctions(text)).toEqual({ up: 2, down: 4 });
  });

  it('should find properties, exports.up and multi-line parameters', () => {
    const text = [
      'module.exports = {',
      '  up: async ({ db }) => {},',
      '};',
      'exports.down = async function (ctx) {};',
      'const other = {',
      '  async up(',
      '    ctx,',
      '  ) {},',
      '};',
    ].join('\n');
    expect(findMigrationFunctions(text)).toEqual({ up: 1, down: 3 });
  });

  it('should not mistake a call for a definition', () => {
    const text = ['async function helper() {', '  await up(ctx);', '  down(ctx);', '}'].join('\n');
    expect(findMigrationFunctions(text)).toEqual({ up: null, down: null });
  });

  it('should handle CRLF line endings and missing functions', () => {
    expect(findMigrationFunctions('// nothing\r\nexport async function up() {}\r\n')).toEqual({
      up: 1,
      down: null,
    });
  });
});
