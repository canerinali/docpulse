# Security policy

docpulse is a local command-line tool maintained by one person. This document
says which versions get fixes, how to report a problem privately, how long you
should expect to wait, and what is and is not treated as a vulnerability.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes — security fixes land in a new 0.1.x patch |
| < 0.1 | No |

docpulse is pre-1.0 and has a single supported line. Fixes go to the latest
patch of the latest minor; there are no long-term support branches. If you are
pinning a version in CI (`npx docpulse@0.1`), a patch release is the upgrade
path.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

<https://github.com/canerinali/docpulse/security/advisories/new>

(From the repository: **Security** → **Report a vulnerability**. You need a
GitHub account; the report is visible only to you and the maintainer.)

A useful report includes:

- the docpulse version (`docpulse --version`) and your Node.js version;
- the exact command line, with any connection string redacted;
- an input that reproduces it — a snapshot file, a `docpulse.config.json`, or a
  small NDJSON file for `--input-json`. **Redact real data**: docpulse is a
  data-quality tool and reproducers tend to contain production field names.
  Synthetic documents with the same shape are better than real ones;
- what you expected to happen and what happened instead.

Proof-of-concept code is welcome. Please do not test against anything you do
not own, and never attach a live connection string.

## What to expect, and when

This is a spare-time project, so everything below is **best effort**, not a
commitment:

- **Acknowledgement:** within 7 days.
- **First assessment** (is it a vulnerability, how severe, is there a
  workaround): within 10 working days of acknowledgement.
- **Fix:** for a confirmed High or Critical issue, a patch release as soon as
  one can be produced and tested — days, not months. Lower-severity issues are
  usually fixed in the next ordinary release.
- **Disclosure:** coordinated. The advisory is published once a fixed version is
  on npm. You are credited by whatever name or handle you ask for, or not at
  all if you prefer.

If you have not heard anything after 7 days, it is reasonable to nudge
by opening a *non-descriptive* public issue ("awaiting a reply on a private
report") — do not put details in it.

## Scope

docpulse runs on your machine or in your CI runner, reads a MongoDB collection
read-only, and writes JSON and Markdown files. It has no server, no service, no
account and no telemetry, which makes the scope fairly narrow.

### In scope

- **Credential exposure.** A connection string, or any part of it, appearing in
  a snapshot file, a report, a log line, an error message or a stack trace.
- **Anything docpulse writes to MongoDB.** It must only ever issue `find`,
  `$sample`, `countDocuments` and `estimatedDocumentCount`. A write, an index
  build, or a command outside that list is a vulnerability.
- **Code execution or file access driven by input rather than by argv.** A
  snapshot file, a `docpulse.config.json`, an `--input-json` document or a
  document key that causes docpulse to execute code, spawn a process, or read
  or write a path the operator did not name on the command line.
- **Prototype pollution** reachable from any parsed input.
- **Report injection.** A field path, label, collection name or BSON type name
  that escapes its cell in the Markdown or table reporter — these reports are
  pasted into pull requests and CI job summaries, so forged rows, headings,
  links or raw HTML count.
- **Unexpected network traffic.** Any connection to a host other than the
  MongoDB deployment the operator asked for.
- **Denial of service from a malformed file** that is disproportionate: a
  crash, an unbounded allocation or a hang triggered by a small input.
- **Vulnerable runtime dependencies** (`commander`, `mongodb`, `zod` and their
  transitive tree) that are actually reachable from docpulse's code paths.

### Out of scope

- **What the operator asks for.** `--filter`, `--uri`, `--out`, `--config` and
  the two snapshot paths are the operator's own arguments. Reading a file you
  named, writing a file you named, or running a query you typed is not a
  vulnerability, including a `--filter` containing `$where`. See
  "Handling untrusted data" in [docs/semantics.md](docs/semantics.md).
- **A connection string visible in `ps` output or shell history** when you pass
  it as `--uri`. That is inherent to command-line arguments; use the
  `MONGODB_URI` environment variable or a CI secret.
- **Values you put in a `--filter` ending up in the snapshot.** The filter is
  stored on purpose so `diff` can refuse to compare mismatched samples. It is
  documented; choose filter fields accordingly.
- **Missing drift.** A false negative or false positive in the finding rules is
  a bug — please report it as a normal issue — but it is not a security issue.
- **MongoDB server, driver or Node.js vulnerabilities** that are not reachable
  through docpulse. Report those to their own maintainers.
- **Anything requiring an attacker who already runs code as you**, or who can
  already write arbitrary files into your repository or CI runner.
- **Results from automated scanners with no demonstrated impact on docpulse**,
  including `npm audit` advisories against dev-only dependencies.
- **Social engineering, typosquatting of similar package names, and the
  security of GitHub or npm themselves.**

## Hardening notes for operators

- Give docpulse a **read-only MongoDB user**. It never needs more, and a
  read-only user turns the "it never writes" claim into something your database
  enforces rather than something you have to trust.
- Pass the connection string through `MONGODB_URI` (a CI secret), not `--uri`.
- Snapshots and reports are build artefacts derived from your data. Review a
  snapshot before committing it the same way you would review any other file
  that goes into git: the field *names* of your collection are in it.

## Licence

docpulse is Apache-2.0. Reporting a vulnerability grants no licence and asks
for none.
