import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { UsageError } from './errors.js';
import type { Config } from './core/types.js';

/** Looked for in the working directory when `--config` is not given. */
export const DEFAULT_CONFIG_FILE = 'docpulse.config.json';

/** Every threshold docpulse applies, with the documented defaults. */
export const DEFAULT_CONFIG: Config = {
  presenceDropPct: 10,
  nullRatioIncreasePct: 10,
  minSampledDocs: 500,
  minPresenceToTrackPct: 5,
  newFieldMinPresencePct: 5,
  typeNoiseFloorPct: 1,
  treatNumericTypesAsEquivalent: true,
  ignorePaths: ['_id', 'updatedAt'],
};

const percent = z.number().min(0).max(100);

export const configSchema = z
  .strictObject({
    presenceDropPct: percent,
    nullRatioIncreasePct: percent,
    minSampledDocs: z.number().int().min(0),
    minPresenceToTrackPct: percent,
    newFieldMinPresencePct: percent,
    typeNoiseFloorPct: percent,
    treatNumericTypesAsEquivalent: z.boolean(),
    ignorePaths: z.array(z.string()),
  })
  .partial();

export type ConfigOverrides = z.infer<typeof configSchema>;

/** defaults <- file <- overrides (CLI / library caller). Last writer wins. */
export function mergeConfig(
  file: ConfigOverrides = {},
  overrides: ConfigOverrides = {},
): Config {
  return { ...DEFAULT_CONFIG, ...stripUndefined(file), ...stripUndefined(overrides) };
}

function stripUndefined(value: ConfigOverrides): ConfigOverrides {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as ConfigOverrides;
}

/** Validate the contents of a config file, with a readable message on failure. */
export function parseConfigText(text: string, origin: string): ConfigOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `${origin}: not valid JSON`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new UsageError(`${origin}: invalid docpulse config`, z.prettifyError(result.error));
  }
  return result.data;
}

export interface LoadConfigOptions {
  /** Explicit `--config <file>`. Missing file is an error. */
  configPath?: string | undefined;
  /** Where to look for the default config file. */
  cwd?: string;
  /** Highest-precedence layer (CLI flags, library caller). */
  overrides?: ConfigOverrides;
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the file that was applied, or `null` for defaults only. */
  sourcePath: string | null;
}

/**
 * Resolve the effective configuration: built-in defaults, then
 * `docpulse.config.json` (or `--config`), then explicit overrides.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  let sourcePath: string | null = null;

  if (options.configPath !== undefined && options.configPath !== '') {
    const abs = isAbsolute(options.configPath)
      ? options.configPath
      : resolve(cwd, options.configPath);
    if (!existsSync(abs)) {
      throw new UsageError(`config file not found: ${options.configPath}`);
    }
    sourcePath = abs;
  } else {
    const fallback = resolve(cwd, DEFAULT_CONFIG_FILE);
    if (existsSync(fallback)) sourcePath = fallback;
  }

  let fileLayer: ConfigOverrides = {};
  if (sourcePath !== null) {
    const text = await readFile(sourcePath, 'utf8');
    fileLayer = parseConfigText(text, sourcePath);
  }

  return { config: mergeConfig(fileLayer, options.overrides), sourcePath };
}
