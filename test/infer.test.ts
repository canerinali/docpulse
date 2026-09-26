import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SnapshotAccumulator, inferFromDocuments, inferFromSource } from '../src/core/infer.js';
import { ArrayDocumentSource, parseDocumentsText } from '../src/source/arraySource.js';
import type { FieldStat, SamplingInfo, Snapshot } from '../src/core/types.js';

const DOCS = JSON.parse(
  readFileSync(new URL('./fixtures/docs.json', import.meta.url), 'utf8'),
) as Array<Record<string, unknown>>;

const SAMPLING: SamplingInfo = {
  mode: 'input-file',
  sampleSize: 1000,
  filter: {},
  sort: null,
};

function snapshotOf(docs: Array<Record<string, unknown>>): Snapshot {
  return inferFromDocuments(docs, { collection: 'test.docs', sampling: SAMPLING });
}

function field(snapshot: Snapshot, path: string): FieldStat {
  const found = snapshot.fields.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no field ${path} in snapshot`);
  return found;
}

describe('inference over the 4-document fixture', () => {
  const snapshot = snapshotOf(DOCS);

  it('counts every sampled document', () => {
    expect(DOCS).toHaveLength(4);
    expect(snapshot.sampledDocs).toBe(4);
  });

  it('sorts fields by path and finds exactly the expected paths', () => {
    const paths = snapshot.fields.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual([
      '_id',
      'customer',
      'customer.taxId',
      'lines',
      'lines.items[]',
      'lines.items[].qty',
      'lines.items[].sku',
      'note',
    ]);
  });

  it('denominates non-array paths in documents', () => {
    expect(field(snapshot, 'customer.taxId')).toEqual({
      path: 'customer.taxId',
      denominator: 'documents',
      observedUnits: 4,
      presentCount: 3,
      nullCount: 1,
      emptyStringCount: 0,
      bsonTypes: { null: 1, string: 2 },
    });
    // 3 of 4 documents => 75% presence; 1 null of 3 present => 33.3% null ratio.
    const taxId = field(snapshot, 'customer.taxId');
    expect(taxId.presentCount / taxId.observedUnits).toBeCloseTo(0.75, 10);
    expect(taxId.nullCount / taxId.presentCount).toBeCloseTo(1 / 3, 10);
  });

  it('denominates array-element paths in elements of the nearest enclosing array', () => {
    // 2 + 1 + 0 + 4 = 7 elements across the four documents.
    expect(field(snapshot, 'lines.items[]')).toEqual({
      path: 'lines.items[]',
      denominator: 'arrayElements',
      arrayParent: 'lines',
      observedUnits: 7,
      presentCount: 7,
      nullCount: 0,
      emptyStringCount: 0,
      bsonTypes: { object: 7 },
    });
    expect(field(snapshot, 'lines.items[].sku')).toEqual({
      path: 'lines.items[].sku',
      denominator: 'arrayElements',
      arrayParent: 'lines',
      observedUnits: 7,
      presentCount: 6,
      nullCount: 0,
      emptyStringCount: 0,
      bsonTypes: { string: 6 },
    });
  });

  it('counts mixed types per type on the same path', () => {
    expect(field(snapshot, 'lines.items[].qty')).toEqual({
      path: 'lines.items[].qty',
      denominator: 'arrayElements',
      arrayParent: 'lines',
      observedUnits: 7,
      presentCount: 6,
      nullCount: 0,
      emptyStringCount: 0,
      bsonTypes: { int: 5, string: 1 },
    });
  });

  it('keeps missing, null and empty string in three different counters', () => {
    // `note`: "hello", "", "x", missing.
    expect(field(snapshot, 'note')).toEqual({
      path: 'note',
      denominator: 'documents',
      observedUnits: 4,
      presentCount: 3,
      nullCount: 0,
      emptyStringCount: 1,
      bsonTypes: { string: 3 },
    });
    // `customer.taxId`: present-with-null is counted as present, unlike missing.
    const taxId = field(snapshot, 'customer.taxId');
    expect(taxId.presentCount).toBe(3);
    expect(taxId.nullCount).toBe(1);
    expect(taxId.emptyStringCount).toBe(0);
  });

  it('records the array itself as a document-denominated `array` field', () => {
    expect(field(snapshot, 'lines')).toEqual({
      path: 'lines',
      denominator: 'documents',
      observedUnits: 4,
      presentCount: 4,
      nullCount: 0,
      emptyStringCount: 0,
      bsonTypes: { array: 4 },
    });
  });

  it('sorts bsonTypes keys so the file is byte-stable', () => {
    for (const f of snapshot.fields) {
      const keys = Object.keys(f.bsonTypes);
      expect(keys).toEqual([...keys].sort());
      const sum = Object.values(f.bsonTypes).reduce((a, b) => a + b, 0);
      expect(sum).toBe(f.presentCount);
    }
  });
});

describe('determinism and truncation', () => {
  it('produces deep-equal snapshots for two runs over the same documents', () => {
    const a = snapshotOf(DOCS);
    const b = snapshotOf(DOCS);
    expect({ ...a, createdAt: '' }).toEqual({ ...b, createdAt: '' });
  });

  it('respects the sample-size truncation', async () => {
    const source = new ArrayDocumentSource(DOCS, {
      collection: 'test.docs',
      sampleSize: 2,
    });
    const snapshot = await inferFromSource(source);
    expect(snapshot.sampledDocs).toBe(2);
    expect(snapshot.estimatedTotalDocs).toBe(4);
    expect(snapshot.estimatedTotalDocsMethod).toBe('inputLength');
    // Only the first two documents: `lines` has 2 + 1 = 3 elements.
    expect(field(snapshot, 'lines.items[]').observedUnits).toBe(3);
  });

  it('yields nothing for sampleSize 0', async () => {
    const source = new ArrayDocumentSource(DOCS, { collection: 'x.y', sampleSize: 0 });
    const snapshot = await inferFromSource(source);
    expect(snapshot.sampledDocs).toBe(0);
    expect(snapshot.fields).toEqual([]);
  });

  it('empty arrays across every document leave no element path at all', () => {
    const snapshot = snapshotOf([{ lines: [] }, { lines: [] }]);
    expect(snapshot.fields.map((f) => f.path)).toEqual(['lines']);
  });

  it('exposes running counters through the accumulator', () => {
    const acc = new SnapshotAccumulator();
    expect(acc.sampledDocs).toBe(0);
    acc.add({ a: 1 });
    acc.add({ a: 2, b: 3 });
    expect(acc.sampledDocs).toBe(2);
    expect(acc.fields().map((f) => [f.path, f.presentCount, f.observedUnits])).toEqual([
      ['a', 2, 2],
      ['b', 1, 2],
    ]);
  });
});

describe('document parsing', () => {
  it('parses a JSON array', () => {
    expect(parseDocumentsText('[{"a":1},{"a":2}]', 'x')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('parses NDJSON', () => {
    expect(parseDocumentsText('{"a":1}\n\n{"a":2}\n', 'x')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('parses a single JSON object as one document', () => {
    expect(parseDocumentsText('{\n  "a": 1\n}', 'x')).toEqual([{ a: 1 }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseDocumentsText('   \n', 'x')).toEqual([]);
  });

  it('reports the offending NDJSON line number', () => {
    expect(() => parseDocumentsText('{"a":1}\nnot json\n', 'dump.ndjson')).toThrow(
      /dump\.ndjson: line 2 is not valid JSON/,
    );
  });

  it('rejects scalars and arrays as documents', () => {
    expect(() => parseDocumentsText('[1,2]', 'x')).toThrow(/element 0 is not a JSON object/);
  });
});
