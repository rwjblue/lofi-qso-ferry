import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { InventoryAssociations } from "../src/inventory-associations.ts";
import {
  type InventoryBodyArchive,
  InventoryBodyArchiveUnavailable,
} from "../src/inventory-body-archive.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import { collectInventoryColdBodies } from "../src/inventory-payload-retention.ts";
import { InventoryProjectionWorkspace } from "../src/inventory-projection-workspace.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database } from "./helpers.ts";
import {
  matchingFixture,
  sourceContact,
} from "./inventory-matching-fixtures.ts";

test("settled cold ciphertext moves after object persistence and reopens under native projection fences", async () => {
  const runtime = await database();
  try {
    const migrations = await readdir(
      new URL("../migrations/", import.meta.url),
    );
    for (const name of migrations.sort())
      if (
        /^\d+.*\.sql$/.test(name) &&
        !name.startsWith("0001_") &&
        name < "0135_"
      )
        await applyMigration(runtime.db, name);
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
    const original = await f.inventory.body(
      "a",
      "source",
      "qso",
      "q0",
      "source",
    );
    assert.ok(original);
    const refs = [{ scope: "source", key: "q0" }];
    const matchLease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60_000,
    );
    const adoptionLease = await f.store.claim(
      "a",
      "inventory-ownership:qrz",
      Date.now(),
      60_000,
    );
    assert.ok(matchLease && adoptionLease);
    await new InventoryMatchingResults(f.store).publish(
      await f.workspace.prepare("a", "destination", refs),
      matchLease,
    );
    const associations = new InventoryAssociations(f.store);
    const { digest: _, ...input } = await associations.prepare(
      "a",
      "destination",
      refs,
    );
    const aged = Date.now() - 100 * 86_400_000;
    input.preparedAt = aged;
    assert.equal(
      (
        await associations.publish(
          { ...input, digest: await sha256(canonical(input)) },
          adoptionLease,
        )
      ).records,
      1,
    );

    // Backdate test-fixture timestamps before enabling the cooling migration.
    await f.db.batch([
      f.db.prepare("DROP TRIGGER inventory_payloads_immutable"),
      f.db
        .prepare(
          "UPDATE inventory_payloads SET created_at=? WHERE kind='inventory_source'",
        )
        .bind(aged),
      f.db.prepare(
        "CREATE TRIGGER inventory_payloads_immutable BEFORE UPDATE ON inventory_payloads BEGIN SELECT RAISE(ABORT,'immutable inventory payload'); END",
      ),
      f.db.prepare("DROP TRIGGER comparison_projection_version"),
      f.db
        .prepare(
          "UPDATE comparison_projections SET derived_at=? WHERE facet='source'",
        )
        .bind(aged),
      f.db.prepare(
        "CREATE TRIGGER comparison_projection_version BEFORE UPDATE ON comparison_projections WHEN NEW.version<=OLD.version BEGIN SELECT RAISE(ABORT,'comparison projection version required'); END",
      ),
    ]);
    await applyMigration(f.db, "0135_inventory_cold_bodies.sql");
    const bodies = new Map<string, string>();
    let allowWrites = false;
    const archive: InventoryBodyArchive = {
      async put(key, encrypted) {
        if (!allowWrites) throw new Error("fixture archive failed");
        assert.equal(JSON.parse(encrypted).algorithm, "AES-256-GCM");
        bodies.set(key, encrypted);
      },
      async get(key) {
        const body = bodies.get(key);
        return body === undefined
          ? null
          : { size: Buffer.byteLength(body), text: async () => body };
      },
    };
    const store = new Store(f.db, f.store.keys, archive);
    const storage = async () =>
      (
        await f.db
          .prepare(
            `SELECT f.record_key,p.cold,length(p.envelope) AS bytes
       FROM inventory_record_facets f JOIN inventory_payloads p USING(tenant,scope_id,payload_id)
       WHERE f.entity_family='qso' AND f.facet='source' ORDER BY f.record_key`,
          )
          .all<{ record_key: string; cold: number; bytes: number }>()
      ).results;
    const before = await storage();
    assert.equal(await collectInventoryColdBodies(f.store), 0);
    await assert.rejects(
      collectInventoryColdBodies(store),
      /fixture archive failed/,
    );
    assert.deepEqual(await storage(), before);
    allowWrites = true;
    assert.equal(await collectInventoryColdBodies(store), 1);
    assert.equal(await collectInventoryColdBodies(store), 0);
    assert.equal(bodies.size, 1);
    const after = await storage();
    assert.deepEqual(after[0], before[0]);
    assert.equal(after[1].cold, 1);
    assert.ok(after[1].bytes < before[1].bytes);

    const intake = new InventoryIngestion(store);
    assert.deepEqual(
      await intake.body("a", "source", "qso", "q0", "source"),
      original,
    );
    const projected = await new InventoryProjectionWorkspace(store).prepare(
      "a",
      f.generation,
      "source",
      ["q0"],
    );
    assert.equal(projected.rows[0].state, "ready");
    assert.equal(
      (await f.db.prepare("PRAGMA foreign_key_check").all()).results.length,
      0,
    );
    bodies.clear();
    await assert.rejects(
      intake.body("a", "source", "qso", "q0", "source"),
      InventoryBodyArchiveUnavailable,
    );
  } finally {
    await runtime.mf.dispose();
  }
});
