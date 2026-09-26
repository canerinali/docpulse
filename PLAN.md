# docpulse — v0.1 Build Plan

> Scope contract: everything below is buildable by one developer in one day. No TODOs, no "phase 2 hooks".

## 1. Value proposition

docpulse turns a MongoDB collection's *observed* field schema into a versioned snapshot and fails your CI build when the next snapshot drifts past thresholds you chose — data-contract testing for schemaless collections, not a schema viewer.

## 2. Out of scope for v0.1

- No web UI, dashboard, or HTML report.
- No snapshot history / time-series storage. Snapshots are plain files; your VCS or artifact store is the history.
- No automatic threshold learning or baseline suggestion. Thresholds are written by a human.
- No write access to MongoDB, ever. Only `find`, `countDocuments`, `estimatedDocumentCount`, `$sample`.
- No multi-collection or whole-database crawl. One collection per invocation; loop in your shell.
- No Docker image, no GitHub Action marketplace action (only an example workflow YAML).
- No JSON-Schema / `$jsonSchema` validator generation.
- No semantic value checks: no ranges, enums, regex conformance, cardinality, uniqueness, or PII detection.
- No index/query/performance analysis, no change streams, no oplog tailing, no Atlas API.
- No `--seed` flag (see §6, "Sampling"), no plugin system, no i18n.
- Exactly five finding types (§6). Empty-string ratio is reported as context but never raises a finding.

## 3. Tech stack

| Choice | Version | Reason |
|---|---|---|
| TypeScript + Node 22 | `typescript@^7`, `@types/node@^22` | Target user's main stack; `npx docpulse` is the adoption path. |
| `commander` | `^15` | Smallest credible arg parser with real `--help` output and subcommands. |
| `zod` | `^4` | One library validates both `docpulse.config.json` and untrusted snapshot files, and generates the error messages. |
| `mongodb` | `^7` | Official driver; imported by exactly one file. |
| `vitest` | `^5` | Fast, zero-config TS, `describe.skipIf` gives us the gated integration test for free. |
| `tsx` | `^4` (dev) | Run the CLI from source during development without a build step. |
| Markdown reporter | hand-written | A template engine for 30 lines of string building is a liability. |
| License | Apache-2.0 | Patent grant gets the tool through corporate legal when it lands in someone's CI. |

**Runtime dependencies: `commander`, `zod`, `mongodb`. That is all.**

### Decision: write our own inference, do NOT depend on `mongodb-js/mongodb-schema`

Rejected. Not because of install weight (it is light — one transitive dep, `reservoir`), but because its output model is the wrong shape for this product. `mongodb-schema` reports `probability` values whose denominators are *relative to the parent node* and it reservoir-samples example values. docpulse's entire pitch is the honest denominator — the user must be told "present in 412 of 1000 **documents**" vs "present in 3891 of 4102 **array elements**" — and it must distinguish missing / `null` / `""` as three separate counters. Reconstructing our numbers from theirs means reverse-engineering their tree, and we would still own the bugs. Our accumulator is ~150 lines (`core/paths.ts` + `core/infer.ts`), fully unit-testable against plain JS objects, and we control the snapshot format we have to keep stable across versions. Own it.

## 4. File / module layout

