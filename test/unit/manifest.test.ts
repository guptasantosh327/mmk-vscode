import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_MMK_VERSION } from '../../src/mmk/compat.js';

const ROOT = path.resolve(__dirname, '../..');

interface Manifest {
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: Record<string, Array<{ command: string }>>;
    viewsWelcome: Array<{ when: string; contents: string }>;
  };
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;
const declared = manifest.contributes.commands.map((entry) => entry.command);

/** Every command ID the source registers with `registerCommand('mmk.…'` */
function registeredCommands(): string[] {
  const ids: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/registerCommand\(\s*'(mmk\.[\w.]+)'/g)) {
          ids.push(match[1] ?? '');
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return ids;
}

describe('package.json', () => {
  it('should declare exactly the commands the extension registers', () => {
    expect([...declared].sort()).toEqual([...registeredCommands()].sort());
  });

  it('should only put declared commands in menus', () => {
    for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
      for (const entry of entries) {
        expect(declared, `${menu} → ${entry.command}`).toContain(entry.command);
      }
    }
  });

  it('should name MIN_MMK_VERSION in the "too old" welcome text', () => {
    const tooOld = manifest.contributes.viewsWelcome.find((entry) =>
      entry.when.includes('too-old'),
    );
    expect(tooOld?.contents).toContain(`Update mongo-migrate-kit to ${MIN_MMK_VERSION} or later`);
  });

  it('should activate only where an mmk project can be', () => {
    expect(manifest.activationEvents).toEqual([
      'workspaceContains:**/mmk.config.{js,ts,json}',
      'workspaceContains:**/package.json',
    ]);
  });
});
