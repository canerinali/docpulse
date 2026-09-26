import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { diffSnapshots, hasActionableFindings } from '../core/diff.js';
import { parseSnapshot } from '../core/snapshotSchema.js';
import { renderReport, isReportFormat, REPORT_FORMATS } from '../report/index.js';
import { UsageError } from '../errors.js';
import type { DiffResult } from '../core/types.js';

export interface DiffOptions {
  config?: string | undefined;
  format: string;
  out?: string | undefined;
  failOnDrift?: boolean | undefined;
  allowFilterMismatch?: boolean | undefined;
}

export interface DiffOutcome {
  exitCode: number;
  result: DiffResult;
  report: string;
}

async function readSnapshotFile(path: string) {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new UsageError(
      `cannot read snapshot: ${path}`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return parseSnapshot(text, path);
}

/**
 * Run `docpulse diff`.
 *
 * Exit codes: 0 = no drift (or drift without --fail-on-drift),
 * 1 = drift + --fail-on-drift, 2 = refused comparison.
 */
export async function runDiff(
  baselinePath: string,
  currentPath: string,
  options: DiffOptions,
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<DiffOutcome> {
  if (!isReportFormat(options.format)) {
    throw new UsageError(
      `unknown --format ${options.format}`,
      `Supported formats: ${REPORT_FORMATS.join(', ')}.`,
    );
  }

  const baseline = await readSnapshotFile(baselinePath);
  const current = await readSnapshotFile(currentPath);
  const { config } = await loadConfig({ configPath: options.config });

  const result = diffSnapshots(baseline, current, config, {
    allowFilterMismatch: options.allowFilterMismatch === true,
  });
  const report = renderReport(result, options.format);

  if (options.out !== undefined && options.out !== '') {
    try {
      await writeFile(options.out, report, 'utf8');
    } catch (error) {
      throw new UsageError(
        `cannot write report to ${options.out}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    stdout.write(report);
  }

  if (result.refusal !== undefined) {
    stderr.write(`docpulse: ${result.refusal.message}\n${result.refusal.detail}\n`);
    return { exitCode: 2, result, report };
  }

  const drift = hasActionableFindings(result);
  const exitCode = drift && options.failOnDrift === true ? 1 : 0;
  return { exitCode, result, report };
}
