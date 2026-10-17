import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bufferChecksum, checksumOfBytes, startsWithBom } from '../../src/mmk/checksum.js';
import { parseStatusRows } from '../../src/mmk/contract.js';
import { type ContractProject, createProject, hasNextMmk } from './harness.js';

/**
 * The extension hashes unsaved editor text to warn about edits to applied migrations (CLAUDE.md
 * rule 1, exception 1). These tests prove the hash equals the checksum the real mmk records, for
 * the files where it's easy to get wrong: CRLF line endings and a UTF-8 BOM.
 */

const DB = 'contract_checksum';
const BODY = 'module.exports = {\n  async up() {},\n  async down() {},\n};\n';
const FILES = {
  '20260201000000-lf.js': BODY,
  '20260202000000-crlf.js': BODY.replace(/\n/g, '\r\n'),
  '20260203000000-bom.js': `﻿${BODY}`,
  '20260204000000-bom-crlf.js': `﻿${BODY.replace(/\n/g, '\r\n')}`,
  '20260205000000-unicode.js': `// Größe → 尺寸 ✓\n${BODY}`,
};

let mongo: MongoMemoryServer;
let client: MongoClient;
let project: ContractProject;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  project = await createProject(mongo, DB);
  for (const [file, source] of Object.entries(FILES)) {
    project.addMigration(file, source);
  }
  await project.run(['up']);
});

afterAll(async () => {
  project?.cleanup();
  await client?.close();
  await mongo?.stop();
});

/** The checksum mmk wrote in its changelog for `file` */
async function recorded(file: string): Promise<string | undefined> {
  const record = await client.db(DB).collection('_mmk_migrations').findOne({ name: file });
  return typeof record?.checksum === 'string' ? record.checksum : undefined;
}

/** The text VS Code gives for a file: decoded as UTF-8, BOM dropped, line endings kept */
function editorText(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.startsWith('﻿') ? text.slice(1) : text;
}

describe("the extension's checksum equals mmk's", () => {
  it.each(Object.keys(FILES))('%s: unsaved editor text', async (file) => {
    const bytes = readFileSync(path.join(project.migrationsDir, file));

    expect(bufferChecksum(editorText(bytes), startsWithBom(bytes))).toBe(await recorded(file));
  });

  it.each(Object.keys(FILES))('%s: the file on disk', async (file) => {
    const bytes = readFileSync(path.join(project.migrationsDir, file));

    expect(checksumOfBytes(bytes)).toBe(await recorded(file));
  });

  it('notices a CRLF file saved with LF, and a BOM dropped', async () => {
    const crlf = '20260202000000-crlf.js';
    const bom = '20260203000000-bom.js';

    expect(bufferChecksum(BODY, false)).not.toBe(await recorded(crlf));
    expect(bufferChecksum(BODY, false)).not.toBe(await recorded(bom));
  });

  it.runIf(hasNextMmk())("is what status --json reports as each row's checksum (R5)", async () => {
    const rows = parseStatusRows((await project.run(['status'])).value, 'status');

    for (const file of Object.keys(FILES)) {
      const bytes = readFileSync(path.join(project.migrationsDir, file));
      expect(rows.find((row) => row.file === file)?.checksum).toBe(
        bufferChecksum(editorText(bytes), startsWithBom(bytes)),
      );
    }
  });
});
