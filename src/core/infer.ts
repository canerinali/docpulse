import { VERSION } from '../version.js';
import { walkDocument } from './paths.js';
import type {
  Denominator,
  DocumentSource,
  FieldStat,
  SamplingInfo,
  Snapshot,
} from './types.js';

export const SNAPSHOT_FORMAT_VERSION = 1 as const;

/** Identity string written into every snapshot's `tool` field. */
export const TOOL_ID = `docpulse@${VERSION}`;

interface PathAccumulator {
  denominator: Denominator;
  arrayParent: string | undefined;
  presentCount: number;
  nullCount: number;
  emptyStringCount: number;
  bsonTypes: Map<string, number>;
}

export interface SnapshotMetaInput {
  collection: string;
  sampling: SamplingInfo;
  label?: string | null;
  createdAt?: string;
  tool?: string;
  estimatedTotalDocs?: number | null;
  estimatedTotalDocsMethod?: string;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedRecord(entries: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...entries.keys()].sort(compareStrings)) {
    out[key] = entries.get(key) as number;
  }
  return out;
}

/**
 * Folds documents into per-path counters. Deliberately free of any I/O so the
 * whole inference path is unit-testable against plain JS objects.
 */
export class SnapshotAccumulator {
  readonly #paths = new Map<string, PathAccumulator>();
  /** array path -> total elements observed across every document. */
  readonly #arrayUnits = new Map<string, number>();
  #sampledDocs = 0;

  constructor(private readonly maxDepth?: number) {}

  get sampledDocs(): number {
    return this.#sampledDocs;
  }

  add(doc: Record<string, unknown>): void {
    this.#sampledDocs += 1;

    // A document-denominated path occurs at most once per document by
    // construction, but we dedupe defensively so `presentCount / observedUnits`
    // can never exceed 1.
    const seenInDoc = new Set<string>();
    const options = this.maxDepth === undefined ? {} : { maxDepth: this.maxDepth };

    for (const event of walkDocument(doc, options)) {
      if (event.kind === 'arrayLength') {
        this.#arrayUnits.set(
          event.path,
          (this.#arrayUnits.get(event.path) ?? 0) + event.count,
        );
        continue;
      }

      if (event.denominator === 'documents') {
        if (seenInDoc.has(event.path)) continue;
        seenInDoc.add(event.path);
      }

      let acc = this.#paths.get(event.path);
      if (acc === undefined) {
        acc = {
          denominator: event.denominator,
          arrayParent: event.arrayParent,
          presentCount: 0,
          nullCount: 0,
          emptyStringCount: 0,
          bsonTypes: new Map<string, number>(),
        };
        this.#paths.set(event.path, acc);
      }

      acc.presentCount += 1;
      if (event.isNull) acc.nullCount += 1;
      if (event.isEmptyString) acc.emptyStringCount += 1;
      acc.bsonTypes.set(event.bsonType, (acc.bsonTypes.get(event.bsonType) ?? 0) + 1);
    }
  }

  /** Snapshot-ready field statistics, sorted by path. */
  fields(): FieldStat[] {
    const paths = [...this.#paths.keys()].sort(compareStrings);
    return paths.map((path) => {
      const acc = this.#paths.get(path) as PathAccumulator;
      const observedUnits =
        acc.denominator === 'documents'
          ? this.#sampledDocs
          : (this.#arrayUnits.get(acc.arrayParent as string) ?? 0);

      const stat: FieldStat = {
        path,
        denominator: acc.denominator,
        observedUnits,
        presentCount: acc.presentCount,
        nullCount: acc.nullCount,
        emptyStringCount: acc.emptyStringCount,
        bsonTypes: sortedRecord(acc.bsonTypes),
      };
      if (acc.arrayParent !== undefined) stat.arrayParent = acc.arrayParent;
      return stat;
    });
  }

  finish(meta: SnapshotMetaInput): Snapshot {
    return {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      tool: meta.tool ?? TOOL_ID,
      label: meta.label ?? null,
      createdAt: meta.createdAt ?? new Date().toISOString(),
      collection: meta.collection,
      sampling: meta.sampling,
      sampledDocs: this.#sampledDocs,
      estimatedTotalDocs: meta.estimatedTotalDocs ?? null,
      estimatedTotalDocsMethod: meta.estimatedTotalDocsMethod ?? 'unavailable',
      fields: this.fields(),
    };
  }
}

/** Convenience wrapper for in-memory document arrays (tests, library use). */
export function inferFromDocuments(
  docs: Array<Record<string, unknown>>,
  meta: SnapshotMetaInput,
  maxDepth?: number,
): Snapshot {
  const acc = new SnapshotAccumulator(maxDepth);
  for (const doc of docs) acc.add(doc);
  return acc.finish(meta);
}

/** Drain a {@link DocumentSource} into a snapshot. */
export async function inferFromSource(
  source: DocumentSource,
  meta: Omit<SnapshotMetaInput, 'collection' | 'sampling'> = {},
): Promise<Snapshot> {
  const acc = new SnapshotAccumulator();
  for await (const doc of source.documents()) {
    acc.add(doc);
  }
  const total = await source.estimatedTotal();
  return acc.finish({
    ...meta,
    collection: source.collection,
    sampling: source.sampling,
    estimatedTotalDocs: total.count,
    estimatedTotalDocsMethod: total.method,
  });
}
