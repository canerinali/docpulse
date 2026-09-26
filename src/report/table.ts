import type { DiffResult } from '../core/types.js';

const HEADERS = ['#', 'FINDING', 'PATH', 'BASELINE -> CURRENT', 'SAMPLE'] as const;

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - text.length));
}

/** Compact fixed-width output for a terminal. */
export function renderTable(result: DiffResult): string {
  const lines: string[] = [];
  lines.push(
    `docpulse ${result.baseline.collection}: ` +
      `${result.baseline.label ?? 'baseline'} (${result.baseline.sampledDocs} docs) -> ` +
      `${result.current.label ?? 'current'} (${result.current.sampledDocs} docs)`,
  );

  if (result.refusal !== undefined) {
    lines.push(`REFUSED (${result.refusal.code}): ${result.refusal.message}`);
    for (const line of result.refusal.detail.split('\n')) lines.push(`  ${line}`);
    return `${lines.join('\n')}\n`;
  }

  for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);

  if (result.findings.length === 0) {
    lines.push('No findings: nothing crossed the configured thresholds.');
    lines.push(`Suppressed (below threshold or in ignorePaths): ${result.suppressed.length}`);
    return `${lines.join('\n')}\n`;
  }

  const rows = result.findings.map((f, i) => [
    String(i + 1),
    `${f.type} [${f.severity}]`,
    f.path,
    f.change,
    f.sample,
  ]);

  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] as string).length)),
  );

  lines.push('');
  lines.push(HEADERS.map((header, i) => pad(header, widths[i] as number)).join('  '));
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    lines.push(row.map((value, i) => pad(value, widths[i] as number)).join('  '));
  }
  lines.push('');
  for (const finding of result.findings) {
    lines.push(`* ${finding.path}: ${finding.suggestedAction}`);
  }
  lines.push('');
  lines.push(`Suppressed (below threshold or in ignorePaths): ${result.suppressed.length}`);

  return `${lines.join('\n')}\n`;
}
