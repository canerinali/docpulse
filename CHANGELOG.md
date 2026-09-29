# Changelog

## 0.1.1 — 2026-09-29

First release on npm.

**Why the npm history starts at 0.1.1 and not 0.1.0.** An unrelated earlier
package of mine used the name `docpulse` in December 2025 and published
`0.1.0`, `0.2.0` and `0.3.0` before being unpublished. npm permanently reserves
unpublished version numbers, so those three are unusable forever and this
project's first published version is `0.1.1`. Nothing was yanked: there has
never been a `docpulse@0.1.0` containing this code. The GitHub tag `v0.1.0`
marks the same source, tagged before the registry conflict was known; `v0.1.1`
is the tag that matches what is on npm.

Also in this release: the version string now has a single source
(`src/version.ts`), and `TOOL_ID` — the `tool` field written into every
snapshot — derives from it, so the two cannot drift apart again.

### What docpulse does

- `docpulse snapshot` samples a MongoDB collection (or a local JSON/NDJSON
  file) and writes a versioned snapshot of the observed field schema: per field
  path, how many sampled documents contain it, which BSON types it takes, and
  how often it is null or an empty string.
- `docpulse diff a.json b.json --fail-on-drift` compares two snapshots and
  exits 1 when a drift crosses your configured thresholds. Five finding types:
  `field_disappeared`, `field_appeared`, `type_changed`, `presence_dropped`,
  `null_ratio_increased`.
- Every ratio carries its denominator, and document-denominated and
  array-element-denominated paths are never compared against each other. Below
  `minSampledDocs` (default 500) findings are downgraded to info.

Node 22, Apache-2.0, three runtime dependencies. See
[docs/semantics.md](docs/semantics.md) for exactly what this tool does and does
not guarantee.
