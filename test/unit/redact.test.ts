import { describe, expect, it } from 'vitest';
import { redactMongoUri } from '../../src/mmk/redact.js';

// The same cases as mongo-migrate-kit's tests/unit/redact.test.ts, so both mask identically.
describe('redactMongoUri', () => {
  it('should redact user and password in a standard URI', () => {
    expect(redactMongoUri('mongodb://alice:s3cret@localhost:27017/db')).toBe(
      'mongodb://***:***@localhost:27017/db',
    );
  });

  it('should redact credentials in a mongodb+srv URI', () => {
    expect(redactMongoUri('connect failed: mongodb+srv://u:p@cluster0.mongodb.net/app')).toBe(
      'connect failed: mongodb+srv://***:***@cluster0.mongodb.net/app',
    );
  });

  it('should redact a username-only userinfo segment', () => {
    expect(redactMongoUri('mongodb://alice@localhost:27017')).toBe('mongodb://***@localhost:27017');
  });

  it('should leave a URI without credentials untouched', () => {
    expect(redactMongoUri('mongodb://localhost:27017/db')).toBe('mongodb://localhost:27017/db');
  });

  it('should redact every occurrence in a longer message', () => {
    expect(redactMongoUri('primary mongodb://a:b@h1 secondary mongodb://c:d@h2')).toBe(
      'primary mongodb://***:***@h1 secondary mongodb://***:***@h2',
    );
  });

  it('should not alter unrelated text', () => {
    expect(redactMongoUri('no uri here')).toBe('no uri here');
  });

  it('should hide a password containing an unescaped "/"', () => {
    const out = redactMongoUri('at mongodb://alice:Top/Secret@127.0.0.1:27017/app');
    expect(out).toBe('at mongodb://***:***@127.0.0.1:27017/app');
    expect(out).not.toContain('Secret');
  });

  it('should hide every part of a password containing an unescaped "@"', () => {
    const out = redactMongoUri('mongodb://alice:Top@Secret@127.0.0.1:27017');
    expect(out).toBe('mongodb://***:***@127.0.0.1:27017');
    expect(out).not.toContain('Secret');
  });

  it('should hide a password containing "?" and "#"', () => {
    expect(redactMongoUri('mongodb+srv://bob:a?b#c@cluster0.example.net')).toBe(
      'mongodb+srv://***:***@cluster0.example.net',
    );
  });

  it('should stop at whitespace so the next URI in the text is redacted on its own', () => {
    expect(redactMongoUri('a mongodb://u:p/1@h1, b mongodb://h2/db')).toBe(
      'a mongodb://***:***@h1, b mongodb://h2/db',
    );
  });

  it('should match the scheme case-insensitively', () => {
    expect(redactMongoUri('MONGODB://alice:s3cret@host')).toBe('MONGODB://***:***@host');
  });
});
