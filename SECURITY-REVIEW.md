# docpulse v0.1.0 — pre-publication security review

**Reviewed:** 2026-09-26
**Target:** `/home/caner/oss-factory/projects/docpulse`, git `3994e50` **plus 12 uncommitted working-tree
modifications and 2 new untracked files** (see [State reviewed](#state-reviewed)).
**Scope:** dependency posture, secret leakage, input validation, credential handling, licence
compatibility, outbound network behaviour.
**Method:** source reading plus hands-on execution of the built CLI (`npm run build`, Node v22.23.2) against
crafted hostile inputs.

## Summary

| Severity | Count |
|---|---|
| High | 0 |
| Medium | 2 |
| Low | 5 |
| Informational | 4 |

No High findings. The two Medium findings are a resource-exhaustion ceiling on `--input-json` and
credential exposure through the process argument list. Everything I could disprove, I disproved by
running it: there is no telemetry, no shell execution, no prototype pollution, no committed secret, no
vulnerable dependency, and no copyleft dependency.

### State reviewed

The working tree is **not** clean against `HEAD` (`3994e50`), and it changed *during* this review —
hardening landed at 21:08–21:15 local time while the audit was running, so several findings below were
reproduced at `HEAD` and then re-tested against the amended tree. State as reviewed:

```
 M docs/semantics.md
 M examples/generated/baseline.snapshot.json
 M examples/generated/current.snapshot.json
 M examples/generated/drift-report.json
 M src/core/bsonType.ts
 M src/core/snapshotSchema.ts
 M src/report/markdown.ts
 M src/report/table.ts
 M test/bsonType.test.ts
 M test/diff.test.ts
 M test/paths.test.ts
 M test/report.test.ts
?? SECURITY.md
?? LAUNCH.md
```

`SECURITY.md` was authored independently during this review, not by the reviewer; it is good and is left
in place, with one edit to align the acknowledgement window with the stated 7-day best-effort target.
Note one tension worth a maintainer decision: `SECURITY.md` declares a connection string visible in `ps`
output **out of scope**, which is a defensible policy for a CLI — but `README.md:31` still teaches the
form that causes it. See MEDIUM-2.

These uncommitted changes are security hardening, and they are good. At `HEAD` I reproduced three real
defects that the working tree now fixes:

1. **Markdown injection in the drift report** — at `HEAD`, `src/report/markdown.ts` escaped only `|`. A
   field path containing a newline and a backtick broke out of its code span and its table row and wrote
   its own headings, rows and HTML into the report. I reproduced this end to end; `HEAD`'s own test suite
   already contained two tests asserting this must not happen and **both failed** (`npm test` → `2 failed |
   127 passed`). The working tree adds `sanitize()`/`cell()`/`fenced()` and the suite is now green
   (`132 passed | 2 skipped`).
2. **Terminal/row injection in the table reporter** — same class, `src/report/table.ts`; now escaped by
   `safe()`, which also neutralises `ESC` (0x1b) so ANSI sequences cannot reach a terminal.
3. **`_bsontype` honoured on plain objects, with a prototype-chain lookup** — at `HEAD`,
   `bsonTypeOf({_bsontype: "constructor"})` returned `Object` (the function), which reached the snapshot
   file as the BSON type name `"function Object() { [native code] }"`; `_bsontype: "__proto__"` produced
   `"[object Object]"`. A document could also hide an entire sub-tree from the snapshot by carrying a
   literal `_bsontype` string field. The working tree's `hasBsonTag()` now trusts `_bsontype` only on
   non-plain-object prototypes.

**Action before publishing: commit these changes.** Everything below is assessed against the working tree.
If the changes are discarded, findings 1–3 above return as High/Medium.

---

## Findings

### MEDIUM-1 — `--input-json` reads and parses the entire file regardless of `--sample-size`

**Where:** `src/source/arraySource.ts:134` (`readFile(file, 'utf8')`), `src/source/arraySource.ts:141`
(`parseDocumentsText(text, file)`), `src/source/arraySource.ts:71-117`, limit applied only later at
`src/source/arraySource.ts:41-45`.

**What it is.** `createFileSource` slurps the whole input file into one JavaScript string, parses *every*
document into an in-memory array, and only then does `ArrayDocumentSource.documents()` stop after
`sampleSize` documents. `--sample-size` therefore bounds nothing about the read.

**Measured.** With an 85 MB NDJSON file (200,000 documents) and `--sample-size 1`:

```
sampleSize=1 -> yielded 1 docs, but peak heap=224MB rss=310MB in 531ms
```

A 539 MB file cannot be processed at all — it exceeds V8's maximum string length:

```
$ docpulse snapshot --input-json huge.ndjson -d s -c o -n 1 -o /dev/null
docpulse: cannot read --input-json file: huge.ndjson
Invalid string length
```

**Why it matters.** `--input-json` is the documented way to run docpulse in CI without a database, and a
Mongo export of a real collection is routinely gigabytes. A CI runner with a 2 GB memory limit will be
OOM-killed on an input the tool advertises as supported, and the failure mode for the >512 MB case is a
hard refusal with no workaround. The input is normally the operator's own file, so this is availability
and usability rather than a trust-boundary break — but it is a self-inflicted denial of service that
`--sample-size` looks like it should prevent.

**Fix.** Stream the file instead of buffering it: open it with `fs.createReadStream` and drive it through
`readline` (or a chunked `[`-aware parser for the JSON-array form), pushing documents into the accumulator
as they are parsed and stopping as soon as `sampleSize` documents have been yielded. `DocumentSource` is
already an `AsyncIterable`, so this is a drop-in change behind `createFileSource`. As a stop-gap, `stat()`
the file first and refuse (exit 2, actionable message) above a documented size.

---

### MEDIUM-2 — the MongoDB connection string is passed through `argv`, where any local user can read it

**Where:** `src/cli.ts:41` (`-u, --uri <uri>`), `src/commands/snapshot.ts:96`
(`options.uri ?? process.env.MONGODB_URI`), `README.md:31` (the headline example).

**What it is.** The primary documented invocation is:

```
docpulse snapshot -u "$MONGODB_URI" -d shop -c orders -o today.json
```

The shell expands `$MONGODB_URI` before `exec`, so the full `mongodb+srv://user:password@host/...` string
lands in the process's argument vector. On Linux `/proc/<pid>/cmdline` is world-readable by default (I
confirmed `-r--r--r--` and `/proc` mounted without `hidepid` on this host), so any local user can read the
database password for as long as the process runs. The same string is written to shell history, and to CI
logs under `set -x`.

**Why it matters.** Credential leakage by the tool is explicitly in scope for this project. The tool
already supports the safe path (`MONGODB_URI` in the environment, which `examples/drift-check.yml:26` uses
correctly), but nothing steers the user there and the README teaches the unsafe form.

**Partially addressed during this review.** `docs/semantics.md` now carries a "Handling untrusted data"
section that says "prefer the `MONGODB_URI` environment variable, and a CI secret in a pipeline", and
`SECURITY.md` declares `ps` visibility out of scope. That is a reasonable policy, but a policy that
declares the risk out of scope while the headline example demonstrates it is the worst of both. The
remaining work is small and is the part that actually changes behaviour:

**Fix.** Three concrete steps, in order of value:

1. Change `README.md:31` and every other `-u "$MONGODB_URI"` example to rely on the environment variable
   implicitly: `MONGODB_URI="$MONGODB_URI" docpulse snapshot -d shop -c orders …`, or simply
   `docpulse snapshot -d shop -c orders …` with the variable already exported.
2. Add a note to the `--uri` help text in `src/cli.ts:41` — e.g. `MongoDB connection string (env:
   MONGODB_URI; prefer the env var: --uri is visible in the process list)`.
3. Optionally add `--uri-file <path>` so a secret can be mounted as a file (the common pattern for
   Kubernetes and Docker secrets) without ever touching `argv`.

---

### LOW-1 — raw MongoDB driver error text is forwarded to stderr without redaction

**Where:** `src/source/mongoSource.ts:53-58`.

```ts
} catch (error) {
  throw new UsageError(
    `cannot connect to MongoDB`,
    error instanceof Error ? error.message : String(error),
  );
}
```

**What it is.** Whatever the driver says is printed verbatim. docpulse performs no redaction of its own.

**Tested — no leak observed.** I ran the built CLI with twelve fake URIs carrying the password
`SuperSecret123`, covering SRV lookup failure, unsupported option, bad scheme, missing host, invalid port,
`mongodb+srv` with a port, invalid TLS value, empty userinfo, and malformed percent-encoding. The password
appeared in **zero** of them; the driver's own messages are already redacted, e.g.:

```
docpulse: cannot connect to MongoDB
querySrv ENOTFOUND _mongodb._tcp.cluster0.abcde.mongodb.net
```

**Why it matters anyway.** docpulse depends on `mongodb@^7.6.0` — a caret range. The redaction is the
driver's behaviour, not docpulse's guarantee, and a future driver version or an error class I did not hit
could echo the URI into a CI log that is often public.

**Fix.** Redact defensively before printing. One helper, applied in `src/source/mongoSource.ts:56` and in
the fallbacks at `src/cli.ts:127` and `src/cli.ts:158`:

```ts
const redact = (s: string) => s.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/gi, '$1<redacted>@');
```

---

### LOW-2 — untrusted filter JSON is rendered as live Markdown in the warning blockquote

**Where:** `src/core/diff.ts:222-225` (the `--allow-filter-mismatch` warning), rendered at
`src/report/markdown.ts:98`; `cell()` at `src/report/markdown.ts:16-18` escapes control characters,
backticks and `|`, but not `<`, `[` or `*`.

**What it is.** A residual of the injection class the working tree otherwise fixed. `sampling.filter`
comes out of a snapshot *file*, and with `--allow-filter-mismatch` its canonical JSON is interpolated into
a blockquote line that is **not** inside a code span. Reproduced:

```
> **Warning:** sampling differs between the two snapshots and --allow-filter-mismatch was given; …
baseline: mode=sort-limit filter={"<img src=x onerror=alert(1)>":"[link](https://evil.example) **bold**"} …
```

The `[link](…)` renders as a clickable link and `**bold**` as bold in any Markdown renderer. (The refusal
path is safe — `src/report/markdown.ts:82-86` puts the same text inside a fenced block and `fenced()`
prevents the fence from being closed.)

**Why it matters.** Bounded: content spoofing and a phishing link in a CI job summary or PR comment, not
script execution — GitHub strips `<img onerror>`. But the report's whole job is to be trusted at a glance.

**Fix.** Wrap the interpolated filter JSON in a code span where the warning is built
(`src/core/diff.ts:222-225`: `filter=\`${filterA}\``), or extend `cell()` to also escape `<`, `&`, `[` and
`*`. The first is smaller and keeps the escaping policy in one place.

---

### LOW-3 — `--filter` is passed to MongoDB unvalidated, so `$where` / `$function` execute server-side JS

**Where:** `src/commands/snapshot.ts:36-50` (`parseJsonObjectFlag` checks only "is a JSON object"),
`src/source/mongoSource.ts:76` (`.find(this.#options.filter)`), `src/source/mongoSource.ts:70`
(`{ $match: this.#options.filter }`), `src/source/mongoSource.ts:95`
(`countDocuments(this.#options.filter)`); README claim at `README.md:174`.

**What it is.** The filter object is handed to the driver as-is. `$where`, `$function` and `$accumulator`
run JavaScript on the mongod when server-side scripting is enabled. README.md:174 says "**Read-only,
always.** The only MongoDB operations it issues are `find`, `$sample`, `countDocuments` and
`estimatedDocumentCount`", with no caveat.

**Why it matters.** This is not an injection: the filter comes only from `argv`, never from a snapshot
file, a config file or a database (I verified there is no path from parsed file content into a query). The
operator is choosing what to run against their own database. The write-safety claim also holds — `$out`
and `$merge` are aggregation stages, not `$match` operators, so no filter can turn the pipeline at
`src/source/mongoSource.ts:67-74` into a write. But "read-only, always" overstates the case when the
filter can execute arbitrary server-side JavaScript, and a `$where` on a large collection is a trivially
achievable self-inflicted DoS.

**Fix.** Documentation, plus an optional guard:

- Amend `README.md:174` to say the filter is passed through verbatim, that `$where`/`$function` execute
  JavaScript on the server if scripting is enabled, and that docpulse should be run with a user holding
  only `read` on the target database.
- Optionally reject `$where`, `$function` and `$accumulator` in `parseJsonObjectFlag` (a recursive key
  scan) behind an `--allow-server-js` escape hatch.

---

### LOW-4 — `sampling.filter` is persisted verbatim into the snapshot file

**Where:** `src/core/snapshotSchema.ts:106-120` (`stringifySnapshot` writes `sampling.filter`),
`src/core/infer.ts:129-142`.

**What it is.** Whatever was passed to `--filter` is written into the snapshot, and snapshots are designed
to be committed to a repository (`examples/drift-check.yml:4-6`). A filter such as
`--filter '{"apiToken":"sk-live-…"}'` — filtering on a secret-bearing field is not far-fetched — puts that
value into version control permanently.

**Why it matters.** It is a deliberate and correct design decision (the diff refuses to compare snapshots
taken with different filters, so the filter must be recorded), but it is undocumented as a data-handling
consequence.

**Fix.** One line in `README.md` and in `docs/semantics.md`: "the snapshot records the exact `--filter` you
used, so do not filter on secret values — the snapshot is meant to be committed." No code change.

---

### LOW-5 — a `__proto__` key in a snapshot's `sampling.filter` is silently dropped, defeating the mismatch guard for that key

**Where:** `src/core/snapshotSchema.ts:13` (`filter: z.record(z.string(), z.unknown())`),
`src/core/snapshotSchema.ts:159-170` (`parseSnapshot`).

**What it is.** `canonicalize` was fixed in the working tree to use `Object.create(null)`, so
`canonicalStringify` now preserves `__proto__` correctly. But the key never survives that far: zod's
`z.record` drops it during `parseSnapshot`. Reproduced:

```
A.filter keys = [ 'z' ]          # file said {"__proto__":{"status":"paid"},"z":1}
B.filter keys = [ 'z' ]          # file said {"z":1}
guard bypassed (A==B): true
Object.prototype.status = undefined
```

**Why it matters.** Low, and bounded in two ways: there is **no prototype pollution** (`Object.prototype`
is untouched — verified), and `__proto__` is not a usable MongoDB field name, so no legitimate filter is
affected. The consequence is only that the "refuse to compare different filters" guard at
`src/core/diff.ts:199-226` can be bypassed by that single key, and that the in-memory filter no longer
matches the file on disk.

**Fix.** Parse snapshot JSON with a reviver that skips `__proto__`, or validate `sampling.filter` as
`z.unknown()` and carry the raw `JSON.parse` result (re-homed onto a null-prototype object) through to
`canonicalStringify`. Alternatively, reject any snapshot whose filter contains a `__proto__` key outright —
it cannot be legitimate.

---

### INFORMATIONAL-1 — no `permissions:` block on either workflow

**Where:** `.github/workflows/ci.yml:14-16`, `examples/drift-check.yml:14-16`.

Neither job declares `permissions:`, so `GITHUB_TOKEN` gets the repository default, which on many
repositories is still `write-all`. `examples/drift-check.yml` is copied verbatim by users into repositories
that hold a production database credential, so its defaults propagate.

**Fix.** Add `permissions: { contents: read }` at job level to both files.

### INFORMATIONAL-2 — no dependency-audit step in CI and no Dependabot configuration

**Where:** `.github/workflows/ci.yml`.

`npm audit` is clean today (see below), but nothing keeps it that way after publication.

**Fix.** Add a `- run: npm audit --audit-level=high` step to `ci.yml`, and a
`.github/dependabot.yml` with a weekly `npm` update schedule.

### INFORMATIONAL-3 — `SECURITY.md` is not in the published tarball

**Where:** `package.json` `files: ["dist","docs","examples","docpulse.config.json","README.md","LICENSE"]`.

Add `"SECURITY.md"` so the reporting channel travels with the npm package as well as the repository.

### INFORMATIONAL-4 — GitHub Actions are pinned by tag, not by commit SHA

**Where:** `.github/workflows/ci.yml:18,20`, `examples/drift-check.yml:18,20,52`.

`actions/checkout@v4` and `actions/setup-node@v4` are mutable tags. For a v0.1 project this is an accepted
trade-off, not a defect; pinning to a full commit SHA is the hardened form if the maintainer wants it.
`examples/drift-check.yml:28,37` also uses `npx docpulse@0.1`, a floating range, in a job that holds a
production credential — worth pinning to an exact version in the example.

---

## Checks performed and passed

### 1. `npm audit` — clean

```
$ npm audit
found 0 vulnerabilities
```

Machine-readable form, for the record:

```json
{
  "vulnerabilities": {
    "info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0, "total": 0
  },
  "dependencies": {
    "prod": 15, "dev": 111, "optional": 73, "peer": 36, "peerOptional": 0, "total": 125
  }
}
```

No `npm audit fix --force` was run, and no dependency was changed.

### 2. Secrets and connection strings — clean

- Working tree, all files outside `node_modules/` and `.git/`, searched for
  `mongodb://` / `mongodb+srv://` patterns: **two hits, both benign** — `README.md:273`
  (`MONGODB_URI="mongodb://localhost:27017" npm test`) and `test/cli.test.ts:178`
  (`'mongodb://localhost:27017'`). No credentials in either.
- Full git history (`git log -p --all`) searched for connection strings, `api[_-]?key`, `secret`,
  `password`, `passwd`, `token`, `BEGIN … PRIVATE KEY`, `AKIA…`, `ghp_…`, `npm_…`: **three hits, all
  benign** — the two above plus `MONGODB_URI: ${{ secrets.MONGODB_URI_READONLY }}`, which is a GitHub
  Actions secret *reference*, not a secret. No secret was ever committed and later removed.
- **No `.env` file exists** anywhere in the repository.
- `.gitignore` covers `node_modules/`, `dist/`, `.env`, `.env.*` (with `!.env.example`), `*.log`,
  `coverage/`, `*.tsbuildinfo`. Correct.
- `git ls-files` (51 tracked files) reviewed in full: source, tests, docs, examples, licence, lockfile.
  Nothing sensitive.
- `npm pack --dry-run`: 92 files, 80.1 kB. Ships `dist/`, `docs/`, `examples/`, `docpulse.config.json`,
  `README.md`, `LICENSE`. Nothing secret. The example NDJSON fixtures (248 kB, the bulk of the tarball) are
  fully synthetic — generated deterministically by `examples/generate-input.mjs` with no RNG and no real
  data (`{"_id":0,"status":"pending","total":1000,"customer":{"taxId":"TR1000000"},…}`).

### 3. Input validation

- **Path traversal — clean.** Every filesystem path the tool touches comes from `argv`
  (`--input-json`, `--out`, `--config`, the two `diff` positionals). I traced every read and write and
  found **no path derived from file content**: a snapshot's `collection` field is never used as a path,
  and `createFileSource` uses `basename()` only to build a display name
  (`src/source/arraySource.ts:143`). There is nothing to traverse.
- **Command injection — clean.** No `child_process`, `exec`, `execSync`, `spawn`, `eval` or
  `new Function` anywhere in `src/` or `dist/`. The single `child_process` import in the repository is
  `test/cli.test.ts:1`, and it uses `execFile` with an argument array and no `shell: true` — correct.
- **Regex DoS — clean.** Every regex literal in `src/` was enumerated and inspected:
  `/\\/g`, `/\./g`, `/\[/g` (`src/core/paths.ts:45`), `/\\(.)/g` (`src/core/paths.ts:50`), `/\r?\n/`
  (`src/source/arraySource.ts:101`), `/\|/g` (`src/report/markdown.ts:17`), `/\n/g`
  (`src/core/diff.ts:224`). All are single-character classes or a fixed optional; none contains nested
  quantifiers or alternation overlap. Linear time on every input.
- **Prototype pollution — clean, verified by execution.** This was tested hardest, because snapshots are
  JSON files that get read back in. Every vector attempted, and the result after each:
  - `parseConfigText('{"__proto__":{"pwn":1},…}')` → rejected by zod's `strictObject`
    (`Unrecognized key: "__proto__"`); `constructor.prototype` likewise rejected.
  - `parseSnapshot` with `__proto__` inside `sampling.filter` and inside `bsonTypes` → key dropped, no
    pollution (see LOW-5 for the lossiness).
  - `canonicalize` (`src/core/snapshotSchema.ts:86-98`) builds onto `Object.create(null)`, so a
    `__proto__` key is stored as an own property instead of invoking the setter. Verified:
    `canonicalStringify(JSON.parse('{"__proto__":{"evil":1},"z":1}'))` →
    `{"__proto__":{"evil":1},"z":1}`, distinct from `{"z":1}`.
  - Documents whose keys are literally `__proto__`, `constructor` and `toString` → walked correctly into
    paths `['__proto__', '__proto__.a', 'constructor', 'toString']`; the accumulator keys off `Map`
    (`src/core/infer.ts:51-53`), not a plain object, so nothing is reachable.
  - `_bsontype: "constructor"` / `"__proto__"` / `"hasOwnProperty"` → after the working-tree fix, all
    correctly report `object`.
  - `Object.prototype` was asserted untouched after every one of the above. It was.
- **Unbounded recursion — capped.** `canonicalize` has `MAX_CANONICAL_DEPTH = 100`
  (`src/core/snapshotSchema.ts:68`). A snapshot with a 20,000-deep `sampling.filter` produced a clean
  exit 2 and an actionable message, not a stack trace:
  `docpulse: nested more than 100 levels deep`. `walkDocument` caps at `DEFAULT_MAX_DEPTH = 24`
  (`src/core/paths.ts:8`); a 20,000-deep document via `--input-json` completed normally at exit 0.
- **Unbounded memory — see MEDIUM-1.** This is the one input-validation check that does not pass.
- **Report output escaping — passes (in the working tree).** Re-tested after the fix: a field path
  containing `\n\n## Injected heading\n\n<script>…\n[click](…)\n` ` and a label containing
  `` ` \n\n# INJECTED LABEL `` produced exactly one table row with all control characters rendered as
  visible escapes (`\n`, ```) in both the Markdown and the table reporter. The JSON reporter is safe
  by construction (`JSON.stringify`). See LOW-2 for the one remaining gap.

### 4. Credential handling — no leak found

- **The connection string never reaches a snapshot.** `Snapshot` (`src/core/types.ts:81-100`) has no
  field that can hold it; `stringifySnapshot` (`src/core/snapshotSchema.ts:106`) writes a fixed key list.
  The only identifying value recorded is `db.collection`.
- **Verified by running it.** Twelve invocations of the built CLI with fake URIs containing the password
  `SuperSecret123`, each checking stdout, stderr and the written snapshot file. **Zero occurrences of the
  password in any of the three, in any run.** Representative:

  ```
  $ docpulse snapshot -u "mongodb+srv://admin:SuperSecret123@cluster0.abcde.mongodb.net/?retryWrites=true" \
      -d shop -c orders -n 5 -o out.json
  docpulse: cannot connect to MongoDB
  querySrv ENOTFOUND _mongodb._tcp.cluster0.abcde.mongodb.net
  exit=2
  ```

  Also covered: unsupported option, invalid scheme, missing host, invalid port, `mongodb+srv` with a port,
  bad TLS value, empty userinfo, malformed percent-encoding.
- The residual risks are LOW-1 (no redaction of our own) and MEDIUM-2 (`argv` exposure), above.

### 5. Dependency licences — all permissive, compatible with Apache-2.0

Direct dependencies:

| Package | Version | Licence |
|---|---|---|
| `commander` | 15.0.0 | MIT |
| `mongodb` | 7.6.0 | Apache-2.0 |
| `zod` | 4.6.5 | MIT |

Full installed production tree (15 packages):

| Licence | Packages |
|---|---|
| MIT | `commander`, `zod`, `@mongodb-js/saslprep`, `@types/webidl-conversions`, `@types/whatwg-url`, `memory-pager`, `punycode`, `sparse-bitfield`, `tr46`, `whatwg-url` |
| Apache-2.0 | `mongodb`, `bson`, `mongodb-connection-string-url` |
| BSD-2-Clause | `webidl-conversions` |

**No copyleft (GPL/LGPL/AGPL/MPL/SSPL) anywhere in the production tree.** MIT, Apache-2.0 and BSD-2-Clause
are all one-way compatible with Apache-2.0, so distributing docpulse under Apache-2.0 is sound.

Note for completeness: `mongodb` declares optional peer dependencies (`kerberos`, `snappy`, `socks`,
`gcp-metadata`, `@aws-sdk/credential-providers`, `mongodb-client-encryption`, `@mongodb-js/zstd`). None are
installed and none are required; they are all permissively licensed upstream if a user opts into one.

### 6. Telemetry and outbound network calls — none

Searched `src/` and the built `dist/` for `fetch(`, `XMLHttpRequest`, `axios`, `undici`, `node-fetch`,
`http.get`, `http.request`, `https.get`, `https.request`, `net.connect`, `dgram`, `WebSocket` and
`navigator.sendBeacon`. **Zero matches.**

The only network capability in the project is the `mongodb` driver, imported by exactly one file
(`src/source/mongoSource.ts:1`) and loaded lazily (`src/commands/snapshot.ts:112`) so that the
`--input-json` path never even loads it. The only operations issued are `find`, `sort`, `limit`,
`$match` + `$sample`, `countDocuments` and `estimatedDocumentCount` — no write, no index, no admin
command. There is no analytics endpoint, no version-check ping, no crash reporter.

### 7. Test suite and typecheck

`npm run check` (tsc `--noEmit` over `src/` and `test/`, then `vitest run`) passes on the working tree:
**132 passed | 2 skipped**, 8 test files. The 2 skipped tests are the live-MongoDB integration tests,
correctly gated behind `describe.skipIf(!process.env.MONGODB_URI)`.

At `HEAD` this same command **failed** (2 failing tests in `test/report.test.ts`) — see
[State reviewed](#state-reviewed).

---

## Recommendation

Publishable at v0.1.0 once the uncommitted hardening is committed and MEDIUM-2 is addressed (a README
change and a help-text line — no code restructuring). MEDIUM-1 is a real ceiling on the tool's own
advertised use case and should be on the v0.2 milestone, but it is not a reason to hold the release. The
Low findings are all one-to-five-line changes and can be bundled into the same pass.
