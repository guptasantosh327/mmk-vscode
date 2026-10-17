import { createHash } from 'node:crypto';

/**
 * mmk's checksum (`computeChecksum` in mongo-migrate-kit's `src/utils/checksum.ts`): the SHA-256
 * hex digest of the file read as UTF-8 text. This is the first documented exception to "never
 * re-implement mmk" (CLAUDE.md rule 1): it hashes an **unsaved editor buffer**, which mmk can't
 * see. `test/contract/checksum.contract.test.ts` proves it equals what mmk records, for LF,
 * CRLF and BOM files.
 */
export function checksumOfText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The checksum of a file's bytes, as mmk computes it: decoded as UTF-8 (invalid sequences
 * become U+FFFD, as `readFileSync(file, 'utf8')` does), then hashed.
 */
export function checksumOfBytes(bytes: Uint8Array): string {
  return checksumOfText(Buffer.from(bytes).toString('utf8'));
}

/** The UTF-8 byte order mark, which `readFileSync(file, 'utf8')` keeps as U+FEFF */
const BOM = '﻿';

/**
 * The checksum mmk would record if the editor's text were saved. VS Code drops a UTF-8 BOM from
 * a document's text and writes it back on save, while mmk's read keeps it, so it's added back
 * when the file on disk starts with one. Line endings are hashed as the text has them: VS Code
 * keeps a CRLF file's `\r\n`.
 */
export function bufferChecksum(text: string, fileHasBom: boolean): string {
  return checksumOfText(fileHasBom && !text.startsWith(BOM) ? `${BOM}${text}` : text);
}

/** True when `bytes` start with the UTF-8 byte order mark */
export function startsWithBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** `3f9a1c07…be21`: a checksum short enough for a message */
export function shortChecksum(checksum: string): string {
  return checksum.length > 12 ? `${checksum.slice(0, 8)}…${checksum.slice(-4)}` : checksum;
}
