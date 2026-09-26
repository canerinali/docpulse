import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.js');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the built CLI exactly the way a user would, and capture the exit code. */
async function run(args: string[], cwd = ROOT): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, MONGODB_URI: '' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeAll(async () => {
  // The CLI tests exercise the *built* bin, so build it first.
  await execFileAsync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
    cwd: ROOT,
  });
  expect(existsSync(CLI)).toBe(true);
  // `npm run build` chmods the bin; do the same here so the symlink tests below
  // exercise exactly what npm installs.
  chmodSync(CLI, 0o755);
}, 120_000);

describe('docpulse --help / --version', () => {
  it('prints the version and exits 0', async () => {
    const result = await run(['--version']);
    expect(result.code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('documents both subcommands', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('snapshot');
    expect(result.stdout).toContain('diff');
  });

  it('exits 2 on an unknown command', async () => {
    const result = await run(['explode']);
    expect(result.code).toBe(2);
  });
});

describe('the npm bin entry point', () => {
  /**
   * npm installs the bin as `node_modules/.bin/docpulse`, a **symlink** to
   * dist/cli.js. Node resolves that symlink for `import.meta.url` but not for
   * `process.argv[1]`, so a naive entry-point check makes the CLI exit 0 having
   * printed nothing. Reproduce npm's layout exactly.
   */
  it('runs when invoked through a bin symlink, not just by real path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-bin-'));
    await mkdir(join(dir, '.bin'), { recursive: true });
    const link = join(dir, '.bin', 'docpulse');
    await symlink(CLI, link);

    const { stdout } = await execFileAsync(link, ['--version'], {
      cwd: dir,
      env: { ...process.env, MONGODB_URI: '' },
    });
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(stdout.trim()).toBe(pkg.version);
  });

  it('still reports drift exit codes through the symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-bin-'));
    await mkdir(join(dir, '.bin'), { recursive: true });
    const link = join(dir, '.bin', 'docpulse');
    await symlink(CLI, link);

    let code = 0;
    let stdout = '';
    try {
      const out = await execFileAsync(
        link,
        [
          'diff',
          join(ROOT, 'examples', 'baseline.snapshot.json'),
          join(ROOT, 'examples', 'current.snapshot.json'),
          '--fail-on-drift',
        ],
        { cwd: dir, env: { ...process.env, MONGODB_URI: '' } },
      );
      stdout = out.stdout;
    } catch (error) {
      const e = error as { code?: number; stdout?: string };
      code = e.code ?? 1;
      stdout = e.stdout ?? '';
    }
    expect(code).toBe(1);
    expect(stdout).toContain('**5 findings**');
  });
});

describe('docpulse snapshot --input-json', () => {
  it('writes a snapshot file and exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-cli-'));
    const out = join(dir, 'snap.json');
    const result = await run([
      'snapshot',
      '--input-json',
      join(ROOT, 'test', 'fixtures', 'docs.json'),
      '--label',
      'fixture',
      '-o',
      out,
    ]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);

    const snapshot = JSON.parse(await readFile(out, 'utf8')) as {
      formatVersion: number;
      label: string;
      sampledDocs: number;
      collection: string;
    };
    expect(snapshot.formatVersion).toBe(1);
    expect(snapshot.label).toBe('fixture');
    expect(snapshot.sampledDocs).toBe(4);
    expect(snapshot.collection).toBe('input:docs.json');
  });

  it('writes to stdout when --out is omitted', async () => {
    const result = await run([
      'snapshot',
      '--input-json',
      join(ROOT, 'test', 'fixtures', 'docs.json'),
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sampledDocs: 4 });
  });

  it('is byte-identical across two runs apart from createdAt', async () => {
    const args = ['snapshot', '--input-json', join(ROOT, 'test', 'fixtures', 'docs.json')];
    const strip = (text: string): string =>
      text.replace(/"createdAt": "[^"]*"/, '"createdAt": "<ts>"');
    const first = await run(args);
    const second = await run(args);
    expect(strip(first.stdout)).toBe(strip(second.stdout));
  });

  it('exits 2 when neither --input-json nor a MongoDB target is given', async () => {
    const result = await run(['snapshot']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('connection string');
  });

  it('refuses --uri together with --input-json', async () => {
    const result = await run([
      'snapshot',
      '--input-json',
      join(ROOT, 'test', 'fixtures', 'docs.json'),
      '-u',
      'mongodb://localhost:27017',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--uri cannot be combined with --input-json');
  });

  it('exits 2 on an unreadable --input-json file', async () => {
    const result = await run(['snapshot', '--input-json', 'no-such-file.json']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('cannot read --input-json file');
  });
});

describe('docpulse diff exit codes', () => {
  const baseline = join(ROOT, 'examples', 'baseline.snapshot.json');
  const current = join(ROOT, 'examples', 'current.snapshot.json');

  it('exits 1 for drift with --fail-on-drift', async () => {
    const result = await run(['diff', baseline, current, '--fail-on-drift']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('**5 findings** (3 error, 2 warning)');
  });

  it('exits 0 for the same drift without --fail-on-drift', async () => {
    const result = await run(['diff', baseline, current]);
    expect(result.code).toBe(0);
  });

  it('exits 0 against itself even with --fail-on-drift', async () => {
    const result = await run(['diff', baseline, baseline, '--fail-on-drift']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('**0 findings**');
  });

  it('exits 2 on a missing snapshot path', async () => {
    const result = await run(['diff', join(ROOT, 'nope.json'), current, '--fail-on-drift']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('cannot read snapshot');
  });

  it('exits 2 on a snapshot that is not valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-cli-'));
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{ not json', 'utf8');
    const result = await run(['diff', bad, current]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not valid JSON');
  });

  it('exits 2 on a JSON file that is not a snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-cli-'));
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{"hello":"world"}', 'utf8');
    const result = await run(['diff', bad, current]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not a valid docpulse snapshot');
  });

  it('exits 2 on an unknown --format', async () => {
    const result = await run(['diff', baseline, current, '--format', 'html']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown --format html');
  });

  it('writes the report to --out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-cli-'));
    const out = join(dir, 'report.json');
    const result = await run(['diff', baseline, current, '--format', 'json', '-o', out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const parsed = JSON.parse(await readFile(out, 'utf8')) as { summary: { findings: number } };
    expect(parsed.summary.findings).toBe(5);
  });

  it('honours a --config file that raises the thresholds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-cli-'));
    const cfg = join(dir, 'loose.json');
    await writeFile(cfg, JSON.stringify({ presenceDropPct: 90, nullRatioIncreasePct: 90 }), 'utf8');
    const result = await run(['diff', baseline, current, '--config', cfg, '--fail-on-drift']);
    // presence_dropped and null_ratio_increased no longer cross; the other three still do.
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('**3 findings**');
  });

  it('exits 2 on a --config path that does not exist', async () => {
    const result = await run(['diff', baseline, current, '--config', '/nope/cfg.json']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('config file not found');
  });
});

