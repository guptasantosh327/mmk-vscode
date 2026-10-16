/**
 * Credential masking for everything the extension logs or shows.
 *
 * Mirrors `redactMongoUri` in mongo-migrate-kit's `src/utils/redact.ts`. The package does not
 * export it, and the extension never loads mmk at runtime, so the behaviour is kept here and
 * `test/unit/redact.test.ts` runs the same cases as mmk's own tests.
 */

/**
 * Replace the credentials in every MongoDB connection string inside `text` with `***:***`
 * (or `***` for a username alone), keeping the host and the rest of the URI.
 *
 * Rewrites everything up to the **last** `@` of each URI, so a password with an unescaped
 * `/`, `@`, `?` or `#` is hidden in full. Hiding too much is the safe way to be wrong.
 *
 * @example
 * redactMongoUri('failed: mongodb+srv://alice:s3cret@cluster0.mongodb.net')
 * // → 'failed: mongodb+srv://***:***@cluster0.mongodb.net'
 */
export function redactMongoUri(text: string): string {
  return text.replace(
    /(mongodb(?:\+srv)?:\/\/)([^\s"'<>]*)@/gi,
    (_match, scheme: string, userinfo: string) => `${scheme}${maskUserinfo(userinfo)}@`,
  );
}

/** `***:***` for `user:password`, `***` for a username alone */
function maskUserinfo(userinfo: string): string {
  return userinfo.includes(':') ? '***:***' : '***';
}
