import { TOOL_ID } from '../core/infer.js';
import type { DiffResult, Severity } from '../core/types.js';

/**
 * Machine-readable report with a stable key order, for pipelines that want to
 * do their own thing with the findings.
 */
export function renderJson(result: DiffResult): string {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of result.findings) counts[f.severity] += 1;

  const payload = {
    tool: TOOL_ID,
    collection: result.baseline.collection,
    baseline: {
      label: result.baseline.label,
      createdAt: result.baseline.createdAt,
      sampledDocs: result.baseline.sampledDocs,
    },
    current: {
      label: result.current.label,
      createdAt: result.current.createdAt,
      sampledDocs: result.current.sampledDocs,
    },
    thresholds: {
      presenceDropPct: result.config.presenceDropPct,
      nullRatioIncreasePct: result.config.nullRatioIncreasePct,
      minSampledDocs: result.config.minSampledDocs,
      minPresenceToTrackPct: result.config.minPresenceToTrackPct,
      newFieldMinPresencePct: result.config.newFieldMinPresencePct,
      typeNoiseFloorPct: result.config.typeNoiseFloorPct,
      treatNumericTypesAsEquivalent: result.config.treatNumericTypesAsEquivalent,
      ignorePaths: result.config.ignorePaths,
    },
    lowSample: result.lowSample,
    refusal: result.refusal ?? null,
    warnings: result.warnings,
    summary: {
      findings: result.findings.length,
      error: counts.error,
      warning: counts.warning,
      info: counts.info,
      suppressed: result.suppressed.length,
    },
    findings: result.findings.map((f) => ({
      type: f.type,
      severity: f.severity,
      path: f.path,
      change: f.change,
      sample: f.sample,
      suggestedAction: f.suggestedAction,
      metrics: f.metrics,
    })),
    suppressed: result.suppressed.map((s) => ({
      path: s.path,
      reason: s.reason,
      detail: s.detail,
    })),
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}