describe('docpulse diff refusals', () => {
  const baseline = join(ROOT, 'examples', 'baseline.snapshot.json');

  async function withFilter(filter: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-cli-'));
    const path = join(dir, 'filtered.snapshot.json');
    const snapshot = JSON.parse(await readFile(join(ROOT, 'examples', 'current.snapshot.json'), 'utf8')) as {
      sampling: { filter: Record<string, unknown> };
    };
    snapshot.sampling.filter = filter;
    await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8');
    return path;
  }

  it('refuses a filter mismatch with exit 2', async () => {
    const other = await withFilter({ status: 'paid' });
    const result = await run(['diff', baseline, other]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('different sampling');
    expect(result.stderr).toContain('{"status":"paid"}');
  });

  it('proceeds under --allow-filter-mismatch', async () => {
    const other = await withFilter({ status: 'paid' });
    const result = await run(['diff', baseline, other, '--allow-filter-mismatch']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('> **Warning:**');
    expect(result.stdout).toContain('**5 findings**');
  });

  it('refuses a collection mismatch even with --allow-filter-mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-cli-'));
    const path = join(dir, 'other-collection.json');
    const snapshot = JSON.parse(await readFile(join(ROOT, 'examples', 'current.snapshot.json'), 'utf8')) as {
      collection: string;
    };
    snapshot.collection = 'shop.invoices';
    await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8');

    const result = await run(['diff', baseline, path, '--allow-filter-mismatch']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('different collections');
  });
});

describe('end-to-end with no database', () => {
  it('snapshots two document sets and diffs them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docpulse-e2e-'));
    const before = join(dir, 'before.ndjson');
    const after = join(dir, 'after.ndjson');

    const makeDocs = (withField: number, qtyAsString: boolean): string =>
      Array.from({ length: 600 }, (_, i) => {
        const doc: Record<string, unknown> = {
          _id: i,
          lines: [{ sku: `S${i}`, qty: qtyAsString && i % 2 === 0 ? String(i % 5) : i % 5 }],
        };
        if (i < withField) doc.taxId = `T${i}`;
        return JSON.stringify(doc);
      }).join('\n');

    await writeFile(before, makeDocs(540, false), 'utf8');
    await writeFile(after, makeDocs(120, true), 'utf8');

    const snapA = join(dir, 'a.json');
    const snapB = join(dir, 'b.json');
    // -d/-c name the logical collection, so the two files are comparable.
    const target = ['-d', 'shop', '-c', 'orders'];
    expect(
      (await run(['snapshot', '--input-json', before, ...target, '--label', 'before', '-o', snapA])).code,
    ).toBe(0);
    expect(
      (await run(['snapshot', '--input-json', after, ...target, '--label', 'after', '-o', snapB])).code,
    ).toBe(0);
    const snapshotA = JSON.parse(await readFile(snapA, 'utf8')) as { collection: string };
    expect(snapshotA.collection).toBe('shop.orders');

    const clean = await run(['diff', snapA, snapA, '--fail-on-drift']);
    expect(clean.code).toBe(0);

    const drift = await run(['diff', snapA, snapB, '--format', 'json', '--fail-on-drift']);
    expect(drift.code).toBe(1);
    const parsed = JSON.parse(drift.stdout) as { findings: Array<{ type: string; path: string }> };
    expect(parsed.findings.map((f) => f.type).sort()).toEqual([
      'presence_dropped',
      'type_changed',
    ]);
    expect(parsed.findings.find((f) => f.type === 'type_changed')?.path).toBe('lines.items[].qty');
  }, 60_000);
});
