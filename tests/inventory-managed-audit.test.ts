import assert from "node:assert/strict";
import test from "node:test";
import { managedInventoryResultCounts } from "../scripts/inventory-managed-trial.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { selectedPagesFixture } from "./inventory-matching-selected-fixtures.ts";

test("managed audit validates shared sets once without admitting stale cohort members", async (t) => {
  const f = await selectedPagesFixture({
    sources: Array.from({ length: 20 }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: 20 }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    await f.matches.match("a", "destination", f.selected);
    const expected = await f.db
      .prepare(
        "SELECT s.provider,r.state,r.reason,count(*) AS records FROM match_results_current r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.destination WHERE r.tenant='a' GROUP BY s.provider,r.state,r.reason ORDER BY s.provider,r.state,r.reason",
      )
      .all();
    const actual = await managedInventoryResultCounts(f.db, "a");
    assert.deepEqual(actual.results, expected.results);
    assert.deepEqual(actual.results, [
      { provider: "qrz", state: "matched_existing", reason: null, records: 20 },
    ]);
    assert.ok(actual.meta.rows_read < expected.meta.rows_read / 2);
    t.diagnostic(
      `20 shared members: ${actual.meta.rows_read} audit reads versus ${expected.meta.rows_read} through the row-wise currentness view`,
    );
    await f.projections.project("a", f.generation, "source", ["q0"]);
    assert.deepEqual(
      (await managedInventoryResultCounts(f.db, "a")).results,
      [],
    );
    assert.deepEqual(
      (await managedInventoryResultCounts(f.db, "another-tenant")).results,
      [],
    );
  } finally {
    await f.mf.dispose();
  }
});
