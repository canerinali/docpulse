import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  diffSnapshots,
  hasActionableFindings,
  isIgnored,
  nullRatio,
  presenceRatio,
  significantTypes,
} from '../src/core/diff.js';
import type { Config, Finding } from '../src/core/types.js';
import { docField, elemField, snap } from './helpers/snapshots.js';

function cfg(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function typesOf(findings: Finding[]): string[] {
  return findings.map((f) => f.type);
}

describe('one test per finding type', () => {
  it('field_disappeared', () => {
    const a = snap({ fields: [docField('legacyFlag', { units: 1000, present: 800, types: { bool: 800 } })] });
    const b = snap({ fields: [] });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['field_disappeared']);
    expect(result.findings[0]).toMatchObject({
      path: 'legacyFlag',
      severity: 'error',
      change: '80.0% → absent',
      sample: '1000 → 1000 documents',
    });
  });

  it('field_appeared', () => {
    const a = snap({ fields: [] });
    const b = snap({ fields: [docField('loyaltyTier', { units: 1000, present: 300, types: { string: 300 } })] });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['field_appeared']);
    expect(result.findings[0]).toMatchObject({
      path: 'loyaltyTier',
      severity: 'warning',
      change: 'absent → 30.0%',
    });
  });

  it('type_changed', () => {
    const a = snap({
      fields: [elemField('lines.items[].qty', 'lines', { units: 4102, present: 4102, types: { int: 4102 } })],
    });
    const b = snap({
      fields: [
        elemField('lines.items[].qty', 'lines', {
          units: 3987,
          present: 3987,
          types: { int: 2987, string: 1000 },
        }),
      ],
    });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['type_changed']);
    expect(result.findings[0]).toMatchObject({
      path: 'lines.items[].qty',
      severity: 'error',
      change: 'number → number, string',
      sample: '4102 → 3987 array elements',
      suggestedAction:
        'A producer is sending numbers as strings; find it before your aggregations silently drop rows.',
    });
  });

  it('presence_dropped', () => {
    const a = snap({ fields: [docField('customer.taxId', { units: 1000, present: 412, types: { string: 412 } })] });
    const b = snap({ fields: [docField('customer.taxId', { units: 1000, present: 124, types: { string: 124 } })] });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['presence_dropped']);
    expect(result.findings[0]).toMatchObject({
      severity: 'error',
      change: '41.2% → 12.4% (-28.8pp)',
      sample: '1000 → 1000 documents',
    });
    expect(result.findings[0]?.metrics.presenceDropPp).toBeCloseTo(28.8, 6);
  });

  it('null_ratio_increased', () => {
    const a = snap({
      fields: [docField('payment.provider', { units: 1000, present: 1000, nulls: 21, types: { null: 21, string: 979 } })],
    });
    const b = snap({
      fields: [docField('payment.provider', { units: 1000, present: 1000, nulls: 198, types: { null: 198, string: 802 } })],
    });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['null_ratio_increased']);
    expect(result.findings[0]).toMatchObject({
      severity: 'warning',
      change: '2.1% → 19.8% null of present (+17.7pp)',
    });
  });
});

describe('suppression and ordering', () => {
  it('field_disappeared suppresses presence_dropped on the same path', () => {
    const a = snap({ fields: [docField('legacyFlag', { units: 1000, present: 900, types: { bool: 900 } })] });
    const b = snap({ fields: [docField('legacyFlag', { units: 1000, present: 0, types: {} })] });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['field_disappeared']);
    expect(result.findings[0]?.change).toBe('90.0% → 0.0%');
  });

  it('field_appeared suppresses the other three on the same path', () => {
    const a = snap({ fields: [docField('flag', { units: 1000, present: 0, types: {} })] });
    const b = snap({ fields: [docField('flag', { units: 1000, present: 700, nulls: 400, types: { null: 400, string: 300 } })] });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['field_appeared']);
  });

  it('orders findings by severity, then by finding type, then by path', () => {
    const a = snap({
      fields: [
        docField('customer.taxId', { units: 1000, present: 412, types: { string: 412 } }),
        docField('payment.provider', { units: 1000, present: 1000, nulls: 21, types: { null: 21, string: 979 } }),
        elemField('lines.items[].qty', 'lines', { units: 4102, present: 4102, types: { int: 4102 } }),
      ],
    });
    const b = snap({
      fields: [
        docField('customer.taxId', { units: 1000, present: 124, types: { string: 124 } }),
        docField('payment.provider', { units: 1000, present: 1000, nulls: 198, types: { null: 198, string: 802 } }),
        elemField('lines.items[].qty', 'lines', { units: 3987, present: 3987, types: { int: 2987, string: 1000 } }),
      ],
    });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual([
      'type_changed',
      'presence_dropped',
      'null_ratio_increased',
    ]);
  });
});

