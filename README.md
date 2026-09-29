# docpulse

[![ci](https://github.com/canerinali/docpulse/actions/workflows/ci.yml/badge.svg)](https://github.com/canerinali/docpulse/actions/workflows/ci.yml)
[![licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)
[![node: >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/docpulse.svg)](https://www.npmjs.com/package/docpulse)

<https://github.com/canerinali/docpulse>

**Data contract testing for schemaless MongoDB collections.**

docpulse samples a MongoDB collection and writes down the schema your documents *actually* have: which fields
are present in what share of the sample, which BSON types they take, how often they are null or empty. Then it
diffs two of those snapshots and, under `--fail-on-drift`, exits nonzero when a drift crosses a threshold you set.

![docpulse turning field drift into a failed build](docs/demo.gif)

- **You find out the day a field stops being written, not the week a report comes out wrong.** An upstream
  service quietly drops `customer.taxId` from its payload. Nothing throws, nothing 500s, and the aggregation
  that reads it just returns fewer rows. docpulse turns that into a failed build on the next CI run.
- **You are never guessing at the denominator.** Every finding says what it counted and out of how many:
  `412 of 1000 documents`, or `4098 of 4102 array elements`, tracked separately and never compared against each
  other. Below `minSampledDocs` (default 500) docpulse downgrades its findings to info and lets the build pass,
  because a 10-point "drop" in a 50-document sample is noise and a tool that cries wolf gets muted.
- **It is a test, not a dashboard.** Two commands, a JSON file you commit, and an exit code. No web UI, no
  agent, no history store, no write access to your database. Three runtime dependencies in total:
  `commander`, `zod`, `mongodb`.

## Install

```sh
npm install -g docpulse    # or run it without installing: npx docpulse --help
```

## Usage

```sh
export MONGODB_URI="mongodb+srv://..."   # docpulse reads it from the environment
docpulse snapshot -d shop -c orders -o today.json && docpulse diff baseline.json today.json --fail-on-drift
```

docpulse reads the connection string from `MONGODB_URI`, or from a file with
`--uri-file /run/secrets/mongodb-uri` — the usual Docker and Kubernetes secret
mount. There is a `--uri` flag, but prefer either of the other two: an argument
is visible to every user on the machine (`/proc/<pid>/cmdline` is world-readable
on Linux), and it lands in your shell history and in CI logs under `set -x`.

`snapshot` writes the file. `diff` reports only what crosses your thresholds and, with `--fail-on-drift`, exits
`1` when something does (`0` = clean, or drift without that flag; `2` = bad input or a comparison docpulse
refuses to make).

## Try it with no database

```bash
./examples/run.sh
```

It snapshots two local NDJSON files as if they were two weekly samples of the
same `shop.orders` collection, then diffs them. Everything below is real output
from that script.

### Sample output

Taking the two snapshots, then diffing the baseline against itself — no drift,
exit 0:

```console
$ docpulse snapshot --input-json orders-before.ndjson --db shop --collection orders \
    --label week-38 --out generated/baseline.snapshot.json
exit=0

$ docpulse snapshot --input-json orders-after.ndjson --db shop --collection orders \
    --label week-39 --out generated/current.snapshot.json
exit=0

$ docpulse diff generated/baseline.snapshot.json generated/baseline.snapshot.json \
    --format table --fail-on-drift
docpulse shop.orders: week-38 (600 docs) -> week-38 (600 docs)
No findings: nothing crossed the configured thresholds.
Suppressed (below threshold or in ignorePaths): 2
exit=0
```

Diffing last week against this week — drift, exit 1:

```console
$ docpulse diff generated/baseline.snapshot.json generated/current.snapshot.json --fail-on-drift
exit=1
```

<!-- sample-report:start -->
The report it wrote:

# docpulse drift report

`shop.orders` — baseline `week-38` (600 docs) → current `week-39` (600 docs)
**5 findings** (3 error, 2 warning) · thresholds: presenceDrop 10pp, nullRatioIncrease 10pp, minSampledDocs 500

| # | Finding | Path | Baseline → Current | Sample | Suggested action |
|---|---|---|---|---|---|
| 1 | `field_disappeared` | `couponCode` | 63.3% → absent | 600 → 600 documents | The field is absent from the whole sample. Confirm the producer was retired on purpose, then re-baseline. |
| 2 | `type_changed` | `lines.items[].qty` | `number` → `number, string` | 1200 → 1200 array elements | A producer is sending numbers as strings; find it before your aggregations silently drop rows. |
| 3 | `presence_dropped` | `customer.taxId` | 75.0% → 20.0% (-55.0pp) | 600 → 600 documents | Confirm the field is still being written; if it was intentionally retired, re-baseline. |
| 4 | `field_appeared` | `channel` | absent → 100.0% | 600 → 600 documents | A field you have no contract for is being written. Add it to the contract, or to ignorePaths. |
| 5 | `null_ratio_increased` | `paymentProvider` | 2.0% → 30.0% null of present (+28.0pp) | 600 → 600 documents | Upstream is writing nulls instead of omitting the field; decide which contract you want. |

<details><summary>Suppressed (below threshold or in ignorePaths): 2</summary>

- `_id` — matched ignorePaths
- `updatedAt` — matched ignorePaths

</details>
<!-- sample-report:end -->

### Snapshot format

A snapshot is a plain, key-stable JSON file — diff it, review it, commit it.
Two runs over the same documents are byte-identical apart from `createdAt`.
This is `examples/generated/baseline.snapshot.json` with `fields` abridged to two
of its twelve entries:

```json
{
  "formatVersion": 1,
  "tool": "docpulse@0.1.1",
  "label": "week-38",
  "createdAt": "2026-09-26T17:52:07.895Z",
  "collection": "shop.orders",
  "sampling": { "mode": "input-file", "sampleSize": 1000, "filter": {}, "sort": null },
  "sampledDocs": 600,
  "estimatedTotalDocs": 600,
  "estimatedTotalDocsMethod": "inputLength",
  "fields": [
    {
      "path": "customer.taxId",
      "denominator": "documents",
      "observedUnits": 600,
      "presentCount": 450,
      "nullCount": 0,
      "emptyStringCount": 0,
      "bsonTypes": { "string": 450 }
    },
    {
      "path": "lines.items[].qty",
      "denominator": "arrayElements",
      "arrayParent": "lines",
      "observedUnits": 1200,
      "presentCount": 1200,
      "nullCount": 0,
      "emptyStringCount": 0,
      "bsonTypes": { "int": 1200 }
    }
  ]
}
```

The snapshot records the exact `--filter` the sample was taken with, because
`diff` refuses to compare two snapshots taken with different filters — a
presence drop caused by a narrower query is not drift, so the filter has to
travel with the data. Snapshots are meant to be committed, so **do not filter on
secret values**: `--filter '{"apiToken":"sk-live-…"}'` writes that token into
your repository, permanently.

## The problem

Your `orders` collection has no schema, so nothing tells you when an upstream
producer quietly starts sending `qty` as a string, stops writing `customer.taxId`,
or replaces an omitted field with an explicit `null`. You find out weeks later,
in an aggregation that silently dropped rows.

docpulse makes that a build failure. You commit a baseline snapshot, take a new
one on a schedule, and `docpulse diff --fail-on-drift` exits non-zero when the
difference crosses a threshold you wrote down.

## Features

- **Two commands.** `snapshot` samples a collection into a JSON file;
  `diff` compares two of those files and sets an exit code. That is the whole tool.
- **Honest denominators.** A ratio is always reported against the population it
  was measured in: `41.2% of 1000 documents` and `99.9% of 4102 array elements`
  are different statements, and docpulse never mixes them.
- **Missing, `null` and `""` are three different things.** They land in three
  different counters, so "the field stopped being written" and "the field is now
  explicitly null" are different findings.
- **Exactly five finding types.** `field_disappeared`, `field_appeared`,
  `type_changed`, `presence_dropped`, `null_ratio_increased`. Nothing else.
- **Thresholds you write, in `docpulse.config.json`.** No automatic baseline
  learning, no magic.
- **It refuses to compare apples and oranges.** Different query filter, different
  collection, or different snapshot format version: it exits `2` and tells you
  why, instead of reporting a presence drop that is really just a narrower query.
- **It shuts up on small samples.** Below `minSampledDocs` (default 500) every
  finding is downgraded to `info` and `--fail-on-drift` passes, because at n = 50
  a 10pp "drop" is indistinguishable from noise.
- **Read-only, always.** The only MongoDB operations it issues are `find`,
  `$sample`, `countDocuments` and `estimatedDocumentCount`. One caveat, and it
  is yours to make: `--filter` is passed to MongoDB **verbatim**, and `$where`,
  `$function` and `$accumulator` make the *server* execute JavaScript when
  server-side scripting is enabled. docpulse refuses those three unless you pass
  `--allow-server-js`, and either way you should run docpulse with a user that
  holds only `read` on the target database.
- **Works with no database at all.** `--input-json` reads a JSON array or NDJSON
  file, so you can try it, test it, and run it in CI without a `mongod`. NDJSON
  is *streamed*: with `-n 1000` docpulse reads a thousand lines of your 40 GB
  export and stops, at constant memory. A `[ … ]` array is a single JSON value
  that has to be held in memory in one piece, so that form is capped at 128 MB
  and the error tells you to convert the file to NDJSON.
- **Three runtime dependencies**: `commander`, `zod`, `mongodb`.

## Commands

```
docpulse snapshot [options]

  -u, --uri <uri>          MongoDB connection string. Prefer MONGODB_URI or --uri-file:
                           an argument is visible in the process list.
      --uri-file <path>    Read the connection string from a file (secret mount).
                           Trailing newline trimmed. Not with --uri or --input-json.
  -d, --db <name>          Database name
  -c, --collection <name>  Collection name (required unless --input-json)
      --input-json <file>  Read documents from a JSON array or NDJSON file instead of MongoDB
  -o, --out <file>         Write snapshot here (default: stdout)
  -n, --sample-size <n>    Max documents to sample (default: 1000)
      --filter <json>      Query filter, JSON object (default: {})
      --sort <json>        Sort for deterministic sampling (default: {"_id":-1})
      --allow-server-js    Allow $where / $function / $accumulator in --filter. These make
                           the MongoDB server execute JavaScript; refused by default.
      --random             Use $sample instead of sort+limit. Unbiased but NOT reproducible.
      --label <text>       Free-text label stored in the snapshot
```

```
docpulse diff [options] <baseline.json> <current.json>

      --config <file>          Config file (default: ./docpulse.config.json if present)
      --format <fmt>           markdown | json | table (default: markdown)
  -o, --out <file>             Write report here (default: stdout)
      --fail-on-drift          Exit 1 if any finding survives the thresholds
      --allow-filter-mismatch  Downgrade a filter/sampling mismatch from refusal to a warning

Exit codes: 0 = no drift (or drift without --fail-on-drift)
            1 = drift + --fail-on-drift
            2 = usage error, invalid/unreadable snapshot, or refused comparison
```

With `--input-json`, `-d`/`-c` name the *logical* collection the documents belong
to. Pass the same pair for both files you intend to compare — `diff` refuses to
compare snapshots of different collections.

The connection string is resolved in this order: `--uri-file`, then `--uri`,
then `MONGODB_URI`. Passing both `--uri-file` and `--uri` is not a precedence
question but an error — docpulse exits `2` rather than guess which one you
meant. `--uri-file` reads one line from a file and trims the trailing newline,
so a Docker or Kubernetes secret works unmodified:

```sh
docpulse snapshot --uri-file /run/secrets/mongodb-uri -d shop -c orders -o today.json
```

## Configuration

`docpulse.config.json` is picked up from the working directory. Every key below
is the default, and the file is optional:

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

Full semantics — paths, denominators, every finding rule, and what docpulse
explicitly does *not* guarantee — are in [docs/semantics.md](docs/semantics.md).

## In CI

[`examples/drift-check.yml`](examples/drift-check.yml) is a complete GitHub
Actions workflow: it takes a nightly snapshot, diffs it against a baseline
committed in the repo, publishes the markdown report to the job summary, and
fails the build on drift.

## Contributing

Issues and pull requests are welcome at
<https://github.com/canerinali/docpulse>.

```bash
git clone https://github.com/canerinali/docpulse.git
cd docpulse
npm install
npm run check      # tsc --noEmit && vitest run
npm run build      # emit dist/
./examples/run.sh  # the end-to-end example, no database needed
```

Ground rules that keep this tool small:

- **The whole unit suite must pass with no database.** Anything that needs a
  live MongoDB belongs in `test/integration/`, wrapped in
  `describe.skipIf(!process.env.MONGODB_URI)`.
- **`mongodb` is imported by exactly one file**, `src/source/mongoSource.ts`.
  Everything else talks to the `DocumentSource` interface.
- **The snapshot format is a file format.** People commit these. Changing its
  shape means bumping `formatVersion` and saying so.
- **New finding types are a hard sell.** There are five, on purpose. A tool that
  cries wolf gets muted, and a muted tool is worth nothing.
- Please add a test with any behaviour change; `npm run check` must be green.

If you are running a live integration check locally:

```bash
MONGODB_URI="mongodb://localhost:27017" npm test
```

## Licence

Apache-2.0 — see [LICENSE](LICENSE). Copyright 2026 Caner İnali.

The patent grant is deliberate: this tool is meant to run inside other
companies' CI pipelines, and Apache-2.0 is the licence that gets it past their
legal review.
