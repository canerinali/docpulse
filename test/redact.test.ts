import { describe, expect, it } from 'vitest';
import { redactConnectionStrings } from '../src/redact.js';
import { MongoDocumentSource } from '../src/source/mongoSource.js';
import { DocpulseError } from '../src/errors.js';

const PASSWORD = 'SuperSecret123';

describe('redactConnectionStrings', () => {
  it('removes the credentials from a mongodb:// URI', () => {
    expect(redactConnectionStrings(`connect ECONNREFUSED mongodb://admin:${PASSWORD}@db:27017/shop`)).toBe(
      'connect ECONNREFUSED mongodb://<redacted>@db:27017/shop',
    );
  });

  it('removes the credentials from a mongodb+srv:// URI, case-insensitively', () => {
    const text = `MongoDB+SRV://admin:${PASSWORD}@cluster0.abcde.mongodb.net/?retryWrites=true`;
    const out = redactConnectionStrings(text);
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain('<redacted>@cluster0.abcde.mongodb.net');
  });

  it('redacts every URI in a multi-line message', () => {
    const text =
      `first: mongodb://a:${PASSWORD}@h1:27017\n` +
      `second: mongodb+srv://b:${PASSWORD}@h2/db`;
    const out = redactConnectionStrings(text);
    expect(out).not.toContain(PASSWORD);
    expect(out.match(/<redacted>/g)).toHaveLength(2);
  });

  it('leaves a credential-free URI alone', () => {
    expect(redactConnectionStrings('mongodb://localhost:27017')).toBe('mongodb://localhost:27017');
  });

  it('does not run past the host of one URI into the next word', () => {
    expect(redactConnectionStrings('mongodb://u:p@host/db and user@example.com')).toBe(
      'mongodb://<redacted>@host/db and user@example.com',
    );
  });

  it('leaves text with no connection string untouched', () => {
    expect(redactConnectionStrings('querySrv ENOTFOUND _mongodb._tcp.cluster0.example.net')).toBe(
      'querySrv ENOTFOUND _mongodb._tcp.cluster0.example.net',
    );
  });
});

describe('the MongoDB source never prints a password', () => {
  it('redacts the driver error for an unusable URI', async () => {
    // No host, so the driver rejects this while parsing: no connection is
    // attempted and no timeout is waited out.
    const source = new MongoDocumentSource({
      uri: `mongodb://admin:${PASSWORD}@`,
      db: 'shop',
      collection: 'orders',
      sampleSize: 1,
      filter: {},
      sort: { _id: -1 },
      random: false,
    });

    let thrown: unknown;
    try {
      for await (const _doc of source.documents()) {
        /* unreachable: connecting fails first */
      }
    } catch (error) {
      thrown = error;
    } finally {
      await source.close();
    }

    expect(thrown).toBeInstanceOf(DocpulseError);
    const error = thrown as DocpulseError;
    expect(error.exitCode).toBe(2);
    expect(error.message).toBe('cannot connect to MongoDB');
    expect(`${error.message}\n${error.detail ?? ''}`).not.toContain(PASSWORD);
  });
});
