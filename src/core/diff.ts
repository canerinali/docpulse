import { collapseNumericType } from './bsonType.js';
import { canonicalStringify } from './snapshotSchema.js';
import type {
  Config,
  Denominator,
  DiffResult,
  FieldStat,
  Finding,
  FindingMetrics,
  FindingType,
  Severity,
  Snapshot,
  SnapshotMeta,
  Suppressed,
} from './types.js';

export interface DiffOptions {
  /** Downgrade a filter/sampling mismatch from a refusal to a warning. */
  allowFilterMismatch?: boolean;
}

const SEVERITY_BY_TYPE: Record<FindingType, Severity> = {
  field_disappeared: 'error',
  field_appeared: 'warning',
  type_changed: 'error',
  presence_dropped: 'error',
  null_ratio_increased: 'warning',
};

const TYPE_ORDER: FindingType[] = [
  'field_disappeared',
  'field_appeared',
  'type_changed',
  'presence_dropped',
  'null_ratio_increased',
];

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info'];

/** presentCount / observedUnits, 0 when nothing was observed. */
export function presenceRatio(stat: FieldStat | undefined): number {
  if (stat === undefined || stat.observedUnits === 0) return 0;
  return stat.presentCount / stat.observedUnits;
}

/** nullCount / presentCount — null *among present*, 0 when nothing is present. */
export function nullRatio(stat: FieldStat | undefined): number {
  if (stat === undefined || stat.presentCount === 0) return 0;
  return stat.nullCount / stat.presentCount;
}

/**
 * The BSON types that matter for `p`: counts are first collapsed (when
 * `treatNumericTypesAsEquivalent`), then a bucket must hold at least
 * `typeNoiseFloorPct` of `presentCount` to count as a type rather than noise.
 */
export function significantTypes(stat: FieldStat | undefined, config: Config): Set<string> {
  const out = new Set<string>();
  if (stat === undefined || stat.presentCount === 0) return out;

  const buckets = new Map<string, number>();
  for (const [type, count] of Object.entries(stat.bsonTypes)) {
    const key = config.treatNumericTypesAsEquivalent ? collapseNumericType(type) : type;
    buckets.set(key, (buckets.get(key) ?? 0) + count);
  }

  const floor = config.typeNoiseFloorPct / 100;
  for (const [type, count] of buckets) {
    if (count / stat.presentCount >= floor) out.add(type);
  }
  return out;
}

