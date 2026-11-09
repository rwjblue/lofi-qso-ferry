import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { InventoryAssociations } from "../src/inventory-associations.ts";
import { collectInventoryMatchProofs } from "../src/inventory-match-retention.ts";
import {
  InventoryMatchingResults,
  type InventoryMatchingWorkClaim,
} from "../src/inventory-matching-results.ts";
import { InventoryMatchingWork } from "../src/inventory-matching-work.ts";
import {
  readInventoryRetentionPolicy,
  updateInventoryRetentionPolicy,
} from "../src/inventory-retention-policy.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database } from "./helpers.ts";
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
        sources: ["q1", "q2", "q3", "q4"].map((key, i) =>
          sourceContact(key, "13:00:00", `W${i}AW`),
        ),
        receipts: ["1", "2", "3", "4"].map((id, i) =>
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
    assert.deepEqual((await queue()).results, [
      { set_id: "historical", collected_at: null },
    ]);

    const expired = await publish("expired", ["q2", "q3"], true);
    const expiredDependencies = await dependencyCount("expired");
    assert.ok(expiredDependencies);
    await publish("expired-second", ["q4"], true);
    const secondDependencies = await dependencyCount("expired-second");
    assert.ok(secondDependencies);
    await publish("recent", ["q2"]);
    assert.equal(await collectInventoryMatchProofs(f.store), 0);
    assert.deepEqual((await queue()).results, [
      { set_id: "historical", collected_at: null },
    ]);
    await publish("replacement", ["q3"]);
    await publish("replacement-second", ["q4"]);
    await publish("current", ["q2"]);
    assert.deepEqual((await queue()).results, [
      { set_id: "expired", collected_at: null },
      { set_id: "expired-second", collected_at: null },
      { set_id: "historical", collected_at: null },
      { set_id: "recent", collected_at: null },
    ]);

    const before = await matches.current(
      "a",
      "destination",
      refs(["q1", "q2", "q3", "q4"]),
    );
    await f.db
      .prepare(`CREATE TRIGGER fixture_fail_compaction BEFORE DELETE ON inventory_match_records
     WHEN OLD.set_id='expired-second' BEGIN SELECT RAISE(ABORT,'fixture collection failed'); END`)
      .run();
    await assert.rejects(
      collectInventoryMatchProofs(f.store),
      /fixture collection failed/,
    );
    assert.equal(await dependencyCount("expired"), expiredDependencies);
    assert.equal(await dependencyCount("expired-second"), secondDependencies);
    assert.equal((await queue()).results[0].collected_at, null);
    assert.equal((await queue()).results[1].collected_at, null);
    await f.db.prepare("DROP TRIGGER fixture_fail_compaction").run();
    assert.equal(await collectInventoryMatchProofs(f.store), 2);
    assert.equal(await collectInventoryMatchProofs(f.store), 0);
    assert.equal(await dependencyCount("expired"), 0);
    assert.equal(await dependencyCount("expired-second"), 0);
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
      (
        await matches.current(
          "a",
          "destination",
          refs(["q1", "q2", "q3", "q4"]),
        )
      ).results,
      before.results,
    );

    for (let i = 0; i < 18; i++) await publish(`burst-${i}`, ["q2"], true);
    await publish("burst-current", ["q2"]);
    const oneProofBudget = await dependencyCount("burst-0");
    assert.ok(oneProofBudget);
    const constrained = new Store(f.db, f.store.keys);
    constrained.statement = (sql, ...params) => {
      if (!sql.includes("UPDATE inventory_match_proof_retirements"))
        return f.store.statement(sql, ...params);
      assert.deepEqual(params, [16, 20_000]);
      return f.store.statement(sql, params[0], oneProofBudget);
    };
    assert.equal(await collectInventoryMatchProofs(constrained), 1);
    assert.equal(await collectInventoryMatchProofs(f.store), 16);
    assert.equal(await collectInventoryMatchProofs(f.store), 1);
    assert.equal(await collectInventoryMatchProofs(f.store), 0);
  } finally {
    await runtime.mf.dispose();
  }
});

