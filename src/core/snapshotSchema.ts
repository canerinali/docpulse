import { z } from 'zod';
import { UsageError } from '../errors.js';
import type { Snapshot } from './types.js';

/** The only snapshot format version this build understands. */
export const SUPPORTED_FORMAT_VERSION = 1;

const nonNegativeInt = z.number().int().min(0);

export const samplingInfoSchema = z.object({
  mode: z.enum(['sort-limit', 'random-sample', 'input-file']),
  sampleSize: nonNegativeInt,
  filter: z.record(z.string(), z.unknown()),
  sort: z.record(z.string(), z.number()).nullable(),
});

export const fieldStatSchema = z
  .object({
    path: z.string().min(1),
    denominator: z.enum(['documents', 'arrayElements']),
    arrayParent: z.string().min(1).optional(),
    observedUnits: nonNegativeInt,
    presentCount: nonNegativeInt,
    nullCount: nonNegativeInt,
    emptyStringCount: nonNegativeInt,
    bsonTypes: z.record(z.string(), nonNegativeInt),
  })
  .refine((f) => f.denominator !== 'arrayElements' || f.arrayParent !== undefined, {
    message: 'an arrayElements field must name its arrayParent',
    path: ['arrayParent'],
  })
  .refine((f) => f.presentCount <= f.observedUnits, {
    message: 'presentCount cannot exceed observedUnits',
    path: ['presentCount'],
  })
  .refine((f) => f.nullCount <= f.presentCount, {
    message: 'nullCount cannot exceed presentCount',
    path: ['nullCount'],
  })
  .refine((f) => f.emptyStringCount <= f.presentCount, {
    message: 'emptyStringCount cannot exceed presentCount',
    path: ['emptyStringCount'],
  })
  .refine(
    (f) => Object.values(f.bsonTypes).reduce((a, b) => a + b, 0) === f.presentCount,
    { message: 'bsonTypes counts must sum to presentCount', path: ['bsonTypes'] },
  );

export const snapshotSchema = z.object({
  formatVersion: z.literal(SUPPORTED_FORMAT_VERSION),
  tool: z.string().min(1),
  label: z.string().nullable(),
  createdAt: z.string().min(1),
  collection: z.string().min(1),
  sampling: samplingInfoSchema,
  sampledDocs: nonNegativeInt,
  estimatedTotalDocs: nonNegativeInt.nullable(),
  estimatedTotalDocsMethod: z.string().min(1),
  fields: z.array(fieldStatSchema),
});

/**
 * Recursively key-sorted, compact JSON. Used to compare two snapshots'
 * `sampling.filter` without caring how the operator happened to type it.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/**
 * Serialise a snapshot with a fixed key order, so two runs over the same data
 * are byte-identical apart from `createdAt`.
 */
export function stringifySnapshot(snapshot: Snapshot): string {
  const ordered = {
    formatVersion: snapshot.formatVersion,
    tool: snapshot.tool,
    label: snapshot.label,
    createdAt: snapshot.createdAt,
    collection: snapshot.collection,
    sampling: {
      mode: snapshot.sampling.mode,
      sampleSize: snapshot.sampling.sampleSize,
      filter: canonicalize(snapshot.sampling.filter),
      sort: snapshot.sampling.sort === null ? null : canonicalize(snapshot.sampling.sort),
    },
    sampledDocs: snapshot.sampledDocs,
    estimatedTotalDocs: snapshot.estimatedTotalDocs,
    estimatedTotalDocsMethod: snapshot.estimatedTotalDocsMethod,
    fields: snapshot.fields.map((f) => {
      const base: Record<string, unknown> = {
        path: f.path,
        denominator: f.denominator,
      };
      if (f.arrayParent !== undefined) base.arrayParent = f.arrayParent;
      base.observedUnits = f.observedUnits;
      base.presentCount = f.presentCount;
      base.nullCount = f.nullCount;
      base.emptyStringCount = f.emptyStringCount;
      base.bsonTypes = f.bsonTypes;
      return base;
    }),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Validate an already-parsed value as a snapshot. */
export function validateSnapshot(value: unknown, origin: string): Snapshot {
  if (typeof value === 'object' && value !== null) {
    const version = (value as { formatVersion?: unknown }).formatVersion;
    if (typeof version === 'number' && version !== SUPPORTED_FORMAT_VERSION) {
      throw new UsageError(
        `${origin}: unsupported snapshot formatVersion ${version}`,
        `This build of docpulse reads formatVersion ${SUPPORTED_FORMAT_VERSION} only.`,
      );
    }
  }

  const result = snapshotSchema.safeParse(value);
  if (!result.success) {
    throw new UsageError(`${origin}: not a valid docpulse snapshot`, z.prettifyError(result.error));
  }
  return result.data as Snapshot;
}

/** Parse and validate snapshot JSON text. */
export function parseSnapshot(text: string, origin: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `${origin}: not valid JSON`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return validateSnapshot(parsed, origin);
}
