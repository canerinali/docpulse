import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inferFromSource } from '../src/core/infer.js';
import {
  MAX_BUFFERED_INPUT_BYTES,
  NdjsonDocumentSource,
  createFileSource,
} from '../src/source/arraySource.js';
import { DocpulseError } from '../src/errors.js';

let dir: string;

/** One ~130-byte document per line, so the counts below are about the file, not the parser. */
function ndjsonLine(i: number): string {
  return JSON.stringify({
    _id: i,
    status: i % 3 === 0 ? 'paid' : 'pending',
    total: i * 7,
    customer: { taxId: `TR${1_000_000 + i}`, region: 'eu-west' },
    lines: [{ sku: `SKU-${i}`, qty: (i % 4) + 1 }],
  });
}

async function writeNdjson(name: string, lines: string[]): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

async function collect(
  source: { documents(): AsyncIterable<Record<string, unknown>> },
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const doc of source.documents()) out.push(doc);
  return out;
}

/** 100_000 documents, ~13 MB. Big enough that buffering it would show. */
const BIG_DOCS = 100_000;
let bigFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docpulse-filesource-'));
  const lines: string[] = [];
  for (let i = 0; i < BIG_DOCS; i += 1) lines.push(ndjsonLine(i));
  bigFile = await writeNdjson('big.ndjson', lines);
}, 60_000);

afterAll(() => {
  /* the OS reclaims the temp dir; leaving it costs nothing and keeps failures inspectable */
});

