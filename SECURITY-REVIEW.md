# docpulse 0.1.0 — pre-publication security review

> **Note on concurrency.** A second reviewer was writing to this same path while
> this review ran, and two commits (`d7230e4`, `c3c19d5`) landed mid-review
> carrying the fixes described below. This document is the version produced by
> the reviewer who found and fixed H-1/M-1/M-4/L-1/L-2/L-3; the other reviewer's
> independent draft, which assessed the tree *after* those fixes and
> contributed M-3, M-4, L-2 and I-1/I-2/I-9, was preserved rather than
> discarded. Where the two disagree on severity, the difference is only which
> tree was assessed: at `3994e50` there is one High finding; after the fixes
> there is none.

**Reviewed:** 2026-09-26. **Base:** git `3994e50`, plus the fixes this review
applied (see [Files changed](#files-changed-by-this-review)).
**Scope:** `src/`, `test/`, `examples/`, `docs/`, `.github/`, packaging
metadata, the resolved dependency tree, and the git history of all commits.
**Method:** source reading, plus dynamic testing of the built CLI (Node
v22.23.2) against crafted hostile inputs, a network tripwire, and a throwaway
authenticated `mongo:7` container.

| Severity | Count | Fixed | Still open |
|---|---|---|---|
| Critical | 0 | — | — |
| High | 1 | 1 | 0 |
| Medium | 4 | 4 | 0 |
| Low | 5 | 4 | 1 |
| Informational | 9 | 3 (+1 partial) | 5 |

`npm audit` is clean, `npm run check` is green (185 passed / 2 skipped without a
database; 187 passed with one), and the example still produces byte-identical
output apart from `createdAt`.

### Reconciliation pass — 2026-09-29

The counts above are **not** the ones this review shipped with. Six commits
landed after it was written, and every finding was re-verified against the built
CLI on 2026-09-29 (Node v22.23.2, a throwaway authenticated `mongo:7`
container). What changed:

| Finding | Status in the original review | Verified status, 2026-09-29 | What changed it |
|---|---|---|---|
| M-2 | documented only | **fixed** | `059cdd8` — `--uri-file`, env-var-first help and README |
| M-3 | recommendation, not fixed | **fixed** | `52ff331` — NDJSON is streamed; the array form is capped |
| L-4 | documented | **still open, by design** | `ff89605` added the README warning; the behaviour is unchanged and deliberate |
| L-5 | documented, guard not added | **fixed** | `ecec2e9` — `$where`/`$function`/`$accumulator` refused by default |
| I-8 | recommendation | **fixed** | `52ff331` — `LAUNCH.md` gitignored; absent from `main`'s history |
| I-9 | not applied | **partially fixed** | `630a2ae` — audit step, Dependabot, exact `npx` pin; actions still tag-pinned, no provenance |

H-1, M-1, M-4, L-1, L-2 and L-3 were re-tested against the current build and are
still fixed; the per-finding notes below record the evidence. The later commits
use their own numbering (`MEDIUM-2`, `LOW-1`…`LOW-5`) which does **not** line up
with the `M-`/`L-` numbers in this document — the table above is the mapping.

---

## Threat model

docpulse is a local CLI with no server and no account. It takes three kinds of
input and only one of them is trustworthy:

| Input | Trust |
|---|---|
| `--uri`, `--db`, `--collection`, `--out`, `--filter`, file paths | **The operator's own argv.** Trusted. Reading a file you named or running a query you typed is not an attack. |
| Documents sampled from MongoDB — keys, values, `_bsontype` tags | **Untrusted.** The tool exists precisely because an upstream producer may start writing things nobody agreed to. |
| Snapshot files, `docpulse.config.json`, `--input-json` files | **Untrusted.** The README tells you to commit baseline snapshots, so they arrive through pull requests. |

Two assets are worth protecting: the **MongoDB credential** the operator hands
over, and the **integrity of the drift report**, which
`examples/drift-check.yml` publishes to a GitHub job summary and the README
suggests pasting into a PR comment. Almost every finding below is one or the
other.

---

## Critical

None.

---

## High

### H-1 — A document key can forge content in the drift report *(FIXED)*

**Where (at `3994e50`):** `src/report/markdown.ts:3-5` and
`src/report/table.ts:32-38`.

The Markdown reporter escaped exactly one character:

```ts
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');          // before
}
```

Newlines, carriage returns, ESC and backticks passed through untouched, and
several report cells are attacker-controlled:

- `finding.path` **is a MongoDB document key** (`src/core/paths.ts:118-126`);
  MongoDB permits newlines and backticks in key names.
- The BSON type names in the `Baseline → Current` cell can come from a stored
  `_bsontype` value (`camelize`, `src/core/bsonType.ts:60`) — an arbitrary
  string from a document.
- `baseline.collection` and both labels come from the **snapshot files**, which
  arrive through pull requests.
- `refusal.detail` was printed inside a fenced block with no escaping, so a
  triple backtick in it closed the fence.

**Why it matters here.** This is the one output docpulse is designed to
publish. `examples/drift-check.yml` does
`cat drift-report.md >> "$GITHUB_STEP_SUMMARY"`, and the README recommends PR
comments. Any producer that can write one document into the watched collection
could therefore write arbitrary Markdown into the summary a reviewer trusts —
including a forged `| 1 | no_drift | everything | fine |` row. The entire value
of docpulse is that a human believes that table.

**Reproduced.** A document key of
``ok`\n\n## INJECTED HEADING\n\n<img src=x onerror=alert(1)>\n\n| 1 | `no_drift` | … |``
produced:

```markdown
| 1 | `field_appeared` | `ok`

## INJECTED HEADING

<img src=x onerror=alert(1)>

\| 1 \| `no_drift` \| `everything` \| fine \| fine \| Nothing to do \|

benign` | absent → 100.0% | 600 → 600 documents | … |
```

The backtick closed the code span, the newline ended the table, and everything
after it rendered as top-level Markdown. Note that the project's own test suite
already asserted this must not happen once the new tests were added — the fix
is not a change of intent, only of implementation.

**Fix applied.** `src/report/markdown.ts:16-51` now routes every printed value
through a sanitiser: control characters (C0 — which includes ESC 0x1b — plus
DEL, U+2028 and U+2029) become visible escapes (`\n`, `\r`, `\t`, `\u00XX`) and
a literal backtick becomes ```, because Markdown offers no way to escape a
backtick inside a code span. `|` escaping is kept for table cells (`cell()`,
line 16) and dropped for fenced blocks (`fenced()`, line 21). The same
sanitising now covers the header line (line 87), labels (line 53), warnings
(line 111, see M-4), the suppressed list (line 139) and the refusal block
(lines 95, 98). `src/report/table.ts:15-29` gained an equivalent `safe()` for
control characters, applied to the header, the refusal, warnings, every row and
the suggested-action lines — a newline there broke the column layout the same
way, and an ESC would have reached the operator's terminal.

**After the fix** the same key renders inside one cell, on one line:

```markdown
| 1 | `field_appeared` | `ok`\n\n## INJECTED HEADING\n\n<img src=x onerror=alert(1)>\n\n\| 1 \| … \n\nbenign` | absent → 100.0% | 600 → 600 documents | … |
```

No line break, no heading, no extra row. The JSON reporter was already safe
(`JSON.stringify` escapes). Documented in `docs/semantics.md` ("Handling
untrusted data") so a reader knows a path shown with `\n` in it really contains
that character.

**Regression tests:** `test/report.test.ts` — "cannot be escaped by a document
key", "sanitises a label, a collection name and a BSON type name from a
snapshot file", "keeps its columns when a document key contains a newline".

> **Re-verified 2026-09-29: still fixed.** The same hostile key, replayed
> through the current build (`--input-json` → `diff`), produced an 8-line report
> whose only `#` line is docpulse's own `# docpulse drift report`, two table rows
> in total, and the whole payload contained in one cell on one line:
>
> ```markdown
> | 1 | `field_appeared` | `ok\u0060\n\n## INJECTED HEADING\n\n<img src=x onerror=alert(1)>\n\n\| 1 \| …\n\nbenign` | absent → 100.0% | 600 → 600 documents | … |
> ```

---

## Medium

### M-1 — A stored `_bsontype` field hides an entire subtree from the snapshot *(FIXED)*

**Where (at `3994e50`):** `src/core/bsonType.ts:22-25`, reached from
`src/core/paths.ts:90` and `:107-121`.

`bsonTypeOf` trusted `_bsontype` on any object:

```ts
function hasBsonTag(value: object): string | undefined {   // before
  const tag = (value as { _bsontype?: unknown })._bsontype;
  return typeof tag === 'string' && tag.length > 0 ? tag : undefined;
}
```

`walkDocument` descends only into a value whose type is `object`
(`src/core/paths.ts:117`). MongoDB happily stores a field literally named
`_bsontype`, so

```json
{ "safe": 1, "payload": { "_bsontype": "ObjectId", "hiddenNewField": 42 } }
```

made docpulse report `payload` as `objectId` — a scalar — and stop walking.
`payload.hiddenNewField` never appeared in the snapshot at all. A crafted tag
also produced junk type names in the snapshot (e.g. `_bsontype: "constructor"`
surfacing as the stringified `Object` function).

**Why it matters here.** docpulse's single job is to notice that an upstream
producer changed the shape of the data. This gave that same producer a one-key
switch to hide any number of new or changed fields from the tool watching it,
and `diff` reports nothing because the fields are in neither snapshot. It is a
bypass of the control itself, not a crash.

**Fix applied.** `src/core/bsonType.ts:32-38` believes `_bsontype` only on a
value that is not a plain object:

```ts
function hasBsonTag(value: object): string | undefined {   // after
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === null || proto === Object.prototype) return undefined;
  const tag = (value as { _bsontype?: unknown })._bsontype;
  return typeof tag === 'string' && tag.length > 0 ? tag : undefined;
}
```

Real BSON wrappers are class instances, so all 16 canonical types still resolve
and the existing type test passes unchanged. After the fix the same document
yields `payload : object`, `payload._bsontype : string`,
`payload.hiddenNewField : int`.

**Regression test:** `test/bsonType.test.ts` — "ignores a `_bsontype` field
stored in a plain document object". Documented in `docs/semantics.md` §BSON
types.

> **Re-verified 2026-09-29: still fixed.** 600 documents of
> `{"safe":1,"payload":{"_bsontype":"ObjectId","hiddenNewField":42}}` snapshot to
> `payload -> {"object":600}`, `payload._bsontype -> {"string":600}`,
> `payload.hiddenNewField -> {"int":600}`. Nothing is hidden.

### M-2 — The connection string is passed through `argv`, where any local user can read it *(FIXED)*

**Where:** `src/cli.ts:41` (`-u, --uri <uri>`), `src/commands/snapshot.ts:96`,
and the headline example in `README.md`.

The documented invocation is `docpulse snapshot -u "$MONGODB_URI" …`. The shell
expands the variable before `exec`, so the full
`mongodb+srv://user:password@host/…` lands in the process's argument vector.

**Measured on this host.** `/proc` is mounted without `hidepid`, all 431 PIDs
are visible, `/proc/<pid>/cmdline` is mode `0444`, and reading another running
process's `cmdline` returned the password in full:

```
mode: 444 owner uid: 1000
cmdline: …/node …/keep.js --uri mongodb://u:SUPERSECRET123@h/db
password readable from a different process: true
ps sees it too: true
```

The same string also lands in shell history and in CI logs under `set -x`.

**Why it matters here.** Credential exposure is the headline risk for this tool
— it is the one secret a user hands it. The safe path already exists
(`MONGODB_URI`, which `src/commands/snapshot.ts:96` reads and
`examples/drift-check.yml` uses correctly), but the README teaches the argv form
first.

**Fix applied:** `docs/semantics.md` now states this plainly and tells the
reader to prefer the environment variable; `SECURITY.md` lists it as a known,
inherent limitation with the same advice. **Left for the author** (this review
was asked not to touch `README.md`): change the `-u "$MONGODB_URI"` examples to
rely on the exported variable, and extend the `--uri` help string in
`src/cli.ts:41` to say "prefer the env var: `--uri` is visible in the process
list". An optional `--uri-file <path>` would suit Docker/Kubernetes secret
mounts. Note the tension a maintainer should settle: `SECURITY.md` declares this
out of scope — defensible for a CLI — while the README still teaches the form
that causes it.

> **Status as of 2026-09-29: fixed** by `059cdd8` "MEDIUM-2: keep the connection
> string out of argv". Everything this review left for the author was done.
> `src/commands/snapshot.ts:145-177` adds `resolveUri()` with a `--uri-file
> <path>` that reads one line from a secret mount and refuses to combine with
> `--uri`; `src/cli.ts:42-51` rewrites the `--uri` help to "Prefer the MONGODB_URI
> env var or --uri-file"; `src/commands/snapshot.ts:206-210` makes the
> "connection string is required" error name the safe paths first; and
> `README.md:39-50` now leads with `export MONGODB_URI=…`.
>
> Measured again on this host, against a live `mongo:7`:
>
> ```
> env-var path:   cmdline = "node …/docpulse snapshot -d shop -c orders -o /dev/null"
>                 secret readable in /proc/<pid>/cmdline: 0   ps sees it: 0
> --uri-file:     secret readable in /proc/<pid>/cmdline: 0
> --uri:          secret readable in /proc/<pid>/cmdline: 1   (unchanged, on purpose)
> ```
>
> **Residual, accepted:** `--uri` still exists and still puts the string in
> `argv`. That is the point of an escape hatch, and it is now the only path the
> help text argues against. Regression tests: `test/uriFile.test.ts`,
> `test/cli.test.ts`.

### M-3 — `--input-json` reads and parses the whole file regardless of `--sample-size` *(FIXED)*

**Where:** `src/source/arraySource.ts:134` (`readFile(file, 'utf8')`) and
`:141` (`parseDocumentsText`), with the limit applied only afterwards at
`src/source/arraySource.ts:41-44`.

`createFileSource` slurps the whole file into one JavaScript string, parses
*every* document into an array, and only then stops after `sampleSize`
documents. `--sample-size` bounds nothing about the read.

**Measured.** A 65 MB / 200 000-document NDJSON file with `--sample-size 1`:

```
exit 0 | peak RSS 355 MB | elapsed 696ms
```

(the same command on the 126 KB example fixture peaks at 67 MB), and the
snapshot reports `estimatedTotalDocs 200000` — proof that every document was
parsed in order to yield one. A 540 MB file cannot be processed at all:

```
$ docpulse snapshot --input-json huge.ndjson -d s -c o -n 1 -o /dev/null
docpulse: cannot read --input-json file: huge.ndjson
Invalid string length
```

**Why it matters here.** `--input-json` is the documented way to run docpulse in
CI without a database, and a `mongoexport` of a real collection is routinely
gigabytes. A 2 GB CI runner is OOM-killed on an input the tool advertises as
supported, and above V8's maximum string length there is no workaround at all.
The file is the operator's own, so this is availability rather than a trust
boundary — but `--sample-size` looks like it should prevent exactly this.

**Fix: not applied** — streaming is a rewrite of `arraySource.ts`, outside the
scope of a security pass. **Recommendation:** drive the file through
`fs.createReadStream` + `readline` for the NDJSON form, pushing documents into
the accumulator as they parse and stopping at `sampleSize`; `DocumentSource` is
already an `AsyncIterable`, so it is a drop-in change behind `createFileSource`.
Keep the whole-file `JSON.parse` only for the JSON-array form. As a stop-gap,
`stat()` the file and refuse above a documented size with an actionable message.

> **Status as of 2026-09-29: fixed** by `52ff331`, and along exactly the lines
> recommended above. `src/source/arraySource.ts:134-212` adds
> `NdjsonDocumentSource`, which drives the file through `createReadStream` +
> `readline` and destroys the handle the moment `sampleSize` documents have been
> yielded; `:251-280` sniffs the form from the first 64 KiB; `:227` caps the
> unavoidable JSON-array form at `MAX_BUFFERED_INPUT_BYTES = 128 MiB` with the
> actionable `jq -c '.[]'` message.
>
> **Measured again**, on a freshly generated 70 MB / 200 000-document NDJSON
> file (the review's own case was 65 MB / 200 000):
>
> ```
> -n 1        exit 0 | peak RSS  66 MB | elapsed  109ms   (was: 355 MB / 696ms)
> -n 200000   exit 0 | peak RSS 124 MB | elapsed 1461ms
> ```
>
> and the `-n 1` snapshot reports `estimatedTotalDocs: null` with
> `estimatedTotalDocsMethod: "inputTruncated"` — the file was *not* read to the
> end. The 540 MB case that previously died with `Invalid string length` now
> works: a 559 MB NDJSON file with `-n 1` exits 0 at a 66 MB peak in 101ms. The
> array form above the cap fails closed with the documented message:
>
> ```
> $ docpulse snapshot --input-json big.json -d s -c o -n 1 -o /dev/null
> docpulse: --input-json file is too large to read as a JSON array: big.json (154.9 MB, limit 128.0 MB)
> (exit 2)
> ```
>
> Regression tests: `test/fileSource.test.ts`.

### M-4 — A snapshot file can still write live Markdown into the warning blockquote *(FIXED)*

**Where:** `src/core/diff.ts:222-225` builds the `--allow-filter-mismatch`
warning by interpolating both snapshots' canonical `sampling.filter`;
`src/report/markdown.ts:111` renders it into a blockquote.

This is a residual of H-1 that survived the first fix: the warning is the one
place untrusted text is rendered as Markdown **prose** rather than inside a code
span, and `cell()` escapes control characters, backticks and `|` — but not `<`,
`[`, `*` or `&`. Reproduced after the H-1 fix, from a snapshot file whose filter
keys and values were attacker-chosen:

```
> **Warning:** … baseline: mode=sort-limit filter={"<img src=x onerror=alert(1)>":"[click me](https://evil.example) **bold** ## heading"} | current: …
```

`[click me](…)` rendered as a live link and `**bold**` as bold.

**Why it matters here.** Bounded — no forged table rows, and GitHub strips
`<img onerror>` — but a clickable attacker-chosen link inside a report a
reviewer trusts is content spoofing and a phishing vector, in the same output
H-1 was about. The refusal path was already safe: the same text goes into a
fenced block (`src/report/markdown.ts:95,98`) and `fenced()` prevents the fence
from being closed.

**Fix applied.** `src/report/markdown.ts:34-36` adds a `prose()` helper —
sanitise, then backslash-escape the ASCII punctuation that can start an inline
construct (`` \ ` * _ [ ] < > & ~ | ``) — and line 111 uses it for the warning.
docpulse's own warning wording contains none of that punctuation, so the message
stays readable. After:

```
> **Warning:** … filter={"\<img src=x onerror=alert(1)\>":"\[click me\](https://evil.example) \*\*bold\*\* ## heading"} \| current: …
```

The table reporter's warning line is covered by `safe()` (control characters
only, which is the whole risk in a terminal).

**Regression test:** `test/report.test.ts` — "does not let a snapshot file write
live Markdown into the warning blockquote".

> **Re-verified 2026-09-29: still fixed.** A snapshot file whose
> `sampling.filter` is
> `{"<img src=x onerror=alert(1)>":"[click me](https://evil.example) **bold** ## heading"}`,
> diffed with `--allow-filter-mismatch` against the current build, renders inert:
>
> ```markdown
> > **Warning:** … baseline: mode=sort-limit filter=`{}` \| current: mode=sort-limit filter=`{"\<img src=x onerror=alert(1)\>":"\[click me\](https://evil.example) \*\*bold\*\* ## heading"}`
> ```
>
> `3666173` later moved the filters into a code span as well
> (`src/core/diff.ts:216-225`, `src/report/markdown.ts:38-57`), so the text is
> now both span-wrapped *and* prose-escaped.

---

## Low

### L-1 — `canonicalStringify` silently dropped a key named `__proto__`, defeating the filter-mismatch refusal *(FIXED)*

**Where (at `3994e50`):** `src/core/snapshotSchema.ts:70-79`.

`canonicalize` built its output into an object literal:

```ts
const out: Record<string, unknown> = {};
for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
```

`JSON.parse` creates `__proto__` as a real own property, but assigning to
`out.__proto__` invokes the `Object.prototype.__proto__` **setter**, which
changes `out`'s prototype instead of adding a key; `JSON.stringify` then omits
it. Measured:

```
canonicalStringify({"__proto__":{"evil":1},"status":"paid"})  ->  {"status":"paid"}
canonicalStringify({"status":"paid"})                          ->  {"status":"paid"}
identical? true
```

**Why it matters here.** `src/core/diff.ts:199-202` compares exactly these two
strings to decide whether to refuse the comparison, so two snapshots taken with
genuinely different filters could be judged identical and compared anyway — the
"a presence drop caused by a narrower query is not drift" guard the README
advertises. `stringifySnapshot` used the same helper, so the key also vanished
from the written file. No global prototype pollution occurred (only the local
`out` object was affected), and `__proto__` as a Mongo filter key is exotic —
hence Low.

**Fix applied.** `src/core/snapshotSchema.ts:93` builds the result with
`Object.create(null)`. After: `{"__proto__":{"evil":1},"status":"paid"}` ≠
`{"status":"paid"}`.

**Regression test:** `test/diff.test.ts` — "keeps a key literally named
`__proto__` instead of swallowing it".

> **Re-verified 2026-09-29: still fixed.** `src/core/snapshotSchema.ts:93` still
> builds with `Object.create(null)`, and against the current build
> `canonicalStringify({"__proto__":{"evil":1},"status":"paid"})` →
> `{"__proto__":{"evil":1},"status":"paid"}` vs `{"status":"paid"}`,
> `identical? false`.

### L-2 — zod dropped the same key again when a snapshot was read from disk *(FIXED)*

**Where:** `src/core/snapshotSchema.ts:13`
(`filter: z.record(z.string(), z.unknown())`) via `validateSnapshot`.

L-1's fix was not enough: zod rebuilds a `z.record` into a fresh object literal,
so the key hit the prototype setter a second time and vanished during
`parseSnapshot`. Measured after L-1 was fixed but before this one:

```
A filter own keys: [ 'z' ]     # file said {"__proto__":{"status":"paid"},"z":1}
B filter own keys: [ 'z' ]     # file said {"z":1}
canonical A = {"z":1}
canonical B = {"z":1}
GUARD BYPASSED? true
Object.prototype.status = undefined
```

Note the last line: there is **no prototype pollution** — the only consequence
is a lost key and a bypassable guard. Same reasoning and severity as L-1, but
this is the path that actually matters, because snapshots arrive as files.

**Fix applied.** `src/core/snapshotSchema.ts:156-174`: after zod validates, both
`sampling.filter` and `sampling.sort` are re-homed onto the canonical
null-prototype form built from the raw parsed value, which keeps every key and
is exactly what `stringifySnapshot` writes anyway. After the fix,
`parseSnapshot` yields filter own keys `[ '__proto__', 'z' ]` and the CLI
refuses end to end:

```
REFUSED (sampling_mismatch): refusing to compare snapshots taken with different sampling …
  baseline: mode=sort-limit filter={"__proto__":{"status":"paid"},"z":1}
  current:  mode=sort-limit filter={"z":1}
```

**Regression test:** `test/diff.test.ts` — "survives zod validation: a
`__proto__` filter key read from a file still refuses".

**Residual, not fixed:** the same zod behaviour would drop a `__proto__` key
from a `bsonTypes` record in a hand-edited snapshot, which could mask a
`type_changed`. It is unreachable from real data — after M-1, type names come
only from real BSON classes, a bounded set — so it was left alone rather than
widen the change. Worth a line in a future pass.

> **Re-verified 2026-09-29: still fixed, and since hardened — so the output
> quoted above has changed.** `93ba71a` "LOW-5: refuse a snapshot whose
> sampling.filter has a `__proto__` key" added `hasProtoKey()`
> (`src/core/snapshotSchema.ts:108-124`) and a refusal at `:181-194`, on the
> reasoning that `__proto__` is not a field name MongoDB can store, so any
> snapshot carrying one was hand-edited. The re-homing fix described above is
> still in place at `:196-214`. A snapshot file whose filter is
> `{"__proto__":{"status":"paid"},"z":1}` therefore no longer reaches the
> `sampling_mismatch` refusal quoted above; it is rejected earlier:
>
> ```
> docpulse: proto.json: sampling.filter contains a __proto__ key
> (exit 2)
> Object.prototype.status after the run: undefined   # still no prototype pollution
> ```

### L-3 — A deeply nested `sampling.filter` crashed `diff` with a bare stack overflow *(FIXED)*

**Where (at `3994e50`):** `src/core/snapshotSchema.ts:70-79` — `canonicalize`
recursed without a depth limit, and `samplingInfoSchema` types the filter as
`z.record(z.string(), z.unknown())`, so zod never inspects nested values.

| filter depth in the snapshot file | result before |
|---|---|
| 2 000 | works |
| 10 000 | `docpulse: Maximum call stack size exceeded`, exit 2 |
| 50 000 | same |

**Why it matters here.** It fails *closed* — exit 2 fails a CI build — so the
impact is a confusing error on a hostile or corrupt snapshot, not a bypass.
Still, snapshots arrive through pull requests and unbounded recursion on parsed
input should be capped.

**Fix applied.** `src/core/snapshotSchema.ts:62-84`: `MAX_CANONICAL_DEPTH = 100`
(MongoDB's own BSON nesting limit) with a `UsageError` above it. After, at depth
50 000:

```
docpulse: nested more than 100 levels deep
A snapshot's sampling.filter cannot be nested deeper than MongoDB allows.
(exit 2)
```

**Regression test:** `test/diff.test.ts` — "refuses a filter nested deeper than
MongoDB allows instead of overflowing the stack".

> **Re-verified 2026-09-29: still fixed.** Against the current build, a snapshot
> whose `sampling.filter` nests 2 000 / 10 000 / 50 000 deep all exit 2 with
> `docpulse: nested more than 100 levels deep`; depth 50 still compares normally.

### L-4 — `--filter` is persisted verbatim into a file the docs tell you to commit *(OPEN — documented, by design)*

**Where:** `src/source/mongoSource.ts:39` → `src/core/infer.ts:170` →
`src/core/snapshotSchema.ts:95`, and reprinted by `src/core/diff.ts:206-207`
and `:222-225`.

Verified against the live mongod: `--filter '{"sku":"s1"}'` produced
`"sampling":{"mode":"sort-limit","sampleSize":1000,"filter":{"sku":"s1"},"sort":{"_id":-1}}`
in the snapshot, and the value is reprinted on stderr and in the report whenever
`diff` refuses a filter mismatch.

**Why it matters here.** This is deliberate and correct — `diff` refuses to
compare snapshots taken with different filters, which is one of the tool's best
properties — but the whole documented workflow is *commit the baseline snapshot*
and *publish the report*. A natural filter such as `{"customerEmail":"…"}` or
`{"apiToken":"…"}` therefore ends up in git history and in a CI job summary, and
nothing warned about it.

**Fix applied:** documentation only. Removing the filter would break the
mismatch refusal and silently redacting it would make the snapshot lie.
`docs/semantics.md` gained a "Handling untrusted data" section saying so
plainly, and `SECURITY.md` lists it as out of scope with the same explanation.
**If it ever becomes a real complaint,** the honest fix is a `--filter-digest`
mode that stores a hash of the canonical filter, since `diff` only ever compares
it for equality.

> **Status as of 2026-09-29: still open, and deliberately so.** The behaviour is
> unchanged; `ff89605` "LOW-4: say that the snapshot records the filter and is
> committed" only widened the documentation, adding the warning to
> `README.md:159-164` so a reader meets it on the first screen rather than only
> in `docs/semantics.md:213-220` and `SECURITY.md:101-103`.
>
> Re-measured against a live `mongo:7`:
>
> ```
> $ docpulse snapshot -d shop -c orders --filter '{"apiToken":"sk-live-LEAKME"}' -n 600 -o filtered.json
> exit=0
> sampling = {"mode":"sort-limit","sampleSize":600,"filter":{"apiToken":"sk-live-LEAKME"},"sort":{"_id":-1}}
> grep -c sk-live-LEAKME filtered.json -> 1
> ```
>
> and `diff` reprints it in the refusal, exactly as described above. Do not read
> the `--filter` guard added for L-5 as a fix for this one: it rejects
> server-side JavaScript, not secrets. `--filter-digest` remains the honest fix
> if this ever becomes a complaint.

### L-5 — `--filter` reaches MongoDB unvalidated, so `$where` runs server-side JavaScript *(FIXED)*

**Where:** `src/commands/snapshot.ts:36-50` (`parseJsonObjectFlag` checks only
"is this a JSON object"), `src/source/mongoSource.ts:76` (`.find(filter)`),
`:70` (`{ $match: filter }`), `:95` (`countDocuments(filter)`).

Verified against the live mongod:

```
$ docpulse snapshot --uri … --db shop --collection orders \
    --filter '{"$where":"sleep(1); return true"}' -n 3 -o where.json
exit=0   sampledDocs 3   filter {"$where":"sleep(1); return true"}
```

The server executed the JavaScript, and the string was then written into the
snapshot file.

**Why it matters here.** This is **not** an injection: the filter comes only
from argv, never from a snapshot file, a config file or the database — every
path was traced and there is none. The write-safety claim also holds: `$out` and
`$merge` are aggregation *stages*, not `$match` operators, so no filter can turn
the pipeline at `src/source/mongoSource.ts:67-74` into a write. But the README
and `docs/semantics.md` both promise "the only MongoDB operations it issues are
`find`, `$sample`, `countDocuments` and `estimatedDocumentCount`", and `$where`
makes the *server* run arbitrary JS — a stronger capability than that sentence
implies, and a trivially achievable self-inflicted DoS on a large collection.
The realistic risk is a workflow that interpolates an input into `--filter`
(`examples/drift-check.yml` is `workflow_dispatch`-triggered).

**Fix: deliberately not applied.** Rejecting `$where` / `$function` /
`$accumulator` is a short recursive key scan, but it would break a user who
legitimately uses them, and a security pass should not silently narrow the
tool's contract. Documented in `docs/semantics.md` and `SECURITY.md` instead.
**Recommendation:** if the author wants the read-only claim airtight, reject
those three operators with a clear error and an `--allow-server-side-js` escape
hatch, and add "run docpulse with a user holding only `read`" to the README.

> **Status as of 2026-09-29: fixed** by `ecec2e9` "LOW-3: refuse $where /
> $function / $accumulator in --filter" — the recommendation above, taken
> verbatim except that the flag is spelled `--allow-server-js`.
> `src/commands/snapshot.ts:44` names the three operators,
> `:54-70` (`findServerJsOperator`) scans for them iteratively — so a deeply
> nested filter cannot overflow the stack the way L-3 did — and `:98-109` raises
> a `UsageError`. `src/cli.ts:74-78` adds the escape hatch, and the error text
> carries this review's "run docpulse as a user that holds only `read`" advice.
> The guard covers `--sort` as well as `--filter`.
>
> Re-measured against a live `mongo:7`:
>
> ```
> $ docpulse snapshot -d shop -c orders --filter '{"$where":"sleep(1); return true"}' -n 3 -o where.json
> docpulse: --filter: $where runs JavaScript on the MongoDB server
> (exit 2, no snapshot file written)
>
> nested in $or:              --filter '{"$or":[{"a":1},{"b":{"$function":{"body":"x"}}}]}'  -> refused, exit 2
> nested inside an array:     --filter '{"a":{"b":[{"c":{"$accumulator":{}}}]}}'             -> refused, exit 2
> in --sort:                  --sort   '{"$where":"1"}'                                     -> refused, exit 2
> with --allow-server-js:     the server runs it, sampledDocs 3                             -> exit 0
> ```
>
> Regression tests: `test/filterFlag.test.ts`, `test/cli.test.ts`.

---

## Informational

- **I-1 — Neither workflow declared `permissions:` *(FIXED)*.**
  `.github/workflows/ci.yml` and `examples/drift-check.yml` let `GITHUB_TOKEN`
  inherit the repository default, which on many repositories is still
  `write-all`. `drift-check.yml` matters more: users copy it verbatim into
  repositories that hold a production database credential, so the default
  propagates. Both now declare `permissions: contents: read` at workflow level.
- **I-2 — `SECURITY.md` was not in the published tarball *(FIXED)*.** Added to
  `files` in `package.json`; `npm pack --dry-run` lists it. *(2026-09-29: the
  tarball is now 98 files / 157.6 kB packed, 603.3 kB unpacked — `docs/demo.gif`
  was added to the README since.)*
- **I-3 — `npm audit` is clean, and so are registry signatures.** Verbatim
  output below; `npm audit signatures` reports 56/56 verified signatures and 25
  attestations.
- **I-4 — Every production licence is permissive and Apache-2.0 compatible.**
  Full resolved tree below; no copyleft anywhere.
- **I-5 — No install scripts in the project, and none that run for consumers.**
  `package.json` has no `preinstall`/`install`/`postinstall`. Four production
  packages declare `prepare`/`prepack` (`mongodb`, `bson`,
  `mongodb-connection-string-url`, `whatwg-url`), which npm runs only when
  installing from a git URL or publishing, never from a registry tarball. The
  only real `postinstall` in the whole tree is `esbuild@0.28.2`, a
  vitest-transitive **dev** dependency — it never reaches a user of the
  published CLI, but it does run in this repo's own CI on `npm ci`.
- **I-6 — The tarball ships source maps whose sources are not published.**
  `dist/**/*.js.map` reference `../src/*.ts`, and `files` excludes `src/`. No
  absolute paths (`grep -r /home/caner dist/` is empty) and no `sourcesContent`
  — nothing leaks — but the maps are dangling. Either add `src` to `files`, or
  turn off `sourceMap`/`declarationMap` in a publish-only tsconfig.
- **I-7 — 248 KB of example NDJSON and committed build output ship to npm.**
  `examples/orders-{before,after}.ndjson` plus `examples/generated/` (four files
  produced by `examples/run.sh`) are all inside `files`. The fixtures are fully
  synthetic — generated deterministically by `examples/generate-input.mjs`, no
  RNG, no real data — so this is bloat, not exposure. `examples/generated/` is
  build output in version control; consider gitignoring it and excluding it from
  the package.
- **I-8 — `LAUNCH.md` (34 KB) was untracked and not in `.gitignore` *(FIXED)*.**
  A `git add -A` before the first public push would sweep it into the public
  repository — and mid-review, commit `c3c19d5` did exactly that. It contains no
  credentials (checked), but it is clearly internal: remove it from the
  repository and gitignore it before publishing. *(2026-09-29: done by
  `52ff331`. `.gitignore:15-16` now covers `LAUNCH.md` and `make-demo.py`,
  `git ls-files` does not know either file, and `git log main -- LAUNCH.md` is
  empty — it is on no commit reachable from `main`. It does still exist on the
  `backup-before-history-rewrite` branch, so that branch must never be pushed.)*
- **I-9 — Supply-chain hardening left undone.** No `npm audit` step in CI and no
  `.github/dependabot.yml`, so today's clean audit does not stay clean. GitHub
  Actions are pinned by mutable tag (`actions/checkout@v4`), and
  `examples/drift-check.yml` runs `npx docpulse@0.1` — a floating range — in a
  job holding a production credential. Consider `npm publish --provenance` from
  a workflow with `id-token: write`, plus 2FA and a granular automation token on
  the npm account. These were not applied: an `npm audit --audit-level=high` step
  can break CI on an unrelated upstream advisory, and pinning is the author's
  trade-off to make. *(2026-09-29: **partially fixed** by `630a2ae`.
  `.github/workflows/ci.yml` now runs `npm audit --audit-level=high`,
  `.github/dependabot.yml` exists with weekly npm and github-actions updates, and
  `examples/drift-check.yml` calls `npx docpulse@0.1.0` — an exact version, not
  the floating `@0.1`. **Still open:** `actions/*` are pinned by mutable tag
  rather than commit SHA, and there is no `npm publish --provenance` workflow.)*

---

## What I checked and found clean

"Clean" here means I looked and found nothing — not that I assumed it.

**Credential handling — the single most likely real vulnerability, traced end to
end.** The connection string enters at `src/cli.ts:41` /
`src/commands/snapshot.ts:96`, lives only in `MongoSourceOptions.uri`
(`src/source/mongoSource.ts:5-16`), and is used at exactly one call site:
`MongoClient.connect` (`src/source/mongoSource.ts:51`). It is **never** copied
into `SamplingInfo` (`src/core/types.ts:43-56`), the only sampling metadata that
reaches a snapshot; `Snapshot` has no field that could hold it, and
`stringifySnapshot` writes a fixed key list. No reporter has access to it.
Empirically, against a real `mongo:7` container with SCRAM authentication and
against unreachable and hostile endpoints:

| Scenario | stdout | stderr | snapshot file |
|---|---|---|---|
| Successful snapshot, `mongodb://root:PASS@…` | clean | clean | password absent (`grep -c` = 0) |
| Snapshot to stdout, no `--out` | clean | clean | n/a |
| Wrong password (real auth failure) | empty | `cannot connect to MongoDB` / `Authentication failed.` | not written |
| Connection refused | empty | `connect ECONNREFUSED 127.0.0.1:1` | not written |
| Server accepts then closes, or sends garbage, or hangs | empty | `connection <monitor> to … closed`, `Server selection timed out after 1500 ms` | not written |

I additionally probed the driver directly with 16 malformed credentialed URIs
(bad scheme, empty userinfo, unencoded `@`, malformed percent-encoding, bad
port, bad `tls`/`maxPoolSize`/`compressors`/`authMechanism`, `mongodb+srv` with
a port, unterminated IPv6, SRV lookup failure). Every resulting `message` **and**
`stack` was checked for the password: none contained it — mongodb@7 redacts. The
`--input-json` path never even loads the driver (`src/commands/snapshot.ts:112`
is a dynamic import). The two residual risks are M-2 (argv) and the fact that
redaction is the *driver's* behaviour under a caret range, not docpulse's own
guarantee — a defensive
`s.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/gi, '$1<redacted>@')` applied at
`src/source/mongoSource.ts:56` and `src/cli.ts:127,158` would cost three lines
and remove that dependency.

**Secrets in the repository and in git history.** No hits for credentialed
connection strings, `AKIA…`, `ghp_…`, `npm_…`, PEM private keys, or
`password|secret|api_key|token` assignments — in the working tree (excluding
`node_modules/`, `.git/`, `dist/`) or across all commits on all refs
(`git log -p --all --full-history`). The only `mongodb://` strings anywhere are
`mongodb://localhost:27017` in `README.md` and `test/cli.test.ts`, and the
`${{ secrets.MONGODB_URI_READONLY }}` *reference* in `examples/drift-check.yml`
— no credentials in any of them. No `.env`, `.pem`, `.p12`, `id_rsa` or
credential file has ever been added (`git log --diff-filter=A --name-only`).
`.gitignore` covers `node_modules/`, `dist/`, `*.log`, `coverage/`,
`*.tsbuildinfo`, `.env` and `.env.*` with a `!.env.example` exception. There is
no `.npmrc`. `files` is an allowlist, so even a stray `.env` could not be packed.

**Prototype pollution — tested, not assumed.** Documents containing `__proto__`,
nested `__proto__`, `constructor.prototype`, `prototype` and `toString` keys
were fed through `--input-json` and through the library API. All are reported as
ordinary field paths (`__proto__`, `__proto__.polluted`,
`constructor.prototype.polluted2`, …) and afterwards `({}).polluted`,
`({}).isAdmin`, `({}).polluted2` and `({}).deep` are all `undefined` and
`Object.keys(Object.prototype)` is `[]`. Structurally: `src/core/paths.ts` only
*reads* (`Object.keys` + `value[key]`); `src/core/infer.ts` accumulates into
`Map`s, not objects; there is no deep merge anywhere, and `mergeConfig`
(`src/config.ts:41-46`) is a shallow spread of a zod-validated object. A config
file containing `__proto__` or `constructor` is rejected outright by
`configSchema`'s `strictObject` (`src/config.ts:25-36`):
`✖ Unrecognized keys: "__proto__", "constructor"`. The two real defects in this
area (L-1, L-2) were *dropped* keys, not polluted prototypes.

**ReDoS — every regex in `src/`, with a verdict each.** All linear: no nested
quantifiers, no overlapping alternation, no backtracking opportunity.

| Location | Regex | Verdict |
|---|---|---|
| `src/core/paths.ts:45` | `/\\/g` | Safe — one literal character. |
| `src/core/paths.ts:45` | `/\./g` | Safe — one literal character. |
| `src/core/paths.ts:45` | `/\[/g` | Safe — one literal character. |
| `src/core/paths.ts:50` | `/\\(.)/g` | Safe — fixed two-character match. |
| `src/report/markdown.ts:16` | `/\|/g` | Safe — one literal character. |
| `src/report/markdown.ts:35` | ``/[\\`*_[\]<>&~|]/g`` | Safe — single character class, added by this review. |
| `src/core/diff.ts:224` | `/\n/g` | Safe — one literal character. |
| `src/source/arraySource.ts:101` | `/\r?\n/` | Safe — one optional literal, no ambiguity. |

`src/report/table.ts` and the `sanitize()`/`safe()` helpers use
character-by-character loops, not regexes.

**No shell, no `eval`, no dynamic code.** `grep` for
`child_process|execSync|exec(|spawn|eval(|new Function|vm.|require(` across
`src/` returns nothing. The only dynamic construct is the static
`await import('../source/mongoSource.js')` at `src/commands/snapshot.ts:112`.
The single `child_process` use in the repository is `test/cli.test.ts`, which
calls `execFile` with an argument array and no `shell: true` — correct.

**No telemetry and no unexpected network — proved, not asserted.** `src/`
contains zero occurrences of
`http|fetch|axios|dns|net.|tls|socket|telemetry|analytics|beacon|WebSocket`, and
the only non-`node:` import in the entire source tree is `mongodb`, in
`src/source/mongoSource.ts:1`. The CLI was then run under a tripwire preload
replacing `net.connect`, `net.createConnection`, `net.Socket.prototype.connect`,
`tls.connect`, `dns.lookup`/`resolve`/`resolveSrv` (sync and promise),
`http(s).request`/`get` and global `fetch` with functions that record and throw:

```
snapshot --input-json examples/orders-before.ndjson …    NETGUARD: no network attempts   exit=0
diff examples/baseline… examples/current… --format json  NETGUARD: no network attempts   exit=0
--help                                                   NETGUARD: no network attempts   exit=0
snapshot --uri mongodb://u:p@127.0.0.1:27017/x …         NETGUARD: ATTEMPTS -> net.createConnection {"host":"127.0.0.1","port":27017}
```

The control case proves the tripwire works, and the only host ever contacted is
the one the operator named. No analytics endpoint, no version-check ping, no
crash reporter.

**Path traversal — not applicable, by construction.** Every filesystem path
docpulse touches comes from the operator's own argv: `--input-json`
(`src/source/arraySource.ts:134`), `--config` (`src/config.ts:98-104`), the two
`diff` positionals (`src/commands/diff.ts:26`), and the two `--out` paths
(`src/commands/snapshot.ts:144`, `src/commands/diff.ts:67`). Every read and
write was traced and **no path is derived from file content**: a snapshot's
`collection` field is never used as a path, and `createFileSource` uses
`basename()` only to build a display name (`src/source/arraySource.ts:143`).
There is no include mechanism and no template expansion, so there is nothing for
a confused deputy to traverse.

**Snapshot validation.** Untrusted snapshot files are checked by zod before
anything else touches them (`src/core/snapshotSchema.ts:49-60`), including
cross-field invariants (`presentCount <= observedUnits`,
`nullCount <= presentCount`, `bsonTypes` summing to `presentCount`), and
`formatVersion` is special-cased for a readable error. Document recursion is
bounded at depth 24 (`src/core/paths.ts:8`, `:105`) — a 200 000-deep document
via `--input-json` completes at exit 0 and produces exactly 25 field paths, with
no stack overflow.

**Error handling never prints a stack trace on a reachable path.**
`src/cli.ts:116-129` prints `error.message` only; the one `error.stack` call
(`src/cli.ts:158`) is the last-resort handler for a rejection of `main()`
itself, which `main`'s own try/catch makes unreachable.

---

## The checklist, with real output

### 1. `npm audit`

```
$ npm audit
found 0 vulnerabilities

$ npm audit --production
npm warn config production Use `--omit=dev` instead.
found 0 vulnerabilities

$ npm audit signatures
audited 56 packages in 2s
56 packages have verified registry signatures
25 packages have verified attestations
```

No `npm audit fix` was run and no dependency was changed.

### 2. Secret and token leakage

Covered above: clean in the working tree, clean across all commits, no
credential file ever tracked, `.gitignore` adequate, and the `--uri` trace
proved clean end to end against a live authenticated mongod, including a real
authentication failure. The one thing that *is* persisted is `sampling.filter`
(L-4, still open by design). Argv exposure (M-2) was fixed after this review:
`MONGODB_URI` and `--uri-file` both keep the string out of `argv`, and `--uri`
survives only as an escape hatch its own help text argues against. Since
`d698262`, `src/redact.ts` also rewrites `mongodb://user:pass@` to
`mongodb://<redacted>@` in every string that reaches stderr, so the guarantee no
longer depends on the driver redacting its own messages.

### 3. Input validation

Path traversal: not applicable (above). Prototype pollution: clean, tested
(above); the two related defects were dropped keys (L-1, L-2), both fixed.
Unbounded memory: M-3 for `--input-json` (**fixed since** — NDJSON streams,
the array form is capped at 128 MiB), and L-3 for deeply nested filters (fixed);
document recursion is capped at depth 24. ReDoS: all eight regexes verdicted
safe (`src/redact.ts:7`, added since, is single-character classes only and was
verdicted the same way). Shell / `eval` / Mongo JS: no shell and no `eval`;
`--filter` reached the driver unfiltered and `$where` executed server-side
(L-5) — **fixed since**: `$where`, `$function` and `$accumulator` are refused in
`--filter` and `--sort` unless `--allow-server-js` is passed, which is the
operator's own flag, not injection. Report escaping: H-1 and M-4, both fixed and
regression-tested.

### 4. Dependency licences vs Apache-2.0

```
$ npm ls --omit=dev --all
docpulse@0.1.0
├── commander@15.0.0
├─┬ mongodb@7.6.0
│ ├─┬ @mongodb-js/saslprep@1.5.4
│ │ └─┬ sparse-bitfield@3.0.3
│ │   └── memory-pager@1.5.0
│ ├── bson@7.3.3
│ ├─┬ mongodb-connection-string-url@7.0.2
│ │ ├─┬ @types/whatwg-url@13.0.0
│ │ │ └── @types/webidl-conversions@7.0.3
│ │ └─┬ whatwg-url@14.2.0
│ │   ├─┬ tr46@5.1.1
│ │   │ └── punycode@2.3.1
│ │   └── webidl-conversions@7.0.0
│ └── (7 UNMET OPTIONAL: @aws-sdk/credential-providers, @mongodb-js/zstd,
│      gcp-metadata, kerberos, mongodb-client-encryption, snappy, socks)
└── zod@4.6.5
```

| Package | Licence | Compatible with Apache-2.0? |
|---|---|---|
| commander@15.0.0 | MIT | Yes |
| mongodb@7.6.0 | Apache-2.0 | Yes (same licence) |
| zod@4.6.5 | MIT | Yes |
| @mongodb-js/saslprep@1.5.4 | MIT | Yes |
| bson@7.3.3 | Apache-2.0 | Yes |
| mongodb-connection-string-url@7.0.2 | Apache-2.0 | Yes |
| sparse-bitfield@3.0.3 | MIT | Yes |
| memory-pager@1.5.0 | MIT | Yes |
| @types/whatwg-url@13.0.0 | MIT | Yes |
| @types/webidl-conversions@7.0.3 | MIT | Yes |
| whatwg-url@14.2.0 | MIT | Yes |
| tr46@5.1.1 | MIT | Yes |
| webidl-conversions@7.0.0 | BSD-2-Clause | Yes |
| punycode@2.3.1 | MIT | Yes |

**No copyleft (GPL / LGPL / AGPL / MPL / SSPL) anywhere in the production
tree** — 11 MIT, 3 Apache-2.0, 1 BSD-2-Clause. All are one-way compatible with
Apache-2.0, so distributing docpulse under Apache-2.0 is sound. Note that
`mongodb` is deliberately Apache-2.0, not SSPL (which covers the *server*), so
the patent-grant rationale in the README holds. The seven unmet optional
dependencies are not installed and do not ship; if a user opts into `kerberos`
or `mongodb-client-encryption` for their own deployment, those become their
dependencies, not docpulse's.

### 5. No telemetry / no unexpected network

Proved with the tripwire run above. No project install scripts; the only
`postinstall` in the whole tree is dev-only `esbuild`.

### 6. Supply-chain hygiene

`package-lock.json` is committed (69 KB, lockfile v3) and
`.github/workflows/ci.yml` uses `npm ci`. Three runtime dependencies as
promised, 14 packages in the full production tree, no unmet non-optional
requirement. `npm pack --dry-run` lists 98 files / 157.6 kB packed, 603.3 kB
unpacked (re-measured 2026-09-29; the growth is `docs/demo.gif`), containing
**no** `src/`, no `test/`, no `.env`, no `.github/`, no `PLAN.md` and no
`LAUNCH.md` — the `files` allowlist works. `dist/cli.js` is chmod 755 with a
correct shebang. Open items: I-6 (dangling source maps), I-7 (example data and
committed build output). I-8 was fixed by `52ff331` and I-9 partially fixed by
`630a2ae`; what remains of I-9 is SHA-pinning the actions and publish
provenance.

---

## Verification after the fixes

```
$ npm run check
> docpulse@0.1.0 check
> tsc --noEmit -p tsconfig.check.json && vitest run

 RUN  v5.0.2 /home/caner/oss-factory/projects/docpulse

 Test Files  7 passed | 1 skipped (8)
      Tests  134 passed | 2 skipped (136)
```

and with a throwaway authenticated mongod supplying `MONGODB_URI`, so the gated
integration tests run too (measured mid-review, before the last two fixes):

```
$ MONGODB_URI='mongodb://root:…@127.0.0.1:28018/?authSource=admin' npm run check

 Test Files  8 passed (8)
      Tests  134 passed (134)
```

The baseline before any change was **125 passed / 2 skipped**; the nine new
tests are the regressions listed under H-1, M-1, M-4, L-1, L-2, L-3 and the path
walker's `__proto__` case.

*Re-run on 2026-09-29, after the six later commits:* `npm run check` is
**185 passed / 2 skipped** (11 files passed, 1 skipped) with no database, and
**187 passed** (12 files) with a throwaway `mongo:7` supplying `MONGODB_URI`.
`npm run build`, `npm audit` (0 vulnerabilities) and `./examples/run.sh` are all
green, and the example output is unchanged apart from `createdAt`. `./examples/run.sh` still exits 0 and regenerates
`examples/generated/` byte-for-byte identically apart from `createdAt`, so the
output pasted in the README is still accurate. The test container was removed
after use.

### Files changed by this review

| File | Change |
|---|---|
| `src/report/markdown.ts` | H-1: `sanitize()`/`cell()`/`fenced()` — escape control characters and backticks everywhere a value is printed. M-4: `prose()` for the warning blockquote. |
| `src/report/table.ts` | H-1: `safe()` for control characters (including ESC) in header, refusal, warnings, rows and action lines. |
| `src/core/bsonType.ts` | M-1: trust `_bsontype` only on non-plain objects. |
| `src/core/snapshotSchema.ts` | L-1: `Object.create(null)` in `canonicalize`. L-2: re-home `sampling.filter`/`sort` after zod. L-3: `MAX_CANONICAL_DEPTH = 100`. |
| `test/report.test.ts`, `test/bsonType.test.ts`, `test/diff.test.ts`, `test/paths.test.ts` | Nine regression tests. |
| `docs/semantics.md` | New "Handling untrusted data" section; the `_bsontype` rule in §BSON types. |
| `package.json` | I-2: `SECURITY.md` added to `files`. |
| `.github/workflows/ci.yml`, `examples/drift-check.yml` | I-1: `permissions: contents: read`. |
| `SECURITY.md` | New — reporting policy. |
| `SECURITY-REVIEW.md` | This file. |

`README.md` was **not** modified — it was held by another agent for the duration
of this review. This reviewer ran no state-changing git command; the commits
that landed mid-review came from elsewhere.

---

## What I could not check, and why

- **Non-SCRAM authentication paths.** Live testing used a real `mongo:7` with
  SCRAM-SHA-256 over plain TCP. TLS, `mongodb+srv`, X.509, Kerberos, AWS IAM and
  OIDC were not exercised — their driver plugins are unmet optional dependencies
  in this tree. Those paths construct different errors, so "no credential in any
  error message" is *proven* for SCRAM/TCP and merely *likely* for the rest. A
  TLS or Atlas smoke test would close the gap cheaply; the defensive redaction
  suggested above would close it regardless of driver behaviour.
- **The user's real MongoDB deployments.** Two MongoDB MCP connections
  (`mongodb-prod`, `mongodb-staging`) were available in this session. Neither was
  touched: running security probes against production data would be reckless and
  is not what a source review needs. All live testing used a throwaway container
  on port 28018, removed afterwards.
- **The published npm package.** docpulse is not on the registry yet, so this
  review covered `npm pack --dry-run` rather than a real tarball, and could not
  check registry-side controls — 2FA on the account, token scopes, publish
  provenance, or name-squatting of similar package names.
- **Static analysis and fuzzing.** No CodeQL, Semgrep or ESLint security plugin
  is installed here, and the project has no linter at all (`package.json` has
  `build`, `test`, `check`, `prepublishOnly`; the PLAN mentions a `lint` script
  that does not exist). Everything above is manual reading plus targeted dynamic
  testing. The snapshot and NDJSON parsers were not fuzzed.
- **Git history beyond reachable commits.** This review was asked not to run git
  commands; because the brief also required a history scan, only read-only
  plumbing was used (`git ls-files`, `git log -p --all --full-history`,
  `git log --diff-filter=A`, `git status --porcelain`) and nothing that writes.
  That covers every commit on every ref, but not dangling or unreachable
  objects, which would need `git fsck` / `git cat-file` over the object database.
- **README.md.** Another agent held it throughout. It was read to verify the
  claims it makes (read-only, three dependencies, the CI workflow) but not
  edited, and not re-read after their changes. **Two items are left for its
  owner:** the M-2 change to the `-u "$MONGODB_URI"` examples, and a link to
  `SECURITY.md` and to the new "Handling untrusted data" section of
  `docs/semantics.md`.
- **The dependencies' own integrity.** `npm audit signatures` confirms the
  tarballs match what the registry signed; it does not tell you whether
  `mongodb`, `zod` or `commander` contain a backdoor. This review covered
  docpulse's code, not theirs.

---

## Recommendation

**Publishable at 0.1.0** once every fix described here is committed — most are,
but the M-4 and L-2 fixes in `src/report/markdown.ts` and
`src/core/snapshotSchema.ts`, the I-1 workflow `permissions:` blocks and the I-2
`package.json` change may still be uncommitted. If any of them are reverted,
H-1, M-1, M-4, L-1, L-2 and L-3 come back — H-1 would ship a report that any
upstream producer can forge, which is the one thing this tool must not do.

Before the first publish: commit the fixes, apply the two README changes under
M-2, and remove `LAUNCH.md` from the repository (I-8). M-3 (`--input-json`
streaming) is a real ceiling on the tool's own advertised no-database path and
belongs on the 0.2 milestone, but it is not a reason to hold the release. The
remaining recommendations — defensive URI redaction, the `$where` guard,
Dependabot, an audit step, action pinning, publish provenance — are each a
handful of lines and can be bundled into one pass.
