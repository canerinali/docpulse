import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoDocumentSource } from '../../src/source/mongoSource.js';
import { inferFromSource } from '../../src/core/infer.js';
import type { FieldStat } from '../../src/core/types.js';

const URI = process.env.MONGODB_URI;
const DB = 'docpulse_it';
const COLLECTION = 'orders';
const TOTAL = 1000;
const WITH_OPTIONAL = 700;

/**
 * Gated on MONGODB_URI: skipped, never failed, on a machine with no mongod.
 * The rest of the suite is designed so this is the only DB-dependent test.
 */
describe.skipIf(!URI)('live MongoDB integration', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(URI as string);
    const coll = client.db(DB).collection(COLLECTION);
    await coll.deleteMany({});
    const docs = Array.from({ length: TOTAL }, (_, i) => {
      const doc: Record<string, unknown> = {
        seq: i,
        lines: [{ sku: `SKU-${i}`, qty: 1 }],
      };
      if (i < WITH_OPTIONAL) doc.optional = `value-${i}`;
      return doc;
    });
    await coll.insertMany(docs);
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await client.db(DB).dropDatabase();
      await client.close();
    }
  }, 60_000);

  it('reports the true presence ratio within 2 percentage points', async () => {
    const source = new MongoDocumentSource({
      uri: URI as string,
      db: DB,
      collection: COLLECTION,
      sampleSize: TOTAL,
      filter: {},
      sort: { _id: -1 },
      random: false,
    });
    let snapshot;
    try {
      snapshot = await inferFromSource(source);
    } finally {
      await source.close();
    }

    expect(snapshot.collection).toBe(`${DB}.${COLLECTION}`);
    expect(snapshot.sampling.mode).toBe('sort-limit');
    expect(snapshot.sampledDocs).toBe(TOTAL);

    const optional = snapshot.fields.find((f) => f.path === 'optional') as FieldStat;
    expect(optional).toBeDefined();
    const ratio = (optional.presentCount / optional.observedUnits) * 100;
    expect(ratio).toBeGreaterThanOrEqual(68);
    expect(ratio).toBeLessThanOrEqual(72);

    // The array path is denominated in elements, one per document here.
    const sku = snapshot.fields.find((f) => f.path === 'lines.items[].sku') as FieldStat;
    expect(sku.denominator).toBe('arrayElements');
    expect(sku.arrayParent).toBe('lines');
    expect(sku.observedUnits).toBe(TOTAL);
  }, 120_000);

  it('reports a real collection size', async () => {
    const source = new MongoDocumentSource({
      uri: URI as string,
      db: DB,
      collection: COLLECTION,
      sampleSize: 10,
      filter: {},
      sort: { _id: -1 },
      random: false,
    });
    try {
      const total = await source.estimatedTotal();
      expect(total.method).toBe('estimatedDocumentCount');
      expect(total.count).toBe(TOTAL);
    } finally {
      await source.close();
    }
  }, 120_000);
});
