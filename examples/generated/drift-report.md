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