describe('thresholds', () => {
  const baseline = snap({ fields: [docField('f', { units: 1000, present: 500, types: { string: 500 } })] });

  it('a 9pp drop with presenceDropPct 10 yields nothing', () => {
    const b = snap({ fields: [docField('f', { units: 1000, present: 410, types: { string: 410 } })] });
    const result = diffSnapshots(baseline, b, cfg());
    expect(result.findings).toEqual([]);
    expect(result.suppressed.some((s) => s.path === 'f' && s.reason === 'below_threshold')).toBe(true);
  });

  it('an 11pp drop with presenceDropPct 10 yields a finding', () => {
    const b = snap({ fields: [docField('f', { units: 1000, present: 390, types: { string: 390 } })] });
    expect(typesOf(diffSnapshots(baseline, b, cfg()).findings)).toEqual(['presence_dropped']);
  });

  it('never reports a presence increase', () => {
    const b = snap({ fields: [docField('f', { units: 1000, present: 900, types: { string: 900 } })] });
    expect(diffSnapshots(baseline, b, cfg()).findings).toEqual([]);
  });

  it('never reports a null-ratio decrease', () => {
    const a = snap({ fields: [docField('f', { units: 1000, present: 1000, nulls: 500, types: { null: 500, string: 500 } })] });
    const b = snap({ fields: [docField('f', { units: 1000, present: 1000, nulls: 10, types: { null: 10, string: 990 } })] });
    expect(diffSnapshots(a, b, cfg()).findings).toEqual([]);
  });

  it('a new field below newFieldMinPresencePct is not reported', () => {
    const a = snap({ fields: [] });
    const b = snap({ fields: [docField('rare', { units: 1000, present: 40, types: { string: 40 } })] });
    const result = diffSnapshots(a, b, cfg());
    expect(result.findings).toEqual([]);
    expect(result.suppressed[0]?.detail).toContain('newFieldMinPresencePct');
  });

  it('a vanished field below minPresenceToTrackPct is not reported', () => {
    const a = snap({ fields: [docField('rare', { units: 1000, present: 40, types: { string: 40 } })] });
    const b = snap({ fields: [] });
    const result = diffSnapshots(a, b, cfg());
    expect(result.findings).toEqual([]);
    expect(result.suppressed[0]?.detail).toContain('minPresenceToTrackPct');
  });
});

describe('type semantics', () => {
  const a = snap({ fields: [docField('amount', { units: 1000, present: 1000, types: { int: 1000 } })] });
  const b = snap({ fields: [docField('amount', { units: 1000, present: 1000, types: { double: 1000 } })] });

  it('int -> double is not a type_changed by default', () => {
    expect(diffSnapshots(a, b, cfg()).findings).toEqual([]);
  });

  it('int -> double is a type_changed with treatNumericTypesAsEquivalent: false', () => {
    const result = diffSnapshots(a, b, cfg({ treatNumericTypesAsEquivalent: false }));
    expect(typesOf(result.findings)).toEqual(['type_changed']);
    expect(result.findings[0]?.change).toBe('int → double');
  });

  it('a type present in 0.5% of documents is filtered by typeNoiseFloorPct', () => {
    const before = snap({ fields: [docField('sku', { units: 1000, present: 1000, types: { string: 1000 } })] });
    const after = snap({ fields: [docField('sku', { units: 1000, present: 1000, types: { string: 995, int: 5 } })] });
    const result = diffSnapshots(before, after, cfg());
    expect(result.findings).toEqual([]);
    expect(result.suppressed.some((s) => s.detail.includes('typeNoiseFloorPct'))).toBe(true);

    // ...and is reported once the floor is lowered below its share.
    const strict = diffSnapshots(before, after, cfg({ typeNoiseFloorPct: 0.1 }));
    expect(typesOf(strict.findings)).toEqual(['type_changed']);
  });

  it('collapses numerics before applying the noise floor', () => {
    // 0.6% int + 0.6% double is 1.2% of `number`: significant, not noise.
    const stat = docField('n', { units: 1000, present: 1000, types: { string: 988, int: 6, double: 6 } });
    expect([...significantTypes(stat, cfg())].sort()).toEqual(['number', 'string']);
  });

  it('turns a denominator change into a type_changed and never a presence drop', () => {
    const before = snap({ fields: [docField('payload', { units: 1000, present: 1000, types: { object: 1000 } })] });
    const after = snap({
      fields: [elemField('payload', 'wrapper', { units: 200, present: 60, types: { object: 60 } })],
    });
    const result = diffSnapshots(before, after, cfg({ minSampledDocs: 0 }));
    expect(typesOf(result.findings)).toEqual(['type_changed']);
    expect(result.findings[0]?.change).toBe('object (documents) → object (array elements)');
    expect(result.findings[0]?.metrics).toMatchObject({
      baselineDenominator: 'documents',
      currentDenominator: 'arrayElements',
    });
  });
});

