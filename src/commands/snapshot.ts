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

/** Build the right {@link DocumentSource} for the given flags. */
export async function createSource(options: SnapshotOptions): Promise<DocumentSource> {
  if (options.inputJson !== undefined) {
    for (const [flag, value] of [
      ['--uri', options.uri],
      ['--db', options.db],
      ['--collection', options.collection],
    ] as const) {
      if (value !== undefined) {
        throw new UsageError(`${flag} cannot be combined with --input-json`);
      }
    }
    if (options.random === true) {
      throw new UsageError('--random applies to MongoDB sampling only, not --input-json');
    }
    return createFileSource(options.inputJson, options.sampleSize);
  }

  throw new UsageError(
    'MongoDB sampling is not wired up in this build',
    'Use --input-json <file> to snapshot documents from a local JSON array or NDJSON file.',
  );
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