```
docpulse/
├── package.json                 bin: docpulse -> dist/cli.js; scripts: build, test, check, lint
├── tsconfig.json                strict, module nodenext, outDir dist
├── vitest.config.ts             include test/**/*.test.ts
├── LICENSE                      Apache-2.0
├── README.md                    pitch, install, the two commands, real pasted output
├── docpulse.config.json         default-loaded config; doubles as the documented example
├── docs/semantics.md            §6 of this plan, expanded, plus "what this tool does not guarantee"
├── examples/
│   ├── drift-check.yml          GitHub Actions workflow: snapshot -> diff --fail-on-drift
│   ├── baseline.snapshot.json   hand-written, used by README and by cli tests
│   └── current.snapshot.json    hand-written sibling that triggers all five findings
├── src/
│   ├── cli.ts                   shebang; commander wiring; maps thrown errors -> exit codes
│   ├── commands/snapshot.ts     build a DocumentSource, run inference, write the JSON file
│   ├── commands/diff.ts         read+validate two snapshots, run diff, pick reporter, set exit code
│   ├── core/types.ts            Snapshot, FieldStat, Finding, Config, DocumentSource, SamplingInfo
│   ├── core/bsonType.ts         bsonTypeOf(value) -> canonical BSON type name
│   ├── core/paths.ts            walkDocument(doc) -> PathEvent[]; dotted join + `items[]` marker
│   ├── core/infer.ts            accumulate PathEvents from N docs into a Snapshot
│   ├── core/diff.ts             (a, b, config) -> { findings, warnings, refusal? }
│   ├── core/snapshotSchema.ts   zod schemas + formatVersion check + canonical JSON stringify
│   ├── config.ts               defaults <- docpulse.config.json <- CLI flags, validated by zod
│   ├── source/arraySource.ts    DocumentSource over an in-memory array / JSON / NDJSON file
│   ├── source/mongoSource.ts    DocumentSource over MongoDB — the ONLY file importing `mongodb`
│   └── report/markdown.ts | json.ts | table.ts    Finding[] -> string
└── test/
    ├── bsonType.test.ts  paths.test.ts  infer.test.ts
    ├── diff.test.ts  config.test.ts  report.test.ts  cli.test.ts
    ├── fixtures/*.json         document arrays and snapshot pairs
    └── integration/mongo.test.ts    describe.skipIf(!process.env.MONGODB_URI)
```

## 5. CLI interface

```
$ docpulse snapshot --help
Usage: docpulse snapshot [options]

Sample a MongoDB collection (or a local JSON file) and write a field-schema snapshot.

Options:
  -u, --uri <uri>          MongoDB connection string (env: MONGODB_URI)
  -d, --db <name>          Database name
  -c, --collection <name>  Collection name                          (required unless --input-json)
      --input-json <file>  Read documents from a JSON array or NDJSON file instead of MongoDB
  -o, --out <file>         Write snapshot here (default: stdout)
  -n, --sample-size <n>    Max documents to sample                  (default: 1000)
      --filter <json>      Query filter, JSON object                (default: {})
      --sort <json>        Sort for deterministic sampling          (default: {"_id":-1})
      --random             Use $sample instead of sort+limit. Unbiased but NOT reproducible,
                           and may collection-scan on large collections.
      --label <text>       Free-text label stored in the snapshot (e.g. "prod-2026-09-26")
  -h, --help               display help for command

Examples:
  docpulse snapshot -u "$MONGODB_URI" -d shop -c orders -o baseline.json
  docpulse snapshot --input-json dump.ndjson --label fixture -o fixture.json
```

```
$ docpulse diff --help
Usage: docpulse diff [options] <baseline.json> <current.json>

Compare two snapshots and report only drifts that cross configured thresholds.

Options:
      --config <file>          Config file (default: ./docpulse.config.json if present)
      --format <fmt>           markdown | json | table                (default: markdown)
  -o, --out <file>             Write report here (default: stdout)
      --fail-on-drift          Exit 1 if any finding survives the thresholds
      --allow-filter-mismatch  Downgrade a filter/sampling mismatch from refusal to a warning
  -h, --help                   display help for command

Exit codes: 0 = no drift (or drift without --fail-on-drift) | 1 = drift + --fail-on-drift
            2 = usage error, invalid/unreadable snapshot, or refused comparison
```

`docpulse.config.json` (every key shown is the default; the file is optional):

```json
{
  "presenceDropPct": 10,
  "nullRatioIncreasePct": 10,
  "minSampledDocs": 500,
  "minPresenceToTrackPct": 5,
  "newFieldMinPresencePct": 5,
  "typeNoiseFloorPct": 1,
  "treatNumericTypesAsEquivalent": true,
  "ignorePaths": ["_id", "updatedAt"]
}
```