describe('minSampledDocs', () => {
  it('downgrades every finding to info and disarms --fail-on-drift', () => {
    const a = snap({ sampledDocs: 100, fields: [docField('f', { units: 100, present: 90, types: { string: 90 } })] });
    const b = snap({ sampledDocs: 100, fields: [docField('f', { units: 100, present: 40, types: { string: 40 } })] });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['presence_dropped']);
    expect(result.findings.every((f) => f.severity === 'info')).toBe(true);
    expect(result.lowSample).toBe(true);
    expect(result.warnings.join('\n')).toContain('below minSampledDocs');
    expect(hasActionableFindings(result)).toBe(false);
  });

  it('keeps full severity once both snapshots reach the threshold', () => {
    const a = snap({ sampledDocs: 500, fields: [docField('f', { units: 500, present: 450, types: { string: 450 } })] });
    const b = snap({ sampledDocs: 500, fields: [docField('f', { units: 500, present: 200, types: { string: 200 } })] });
    const result = diffSnapshots(a, b, cfg());
    expect(result.lowSample).toBe(false);
    expect(result.findings[0]?.severity).toBe('error');
    expect(hasActionableFindings(result)).toBe(true);
  });

  it('applies the same rule per-path to thin array-element paths', () => {
    const a = snap({
      fields: [elemField('lines.items[].sku', 'lines', { units: 120, present: 120, types: { string: 120 } })],
    });
    const b = snap({
      fields: [elemField('lines.items[].sku', 'lines', { units: 118, present: 20, types: { string: 20 } })],
    });
    const result = diffSnapshots(a, b, cfg());
    expect(typesOf(result.findings)).toEqual(['presence_dropped']);
    expect(result.findings[0]?.severity).toBe('info');
    expect(hasActionableFindings(result)).toBe(false);
  });
});

describe('refusals', () => {
  const a = snap({ fields: [docField('f', { units: 1000, present: 1000, types: { string: 1000 } })] });

  it('refuses a filter mismatch', () => {
    const b = snap({
      fields: a.fields,
      sampling: { filter: { status: 'paid' } },
    });
    const result = diffSnapshots(a, b, cfg());
    expect(result.refusal?.code).toBe('sampling_mismatch');
    expect(result.findings).toEqual([]);
    expect(result.refusal?.detail).toContain('{"status":"paid"}');
  });

  it('proceeds with a warning under --allow-filter-mismatch', () => {
    const b = snap({
      fields: [docField('f', { units: 1000, present: 500, types: { string: 500 } })],
      sampling: { filter: { status: 'paid' } },
    });
    const result = diffSnapshots(a, b, cfg(), { allowFilterMismatch: true });
    expect(result.refusal).toBeUndefined();
    expect(typesOf(result.findings)).toEqual(['presence_dropped']);
    expect(result.warnings.join('\n')).toContain('--allow-filter-mismatch');
  });

  it('refuses a sampling-mode mismatch too', () => {
    const b = snap({ fields: a.fields, sampling: { mode: 'random-sample', sort: null } });
    expect(diffSnapshots(a, b, cfg()).refusal?.code).toBe('sampling_mismatch');
  });

  it('canonicalises filters, so key order alone is not a mismatch', () => {
    const left = snap({ fields: a.fields, sampling: { filter: { a: 1, b: { d: 4, c: 3 } } } });
    const right = snap({ fields: a.fields, sampling: { filter: { b: { c: 3, d: 4 }, a: 1 } } });
    expect(diffSnapshots(left, right, cfg()).refusal).toBeUndefined();
  });

  it('always refuses a collection mismatch, even with --allow-filter-mismatch', () => {
    const b = snap({ fields: a.fields, collection: 'shop.invoices' });
    const result = diffSnapshots(a, b, cfg(), { allowFilterMismatch: true });
    expect(result.refusal?.code).toBe('collection_mismatch');
    expect(result.refusal?.detail).toContain('shop.invoices');
  });

  it('always refuses a formatVersion mismatch, even with --allow-filter-mismatch', () => {
    const b = snap({ fields: a.fields, formatVersion: 2 });
    const result = diffSnapshots(a, b, cfg(), { allowFilterMismatch: true });
    expect(result.refusal?.code).toBe('format_version_mismatch');
  });
});

describe('ignorePaths', () => {
  it('drops an ignored path entirely', () => {
    const a = snap({
      fields: [
        docField('_id', { units: 1000, present: 1000, types: { objectId: 1000 } }),
        docField('updatedAt', { units: 1000, present: 1000, types: { date: 1000 } }),
      ],
    });
    const b = snap({ fields: [docField('_id', { units: 1000, present: 1000, types: { objectId: 1000 } })] });
    const result = diffSnapshots(a, b, cfg());
    expect(result.findings).toEqual([]);
    expect(result.suppressed.map((s) => [s.path, s.reason])).toEqual([
      ['_id', 'ignored'],
      ['updatedAt', 'ignored'],
    ]);
  });

  it('ignores the whole subtree under an entry', () => {
    expect(isIgnored('lines.items[].sku', ['lines'])).toBe(true);
    expect(isIgnored('customer.taxId', ['customer'])).toBe(true);
    expect(isIgnored('linesTotal', ['lines'])).toBe(false);
  });
});

describe('ratio helpers', () => {
  it('returns 0 rather than NaN for empty populations', () => {
    expect(presenceRatio(undefined)).toBe(0);
    expect(presenceRatio(docField('x', { units: 0, present: 0, types: {} }))).toBe(0);
    expect(nullRatio(docField('x', { units: 10, present: 0, types: {} }))).toBe(0);
  });
});
