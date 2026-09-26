#!/usr/bin/env node
/**
 * Regenerate the two NDJSON files used by run.sh.
 *
 * Fully deterministic (no RNG): running this again produces byte-identical
 * files, which is why the generated snapshots can be committed.
 *
 *   node examples/generate-input.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const COUNT = 600;

function lines(i, qtyAsString) {
  return Array.from({ length: (i % 3) + 1 }, (_, k) => ({
    sku: `S-${i}-${k}`,
    qty: qtyAsString ? String(k + 1) : k + 1,
  }));
}

/** Last week: 75% of orders carry a tax id, 63% carry a coupon, 2% null provider. */
function before(i) {
  const doc = {
    _id: i,
    status: i % 7 === 0 ? 'pending' : 'paid',
    total: 1000 + i,
    customer: i < 450 ? { taxId: `TR${1000000 + i}` } : {},
    paymentProvider: i % 50 === 0 ? null : 'stripe',
    lines: lines(i, false),
    updatedAt: '2026-09-19T02:15:04.881Z',
  };
  if (i < 380) doc.couponCode = `SAVE${i % 20}`;
  return doc;
}

/**
 * This week, after a bad deploy upstream: the tax id mostly stopped being
 * written, coupons were retired, a new `channel` field appeared, the payment
 * provider is now explicitly null 30% of the time, and half the line items
 * send `qty` as a string.
 */
function after(i) {
  return {
    _id: i,
    status: i % 7 === 0 ? 'pending' : 'paid',
    total: 1000 + i,
    customer: i < 120 ? { taxId: `TR${1000000 + i}` } : {},
    channel: i % 3 === 0 ? 'web' : 'app',
    paymentProvider: i % 10 < 3 ? null : 'stripe',
    lines: lines(i, i % 2 === 0),
    updatedAt: '2026-09-26T17:40:11.204Z',
  };
}

for (const [name, build] of [
  ['orders-before.ndjson', before],
  ['orders-after.ndjson', after],
]) {
  const text = `${Array.from({ length: COUNT }, (_, i) => JSON.stringify(build(i))).join('\n')}\n`;
  writeFileSync(join(HERE, name), text);
  console.log(`wrote examples/${name} (${COUNT} documents)`);
}
