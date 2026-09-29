/**
 * Core data model for docpulse.
 *
 * Everything in this file is part of the public, semver-relevant surface: the
 * snapshot JSON format is a file format other people will commit to their repos,
 * so it changes only behind `formatVersion`.
 */

/** The 16 canonical BSON type names docpulse emits for observed values. */
export const CANONICAL_BSON_TYPES = [
  'array',
  'binData',
  'bool',
  'date',
  'decimal',
  'double',
  'int',
  'javascript',
  'long',
  'null',
  'object',
  'objectId',
  'regex',
  'string',
  'symbol',
  'timestamp',
] as const;

export type CanonicalBsonType = (typeof CANONICAL_BSON_TYPES)[number];

/**
 * A canonical BSON type name. Normally one of {@link CANONICAL_BSON_TYPES};
 * exotic BSON wrappers (`minKey`, `maxKey`, `dbRef`, …) are reported under a
 * camelCased form of their `_bsontype` rather than being flattened to
 * "unknown", so the snapshot never lies about what it saw.
 */
export type BsonTypeName = CanonicalBsonType | (string & {});

/** Which population a field's counters are measured against. */
export type Denominator = 'documents' | 'arrayElements';

/** How the documents behind a snapshot were selected. */
export interface SamplingInfo {
  /**
   * `sort-limit`  — deterministic `find(filter).sort(sort).limit(n)`
   * `random-sample` — `$sample`, unbiased but not reproducible
   * `input-file`  — documents read from a local JSON/NDJSON file
   */
  mode: 'sort-limit' | 'random-sample' | 'input-file';
  /** Requested maximum number of documents. */
  sampleSize: number;
  /** Query filter actually used. `{}` for `input-file`. */
  filter: Record<string, unknown>;
  /** Sort actually used, or `null` when the mode does not sort. */
  sort: Record<string, number> | null;
}

/** Observed statistics for exactly one path. */
export interface FieldStat {
  /** Dotted path; array elements are marked with an `items[]` segment. */
  path: string;
  denominator: Denominator;
  /**
   * For `arrayElements` paths: the path of the nearest enclosing array, whose
   * element count is this path's `observedUnits`. Absent for `documents` paths.
   */
  arrayParent?: string;
  /** Size of the population this path was measured against. */
  observedUnits: number;
  /** Units in which the key was present (including `null` and `""`). */
  presentCount: number;
  /** Units in which the value was BSON `null`. Subset of `presentCount`. */
  nullCount: number;
  /** Units in which the value was `""`. Subset of `presentCount`. Context only. */
  emptyStringCount: number;
  /** Per-type counts. Sums to `presentCount`. */
  bsonTypes: Record<string, number>;
}

/** A field-schema snapshot. This is the on-disk file format. */
export interface Snapshot {
  formatVersion: 1;
  /** e.g. `docpulse@0.1.1` */
  tool: string;
  /** Free-text label from `--label`, or `null`. */
  label: string | null;
  /** ISO-8601 timestamp. The only field expected to differ between two runs. */
  createdAt: string;
  /** `db.collection` for MongoDB, or `input:<basename>` for a local file. */
  collection: string;
  sampling: SamplingInfo;
  /** How many documents were actually consumed. */
  sampledDocs: number;
  /** Best-effort collection size, or `null` when unavailable. */
  estimatedTotalDocs: number | null;
  /** How `estimatedTotalDocs` was obtained. */
  estimatedTotalDocsMethod: string;
  /** Sorted by `path`, one entry per observed path. */
  fields: FieldStat[];
}

export const FINDING_TYPES = [
  'field_disappeared',
  'field_appeared',
  'type_changed',
  'presence_dropped',
  'null_ratio_increased',
] as const;

export type FindingType = (typeof FINDING_TYPES)[number];

export type Severity = 'error' | 'warning' | 'info';

/** Machine-readable numbers behind a finding, for the JSON reporter. */
export interface FindingMetrics {
  baselinePresenceRatio?: number;
  currentPresenceRatio?: number;
  presenceDropPp?: number;
  baselineNullRatio?: number;
  currentNullRatio?: number;
  nullRatioIncreasePp?: number;
  baselineTypes?: string[];
  currentTypes?: string[];
  baselineDenominator?: Denominator;
  currentDenominator?: Denominator;
  baselineObservedUnits?: number;
  currentObservedUnits?: number;
}

/** One drift that crossed a configured threshold. */
export interface Finding {
  type: FindingType;
  severity: Severity;
  path: string;
  /** Human-readable `baseline → current` cell, e.g. `int → int, string`. */
  change: string;
  /** Sample-size cell, e.g. `4102 → 3987 array elements`. */
  sample: string;
  /** What the operator should do about it. */
  suggestedAction: string;
  metrics: FindingMetrics;
}

export type SuppressionReason = 'ignored' | 'below_threshold' | 'low_sample_unit';

/** A path that was looked at and deliberately not reported. */
export interface Suppressed {
  path: string;
  reason: SuppressionReason;
  detail: string;
}

/** Why a comparison was refused outright. */
export interface Refusal {
  code:
    | 'collection_mismatch'
    | 'format_version_mismatch'
    | 'sampling_mismatch';
  message: string;
  /** Multi-line evidence printed under the message. */
  detail: string;
}

/** Thresholds and ignore rules. Every field has a default. */
export interface Config {
  /** Percentage-point drop in presence ratio that raises `presence_dropped`. */
  presenceDropPct: number;
  /** Percentage-point rise in null-among-present that raises `null_ratio_increased`. */
  nullRatioIncreasePct: number;
  /** Below this many sampled units, findings are downgraded to `info`. */
  minSampledDocs: number;
  /** A baseline path below this presence ratio cannot "disappear". */
  minPresenceToTrackPct: number;
  /** A new path below this presence ratio is not reported as "appeared". */
  newFieldMinPresencePct: number;
  /** A BSON type below this share of `presentCount` is noise, not a type. */
  typeNoiseFloorPct: number;
  /** Collapse `int|long|double|decimal` to `number` in the diff only. */
  treatNumericTypesAsEquivalent: boolean;
  /** Paths (and their subtrees) skipped entirely. */
  ignorePaths: string[];
}

/** Snapshot header data the reporters need. */
export interface SnapshotMeta {
  label: string | null;
  collection: string;
  sampledDocs: number;
  createdAt: string;
  sampling: SamplingInfo;
}

/** Result of comparing two snapshots. */
export interface DiffResult {
  findings: Finding[];
  /** Non-fatal messages for the report header. */
  warnings: string[];
  suppressed: Suppressed[];
  /** Present iff the comparison was refused; `findings` is then empty. */
  refusal?: Refusal;
  /** True when either snapshot is below `minSampledDocs`. */
  lowSample: boolean;
  config: Config;
  baseline: SnapshotMeta;
  current: SnapshotMeta;
}

/**
 * Where documents come from. Deliberately the only seam between inference and
 * MongoDB, so the entire unit suite runs with no database.
 */
export interface DocumentSource {
  /** `db.collection` or `input:<basename>`. */
  readonly collection: string;
  /** How this source selects documents. */
  readonly sampling: SamplingInfo;
  /** Yields at most `sampling.sampleSize` documents. */
  documents(): AsyncIterable<Record<string, unknown>>;
  /** Best-effort total size of the underlying population. */
  estimatedTotal(): Promise<{ count: number | null; method: string }>;
  /** Release any resources. Safe to call more than once. */
  close(): Promise<void>;
}
