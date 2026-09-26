import type { DiffResult } from '../core/types.js';

const HEADERS = ['#', 'FINDING', 'PATH', 'BASELINE -> CURRENT', 'SAMPLE'] as const;

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - text.length));
}

/**
 * Field paths come from document keys and labels come from snapshot files, so
 * every cell is untrusted. A newline or a carriage return would break the
 * column layout and let a document key forge extra rows, so control characters
 * become visible escapes here too.
 */
function safe(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += char;
  }
  return out;
}

/** Compact fixed-width output for a terminal. */
export function renderTable(result: DiffResult): string {
  const lines: string[] = [];
  lines.push(
    `docpulse ${safe(result.baseline.collection)}: ` +
      `${safe(result.baseline.label ?? 'baseline')} (${result.baseline.sampledDocs} docs) -> ` +
      `${safe(result.current.label ?? 'current')} (${result.current.sampledDocs} docs)`,
  );

  if (result.refusal !== undefined) {
    lines.push(`REFUSED (${safe(result.refusal.code)}): ${safe(result.refusal.message)}`);
    for (const line of result.refusal.detail.split('\n')) lines.push(`  ${safe(line)}`);
    return `${lines.join('\n')}\n`;
  }

  for (const warning of result.warnings) lines.push(`WARNING: ${safe(warning)}`);

  if (result.findings.length === 0) {
    lines.push('No findings: nothing crossed the configured thresholds.');
    lines.push(`Suppressed (below threshold or in ignorePaths): ${result.suppressed.length}`);
    return `${lines.join('\n')}\n`;
  }

  const rows = result.findings.map((f, i) => [
    String(i + 1),
    `${f.type} [${f.severity}]`,
    safe(f.path),
    safe(f.change),
    safe(f.sample),
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
    lines.push(`* ${safe(finding.path)}: ${safe(finding.suggestedAction)}`);
  }
  lines.push('');
  lines.push(`Suppressed (below threshold or in ignorePaths): ${result.suppressed.length}`);

  return `${lines.join('\n')}\n`;
}
