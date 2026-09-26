import type { DiffResult, Finding, Severity } from '../core/types.js';

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function labelOf(label: string | null): string {
  return label === null ? '(unlabelled)' : `\`${label}\``;
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** `int → int, string` becomes `` `int` → `int, string` ``. */
function renderChange(finding: Finding): string {
  if (finding.type !== 'type_changed') return cell(finding.change);
  const parts = finding.change.split(' → ');
  return parts.map((part) => `\`${cell(part)}\``).join(' → ');
}

export function summaryLine(findings: Finding[]): string {
  const counts = countBySeverity(findings);
  const parts: string[] = [];
  if (counts.error > 0) parts.push(`${counts.error} error`);
  if (counts.warning > 0) parts.push(`${counts.warning} warning`);
  if (counts.info > 0) parts.push(`${counts.info} info`);
  const noun = findings.length === 1 ? 'finding' : 'findings';
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `**${findings.length} ${noun}**${breakdown}`;
}

/** The default reporter: a drift report you can paste into a PR comment. */
export function renderMarkdown(result: DiffResult): string {
  const { baseline, current, config, findings } = result;
  const lines: string[] = ['# docpulse drift report', ''];

  lines.push(
    `\`${baseline.collection}\` — baseline ${labelOf(baseline.label)} (${baseline.sampledDocs} docs) ` +
      `→ current ${labelOf(current.label)} (${current.sampledDocs} docs)`,
  );

  if (result.refusal !== undefined) {
    lines.push('');
    lines.push(`## Comparison refused: \`${result.refusal.code}\``);
    lines.push('');
    lines.push(result.refusal.message);
    lines.push('');
    lines.push('```');
    lines.push(result.refusal.detail);
    lines.push('```');
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    `${summaryLine(findings)} · thresholds: presenceDrop ${config.presenceDropPct}pp, ` +
      `nullRatioIncrease ${config.nullRatioIncreasePct}pp, minSampledDocs ${config.minSampledDocs}`,
  );

  if (result.warnings.length > 0) {
    lines.push('');
    for (const warning of result.warnings) {
      lines.push(`> **Warning:** ${warning}`);
      lines.push('>');
    }
    lines.pop();
  }

  lines.push('');

  if (findings.length === 0) {
    lines.push('No drift crossed the configured thresholds.');
  } else {
    lines.push('| # | Finding | Path | Baseline → Current | Sample | Suggested action |');
    lines.push('|---|---|---|---|---|---|');
    findings.forEach((finding, index) => {
      lines.push(
        `| ${index + 1} | \`${finding.type}\` | \`${cell(finding.path)}\` | ${renderChange(finding)} ` +
          `| ${cell(finding.sample)} | ${cell(finding.suggestedAction)} |`,
      );
    });
  }

  if (result.suppressed.length > 0) {
    lines.push('');
    lines.push(
      `<details><summary>Suppressed (below threshold or in ignorePaths): ${result.suppressed.length}</summary>`,
    );
    lines.push('');
    for (const item of result.suppressed) {
      lines.push(`- \`${item.path}\` — ${item.detail}`);
    }
    lines.push('');
    lines.push('</details>');
  }

  return `${lines.join('\n')}\n`;
}