Snapshot file (abbreviated — `fields` is a sorted array, one entry per path):

```json
{
  "formatVersion": 1,
  "tool": "docpulse@0.1.0",
  "label": "prod-2026-09-26",
  "createdAt": "2026-09-26T17:40:11.204Z",
  "collection": "shop.orders",
  "sampling": { "mode": "sort-limit", "sampleSize": 1000, "filter": {}, "sort": { "_id": -1 } },
  "sampledDocs": 1000,
  "estimatedTotalDocs": 482913,
  "estimatedTotalDocsMethod": "estimatedDocumentCount",
  "fields": [
    { "path": "customer.taxId", "denominator": "documents",     "observedUnits": 1000,
      "presentCount": 412, "nullCount": 17, "emptyStringCount": 3,
      "bsonTypes": { "string": 395, "null": 17 } },
    { "path": "lines",          "denominator": "documents",     "observedUnits": 1000,
      "presentCount": 1000, "nullCount": 0, "emptyStringCount": 0,
      "bsonTypes": { "array": 1000 } },
    { "path": "lines.items[].sku", "denominator": "arrayElements", "arrayParent": "lines",
      "observedUnits": 4102, "presentCount": 4098, "nullCount": 0, "emptyStringCount": 12,
      "bsonTypes": { "string": 4098 } }
  ]
}
```

Markdown report (`--format markdown`):

```markdown
# docpulse drift report

`shop.orders` — baseline `prod-2026-09-19` (1000 docs) → current `prod-2026-09-26` (1000 docs)
**3 findings** (2 error, 1 warning) · thresholds: presenceDrop 10pp, nullRatioIncrease 10pp, minSampledDocs 500

| # | Finding | Path | Baseline → Current | Sample | Suggested action |
|---|---|---|---|---|---|
| 1 | `type_changed` | `lines.items[].qty` | `int` → `int, string` | 4102 → 3987 array elements | A producer is sending numbers as strings; find it before your aggregations silently drop rows. |
| 2 | `presence_dropped` | `customer.taxId` | 41.2% → 12.4% (-28.8pp) | 1000 → 1000 documents | Confirm the field is still being written; if it was intentionally retired, re-baseline. |
| 3 | `null_ratio_increased` | `payment.provider` | 2.1% → 19.8% null of present (+17.7pp) | 1000 → 1000 documents | Upstream is writing nulls instead of omitting the field; decide which contract you want. |

<details><summary>Suppressed (below threshold or in ignorePaths): 14</summary>…</details>
```

## 6. Semantics decisions

**Paths.** Object nesting joins with `.`: `customer.taxId`. An array field `lines` produces **two** paths: `lines` itself (BSON type `array`, denominated in documents) and `lines.items[]` for its elements. Anything under an element continues from there: `lines.items[].sku`, and nested arrays give `lines.items[].tags.items[]`. Dots inside real MongoDB key names are escaped as `\.` so the path stays unambiguous.

**Denominators.** A path containing no `items[]` segment is **document-denominated**: `observedUnits = sampledDocs` and `presentCount` increments at most once per document, so a ratio of 41.2% means "41.2% of sampled documents". A path containing at least one `items[]` segment is **array-element-denominated**: `observedUnits` is the total number of elements observed in the nearest enclosing array (recorded as `arrayParent`) across all sampled documents, and `presentCount` increments once per element. The two are never compared against each other; a path whose `denominator` differs between two snapshots is reported as a hard `type_changed` (the shape itself changed) and never as a presence drop. `lines.items[]` itself always has ratio 1.0 — it exists to carry the *element* type distribution, which is where "array of strings became array of objects" appears. An empty array `[]` contributes `array` to its parent's `bsonTypes` and adds **zero** to the child's `observedUnits`.

