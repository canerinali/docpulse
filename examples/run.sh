#!/usr/bin/env bash
#
# End-to-end docpulse demo with NO database at all.
#
#   ./examples/run.sh
#
# It snapshots two local NDJSON files as if they were two weekly samples of the
# same `shop.orders` collection, then diffs them twice: once against itself
# (clean, exit 0) and once against the drifted week (exit 1 under
# --fail-on-drift). Everything it writes lands in examples/generated/.
set -uo pipefail
cd "$(dirname "$0")"

# Use the local build if there is one, otherwise the installed `docpulse` bin.
if [ -f ../dist/cli.js ]; then
  DOCPULSE=(node ../dist/cli.js)
else
  DOCPULSE=(docpulse)
fi

mkdir -p generated

echo "==> 1. snapshot last week's sample"
"${DOCPULSE[@]}" snapshot \
  --input-json orders-before.ndjson \
  --db shop --collection orders \
  --label week-38 \
  --out generated/baseline.snapshot.json
echo "exit=$?"

echo
echo "==> 2. snapshot this week's sample"
"${DOCPULSE[@]}" snapshot \
  --input-json orders-after.ndjson \
  --db shop --collection orders \
  --label week-39 \
  --out generated/current.snapshot.json
echo "exit=$?"

echo
echo "==> 3. diff the baseline against itself: no drift, exit 0"
"${DOCPULSE[@]}" diff \
  generated/baseline.snapshot.json \
  generated/baseline.snapshot.json \
  --format table --fail-on-drift
echo "exit=$?"

echo
echo "==> 4. diff last week against this week: drift, exit 1"
"${DOCPULSE[@]}" diff \
  generated/baseline.snapshot.json \
  generated/current.snapshot.json \
  --fail-on-drift \
  --out generated/drift-report.md
echo "exit=$?"

echo
echo "==> 5. the same diff as machine-readable JSON"
"${DOCPULSE[@]}" diff \
  generated/baseline.snapshot.json \
  generated/current.snapshot.json \
  --format json \
  --out generated/drift-report.json
echo "exit=$?"

echo
echo "==> drift report (generated/drift-report.md)"
cat generated/drift-report.md
