import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveUri, type SnapshotOptions } from '../src/commands/snapshot.js';
import { DocpulseError } from '../src/errors.js';

const BASE: SnapshotOptions = {
  sampleSize: 1000,
  filter: '{}',
  sort: '{"_id":-1}',
};

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docpulse-urifile-'));
});

async function secret(name: string, contents: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, contents, 'utf8');
  return file;
}

describe('--uri-file', () => {
  it('reads the connection string from the file, trailing newline trimmed', async () => {
    const file = await secret('mongodb-uri', 'mongodb+srv://admin:pw@cluster0.example.net/shop\n');
    await expect(resolveUri({ ...BASE, uriFile: file })).resolves.toBe(
      'mongodb+srv://admin:pw@cluster0.example.net/shop',
    );
  });

  it('trims a CRLF-terminated secret too', async () => {
    const file = await secret('crlf-uri', 'mongodb://localhost:27017\r\n');
    await expect(resolveUri({ ...BASE, uriFile: file })).resolves.toBe('mongodb://localhost:27017');
  });

  it('wins over MONGODB_URI in the environment', async () => {
    const file = await secret('wins', 'mongodb://from-file:27017\n');
    const previous = process.env.MONGODB_URI;
    process.env.MONGODB_URI = 'mongodb://from-env:27017';
    try {
      await expect(resolveUri({ ...BASE, uriFile: file })).resolves.toBe('mongodb://from-file:27017');
    } finally {
      if (previous === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = previous;
    }
  });

  it('refuses to be combined with --uri', async () => {
    const file = await secret('both', 'mongodb://localhost:27017\n');
    await expect(
      resolveUri({ ...BASE, uriFile: file, uri: 'mongodb://localhost:27017' }),
    ).rejects.toThrow(/--uri-file cannot be combined with --uri/);
  });

  it('exits 2 when the file cannot be read', async () => {
    const error = await resolveUri({ ...BASE, uriFile: join(dir, 'no-such-secret') }).then(
      () => null,
      (e: unknown) => e as DocpulseError,
    );
    expect(error).toBeInstanceOf(DocpulseError);
    expect((error as DocpulseError).exitCode).toBe(2);
    expect((error as DocpulseError).message).toMatch(/cannot read --uri-file/);
  });

  it('exits 2 on an empty secret file', async () => {
    const file = await secret('empty', '   \n');
    await expect(resolveUri({ ...BASE, uriFile: file })).rejects.toThrow(/--uri-file is empty/);
  });

  it('exits 2 when the file holds more than the connection string', async () => {
    const file = await secret('chatty', 'export MONGODB_URI=mongodb://localhost:27017\nother line\n');
    await expect(resolveUri({ ...BASE, uriFile: file })).rejects.toThrow(
      /--uri-file must hold one line/,
    );
  });

  it('falls back to --uri and then to MONGODB_URI when no file is given', async () => {
    const previous = process.env.MONGODB_URI;
    process.env.MONGODB_URI = 'mongodb://from-env:27017';
    try {
      await expect(resolveUri({ ...BASE, uri: 'mongodb://from-flag:27017' })).resolves.toBe(
        'mongodb://from-flag:27017',
      );
      await expect(resolveUri({ ...BASE })).resolves.toBe('mongodb://from-env:27017');
    } finally {
      if (previous === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = previous;
    }
  });
});