describe('NDJSON is streamed, not buffered', () => {
  it('yields exactly --sample-size documents from a large file and completes', async () => {
    const source = await createFileSource(bigFile, 5, 'shop.orders');
    const docs = await collect(source);
    expect(docs).toHaveLength(5);
    expect(docs[0]).toMatchObject({ _id: 0 });
    expect(docs[4]).toMatchObject({ _id: 4 });
  });

  it('stops reading the file at the limit instead of parsing all of it', async () => {
    // Line 11 is deliberately unparseable. A reader that stops after five
    // documents never sees it; one that slurps the file cannot avoid it.
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => ndjsonLine(i)),
      '{ this is not json',
      ...Array.from({ length: 10 }, (_, i) => ndjsonLine(100 + i)),
    ];
    const file = await writeNdjson('poisoned.ndjson', lines);

    const stopsEarly = await createFileSource(file, 5, 'shop.orders');
    expect(await collect(stopsEarly)).toHaveLength(5);

    const readsPastIt = await createFileSource(file, 20, 'shop.orders');
    await expect(collect(readsPastIt)).rejects.toThrow(/line 11 is not valid JSON/);
  });

  it('records an exact total only when it read the whole file', async () => {
    const file = await writeNdjson(
      'small.ndjson',
      Array.from({ length: 12 }, (_, i) => ndjsonLine(i)),
    );

    const whole = await createFileSource(file, 1000, 'shop.orders');
    const wholeSnapshot = await inferFromSource(whole);
    expect(wholeSnapshot.sampledDocs).toBe(12);
    expect(wholeSnapshot.estimatedTotalDocs).toBe(12);
    expect(wholeSnapshot.estimatedTotalDocsMethod).toBe('inputLength');

    const partial = await createFileSource(file, 3, 'shop.orders');
    const partialSnapshot = await inferFromSource(partial);
    expect(partialSnapshot.sampledDocs).toBe(3);
    expect(partialSnapshot.estimatedTotalDocs).toBeNull();
    expect(partialSnapshot.estimatedTotalDocsMethod).toBe('inputTruncated');
  });

  it('infers a snapshot from a large file with a small sample size', async () => {
    const source = await createFileSource(bigFile, 10, 'shop.orders');
    const snapshot = await inferFromSource(source);
    expect(snapshot.sampledDocs).toBe(10);
    expect(snapshot.collection).toBe('shop.orders');
    expect(snapshot.fields.map((f) => f.path)).toContain('customer.taxId');
  });

  it('yields nothing for --sample-size 0 without opening the file', async () => {
    const source = new NdjsonDocumentSource(join(dir, 'does-not-exist.ndjson'), {
      collection: 'shop.orders',
      sampleSize: 0,
    });
    expect(await collect(source)).toEqual([]);
  });

  it('keeps the NDJSON line-number error message', async () => {
    const file = await writeNdjson('bad.ndjson', ['{"a":1}', 'not json']);
    const source = await createFileSource(file, 100);
    await expect(collect(source)).rejects.toThrow(/bad\.ndjson: line 2 is not valid JSON/);
  });

  it('rejects a line that is not a JSON object', async () => {
    const file = await writeNdjson('scalar.ndjson', ['{"a":1}', '42']);
    const source = await createFileSource(file, 100);
    await expect(collect(source)).rejects.toThrow(/line 2 is not a JSON object/);
  });

  it('skips blank lines and handles CRLF', async () => {
    const file = join(dir, 'crlf.ndjson');
    await writeFile(file, '{"a":1}\r\n\r\n{"a":2}\r\n', 'utf8');
    const source = await createFileSource(file, 100);
    expect(await collect(source)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('defaults the collection name to input:<basename>', async () => {
    const file = await writeNdjson('named.ndjson', ['{"a":1}']);
    const source = await createFileSource(file, 100);
    expect(source.collection).toBe('input:named.ndjson');
  });
});

describe('the JSON-array form keeps working, under a documented ceiling', () => {
  it('parses a pretty-printed JSON array', async () => {
    const file = join(dir, 'array.json');
    await writeFile(file, '[\n  {"a": 1},\n  {"a": 2}\n]\n', 'utf8');
    const source = await createFileSource(file, 100);
    expect(await collect(source)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await source.estimatedTotal()).toEqual({ count: 2, method: 'inputLength' });
  });

  it('parses a single pretty-printed JSON object as one document', async () => {
    const file = join(dir, 'single.json');
    await writeFile(file, '{\n  "a": 1,\n  "b": {"c": 2}\n}\n', 'utf8');
    const source = await createFileSource(file, 100);
    expect(await collect(source)).toEqual([{ a: 1, b: { c: 2 } }]);
  });

  it('refuses an array file above the ceiling with exit 2 and an actionable message', async () => {
    const file = join(dir, 'too-big.json');
    await writeFile(file, `[${'{"a":1},'.repeat(40)}{"a":1}]`, 'utf8');

    // The real ceiling is 128 MB; the test writes 300-odd bytes and lowers it.
    const error = await createFileSource(file, 1, undefined, 64).then(
      () => null,
      (e: unknown) => e as DocpulseError,
    );

    expect(error).toBeInstanceOf(DocpulseError);
    expect((error as DocpulseError).exitCode).toBe(2);
    expect((error as DocpulseError).message).toMatch(/too large to read as a JSON array/);
    expect((error as DocpulseError).message).toContain('too-big.json');
    expect((error as DocpulseError).detail).toMatch(/NDJSON/);
    expect((error as DocpulseError).detail).toMatch(/jq -c '\.\[\]'/);
  });

  it('applies no ceiling to NDJSON, whatever its size', async () => {
    // Same lowered ceiling, a file far above it: NDJSON is streamed, so it runs.
    const source = await createFileSource(bigFile, 3, 'shop.orders', 64);
    expect(await collect(source)).toHaveLength(3);
  });

  it('ships a 128 MB default ceiling', () => {
    expect(MAX_BUFFERED_INPUT_BYTES).toBe(128 * 1024 * 1024);
  });
});

describe('unreadable input', () => {
  it('reports a missing file as a usage error', async () => {
    await expect(createFileSource(join(dir, 'nope.ndjson'), 10)).rejects.toThrow(
      /cannot read --input-json file/,
    );
  });

  it('reports a directory as a usage error', async () => {
    await expect(createFileSource(dir, 10)).rejects.toThrow(/cannot read --input-json file/);
  });
});
