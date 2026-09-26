#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { DocpulseError } from './errors.js';
import { runSnapshot, type SnapshotOptions } from './commands/snapshot.js';
import { VERSION } from './version.js';

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError('expected a non-negative integer');
  }
  return n;
}

export function buildProgram(): Command {
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

  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return 0;
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
    process.stderr.write(`docpulse: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`docpulse: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