test("settled live results age out while missing contacts remain available for review", async () => {
  const runtime = await database();
  try {
    await applyAdditionalMigrations(runtime.db);
    const f = await matchingFixture(
      {
        sources: [
          sourceContact("q0"),
          sourceContact("missing", "13:00:00", "K1XYZ"),
        ],
      },
      runtime,
      "current",
    );
    const refs = [{ scope: "source", key: "q0" }];
    const missing = [{ scope: "source", key: "missing" }];
    const matches = new InventoryMatchingResults(f.store);
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60_000,
    );
    assert.ok(lease);
    for (const [id, selected] of [
      ["settled", refs],
      ["missing", missing],
    ] as const) {
      const page = await f.workspace.prepare("a", "destination", selected);
      const { digest: _digest, ...input } = page;
      input.preparedAt -= 100 * 86_400_000;
      const claim = await f.db
        .prepare(
          `SELECT source_scope AS scope,record_key AS key,work_version AS workVersion,completed_version AS completedVersion,
           source_config_version AS sourceConfigVersion,destination_config_version AS destinationConfigVersion,due_at AS dueAt,0 AS resultVersion
           FROM matching_work WHERE record_key=?`,
        )
        .bind(selected[0].key)
        .first<InventoryMatchingWorkClaim>();
      assert.ok(claim);
      await matches.publish(
        { ...input, digest: await sha256(canonical(input)) },
        lease,
        id,
        [claim],
      );
    }
    await f.store.release(lease);
    const associations = new InventoryAssociations(f.store);
    const ownershipLease = await f.store.claim(
      "a",
      "inventory-ownership:qrz",
      Date.now(),
      60_000,
    );
    assert.ok(ownershipLease);
    const { digest: _digest, ...input } = await associations.prepare(
      "a",
      "destination",
      refs,
    );
    input.preparedAt -= 95 * 86_400_000;
    const page = { ...input, digest: await sha256(canonical(input)) };
    assert.equal(
      (await associations.publish(page, ownershipLease, "settlement")).records,
      1,
    );
    await f.store.release(ownershipLease);

    const owner = () =>
      f.db.prepare("SELECT * FROM inventory_historical_associations").first();
    const original = await owner();
    assert.ok(original);
    await updateInventoryRetentionPolicy(f.db, 97);
    assert.equal(await collectInventoryMatchProofs(f.store), 0);
    assert.equal(
      (await matches.current("a", "destination", refs)).results.length,
      1,
    );
    await assert.rejects(
      f.db
        .prepare("DELETE FROM match_results WHERE record_key='missing'")
        .run(),
      /inventory result still retained/,
    );
    await updateInventoryRetentionPolicy(f.db, 90);
    assert.equal(await collectInventoryMatchProofs(f.store), 1);
    assert.equal(
      (await matches.current("a", "destination", refs)).results.length,
      0,
    );
    assert.equal(
      (await matches.current("a", "destination", missing)).results[0].state,
      "absent_at_inventory",
    );
    assert.deepEqual(await owner(), original);
    for (const table of [
      "inventory_match_live_sets",
      "inventory_match_records",
      "inventory_matching_bucket_dependents",
    ]) {
      assert.equal(
        await f.db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE set_id='settled'`)
          .first("n"),
        0,
      );
    }

    const work = new InventoryMatchingWork(f.store);
    assert.equal(
      (await work.enqueue("a", f.generation, "destination", refs)).records,
      1,
    );
    assert.equal((await work.step("a")).kind, "matched");
    assert.equal(
      (await matches.current("a", "destination", refs)).results[0].state,
      "matched_existing",
    );
    assert.deepEqual(await owner(), original);
    assert.equal(
      await f.db.prepare("SELECT count(*) AS n FROM attempts").first("n"),
      0,
    );
    assert.equal(
      (await f.db.prepare("PRAGMA foreign_key_check").all()).results.length,
      0,
    );
  } finally {
    await runtime.mf.dispose();
  }
});

test("operator cooling period ages historical proof dependencies while preserving ownership and its receipt", async () => {
  const runtime = await database();
  try {
    const migrations = await readdir(
      new URL("../migrations/", import.meta.url),
    );
    for (const name of migrations.sort())
      if (
        /^\d+.*\.sql$/.test(name) &&
        !/^(?:0001|0129|0130)_/.test(name) &&
        name < "0135_"
      )
        await applyMigration(runtime.db, name);
    const f = await matchingFixture({}, runtime, "current");
    const refs = [{ scope: "source", key: "q0" }];
    const matches = new InventoryMatchingResults(f.store);
    const matchLease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60_000,
    );
    const ownershipLease = await f.store.claim(
      "a",
      "inventory-ownership:qrz",
      Date.now(),
      60_000,
    );
    assert.ok(matchLease && ownershipLease);
    const historical = await f.workspace.prepare("a", "destination", refs);
    const { digest: _historical, ...proofInput } = historical;
    proofInput.preparedAt -= 100 * 86_400_000;
    Object.assign(historical, proofInput, {
      digest: await sha256(canonical(proofInput)),
    });
    await matches.publish(historical, matchLease, "historical-set");
    const associations = new InventoryAssociations(f.store);
    const adoption = await associations.prepare("a", "destination", refs);
    const { digest: _adoption, ...adoptionInput } = adoption;
    adoptionInput.preparedAt -= 60 * 86_400_000;
    Object.assign(adoption, adoptionInput, {
      digest: await sha256(canonical(adoptionInput)),
    });
    assert.equal(
      (await associations.publish(adoption, ownershipLease, "adoption"))
        .records,
      1,
    );
    const owner = () =>
      f.db.prepare("SELECT * FROM inventory_historical_associations").first();
    const original = await owner();
    assert.ok(original);
    const current = await f.workspace.prepare("a", "destination", refs);
    await matches.publish(current, matchLease, "current-set");
    assert.equal(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_match_proof_retirements")
        .first("n"),
      0,
    );
    await applyMigration(f.db, "0129_inventory_settled_proof_retirement.sql");
    await applyMigration(f.db, "0130_inventory_settled_result_retirement.sql");

    assert.deepEqual(await readInventoryRetentionPolicy(f.db), {
      settledRetentionDays: 90,
    });
    assert.equal(await collectInventoryMatchProofs(f.store), 0);
    assert.equal(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_match_proof_retirements")
        .first("n"),
      1,
    );
    for (const invalid of [0, 1.5, 3651])
      await assert.rejects(
        updateInventoryRetentionPolicy(f.db, invalid),
        /invalid_inventory_retention_days/,
      );
    assert.deepEqual(await updateInventoryRetentionPolicy(f.db, 45), {
      settledRetentionDays: 45,
    });
    assert.equal(await collectInventoryMatchProofs(f.store), 1);
    assert.equal(await collectInventoryMatchProofs(f.store), 0);
    assert.deepEqual(await owner(), original);
    assert.equal(
      (await associations.publish(adoption, ownershipLease, "adoption"))
        .recovered,
      true,
    );
    assert.equal(
      (await matches.publish(historical, matchLease, "historical-set"))
        .recovered,
      true,
    );
    assert.equal(
      (await matches.current("a", "destination", refs)).results[0].set_id,
      "current-set",
    );
    assert.equal(
      (await f.db.prepare("PRAGMA foreign_key_check").all()).results.length,
      0,
    );
  } finally {
    await runtime.mf.dispose();
  }
});
