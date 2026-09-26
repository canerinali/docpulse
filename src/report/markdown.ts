import type { DiffResult, Finding, Severity } from '../core/types.js';

/**
 * Everything a report prints is untrusted text.
 *
 * Field paths come from document keys, and BSON type names can come from a
 * `_bsontype` value; labels, collection names and refusal details come out of
 * snapshot *files*, which a pull request can change. This report is designed to
 * be pasted into a GitHub job summary or a PR comment (see
 * `examples/drift-check.yml`), so a newline or a backtick in any of that text
 * would let a document key inject its own Markdown: extra table rows, headings,
 * links. Control characters therefore become visible escapes and a literal
 * backtick becomes `\u0060`, because Markdown has no way to escape a backtick
 * inside a code span.
 */
export function cell(text: string): string {
  return sanitize(text).replace(/\|/g, '\\|');
}

/** Sanitising for text printed inside a fenced block, where `|` is literal. */
function fenced(text: string): string {
  return text.split('\n').map(sanitize).join('\n');
}

/**
 * Sanitising for text rendered as Markdown *prose* rather than inside a code
 * span — currently only the warning blockquote, which interpolates a snapshot
 * file's `sampling.filter`. There the usual backtick/newline escaping is not
 * enough: `[a](http://evil)`, `**bold**` and raw `<html>` would all render. The
 * punctuation escaped below is the set that can start an inline construct;
 * CommonMark lets any ASCII punctuation be backslash-escaped, and docpulse's
 * own warning wording contains none of it, so the result stays readable.
 */
function prose(text: string): string {
  return sanitize(text).replace(/[\\`*_[\]<>&~|]/g, (m) => `\\${m}`);
}

function sanitize(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === '`') out += '\\u0060';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += char;
  }
  return out;
}

function labelOf(label: string | null): string {
  return label === null ? '(unlabelled)' : `\`${cell(label)}\``;
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
    `\`${cell(baseline.collection)}\` — baseline ${labelOf(baseline.label)} (${baseline.sampledDocs} docs) ` +
      `→ current ${labelOf(current.label)} (${current.sampledDocs} docs)`,
  );

  if (result.refusal !== undefined) {
    lines.push('');
    lines.push(`## Comparison refused: \`${cell(result.refusal.code)}\``);
    lines.push('');
    lines.push(fenced(result.refusal.message));
    lines.push('');
    lines.push('```');
    lines.push(fenced(result.refusal.detail));
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
      lines.push(`> **Warning:** ${prose(warning)}`);
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
      lines.push(`- \`${cell(item.path)}\` — ${cell(item.detail)}`);
    }
    lines.push('');
    lines.push('</details>');
  }

  return `${lines.join('\n')}\n`;
}
