# docpulse semantics

This document is the contract behind every number docpulse prints. If a
snapshot or a report ever disagrees with what is written here, that is a bug.

## Paths

Object nesting joins with `.`:

```
{ "customer": { "taxId": "TR123" } }   ->   customer, customer.taxId
```

An array field produces **two** paths: the array itself and its elements.

```
{ "lines": [ { "sku": "A" } ] }
  ->  lines               (BSON type `array`, denominated in documents)
      lines.items[]       (the elements, denominated in array elements)
      lines.items[].sku
```

Nested arrays keep stacking the marker:

```
{ "lines": [ { "tags": ["x"] } ] }   ->   lines.items[].tags.items[]
```

Every intermediate object is itself a path, so `customer` appears next to
`customer.taxId`. This is deliberate: "the whole `customer` sub-document stopped
being written" and "only `customer.taxId` stopped being written" are different
incidents and you want to see which one happened.

### Key escaping

MongoDB keys may contain characters docpulse uses as syntax. Inside a real key,
`.`, `[` and `\` are backslash-escaped, so a document key literally named `a.b`
becomes the single path segment `a\.b` and can never be confused with a nested
object. A key literally named `items[]` becomes `items\[]` and is therefore
never mistaken for the array marker.

## Denominators

This is the part most schema tools get wrong, and it is why docpulse exists.

| Path shape | Denominator | `observedUnits` | `presentCount` increments |
|---|---|---|---|
| no `items[]` segment | `documents` | `sampledDocs` | at most once per document |
| at least one `items[]` | `arrayElements` | total elements of the nearest enclosing array (`arrayParent`) across all sampled documents | once per element |

So `41.2%` on `customer.taxId` means "41.2% of sampled **documents**", while
`99.9%` on `lines.items[].sku` means "99.9% of the 4102 observed **line
items**". The two populations are never mixed, never compared, and the unit is
always printed in the report.

A few consequences:

- `lines.items[]` normally has a ratio of exactly 1.0. It exists to carry the
  *element* type distribution, which is where "an array of strings became an
  array of objects" shows up. (It can fall below 1.0 only if an array literally
  contains a JavaScript `undefined` hole, which MongoDB will not produce.)
- An empty array `[]` contributes `array` to its parent's `bsonTypes` and adds
  **zero** to its children's `observedUnits`. Empty arrays cannot dilute a
  child's presence ratio.
- If every array of a given path is empty across the whole sample, no
  `items[]` path exists at all — there is nothing to report on.
- A path whose `denominator` differs between two snapshots is a `type_changed`
  (the shape itself changed) and is **never** a presence drop.

## Missing vs null vs empty string

Three distinct states, three distinct counters:

| State | `presentCount` | `nullCount` | `emptyStringCount` | `bsonTypes` |
|---|---|---|---|---|
| key absent (or JS `undefined`) | — | — | — | — |
| key present, value `null` | +1 | +1 | — | `null` +1 |
| key present, value `""` | +1 | — | +1 | `string` +1 |
| key present, anything else | +1 | — | — | its type +1 |

Missing increments **nothing**, which is exactly what makes
`presentCount / observedUnits` meaningful.

`nullRatio = nullCount / presentCount` — null *among present*, and `0` when
`presentCount` is `0`. A field that is missing half the time and null the other
half has a presence ratio of 50% and a null ratio of 100%.

The empty-string ratio is reported as context and **never** raises a finding.
Whether `""` is a bug is a question about your domain, not about your schema.

## BSON types

`bsonTypeOf` checks `_bsontype` first (so `Timestamp`, which extends `Long`, and
`UUID`, which extends `Binary`, are not mislabelled), then `Array.isArray`,
`Date`, `RegExp`, typed arrays, then `typeof`.

`_bsontype` is only believed on a value that is *not* a plain object, because a
document may legitimately store a field called `_bsontype`. A plain
`{ "_bsontype": "ObjectId", … }` is an `object` and docpulse walks into it like
any other; otherwise a producer could hide every field beneath such an object
from the snapshot simply by writing that key.

The 16 canonical names are: `array`, `binData`, `bool`, `date`, `decimal`,
`double`, `int`, `javascript`, `long`, `null`, `object`, `objectId`, `regex`,
`string`, `symbol`, `timestamp`. Exotic wrappers (`minKey`, `maxKey`, `dbRef`)
are reported under a camelCased form of their `_bsontype` rather than being
flattened into "unknown".

Integral JS numbers are reported as `int` and non-integral ones as `double`.
After deserialization the driver genuinely cannot tell an `int32` from an
integral `double`, which is precisely why `treatNumericTypesAsEquivalent`
(default `true`) collapses `int | long | double | decimal` into `number` **in
the diff only, never in the snapshot**. The snapshot records what was observed;
the diff decides what matters.

A type is *significant* for a path when its share of `presentCount` is at least
`typeNoiseFloorPct`. Numeric collapsing happens **before** the floor is applied,
so 0.6% `int` plus 0.6% `double` is a significant `number`, not two pieces of
noise.

## Findings

For path `p`: `rA`/`rB` are presence ratios, `nA`/`nB` null ratios, `TA`/`TB`
the significant type sets. Paths matching `ignorePaths` (an exact match, or the
subtree beneath it) are skipped entirely. Rules are evaluated in this order, and
`field_disappeared` / `field_appeared` suppress the other three for that path:

1. **`field_disappeared`** (error) — `p` is in the baseline with
   `rA * 100 >= minPresenceToTrackPct`, and in the current snapshot it is absent
   or `rB == 0`.
2. **`field_appeared`** (warning) — `p` is absent from the baseline or `rA == 0`,
   and `rB * 100 >= newFieldMinPresencePct`.
3. **`type_changed`** (error) — `p` is in both and `TA ≠ TB`, in either
   direction; the finding prints both sets. Also fires when `denominator`
   differs between the two snapshots.
4. **`presence_dropped`** (error) — `p` is in both with the same `denominator`,
   and `(rA - rB) * 100 >= presenceDropPct`. **Absolute percentage points**, not
   relative. Increases are never findings.
5. **`null_ratio_increased`** (warning) — `p` is in both and
   `(nB - nA) * 100 >= nullRatioIncreasePct`, in percentage points. Decreases
   are never findings.

There are exactly five finding types. There will not be a sixth in v0.1.

## Different filters

`diff` canonicalizes both snapshots' `sampling.filter` (recursively key-sorted
JSON, so `{a:1,b:2}` and `{b:2,a:1}` are the same filter) and compares it along
with `sampling.mode`. On a mismatch it **refuses**: it prints both filters and
exits `2`, because a presence drop caused by a narrower query is not drift.

`--allow-filter-mismatch` turns the refusal into a warning printed in the report
header and continues.

Two mismatches have **no** override and always exit `2`:

- a different `collection`
- a different `formatVersion`

For `--input-json`, `collection` defaults to `input:<basename>`. Since two
different files then carry two different collection names, pass `-d`/`-c` to
name the logical collection when you intend to compare two local files:

```bash
docpulse snapshot --input-json week38.ndjson -d shop -c orders -o a.json
docpulse snapshot --input-json week39.ndjson -d shop -c orders -o b.json
```

## `minSampledDocs`

Default `500`. When a snapshot's `sampledDocs` is below it, every finding is
downgraded to `severity: "info"`, a prominent warning is emitted, and
`--fail-on-drift` exits **0**. The same rule applies per path to array-element
paths whose own `observedUnits` is below the threshold.

The reasoning: at n = 50 the 95% confidence interval around an observed 50%
presence ratio is roughly ±14 percentage points, so a 10pp "drop" is
indistinguishable from sampling noise. docpulse would rather stay silent than
train you to ignore it.

If you genuinely want findings on a small collection, lower `minSampledDocs`
yourself in `docpulse.config.json`. That is a decision, and it should be written
down where your team can see it.

## Handling untrusted data

A snapshot is meant to be committed and a drift report is meant to be published
(`examples/drift-check.yml` writes it to the job summary). Both are built from
data docpulse does not control, so it is worth being explicit about what ends up
where.

- **Your `--filter` is stored verbatim** in the snapshot's `sampling.filter`,
  and printed in full when `diff` refuses a filter mismatch. That is deliberate:
  a presence drop caused by a narrower query is not drift, so the filter has to
  travel with the snapshot. It also means a filter that matches on an e-mail
  address, an account identifier or anything else you would not put in git ends
  up in git. Filter on non-sensitive fields, or accept that the value is public.
- **Your connection string is never stored or printed.** It is not written to
  the snapshot, not written to any report, and not included in the error
  docpulse prints when a connection fails — only the driver's own (credential-
  free) message is shown. It is, however, visible in `ps` output and in your
  shell history when you pass it as `--uri`, so prefer the `MONGODB_URI`
  environment variable, and a CI secret in a pipeline.
- **`--filter` is passed to MongoDB unchanged.** docpulse issues only reads, but
  a filter containing `$where`, `$function` or `$accumulator` makes the *server*
  run JavaScript. Do not build a `--filter` out of anything you did not write
  yourself, such as a workflow input.
- **Reports escape the data they print.** Field paths are document keys and BSON
  type names can come from a stored `_bsontype` value, so the Markdown and table
  reporters turn control characters into visible escapes (`\n`) and a literal
  backtick into `\u0060`. Without that, a document key containing a newline
  could forge extra rows, headings or links in a report pasted into a pull
  request. A path shown with `\n` or `\u0060` in it really does contain that
  character in your collection.

## What this tool does not guarantee

- **It does not see your collection, only your sample.** Every ratio is an
  estimate. With the default `sort-limit` mode the sample is the newest N
  documents by `_id`, which is reproducible but *not* representative of the
  whole collection. `--random` uses `$sample` and is unbiased but not
  reproducible, and may collection-scan.
- **It does not validate values.** No ranges, enums, regex conformance,
  cardinality, uniqueness or PII detection. A field can be 100% present, 100%
  `string`, and 100% garbage, and docpulse will call it stable.
- **It is not a schema.** A snapshot is a description of what was observed, not
  a specification of what is allowed. It does not generate `$jsonSchema`.
- **It says nothing about intent.** `field_appeared` on a field your team added
  on purpose is still a finding — add it to `ignorePaths` or re-baseline. The
  tool has no way to know, and pretending otherwise would make it lie.
- **It never writes to MongoDB.** The only operations it issues are `find`
  (with `sort` and `limit`), `$sample`, `countDocuments` and
  `estimatedDocumentCount`.
- **`estimatedTotalDocs` is an estimate** when it comes from
  `estimatedDocumentCount` (metadata, not a scan). It is only there for context
  and is never used in a finding.
