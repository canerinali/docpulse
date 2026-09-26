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
 * Deepest structure `canonicalize` will walk. MongoDB itself refuses BSON
 * nested more than 100 levels deep, so nothing legitimate reaches this; the cap
 * exists so a hand-edited snapshot file cannot turn a `sampling.filter` into an
 * unbounded recursion and crash `diff` with a bare stack-overflow message.
 */
export const MAX_CANONICAL_DEPTH = 100;

/**
 * Recursively key-sorted, compact JSON. Used to compare two snapshots'
 * `sampling.filter` without caring how the operator happened to type it.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new UsageError(
      `nested more than ${MAX_CANONICAL_DEPTH} levels deep`,
      'A snapshot\'s sampling.filter cannot be nested deeper than MongoDB allows.',
    );
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Null-prototype, so a key literally called `__proto__` is stored as an own
    // property and survives into the output instead of silently invoking the
    // `Object.prototype.__proto__` setter and vanishing — which would make two
    // different filters canonicalise to the same string and defeat the
    // "refuse to compare different filters" guard.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key], depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * True when a `__proto__` key appears anywhere in the value, as an own
 * property. `JSON.parse` stores such a key as an own data property rather than
 * invoking the `Object.prototype.__proto__` setter, so this sees exactly what
 * the file said. Iterative, so the depth cap belongs to `canonicalize` alone.
 */
function hasProtoKey(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === '__proto__') return true;
      stack.push(record[key]);
    }
  }
  return false;
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

  const rawFilter = (value as { sampling?: { filter?: unknown } }).sampling?.filter;
  if (hasProtoKey(rawFilter)) {
    // `__proto__` is not a usable MongoDB field name, so no legitimate snapshot
    // carries one. It is also the one key that does not survive validation
    // intact, and `diff` refuses to compare snapshots taken with different
    // filters — so silently dropping it would let two genuinely different
    // samples look identical. Refuse the file instead of guessing.
    throw new UsageError(
      `${origin}: sampling.filter contains a __proto__ key`,
      'That is not a field name MongoDB can store, so this snapshot was hand-edited. docpulse ' +
        'compares the two snapshots\' filters before it compares anything else, and it will not ' +
        'run that comparison against a key it cannot represent faithfully.\n' +
        'Remove the key, or re-take the snapshot.',
    );
  }

  const snapshot = result.data as Snapshot;
  // zod rebuilds a `z.record` into a fresh object literal, and assigning a key
  // named `__proto__` there hits the `Object.prototype.__proto__` setter, so
  // the key disappears. `sampling.filter` and `sampling.sort` are what
  // `diffSnapshots` compares to decide whether two snapshots may be compared at
  // all, so losing a key there would let two genuinely different samples look
  // identical. Re-home both onto the canonical (null-prototype) form built from
  // the raw parsed value, which keeps every key and is what `stringifySnapshot`
  // writes anyway.
  const rawSampling = (value as { sampling?: unknown }).sampling;
  if (rawSampling !== null && typeof rawSampling === 'object') {
    const raw = rawSampling as { filter?: unknown; sort?: unknown };
    if (raw.filter !== null && typeof raw.filter === 'object') {
      snapshot.sampling.filter = canonicalize(raw.filter) as Record<string, unknown>;
    }
    if (raw.sort !== null && typeof raw.sort === 'object') {
      snapshot.sampling.sort = canonicalize(raw.sort) as Record<string, number>;
    }
  }
  return snapshot;
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
