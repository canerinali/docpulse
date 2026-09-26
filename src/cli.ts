#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { DocpulseError } from './errors.js';
import { redactConnectionStrings } from './redact.js';
import { runDiff, type DiffOptions } from './commands/diff.js';
import { runSnapshot, type SnapshotOptions } from './commands/snapshot.js';
import { VERSION } from './version.js';

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError('expected a non-negative integer');
  }
  return n;
}

/** Mutable holder so a subcommand action can hand its exit code back to main(). */
export interface CliState {
  exitCode: number;
}

export function buildProgram(state: CliState = { exitCode: 0 }): Command {
  const program = new Command();

  program
    .name('docpulse')
    .description(
      'Data-contract testing for schemaless MongoDB collections: snapshot a\n' +
        "collection's observed field schema and fail CI when it drifts.",
    )
    .version(VERSION, '-V, --version', 'output the version number')
    .configureHelp({ helpWidth: 96 });

  program
    .command('snapshot')
    .configureHelp({ helpWidth: 96 })
    .description(
      'Sample a MongoDB collection (or a local JSON file) and write a field-schema snapshot.',
    )
    .option('-u, --uri <uri>', 'MongoDB connection string (env: MONGODB_URI)')
    .option('-d, --db <name>', 'Database name')
    .option(
      '-c, --collection <name>',
      'Collection name                          (required unless --input-json)',
    )
    .option(
      '--input-json <file>',
      'Read documents from a JSON array or NDJSON file instead of MongoDB',
    )
    .option('-o, --out <file>', 'Write snapshot here (default: stdout)')
    .addOption(
      new Option('-n, --sample-size <n>', 'Max documents to sample')
        .argParser(parsePositiveInt)
        .default(1000),
    )
    .addOption(new Option('--filter <json>', 'Query filter, JSON object').default('{}', '{}'))
    .addOption(
      new Option('--sort <json>', 'Sort for deterministic sampling').default(
        '{"_id":-1}',
        '{"_id":-1}',
      ),
    )
    .option(
      '--random',
      'Use $sample instead of sort+limit. Unbiased but NOT reproducible, ' +
        'and may collection-scan on large collections.',
    )
    .option('--label <text>', 'Free-text label stored in the snapshot (e.g. "prod-2026-09-26")')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  docpulse snapshot -u "$MONGODB_URI" -d shop -c orders -o baseline.json\n' +
        '  docpulse snapshot --input-json dump.ndjson --label fixture -o fixture.json',
    )
    .action(async (options: SnapshotOptions) => {
      await runSnapshot(options);
    });

  program
    .command('diff')
    .configureHelp({ helpWidth: 96 })
    .description('Compare two snapshots and report only drifts that cross configured thresholds.')
    .argument('<baseline.json>', 'Snapshot you consider correct')
    .argument('<current.json>', 'Snapshot taken now')
    .option('--config <file>', 'Config file (default: ./docpulse.config.json if present)')
    .addOption(
      new Option('--format <fmt>', 'markdown | json | table').default('markdown', 'markdown'),
    )
    .option('-o, --out <file>', 'Write report here (default: stdout)')
    .option('--fail-on-drift', 'Exit 1 if any finding survives the thresholds')
    .option(
      '--allow-filter-mismatch',
      'Downgrade a filter/sampling mismatch from refusal to a warning',
    )
    .addHelpText(
      'after',
      '\nExit codes: 0 = no drift (or drift without --fail-on-drift) | 1 = drift + --fail-on-drift\n' +
        '            2 = usage error, invalid/unreadable snapshot, or refused comparison',
    )
    .action(async (baselinePath: string, currentPath: string, options: DiffOptions) => {
      const outcome = await runDiff(baselinePath, currentPath, options);
      state.exitCode = outcome.exitCode;
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const state: CliState = { exitCode: 0 };
  const program = buildProgram(state);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return state.exitCode;
  } catch (error) {
    if (error instanceof DocpulseError) {
      process.stderr.write(`docpulse: ${error.message}\n`);
      if (error.detail !== undefined) process.stderr.write(`${error.detail}\n`);
      return error.exitCode;
    }
    // commander's own errors: help/version exit 0, everything else is a usage error.
    const commanderExit = (error as { exitCode?: unknown }).exitCode;
    if (typeof commanderExit === 'number') {
      return commanderExit === 0 ? 0 : 2;
    }
    process.stderr.write(
      `docpulse: ${redactConnectionStrings(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 2;
  }
}

/**
 * True when this file is the process entry point.
 *
 * `process.argv[1]` is whatever path the shell used, which for an npm-installed
 * bin is the `node_modules/.bin/docpulse` **symlink**, while `import.meta.url`
 * is always the resolved real path. Comparing the two directly would make the
 * CLI silently do nothing when run through its own bin, so resolve both.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const invokedDirectly = isEntryPoint();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `docpulse: ${redactConnectionStrings(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`,
      );
      process.exitCode = 2;
    },
  );
}