**Missing vs null vs empty.** Three distinct states. *Missing*: the key is absent from its containing object (or is JS `undefined`) — it increments nothing, which is why `presentCount / observedUnits` is meaningful. *Null*: key present with BSON `null` — increments `presentCount`, `nullCount`, and `bsonTypes.null`. *Empty string*: increments `presentCount`, `emptyStringCount`, and `bsonTypes.string`. `nullRatio = nullCount / presentCount` (null **among present**, 0 when `presentCount` is 0).

**BSON types.** `bsonTypeOf` checks `_bsontype` first (`objectId`, `decimal`, `long`, `binData`, `timestamp`, …), then `Array.isArray`, `Date`, `RegExp`, then `typeof`. Integral JS numbers are reported as `int`, non-integral as `double` — the driver cannot tell an `int32` from an integral `double` after deserialization, which is exactly why `treatNumericTypesAsEquivalent: true` (default) collapses `int|long|double|decimal` to `number` **in the diff only**, never in the snapshot. A type counts as *significant* for a path when `count / presentCount >= typeNoiseFloorPct / 100`, so one freak document does not raise a finding.

**Findings.** For path `p`, `rA`/`rB` = presence ratios, `nA`/`nB` = null ratios, `TA`/`TB` = significant type sets (after numeric collapsing). Paths matching `ignorePaths` are skipped entirely. Evaluated in this order, and `field_disappeared` / `field_appeared` suppress the other three for that path:

1. `field_disappeared` — `p` is in baseline with `rA * 100 >= minPresenceToTrackPct`, and in current it is absent or `rB == 0`.
2. `field_appeared` — `p` is absent from baseline or `rA == 0`, and `rB * 100 >= newFieldMinPresencePct`.
3. `type_changed` — `p` in both and `TA ≠ TB` (either direction; the finding prints both sets). Also fires when `denominator` differs between snapshots.
4. `presence_dropped` — `p` in both, same `denominator`, and `(rA - rB) * 100 >= presenceDropPct`. **Absolute percentage points**, not relative. Increases are never findings.
5. `null_ratio_increased` — `p` in both and `(nB - nA) * 100 >= nullRatioIncreasePct`, in percentage points.

**Different filters.** `diff` canonicalizes both snapshots' `sampling.filter` (recursively key-sorted JSON) and compares it along with `sampling.mode`. On mismatch it **refuses**: prints both filters and exits 2, because a presence drop caused by a narrower query is not drift. `--allow-filter-mismatch` turns the refusal into a warning printed in the report header and continues. Two mismatches have **no** override and always exit 2: a different `collection`, and a different `formatVersion`.

**`minSampledDocs`.** Default 500. When a snapshot's `sampledDocs` is below it, every finding is downgraded to `severity: "info"`, a prominent warning is emitted, and `--fail-on-drift` exits **0**. The same rule applies per-path to array-element paths whose `observedUnits` is below it. Rationale, stated in `docs/semantics.md`: at n = 50 the 95% confidence interval around an observed 50% presence ratio is roughly ±14 percentage points, so a 10pp "drop" is indistinguishable from noise. docpulse would rather stay silent than train you to ignore it.

## 7. Implementation order

