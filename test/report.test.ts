import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { diffSnapshots } from '../src/core/diff.js';
import { validateSnapshot } from '../src/core/snapshotSchema.js';
import { renderJson, renderMarkdown, renderReport, renderTable } from '../src/report/index.js';
import type { Snapshot } from '../src/core/types.js';
import { docField, snap } from './helpers/snapshots.js';

function example(name: string): Snapshot {
  const text = readFileSync(new URL(`../examples/${name}.snapshot.json`, import.meta.url), 'utf8');
  return validateSnapshot(JSON.parse(text), name);
}

const BASELINE = example('baseline');
const CURRENT = example('current');
const FULL = diffSnapshots(BASELINE, CURRENT, DEFAULT_CONFIG);

describe('markdown reporter', () => {
  it('renders one row per finding type', () => {
    expect(renderMarkdown(FULL)).toMatchInlineSnapshot(`
      "# docpulse drift report

      \`shop.orders\` — baseline \`prod-2026-09-19\` (1000 docs) → current \`prod-2026-09-26\` (1000 docs)
      **5 findings** (3 error, 2 warning) · thresholds: presenceDrop 10pp, nullRatioIncrease 10pp, minSampledDocs 500

      | # | Finding | Path | Baseline → Current | Sample | Suggested action |
      |---|---|---|---|---|---|
      | 1 | \`field_disappeared\` | \`legacyCouponCode\` | 64.0% → absent | 1000 → 1000 documents | The field is absent from the whole sample. Confirm the producer was retired on purpose, then re-baseline. |
      | 2 | \`type_changed\` | \`lines.items[].qty\` | \`number\` → \`number, string\` | 4102 → 3987 array elements | A producer is sending numbers as strings; find it before your aggregations silently drop rows. |
      | 3 | \`presence_dropped\` | \`customer.taxId\` | 41.2% → 12.4% (-28.8pp) | 1000 → 1000 documents | Confirm the field is still being written; if it was intentionally retired, re-baseline. |
      | 4 | \`field_appeared\` | \`fulfilmentProvider\` | absent → 38.0% | 1000 → 1000 documents | A field you have no contract for is being written. Add it to the contract, or to ignorePaths. |
      | 5 | \`null_ratio_increased\` | \`payment.provider\` | 2.1% → 19.8% null of present (+17.7pp) | 1000 → 1000 documents | Upstream is writing nulls instead of omitting the field; decide which contract you want. |

      <details><summary>Suppressed (below threshold or in ignorePaths): 4</summary>

      - \`_id\` — matched ignorePaths
      - \`lines.items[].sku\` — presence 99.9% → 99.8% (-0.1pp), under presenceDropPct 10
      - \`notes\` — presence 30.0% → 26.0% (-4.0pp), under presenceDropPct 10
      - \`updatedAt\` — matched ignorePaths

      </details>
      "
    `);
  });

  it('says so plainly when nothing crossed a threshold', () => {
    const clean = diffSnapshots(BASELINE, BASELINE, DEFAULT_CONFIG);
    const md = renderMarkdown(clean);
    expect(md).toContain('**0 findings**');
    expect(md).toContain('No drift crossed the configured thresholds.');
    expect(md).not.toContain('| # | Finding |');
  });

  it('renders a refusal instead of a table', () => {
    const other = { ...CURRENT, collection: 'shop.invoices' };
    const md = renderMarkdown(diffSnapshots(BASELINE, other, DEFAULT_CONFIG));
    expect(md).toContain('## Comparison refused: `collection_mismatch`');
    expect(md).toContain('shop.invoices');
    expect(md).not.toContain('| # | Finding |');
  });

  it('renders warnings as blockquotes', () => {
    const small = { ...BASELINE, sampledDocs: 100 };
    const md = renderMarkdown(diffSnapshots(small, { ...CURRENT, sampledDocs: 100 }, DEFAULT_CONFIG));
    expect(md).toContain('> **Warning:**');
    expect(md).toContain('below minSampledDocs');
  });

  it('cannot be escaped by a document key: no injected rows, headings or HTML', () => {
    // A field path is a document key, and the report is pasted into a GitHub
    // job summary. A newline plus a backtick would otherwise close the code
    // span, end the row and let the key write its own Markdown.
    const evil = 'ok`\n\n## INJECTED\n\n<img src=x onerror=alert(1)>\n\n| 9 | `all_clear` | `x` | y | z | w |';
    const a = snap({ fields: [docField('safe', { units: 1000, present: 1000, types: { int: 1000 } })] });
    const b = snap({
      fields: [
        docField('safe', { units: 1000, present: 1000, types: { int: 1000 } }),
        docField(evil, { units: 1000, present: 1000, types: { int: 1000 } }),
      ],
    });
    const md = renderMarkdown(diffSnapshots(a, b, DEFAULT_CONFIG));

    // Nothing the key contains reaches the start of a line, so it can be
    // neither a heading, nor a new table row, nor a raw HTML block.
    const lines = md.split('\n');
    expect(lines.filter((l) => /^#/.test(l))).toEqual(['# docpulse drift report']);
    expect(lines.some((l) => /^</.test(l.trim()) && l.includes('img'))).toBe(false);
    expect(lines.filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(1);
    // It is rendered, just neutered: visible escapes instead of real control
    // characters and a real backtick.
    expect(md).toContain('\\n');
    expect(md).toContain('\\u0060');
  });

  it('sanitises a label, a collection name and a BSON type name from a snapshot file', () => {
    const a = snap({
      collection: 'shop.ord`ers',
      label: 'wk\n# OWNED',
      fields: [docField('f', { units: 1000, present: 1000, types: { int: 1000 } })],
    });
    const b = snap({
      collection: 'shop.ord`ers',
      label: 'wk39',
      fields: [docField('f', { units: 1000, present: 1000, types: { 'evil`\ntype': 1000 } })],
    });
    const md = renderMarkdown(diffSnapshots(a, b, DEFAULT_CONFIG));
    const lines = md.split('\n');
    expect(lines.filter((l) => /^#/.test(l))).toEqual(['# docpulse drift report']);
    expect(lines.some((l) => /^type/.test(l))).toBe(false);
    // Header line: both the collection and the label are on it, escaped.
    expect(lines[2]).toContain('shop.ord\\u0060ers');
    expect(lines[2]).toContain('wk\\n# OWNED');
  });

  it('does not let a snapshot file write live Markdown into the warning blockquote', () => {
    const filter = { '<img src=x onerror=alert(1)>': '[click](https://evil.example) **bold**' };
    const a = snap({
      fields: [docField('f', { units: 1000, present: 1000, types: { int: 1000 } })],
      sampling: { filter },
    });
    const b = snap({ fields: a.fields, sampling: { filter: {} } });
    const md = renderMarkdown(diffSnapshots(a, b, DEFAULT_CONFIG, { allowFilterMismatch: true }));
    const warning = md.split('\n').find((l) => l.startsWith('> **Warning:**')) as string;

    expect(warning).toContain('\\[click\\]');
    expect(warning).toContain('\\*\\*bold\\*\\*');
    expect(warning).toContain('\\<img src=x');
    expect(warning).not.toContain('[click](');
    expect(warning).not.toContain('**bold**');
  });

  it('renders the mismatched filters inside a code span, not as prose', () => {
    // A filter key cannot be a live link twice over: the JSON is inside a code
    // span, and the punctuation that starts an inline construct is escaped
    // inside it as well.
    const filter = { 'a]': '[click](https://evil.example)' };
    const a = snap({
      fields: [docField('f', { units: 1000, present: 1000, types: { int: 1000 } })],
      sampling: { filter },
    });
    const b = snap({ fields: a.fields, sampling: { filter: {} } });
    const md = renderMarkdown(diffSnapshots(a, b, DEFAULT_CONFIG, { allowFilterMismatch: true }));
    const warning = md.split('\n').find((l) => l.startsWith('> **Warning:**')) as string;

    // Two code spans (one filter each), so an even number of backticks and no
    // stray one that could swallow the rest of the report.
    const spans = warning.match(/`[^`]*`/g) ?? [];
    expect(spans).toHaveLength(2);
    expect((warning.match(/`/g) ?? []).length).toBe(4);
    expect(spans[0]).toContain('click');
    expect(warning).toContain('filter=`');

    // Everything hostile is inside a span, and escaped inside it too.
    expect(warning).not.toMatch(/\[click\]\(https:\/\/evil\.example\)/);
    expect(warning).toContain('\\[click\\]');

    // The backtick a filter key could carry cannot close the span docpulse
    // opened: it is escaped to its printable form first.
    const hostile = { 'x`y': 1 };
    const c = snap({
      fields: [docField('f', { units: 1000, present: 1000, types: { int: 1000 } })],
      sampling: { filter: hostile },
    });
    const backticked = renderMarkdown(
      diffSnapshots(c, b, DEFAULT_CONFIG, { allowFilterMismatch: true }),
    )
      .split('\n')
      .find((l) => l.startsWith('> **Warning:**')) as string;
    expect(backticked).toMatch(/x\\+u0060y/);
    expect((backticked.match(/`/g) ?? []).length).toBe(4);
    expect((backticked.match(/`[^`]*`/g) ?? [])).toHaveLength(2);
  });

  it('escapes a pipe inside a path so the table survives', () => {
    const a = snap({ fields: [docField('we|ird', { units: 1000, present: 900, types: { string: 900 } })] });
    const b = snap({ fields: [docField('we|ird', { units: 1000, present: 100, types: { string: 100 } })] });
    const md = renderMarkdown(diffSnapshots(a, b, DEFAULT_CONFIG));
    expect(md).toContain('`we\\|ird`');
  });
});

describe('json reporter', () => {
  it('parses and keeps a stable key order', () => {
    const text = renderJson(FULL);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'tool',
      'collection',
      'baseline',
      'current',
      'thresholds',
      'lowSample',
      'refusal',
      'warnings',
      'summary',
      'findings',
      'suppressed',
    ]);
    // Byte-identical across runs.
    expect(renderJson(FULL)).toBe(text);
  });

  it('summarises severities and carries machine-readable metrics', () => {
    const parsed = JSON.parse(renderJson(FULL)) as {
      summary: Record<string, number>;
      findings: Array<{ type: string; metrics: Record<string, unknown> }>;
      refusal: unknown;
    };
    expect(parsed.summary).toEqual({
      findings: 5,
      error: 3,
      warning: 2,
      info: 0,
      suppressed: 4,
    });
    expect(parsed.refusal).toBeNull();
    const dropped = parsed.findings.find((f) => f.type === 'presence_dropped');
    expect(dropped?.metrics.presenceDropPp).toBeCloseTo(28.8, 6);
  });

  it('carries the refusal instead of findings when refused', () => {
    const other = { ...CURRENT, collection: 'shop.invoices' };
    const parsed = JSON.parse(renderJson(diffSnapshots(BASELINE, other, DEFAULT_CONFIG))) as {
      refusal: { code: string } | null;
      findings: unknown[];
    };
    expect(parsed.refusal?.code).toBe('collection_mismatch');
    expect(parsed.findings).toEqual([]);
  });
});

describe('table reporter', () => {
  it('aligns one row per finding', () => {
    const text = renderTable(FULL);
    const lines = text.split('\n');
    const header = lines.find((l) => l.startsWith('#  FINDING')) as string;
    expect(header).toBeDefined();
    expect(text).toContain('field_disappeared [error]');
    expect(text).toContain('null_ratio_increased [warning]');
    expect(text).toContain('Suppressed (below threshold or in ignorePaths): 4');
  });

  it('handles zero findings', () => {
    const clean = diffSnapshots(BASELINE, BASELINE, DEFAULT_CONFIG);
    const text = renderTable(clean);
    expect(text).toContain('No findings: nothing crossed the configured thresholds.');
    expect(text).not.toContain('FINDING');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('prints a refusal', () => {
    const other = { ...CURRENT, collection: 'shop.invoices' };
    const text = renderTable(diffSnapshots(BASELINE, other, DEFAULT_CONFIG));
    expect(text).toContain('REFUSED (collection_mismatch)');
  });

  it('keeps its columns when a document key contains a newline', () => {
    const a = snap({ fields: [docField('safe', { units: 1000, present: 1000, types: { int: 1000 } })] });
    const b = snap({
      fields: [
        docField('safe', { units: 1000, present: 1000, types: { int: 1000 } }),
        docField('bad\nkey', { units: 1000, present: 1000, types: { int: 1000 } }),
      ],
    });
    const text = renderTable(diffSnapshots(a, b, DEFAULT_CONFIG));
    expect(text).toContain('bad\\nkey');
    expect(text).not.toMatch(/^key/m);
  });
});

describe('renderReport dispatch', () => {
  it('routes each supported format', () => {
    expect(renderReport(FULL, 'markdown')).toBe(renderMarkdown(FULL));
    expect(renderReport(FULL, 'json')).toBe(renderJson(FULL));
    expect(renderReport(FULL, 'table')).toBe(renderTable(FULL));
  });

  it('rejects an unknown format', () => {
    expect(() => renderReport(FULL, 'html')).toThrow(/unknown --format html/);
  });
});
