import assert from "node:assert/strict";
import test from "node:test";
import { InventoryAssociations } from "../src/inventory-associations.ts";
import { collectInventoryMatchProof } from "../src/inventory-match-retention.ts";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import { canonical, sha256 } from "../src/security.ts";
import { database } from "./helpers.ts";
import {
  matchingFixture,
  receipt,
  sourceContact,
} from "./inventory-matching-fixtures.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("native retirement preserves pinned proofs and receipts while atomically collecting expired dependencies", async () => {
  const runtime = await database();
  try {
    await applyAdditionalMigrations(runtime.db);
    const f = await matchingFixture(
      {
        sources: ["q1", "q2", "q3"].map((key, i) =>
          sourceContact(key, "13:00:00", `W${i}AW`),
        ),
        receipts: ["1", "2", "3"].map((id, i) =>
          receipt(id, "130000", `W${i}AW`),
        ),
      },
      runtime,
      "current",
    );
    const matches = new InventoryMatchingResults(f.store);
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60_000,
    );
    assert.ok(lease);
    const refs = (keys: string[]) =>
      keys.map((key) => ({ scope: "source", key }));
    const publish = async (id: string, keys: string[], old = false) => {
      const page = await f.workspace.prepare("a", "destination", refs(keys));
      if (old) {
        const { digest: _, ...input } = page;
        input.preparedAt -= 8 * 86_400_000;
        Object.assign(page, input, { digest: await sha256(canonical(input)) });
      }
      await matches.publish(page, lease, id);
      return page;
    };
    const queue = () =>
      f.db
        .prepare(
          "SELECT set_id,collected_at FROM inventory_match_proof_retirements ORDER BY set_id",
        )
        .all();
    const dependencyCount = (id: string) =>
      f.store
        .statement(
          `SELECT (SELECT count(*) FROM inventory_match_scopes WHERE tenant='a' AND set_id=?1)
              + (SELECT count(*) FROM inventory_match_coverage WHERE tenant='a' AND set_id=?1)
              + (SELECT count(*) FROM inventory_match_records WHERE tenant='a' AND set_id=?1)
              + (SELECT count(*) FROM inventory_match_probes WHERE tenant='a' AND set_id=?1)
              + (SELECT count(*) FROM inventory_match_tokens WHERE tenant='a' AND set_id=?1)
              + (SELECT count(*) FROM inventory_match_candidates WHERE tenant='a' AND set_id=?1) AS n`,
          id,
        )
        .first<number>("n");

    await publish("historical", ["q1"], true);
    const adopted = await new InventoryAssociations(f.store).adopt(
      "a",
      "destination",
      refs(["q1"]),
    );
    assert.equal(adopted.records, 1);
    const historicalDependencies = await dependencyCount("historical");
    assert.ok(historicalDependencies);
    await publish("reclassified", ["q1"]);
    assert.deepEqual((await queue()).results, []);

    const expired = await publish("expired", ["q2", "q3"], true);
    const expiredDependencies = await dependencyCount("expired");
    assert.ok(expiredDependencies);
    await publish("recent", ["q2"]);
    assert.equal(await collectInventoryMatchProof(f.store), 0);
    assert.deepEqual((await queue()).results, []);
    await publish("replacement", ["q3"]);
    await publish("current", ["q2"]);
    assert.deepEqual((await queue()).results, [
      { set_id: "expired", collected_at: null },
      { set_id: "recent", collected_at: null },
    ]);

    const before = await matches.current(
      "a",
      "destination",
      refs(["q1", "q2", "q3"]),
    );
    await f.db
      .prepare(`CREATE TRIGGER fixture_fail_compaction BEFORE DELETE ON inventory_match_records
     WHEN OLD.set_id='expired' BEGIN SELECT RAISE(ABORT,'fixture collection failed'); END`)
      .run();
    await assert.rejects(
      collectInventoryMatchProof(f.store),
      /fixture collection failed/,
    );
    assert.equal(await dependencyCount("expired"), expiredDependencies);
    assert.equal((await queue()).results[0].collected_at, null);
    await f.db.prepare("DROP TRIGGER fixture_fail_compaction").run();
    assert.equal(await collectInventoryMatchProof(f.store), 1);
    assert.equal(await collectInventoryMatchProof(f.store), 0);
    assert.equal(await dependencyCount("expired"), 0);
    assert.equal(await dependencyCount("historical"), historicalDependencies);
    assert.ok(await dependencyCount("recent"));
    assert.ok(await dependencyCount("current"));
    assert.equal(
      await f.db
        .prepare(
          "SELECT 1 AS stale FROM inventory_match_stale_sets WHERE tenant='a' AND set_id='expired' LIMIT 1",
        )
        .first("stale"),
      1,
    );
    assert.equal(
      (await matches.publish(expired, lease, "expired")).recovered,
      true,
    );
    assert.equal(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_match_rows WHERE tenant='a' AND set_id='expired'",
        )
        .first("n"),
      2,
    );
    assert.deepEqual(
      (await matches.current("a", "destination", refs(["q1", "q2", "q3"])))
        .results,
      before.results,
    );
  } finally {
    await runtime.mf.dispose();
  }
});
