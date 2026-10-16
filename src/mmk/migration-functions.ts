/** Where a migration file defines `up` and `down` (0-based line numbers) */
export interface MigrationFunctionLines {
  up: number | null;
  down: number | null;
}

/**
 * The ways a migration file defines `up` / `down`: ESM and TypeScript exports, CommonJS
 * `module.exports = { async up() {} }` methods and properties, and `exports.up = …`.
 */
const PATTERNS: readonly RegExp[] = [
  /^\s*export\s+(?:async\s+)?function\s*\*?\s*(up|down)\s*[(<]/,
  /^\s*export\s+(?:const|let|var)\s+(up|down)\s*[:=]/,
  /^\s*(?:module\.)?exports\.(up|down)\s*=/,
  /^\s*(up|down)\s*:\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:async\s+)?(up|down)\s*\([^)]*\)?\s*(?::[^{]*)?\{?\s*$/,
  /^\s*(?:async\s+)?(up|down)\s*\(.*\)\s*(?::[^{]*)?\{/,
];

/**
 * Find the lines where `up` and `down` are defined, so run links can sit above them. The first
 * definition of each wins. Only placement depends on this: what runs is always the whole file,
 * through mmk.
 */
export function findMigrationFunctions(text: string): MigrationFunctionLines {
  const found: MigrationFunctionLines = { up: null, down: null };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const pattern of PATTERNS) {
      const name = pattern.exec(line)?.[1];
      if ((name === 'up' || name === 'down') && found[name] === null) {
        found[name] = index;
        break;
      }
    }
    if (found.up !== null && found.down !== null) {
      break;
    }
  }
  return found;
}
