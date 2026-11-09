import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InventoryDeliveryReview } from "../src/inventory-delivery-review.ts";
import { InventoryOwnership } from "../src/inventory-ownership.ts";
import { Store } from "../src/store.ts";
import { applyMigration } from "./helpers.ts";
import { installMatchingCoordinator } from "./inventory-matching-coordinator-fixtures.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

async function fixture(t: TestContext, provider: "qrz" | "lotw" = "qrz") {
  const f = await matchingWorkFixture({
    provider,
    sources: [
      sourceContact("q1", "13:00:00", "W1AW"),
      sourceContact("q2", "14:00:00", "W2AW"),
    ],
    receipts: [receipt("1")],
  });
  t.after(() => f.mf.dispose());
  await installMatchingCoordinator(f.db);
  await applyMigration(f.db, "0083_inventory_delivery_review.sql");
  return {
    ...f,
    planner: new InventoryDeliveryReview(f.store),
    match: () => f.matches.match("a", "destination", f.selected),
    async decisions() {
      return (
        await f.db
          .prepare(
            "SELECT record_key,decision,result_version FROM inventory_delivery_review_current ORDER BY record_key",
          )
          .all()
      ).results;
    },
  };
}

test("a matched contact stays out of QRZ review and new comparison supersedes a reviewed absence", async (t) => {
  const f = await fixture(t);
  await f.match();
  assert.deepEqual(await f.planner.step("a"), { kind: "reviewed", records: 1 });
  assert.deepEqual(await f.decisions(), [
    { record_key: "q2", decision: "source_proof_required", result_version: 1 },
  ]);
  assert.deepEqual(await f.planner.step("a"), { kind: "idle" });
  await f.match();
  await f.fullReceipt([receipt("1"), receipt("2", "140000", "W2AW")]);
  await f.project("destination");
  assert.deepEqual(await f.planner.step("a"), { kind: "reviewed", records: 1 });
  assert.equal(
    await f.db
      .prepare("SELECT decision FROM inventory_delivery_review")
      .first("decision"),
    "comparison_changed",
  );
  assert.deepEqual(await f.decisions(), []);
  await f.match();
  assert.deepEqual(await f.planner.step("a"), { kind: "idle" });
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_delivery_review")
      .first("n"),
    0,
  );
  assert.equal(
    await f.db.prepare("SELECT count(*) AS n FROM attempts").first("n"),
    0,
  );
});

test("a LoTW ownership hold invalidates a clear review without rewriting the comparison", async (t) => {
  const f = await fixture(t, "lotw");
  await f.match();
  assert.deepEqual(await f.planner.step("a"), { kind: "reviewed", records: 1 });
  assert.deepEqual(await f.decisions(), [
    { record_key: "q2", decision: "source_proof_required", result_version: 1 },
  ]);
  const ownership = new InventoryOwnership(f.store);
  await ownership.hold("a", "lotw", "inflight", "unresolved_delivery");
  assert.deepEqual(await f.decisions(), []);
  assert.deepEqual(await f.planner.step("a"), { kind: "reviewed", records: 1 });
  assert.deepEqual(await f.decisions(), [
    { record_key: "q2", decision: "ownership_incomplete", result_version: 1 },
  ]);
  assert.equal(
    (await f.matches.current("a", "destination", f.selected)).results.find(
      (row) => row.record_key === "q2",
    )?.state,
    "absent_at_inventory",
  );
  assert.deepEqual(await f.planner.step("a"), { kind: "idle" });
});

test("credential replacement reopens a completed review of the same receipt selection", async (t) => {
  const f = await fixture(t);
  await f.match();
  await f.planner.step("a");
  await f.db
    .prepare(
      "UPDATE connections SET credential_version='v2' WHERE id='destination'",
    )
    .run();
  assert.deepEqual(await f.decisions(), []);
  assert.deepEqual(await f.planner.step("a"), { kind: "reviewed", records: 1 });
  assert.equal((await f.decisions())[0]?.decision, "credentials_unavailable");
  await (
    await f.store.putPrivate("a", "destination", "v3", "credential", {
      apiKey: "fixture",
    })
  ).run();
  await f.db
    .prepare(
      "UPDATE connections SET credential_version='v3' WHERE id='destination'",
    )
    .run();
  assert.deepEqual(await f.planner.step("a"), { kind: "reviewed", records: 1 });
  assert.equal((await f.decisions())[0]?.decision, "source_proof_required");
});

test("an ownership change between review preparation and publication leaves the old claim pending", async (t) => {
  const f = await fixture(t);
  await f.match();
  const ownership = new InventoryOwnership(f.store);
  class RacingStore extends Store {
    override statement(sql: string, ...params: (string | number | null)[]) {
      const statement = super.statement(sql, ...params);
      if (!sql.includes("UPDATE inventory_delivery_review AS w"))
        return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "run")
            return async () => {
              await ownership.hold(
                "a",
                "qrz",
                "inflight",
                "unresolved_delivery",
              );
              return target.run();
            };
          return Reflect.get(target, property);
        },
      });
    }
  }
  const raced = new InventoryDeliveryReview(
    new RacingStore(f.db, f.store.keys),
  );
  assert.deepEqual(await raced.step("a"), { kind: "deferred" });
  assert.deepEqual(await f.decisions(), []);
  assert.deepEqual(await f.planner.step("a"), { kind: "reviewed", records: 1 });
  assert.equal((await f.decisions())[0]?.decision, "ownership_incomplete");
});

test("native match publication rolls back when an absence omits its review work", async (t) => {
  const f = await fixture(t);
  await f.db
    .prepare("DROP TRIGGER inventory_delivery_review_result_insert")
    .run();
  await assert.rejects(
    f.match(),
    /inventory delivery review publication incomplete/,
  );
  assert.equal(
    await f.db.prepare("SELECT count(*) AS n FROM match_results").first("n"),
    0,
  );
});
