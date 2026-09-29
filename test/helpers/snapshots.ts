import { TOOL_ID } from '../../src/core/infer.js';
import type { FieldStat, SamplingInfo, Snapshot } from '../../src/core/types.js';

export const SORT_LIMIT: SamplingInfo = {
  mode: 'sort-limit',
  sampleSize: 1000,
  filter: {},
  sort: { _id: -1 },
};

export interface StatInput {
  units: number;
  present: number;
  nulls?: number;
  empty?: number;
  types: Record<string, number>;
}

/** A document-denominated field. */
export function docField(path: string, input: StatInput): FieldStat {
  return {
    path,
    denominator: 'documents',
    observedUnits: input.units,
    presentCount: input.present,
    nullCount: input.nulls ?? 0,
    emptyStringCount: input.empty ?? 0,
    bsonTypes: input.types,
  };
}

/** An array-element-denominated field. */
export function elemField(path: string, arrayParent: string, input: StatInput): FieldStat {
  return {
    path,
    denominator: 'arrayElements',
    arrayParent,
    observedUnits: input.units,
    presentCount: input.present,
    nullCount: input.nulls ?? 0,
    emptyStringCount: input.empty ?? 0,
    bsonTypes: input.types,
  };
}

export interface SnapInput {
  fields: FieldStat[];
  label?: string;
  collection?: string;
  sampledDocs?: number;
  sampling?: Partial<SamplingInfo>;
  formatVersion?: number;
  createdAt?: string;
}

export function snap(input: SnapInput): Snapshot {
  return {
    formatVersion: (input.formatVersion ?? 1) as 1,
    tool: TOOL_ID,
    label: input.label ?? null,
    createdAt: input.createdAt ?? '2026-09-26T00:00:00.000Z',
    collection: input.collection ?? 'shop.orders',
    sampling: { ...SORT_LIMIT, ...input.sampling },
    sampledDocs: input.sampledDocs ?? 1000,
    estimatedTotalDocs: 482913,
    estimatedTotalDocsMethod: 'estimatedDocumentCount',
    fields: input.fields,
  };
}