/** True when `path` is covered by an `ignorePaths` entry (exact match or subtree). */
export function isIgnored(path: string, ignorePaths: readonly string[]): boolean {
  return ignorePaths.some((entry) => path === entry || path.startsWith(`${entry}.`));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function sortedTypes(types: Set<string>): string[] {
  return [...types].sort();
}

function renderTypes(types: Set<string>): string {
  return types.size === 0 ? 'none' : sortedTypes(types).join(', ');
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function pp(delta: number): string {
  const value = delta * 100;
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${Math.abs(value).toFixed(1)}pp`;
}

function unitLabel(denominator: Denominator): string {
  return denominator === 'documents' ? 'documents' : 'array elements';
}

function unitsOf(stat: FieldStat | undefined, snapshot: Snapshot): number {
  if (stat !== undefined) return stat.observedUnits;
  return snapshot.sampledDocs;
}

function sampleCell(
  a: FieldStat | undefined,
  b: FieldStat | undefined,
  baseline: Snapshot,
  current: Snapshot,
): string {
  const denominator: Denominator = a?.denominator ?? b?.denominator ?? 'documents';
  return `${unitsOf(a, baseline)} → ${unitsOf(b, current)} ${unitLabel(denominator)}`;
}

function metaOf(snapshot: Snapshot): SnapshotMeta {
  return {
    label: snapshot.label,
    collection: snapshot.collection,
    sampledDocs: snapshot.sampledDocs,
    createdAt: snapshot.createdAt,
    sampling: snapshot.sampling,
  };
}

function suggestedAction(type: FindingType, from: Set<string>, to: Set<string>): string {
  switch (type) {
    case 'field_disappeared':
      return 'The field is absent from the whole sample. Confirm the producer was retired on purpose, then re-baseline.';
    case 'field_appeared':
      return 'A field you have no contract for is being written. Add it to the contract, or to ignorePaths.';
    case 'type_changed':
      if (!from.has('string') && to.has('string') && (from.has('number') || from.has('int') || from.has('long') || from.has('double') || from.has('decimal'))) {
        return 'A producer is sending numbers as strings; find it before your aggregations silently drop rows.';
      }
      return 'A producer changed the value type. Fix the writer, or widen the contract deliberately.';
    case 'presence_dropped':
      return 'Confirm the field is still being written; if it was intentionally retired, re-baseline.';
    case 'null_ratio_increased':
      return 'Upstream is writing nulls instead of omitting the field; decide which contract you want.';
  }
}

/**
 * Compare two snapshots and report only drifts that cross `config`'s thresholds.
 *
 * Refusals (collection, formatVersion, sampling) short-circuit: the result then
 * carries a `refusal` and no findings at all.
 */
export function diffSnapshots(
  baseline: Snapshot,
  current: Snapshot,
  config: Config,
  options: DiffOptions = {},
): DiffResult {
  const warnings: string[] = [];
  const base: Omit<DiffResult, 'findings' | 'suppressed' | 'lowSample'> = {
    warnings,
    config,
    baseline: metaOf(baseline),
    current: metaOf(current),
  };

  // --- Refusals -------------------------------------------------------------
  if (baseline.formatVersion !== current.formatVersion) {
    return {
      ...base,
      findings: [],
      suppressed: [],
      lowSample: false,
      refusal: {
        code: 'format_version_mismatch',
        message: 'refusing to compare snapshots with different formatVersion',
        detail: `baseline: formatVersion ${baseline.formatVersion}\ncurrent:  formatVersion ${current.formatVersion}`,
      },
    };
  }

  if (baseline.collection !== current.collection) {
    return {
      ...base,
      findings: [],
      suppressed: [],
      lowSample: false,
      refusal: {
        code: 'collection_mismatch',
        message: 'refusing to compare snapshots of different collections',
        detail: `baseline: ${baseline.collection}\ncurrent:  ${current.collection}`,
      },
    };
  }

  const filterA = canonicalStringify(baseline.sampling.filter);
  const filterB = canonicalStringify(current.sampling.filter);
  const samplingMismatch =
    filterA !== filterB || baseline.sampling.mode !== current.sampling.mode;

  if (samplingMismatch) {
    const detail =
      `baseline: mode=${baseline.sampling.mode} filter=${filterA}\n` +
      `current:  mode=${current.sampling.mode} filter=${filterB}`;
    if (options.allowFilterMismatch !== true) {
      return {
        ...base,
        findings: [],
        suppressed: [],
        lowSample: false,
        refusal: {
          code: 'sampling_mismatch',
          message:
            'refusing to compare snapshots taken with different sampling — a presence drop caused by a narrower query is not drift',
          detail: `${detail}\nRe-run with --allow-filter-mismatch if you know the difference is harmless.`,
        },
      };
    }
    warnings.push(
      `sampling differs between the two snapshots and --allow-filter-mismatch was given; ` +
        `presence changes below may be an artefact of the query, not drift. ${detail.replace(/\n/g, ' | ')}`,
    );
  }

  // --- Sample-size gate -----------------------------------------------------
  const lowSample =
    baseline.sampledDocs < config.minSampledDocs || current.sampledDocs < config.minSampledDocs;
  if (lowSample) {
    warnings.push(
      `sampledDocs (${baseline.sampledDocs} → ${current.sampledDocs}) is below minSampledDocs ` +
        `(${config.minSampledDocs}); every finding is downgraded to info and --fail-on-drift will not fail. ` +
        `At small n the confidence interval around a presence ratio is wider than the thresholds.`,
    );
  }

  // --- Per-path evaluation --------------------------------------------------
  const mapA = new Map(baseline.fields.map((f) => [f.path, f]));
  const mapB = new Map(current.fields.map((f) => [f.path, f]));
  const paths = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();

  const findings: Finding[] = [];
  const suppressed: Suppressed[] = [];

  for (const path of paths) {
    if (isIgnored(path, config.ignorePaths)) {
      suppressed.push({ path, reason: 'ignored', detail: 'matched ignorePaths' });
      continue;
    }

    const a = mapA.get(path);
    const b = mapB.get(path);
    const rA = presenceRatio(a);
    const rB = presenceRatio(b);
    const nA = nullRatio(a);
    const nB = nullRatio(b);
    const tA = significantTypes(a, config);
    const tB = significantTypes(b, config);

    const pathFindings: Finding[] = [];
    const push = (type: FindingType, change: string, metrics: FindingMetrics): void => {
      pathFindings.push({
        type,
        severity: severityFor(type, a, b, config, lowSample),
        path,
        change,
        sample: sampleCell(a, b, baseline, current),
        suggestedAction: suggestedAction(type, tA, tB),
        metrics,
      });
    };

    // 1. field_disappeared
    if (a !== undefined && rA * 100 >= config.minPresenceToTrackPct && (b === undefined || rB === 0)) {
      push('field_disappeared', `${pct(rA)} → ${b === undefined ? 'absent' : pct(0)}`, {
        baselinePresenceRatio: rA,
        currentPresenceRatio: rB,
        presenceDropPp: (rA - rB) * 100,
        baselineTypes: sortedTypes(tA),
        currentTypes: sortedTypes(tB),
        baselineObservedUnits: unitsOf(a, baseline),
        currentObservedUnits: unitsOf(b, current),
      });
    }
    // 2. field_appeared
    else if ((a === undefined || rA === 0) && b !== undefined && rB * 100 >= config.newFieldMinPresencePct) {
      push('field_appeared', `${a === undefined ? 'absent' : pct(0)} → ${pct(rB)}`, {
        baselinePresenceRatio: rA,
        currentPresenceRatio: rB,
        baselineTypes: sortedTypes(tA),
        currentTypes: sortedTypes(tB),
        baselineObservedUnits: unitsOf(a, baseline),
        currentObservedUnits: unitsOf(b, current),
      });
    }
    // 3-5. Only comparable when the path exists on both sides.
    else if (a !== undefined && b !== undefined) {
      const denominatorChanged = a.denominator !== b.denominator;

      if (denominatorChanged) {
        push(
          'type_changed',
          `${renderTypes(tA)} (${unitLabel(a.denominator)}) → ${renderTypes(tB)} (${unitLabel(b.denominator)})`,
          {
            baselineTypes: sortedTypes(tA),
            currentTypes: sortedTypes(tB),
            baselineDenominator: a.denominator,
            currentDenominator: b.denominator,
            baselineObservedUnits: a.observedUnits,
            currentObservedUnits: b.observedUnits,
          },
        );
      } else if (!setsEqual(tA, tB)) {
        push('type_changed', `${renderTypes(tA)} → ${renderTypes(tB)}`, {
          baselineTypes: sortedTypes(tA),
          currentTypes: sortedTypes(tB),
          baselineDenominator: a.denominator,
          currentDenominator: b.denominator,
          baselineObservedUnits: a.observedUnits,
          currentObservedUnits: b.observedUnits,
        });
      }

      // A denominator change is never also a presence drop: the shape changed.
      const drop = rA - rB;
      if (!denominatorChanged && drop * 100 >= config.presenceDropPct) {
        push('presence_dropped', `${pct(rA)} → ${pct(rB)} (${pp(-drop)})`, {
          baselinePresenceRatio: rA,
          currentPresenceRatio: rB,
          presenceDropPp: drop * 100,
          baselineObservedUnits: a.observedUnits,
          currentObservedUnits: b.observedUnits,
        });
      } else if (!denominatorChanged && drop > 0) {
        suppressed.push({
          path,
          reason: 'below_threshold',
          detail: `presence ${pct(rA)} → ${pct(rB)} (${pp(-drop)}), under presenceDropPct ${config.presenceDropPct}`,
        });
      }

      const nullRise = nB - nA;
      if (nullRise * 100 >= config.nullRatioIncreasePct) {
        push('null_ratio_increased', `${pct(nA)} → ${pct(nB)} null of present (${pp(nullRise)})`, {
          baselineNullRatio: nA,
          currentNullRatio: nB,
          nullRatioIncreasePp: nullRise * 100,
          baselineObservedUnits: a.observedUnits,
          currentObservedUnits: b.observedUnits,
        });
      } else if (nullRise > 0) {
        suppressed.push({
          path,
          reason: 'below_threshold',
          detail: `null ratio ${pct(nA)} → ${pct(nB)} (${pp(nullRise)}), under nullRatioIncreasePct ${config.nullRatioIncreasePct}`,
        });
      }

      // A type set that only differs below the noise floor is deliberately quiet.
      if (pathFindings.length === 0 && rawTypesDiffer(a, b, config) && setsEqual(tA, tB)) {
        suppressed.push({
          path,
          reason: 'below_threshold',
          detail: `a BSON type below typeNoiseFloorPct ${config.typeNoiseFloorPct} appeared or vanished`,
        });
      }
    }
    // A path present on one side only, but too rare to report either way.
    else if (a !== undefined && b === undefined) {
      suppressed.push({
        path,
        reason: 'below_threshold',
        detail: `gone from the current snapshot but only ${pct(rA)} present in the baseline, under minPresenceToTrackPct ${config.minPresenceToTrackPct}`,
      });
    } else if (b !== undefined) {
      suppressed.push({
        path,
        reason: 'below_threshold',
        detail: `new, but only ${pct(rB)} present, under newFieldMinPresencePct ${config.newFieldMinPresencePct}`,
      });
    }

    findings.push(...pathFindings);
  }

  findings.sort((x, y) => {
    const bySeverity = SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity);
    if (bySeverity !== 0) return bySeverity;
    const byType = TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type);
    if (byType !== 0) return byType;
    return x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
  });

  return { ...base, findings, suppressed, lowSample };
}

function rawTypesDiffer(a: FieldStat, b: FieldStat, config: Config): boolean {
  const norm = (f: FieldStat): Set<string> =>
    new Set(
      Object.keys(f.bsonTypes).map((t) =>
        config.treatNumericTypesAsEquivalent ? collapseNumericType(t) : t,
      ),
    );
  return !setsEqual(norm(a), norm(b));
}

/**
 * `minSampledDocs` downgrades findings to `info` — globally when either
 * snapshot is too small, and per-path for array-element paths whose own
 * `observedUnits` is below the threshold.
 */
function severityFor(
  type: FindingType,
  a: FieldStat | undefined,
  b: FieldStat | undefined,
  config: Config,
  lowSample: boolean,
): Severity {
  if (lowSample) return 'info';
  const elementUnits: number[] = [];
  for (const stat of [a, b]) {
    if (stat !== undefined && stat.denominator === 'arrayElements') {
      elementUnits.push(stat.observedUnits);
    }
  }
  if (elementUnits.length > 0 && Math.min(...elementUnits) < config.minSampledDocs) {
    return 'info';
  }
  return SEVERITY_BY_TYPE[type];
}

/** True when a diff should fail a build under `--fail-on-drift`. */
export function hasActionableFindings(result: DiffResult): boolean {
  return result.findings.some((f) => f.severity !== 'info');
}
