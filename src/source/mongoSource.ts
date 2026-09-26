import { MongoClient, type Document, type Sort } from 'mongodb';
import { UsageError } from '../errors.js';
import type { DocumentSource, SamplingInfo } from '../core/types.js';

export interface MongoSourceOptions {
  uri: string;
  db: string;
  collection: string;
  sampleSize: number;
  filter: Record<string, unknown>;
  sort: Record<string, number>;
  /** Use `$sample` instead of a deterministic sort+limit. */
  random: boolean;
  /** Injectable for tests; defaults to the real driver. */
  client?: MongoClient;
}

/**
 * The only file in the project that imports `mongodb`.
 *
 * docpulse never writes: the sole operations issued here are `find`, `sort`,
 * `limit`, `$sample`, `countDocuments` and `estimatedDocumentCount`.
 */
export class MongoDocumentSource implements DocumentSource {
  readonly collection: string;
  readonly sampling: SamplingInfo;

  readonly #options: MongoSourceOptions;
  #client: MongoClient | null = null;
  #ownsClient = false;
  #closed = false;

  constructor(options: MongoSourceOptions) {
    this.#options = options;
    this.collection = `${options.db}.${options.collection}`;
    this.sampling = {
      mode: options.random ? 'random-sample' : 'sort-limit',
      sampleSize: options.sampleSize,
      filter: options.filter,
      sort: options.random ? null : options.sort,
    };
  }

  async #connect(): Promise<MongoClient> {
    if (this.#client !== null) return this.#client;
    if (this.#options.client !== undefined) {
      this.#client = this.#options.client;
      return this.#client;
    }
    try {
      this.#client = await MongoClient.connect(this.#options.uri);
      this.#ownsClient = true;
    } catch (error) {
      throw new UsageError(
        `cannot connect to MongoDB`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return this.#client;
  }

  async *documents(): AsyncIterable<Record<string, unknown>> {
    if (this.#options.sampleSize <= 0) return;
    const client = await this.#connect();
    const coll = client.db(this.#options.db).collection(this.#options.collection);

    const cursor = this.#options.random
      ? coll.aggregate<Document>(
          [
            { $match: this.#options.filter },
            { $sample: { size: this.#options.sampleSize } },
          ],
          { allowDiskUse: false },
        )
      : coll
          .find(this.#options.filter)
          .sort(this.#options.sort as Sort)
          .limit(this.#options.sampleSize);

    try {
      for await (const doc of cursor) {
        yield doc as Record<string, unknown>;
      }
    } finally {
      await cursor.close();
    }
  }

  async estimatedTotal(): Promise<{ count: number | null; method: string }> {
    const client = await this.#connect();
    const coll = client.db(this.#options.db).collection(this.#options.collection);
    const hasFilter = Object.keys(this.#options.filter).length > 0;
    try {
      if (hasFilter) {
        return { count: await coll.countDocuments(this.#options.filter), method: 'countDocuments' };
      }
      return { count: await coll.estimatedDocumentCount(), method: 'estimatedDocumentCount' };
    } catch {
      // A count failure must never lose an otherwise good snapshot.
      return { count: null, method: 'unavailable' };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsClient && this.#client !== null) {
      await this.#client.close();
    }
    this.#client = null;
  }
}
