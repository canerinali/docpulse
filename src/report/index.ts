import { UsageError } from '../errors.js';
import type { DiffResult } from '../core/types.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';
import { renderTable } from './table.js';

export const REPORT_FORMATS = ['markdown', 'json', 'table'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

export function renderReport(result: DiffResult, format: string): string {
  if (!isReportFormat(format)) {
    throw new UsageError(
      `unknown --format ${format}`,
      `Supported formats: ${REPORT_FORMATS.join(', ')}.`,
    );
  }
  switch (format) {
    case 'json':
      return renderJson(result);
    case 'table':
      return renderTable(result);
    case 'markdown':
      return renderMarkdown(result);
  }
}

export { renderJson, renderMarkdown, renderTable };
