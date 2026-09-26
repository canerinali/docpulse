import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
  loadConfig,
  mergeConfig,
  parseConfigText,
} from '../src/config.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'docpulse-config-'));
}

describe('config defaults', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_CONFIG).toEqual({
      presenceDropPct: 10,
      nullRatioIncreasePct: 10,
      minSampledDocs: 500,
      minPresenceToTrackPct: 5,
      newFieldMinPresencePct: 5,
      typeNoiseFloorPct: 1,
      treatNumericTypesAsEquivalent: true,
      ignorePaths: ['_id', 'updatedAt'],
    });
  });

  it('uses defaults when no config file exists', async () => {
    const dir = await tempDir();
    const loaded = await loadConfig({ cwd: dir });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.sourcePath).toBeNull();
  });

  it('ships docpulse.config.json containing exactly the defaults', async () => {
    const loaded = await loadConfig({ cwd: process.cwd() });
    expect(loaded.sourcePath).toContain(DEFAULT_CONFIG_FILE);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });
});

describe('config precedence', () => {
  it('lets the file beat the default', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, DEFAULT_CONFIG_FILE),
      JSON.stringify({ presenceDropPct: 25, ignorePaths: [] }),
      'utf8',
    );
    const { config } = await loadConfig({ cwd: dir });
    expect(config.presenceDropPct).toBe(25);
    expect(config.ignorePaths).toEqual([]);
    // Untouched keys still come from the defaults.
    expect(config.minSampledDocs).toBe(500);
  });

  it('lets an explicit override beat the file, which beats the default', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, DEFAULT_CONFIG_FILE),
      JSON.stringify({ presenceDropPct: 25, nullRatioIncreasePct: 30 }),
      'utf8',
    );
    const { config } = await loadConfig({ cwd: dir, overrides: { presenceDropPct: 3 } });
    expect(config.presenceDropPct).toBe(3); // override
    expect(config.nullRatioIncreasePct).toBe(30); // file
    expect(config.minSampledDocs).toBe(500); // default
  });

  it('loads an explicit --config path from outside the cwd', async () => {
    const dir = await tempDir();
    const file = join(dir, 'strict.json');
    await writeFile(file, JSON.stringify({ minSampledDocs: 0 }), 'utf8');
    const { config, sourcePath } = await loadConfig({ cwd: process.cwd(), configPath: file });
    expect(sourcePath).toBe(file);
    expect(config.minSampledDocs).toBe(0);
  });

  it('errors when --config points at a missing file', async () => {
    await expect(loadConfig({ configPath: '/nope/does-not-exist.json' })).rejects.toThrow(
      /config file not found/,
    );
  });

  it('ignores undefined override values', () => {
    expect(mergeConfig({ presenceDropPct: 7 }, { presenceDropPct: undefined })).toMatchObject({
      presenceDropPct: 7,
    });
  });
});

describe('config validation', () => {
  /** The CLI prints `message` then `detail`; assert on what the operator sees. */
  function reportFor(text: string): string {
    try {
      parseConfigText(text, 'docpulse.config.json');
    } catch (error) {
      return `${(error as Error).message}\n${(error as { detail?: string }).detail ?? ''}`;
    }
    throw new Error('expected parseConfigText to throw');
  }

  it('produces a readable message for a wrong type', () => {
    const report = reportFor('{"presenceDropPct":"ten"}');
    expect(report).toContain('invalid docpulse config');
    expect(report).toContain('presenceDropPct');
    expect(report).toContain('expected number');
  });

  it('rejects unknown keys instead of silently ignoring a typo', () => {
    const report = reportFor('{"presenceDropPCT":10}');
    expect(report).toContain('Unrecognized key');
    expect(report).toContain('presenceDropPCT');
  });

  it('rejects out-of-range percentages', () => {
    const report = reportFor('{"presenceDropPct":140}');
    expect(report).toContain('presenceDropPct');
    expect(report).toMatch(/Too big|<=100/);
  });

  it('reports invalid JSON with the parser message', () => {
    expect(() => parseConfigText('{oops}', 'cfg')).toThrow(/cfg: not valid JSON/);
  });
});