1. **Scaffold + types + BSON typing.** package.json/tsconfig/vitest, `core/types.ts`, `core/bsonType.ts`. *Done when* `npm run build` emits `dist/` and `npm test` passes `bsonType.test.ts` for all 16 type names.
2. **Path walker + inference accumulator.** `core/paths.ts`, `core/infer.ts`, `source/arraySource.ts`. *Done when* `paths.test.ts` and `infer.test.ts` pass, including the nested-array and empty-array cases.
3. **Snapshot format + `docpulse snapshot --input-json`.** `core/snapshotSchema.ts`, `config.ts`, `cli.ts`, `commands/snapshot.ts`. *Done when* `docpulse snapshot --input-json test/fixtures/docs.json -o /tmp/s.json` writes a file that re-parses under the zod schema, and two runs are byte-identical apart from `createdAt`.
4. **MongoDB adapter.** `source/mongoSource.ts` behind the same `DocumentSource` interface. *Done when* `tsc --noEmit` is clean and `grep -rl "from 'mongodb'" src/` prints exactly `src/source/mongoSource.ts`.
5. **Diff engine + thresholds.** `core/diff.ts` plus config merging. *Done when* `diff.test.ts` has one passing test per finding type from hand-written snapshot pairs, plus filter-mismatch, collection-mismatch and `minSampledDocs` tests.
6. **Reporters + exit codes.** `report/{markdown,json,table}.ts`, `commands/diff.ts`. *Done when* `cli.test.ts` asserts exit 1 for `examples/baseline.snapshot.json` → `examples/current.snapshot.json` with `--fail-on-drift`, exit 0 against itself, and exit 2 on a bad path.
7. **Docs and release prep.** README with output pasted from a real run, `docs/semantics.md`, `examples/drift-check.yml`, LICENSE, `.github/workflows/ci.yml`. *Done when* `npm pack --dry-run` lists `dist/`, `README.md`, `LICENSE`, `docs/`, `examples/` and nothing from `src/` or `test/`.

Every step ends with a green `npm run check`; the repo is releasable from step 6 onward.

## 8. Test strategy

No database is required to run the full suite. `npm run check` = `tsc --noEmit && vitest run`; `npm test` = `vitest run`.

**Unit — `bsonType`:** each of the 16 canonical names, including `ObjectId`, `Decimal128`, `Long`, `Binary`, `Timestamp`, `Date`, `RegExp`; `3` → `int`, `1.5` → `double`, `null` → `null`, `undefined` → missing.

**Unit — `paths`:** flat document; nested object; array of scalars yields `tags` + `tags.items[]`; array of objects yields `lines.items[].sku`; nested array yields `lines.items[].tags.items[]`; empty array adds no child units; a key containing a literal dot is escaped.

**Unit — `infer`:** a 4-document fixture with hand-computed ratios; an array-element path whose `observedUnits` is 7 across 3 documents; mixed types counted per type; missing vs `null` vs `""` land in different counters; two runs over the same array produce deep-equal snapshots (ignoring `createdAt`); `sampledDocs` respects `--sample-size` truncation.

**Unit — `diff`:** one test per finding type; `field_disappeared` suppresses `presence_dropped` on the same path; a 9pp drop with `presenceDropPct: 10` yields nothing and 11pp yields a finding; `int` → `double` is not a `type_changed` by default but is with `treatNumericTypesAsEquivalent: false`; a type present in 0.5% of docs is filtered by `typeNoiseFloorPct`; `denominator` change becomes `type_changed`; `sampledDocs: 100` downgrades all findings to info; filter mismatch refuses and `--allow-filter-mismatch` proceeds; collection and `formatVersion` mismatch always refuse; `ignorePaths` drops the path.

**Unit — `config` / `report`:** defaults with no file; CLI flag beats file beats default; malformed config produces a readable zod message; inline-snapshot test of the markdown report containing one of each finding type; JSON reporter output parses and has stable key order; table reporter handles zero findings.

**CLI (still no DB):** spawn the built `dist/cli.js` with `--input-json` fixtures end-to-end and assert exit codes 0 / 1 / 2 and that `--out` files exist.

**Optional live integration:** `test/integration/mongo.test.ts` wrapped in `describe.skipIf(!process.env.MONGODB_URI)`. It creates database `docpulse_it`, inserts 1000 synthetic documents in which `optional` is present in exactly 700, asserts the reported presence ratio is 70% ±2pp, and drops the database in `afterAll`. It is skipped — not failed — when the env var is absent, so `npm test` is green on a machine with no `mongod`. CI runs `npm run check` on Node 22 without a database service.
