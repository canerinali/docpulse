import { writeFile } from 'node:fs/promises';
import { UsageError } from '../errors.js';
import { inferFromSource } from '../core/infer.js';
import { stringifySnapshot } from '../core/snapshotSchema.js';
import { createFileSource } from '../source/arraySource.js';
import type { DocumentSource, Snapshot } from '../core/types.js';

export interface SnapshotOptions {
  uri?: string | undefined;
  db?: string | undefined;
  collection?: string | undefined;
  inputJson?: string | undefined;
  out?: string | undefined;
  sampleSize: number;
  filter: string;
  sort: string;
  random?: boolean | undefined;
  label?: string | undefined;
}

/** `-d shop -c orders` -> `shop.orders`; `-c orders` -> `orders`; neither -> undefined. */
export function logicalCollectionName(
  db: string | undefined,
  collection: string | undefined,
): string | undefined {
  if (collection === undefined || collection === '') {
    if (db !== undefined && db !== '') {
      throw new UsageError('--db needs --collection: a database name alone does not identify a collection');
    }
    return undefined;
  }
  return db !== undefined && db !== '' ? `${db}.${collection}` : collection;
}

/** Parse a `--filter` / `--sort` flag into a plain JSON object. */
export function parseJsonObjectFlag(raw: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(
      `${flag} is not valid JSON: ${raw}`,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${flag} must be a JSON object, e.g. ${flag} '{"status":"paid"}'`);
  }
  return parsed as Record<string, unknown>;
}

function toSortSpec(raw: Record<string, unknown>, flag: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || (value !== 1 && value !== -1)) {
      throw new UsageError(`${flag}: direction for "${key}" must be 1 or -1`);
    }
    out[key] = value;
  }
  return out;
}

/** Shared by the CLI layer to validate the MongoDB-only flags. */
export function parseSamplingFlags(options: SnapshotOptions): {
  filter: Record<string, unknown>;
  sort: Record<string, number>;
} {
  return {
    filter: parseJsonObjectFlag(options.filter, '--filter'),
    sort: toSortSpec(parseJsonObjectFlag(options.sort, '--sort'), '--sort'),
  };
}

/** Build the right {@link DocumentSource} for the given flags. */
export async function createSource(options: SnapshotOptions): Promise<DocumentSource> {
  if (options.inputJson !== undefined) {
    if (options.uri !== undefined) {
      throw new UsageError('--uri cannot be combined with --input-json');
    }
    if (options.random === true) {
      throw new UsageError('--random applies to MongoDB sampling only, not --input-json');
    }
    if (options.filter !== '{}') {
      throw new UsageError('--filter applies to MongoDB sampling only, not --input-json');
    }
    // -d/-c are optional here, and name the *logical* collection the documents
    // belong to. `diff` refuses to compare snapshots of different collections,
    // so two files that represent the same collection must say so.
    return createFileSource(
      options.inputJson,
      options.sampleSize,
      logicalCollectionName(options.db, options.collection),
    );
  }

  const uri = options.uri ?? process.env.MONGODB_URI;
  if (uri === undefined || uri === '') {
    throw new UsageError(
      'a MongoDB connection string is required',
      'Pass --uri, set MONGODB_URI, or read local documents with --input-json <file>.',
    );
  }
  if (options.db === undefined || options.db === '') {
    throw new UsageError('--db <name> is required when sampling MongoDB');
  }
  if (options.collection === undefined || options.collection === '') {
    throw new UsageError('--collection <name> is required unless --input-json is given');
  }

  const { filter, sort } = parseSamplingFlags(options);
  // Imported lazily so the --input-json path never loads the driver.
  const { MongoDocumentSource } = await import('../source/mongoSource.js');
  return new MongoDocumentSource({
    uri,
    db: options.db,
    collection: options.collection,
    sampleSize: options.sampleSize,
    filter,
    sort,
    random: options.random === true,
  });
}

/** Run `docpulse snapshot` and return the snapshot it wrote. */
export async function runSnapshot(
  options: SnapshotOptions,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<Snapshot> {
  if (!Number.isInteger(options.sampleSize) || options.sampleSize < 0) {
    throw new UsageError('--sample-size must be a non-negative integer');
  }

  const source = await createSource(options);
  let snapshot: Snapshot;
  try {
    snapshot = await inferFromSource(source, { label: options.label ?? null });
  } finally {
    await source.close();
  }

  const text = stringifySnapshot(snapshot);
  if (options.out !== undefined && options.out !== '') {
    try {
      await writeFile(options.out, text, 'utf8');
    } catch (error) {
      throw new UsageError(
        `cannot write snapshot to ${options.out}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    stdout.write(text);
  }
  return snapshot;
}
