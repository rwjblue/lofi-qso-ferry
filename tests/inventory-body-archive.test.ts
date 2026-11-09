import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { InventoryAssociations } from "../src/inventory-associations.ts";
import {
  type InventoryBodyArchive,
  InventoryBodyArchiveUnavailable,
} from "../src/inventory-body-archive.ts";
import { stepInventoryBodyReplay } from "../src/inventory-body-replay.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import { lofiInventoryObservations } from "../src/inventory-observations.ts";
import { collectInventoryColdBodies } from "../src/inventory-payload-retention.ts";
import { InventoryProjectionWorkspace } from "../src/inventory-projection-workspace.ts";
import { updateInventoryRetentionPolicy } from "../src/inventory-retention-policy.ts";
import { canonical, seal, sha256 } from "../src/security.ts";
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
    const record = {
      ...(sourceContact("q0").body as Record<string, unknown>),
      syncedAtMillis: Date.now() - 100 * 86_400_000,
    };
    const [source] = await lofiInventoryObservations([], [record]);
    const f = await matchingFixture(
      {
        sources: [source, sourceContact("missing", "13:00:00", "K1XYZ")],
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
    await applyMigration(f.db, "0136_inventory_cold_body_replay.sql");
    await applyMigration(f.db, "0137_inventory_replay_cooling.sql");
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
    for (const [key, encrypted] of bodies) {
      bodies.set(key, `[${encrypted.slice(1)}`);
      await assert.rejects(
        intake.body("a", "source", "qso", "q0", "source"),
        /inventory_body_archive_digest_changed/,
      );
    }
    bodies.clear();
    await assert.rejects(
      intake.body("a", "source", "qso", "q0", "source"),
      InventoryBodyArchiveUnavailable,
    );
    await assert.rejects(
      intake.body("a", "source", "qso", "q0", "source"),
      InventoryBodyArchiveUnavailable,
    );
    assert.equal(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_body_replay_requests WHERE state='pending'",
        )
        .first("n"),
      1,
    );

    const credential = await seal(
      { key: "browser:replay", secret: "fixture", token: "fixture" },
      {
        tenant: "a",
        connection: "source",
        id: "v1",
        kind: "credential",
        purpose: "storage",
      },
      f.store.keys,
    );
    await f.db
      .prepare(
        "UPDATE private_data SET envelope=? WHERE tenant='a' AND connection='source' AND id='v1'",
      )
      .bind(canonical(credential))
      .run();
    await f.db
      .prepare(
        "INSERT INTO inventory_read_pacing(vendor,tenant,source,last_requested_at,next_allowed_at,loop_delay_ms) VALUES('lofi','a','source',0,0,5000)",
      )
      .run();
    await f.store.release(f.lease);
    const normalCursor = await intake.snapshot("a", "source", "sync");
    let requests = 0;
    const replay: typeof fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/v1/sync");
      assert.equal(init?.method, "POST");
      const payload = JSON.parse(String(init.body));
      assert.deepEqual(Object.keys(payload), ["meta"]);
      assert.equal(payload.meta.sync.qsos.anyClient, true);
      assert.equal(
        payload.meta.sync.qsos.cursor,
        requests ? "repair-next" : undefined,
      );
      requests++;
      return Response.json({
        account: { uuid: "source" },
        operations:
          requests === 1
            ? [
                {
                  uuid: "op",
                  stationCall: "N1RWJ",
                  syncedAtMillis: record.syncedAtMillis + 10,
                },
              ]
            : [],
        qsos:
          requests === 1
            ? [
                {
                  ...record,
                  notes: "different version",
                  syncedAtMillis: record.syncedAtMillis + 1,
                },
              ]
            : [record],
        meta: {
          operations: { records_left: 0 },
          qsos:
            requests === 1
              ? { records_left: 1, next_cursor: "repair-next" }
              : { records_left: 0 },
          suggestedSyncLoopDelay: 0,
        },
      });
    };
    assert.deepEqual(await stepInventoryBodyReplay(store, replay), {
      kind: "continue",
      restored: 0,
    });
    assert.deepEqual(
      await intake.snapshot("a", "source", "sync"),
      normalCursor,
    );
    assert.equal((await storage())[1].cold, 1);
    await new Promise((resolve) => setTimeout(resolve, 5100));
    const interrupted: typeof fetch = async (input, init) => {
      const response = await replay(input, init);
      await f.db
        .prepare(
          "UPDATE leases SET expires_at=0 WHERE tenant='a' AND scope='inventory:source'",
        )
        .run();
      return response;
    };
    await assert.rejects(
      stepInventoryBodyReplay(store, interrupted),
      /inventory body replay authority changed/,
    );
    assert.equal((await storage())[1].cold, 1);
    assert.deepEqual(
      await intake.snapshot("a", "source", "sync"),
      normalCursor,
    );
    await new Promise((resolve) => setTimeout(resolve, 5100));
    assert.deepEqual(await stepInventoryBodyReplay(store, replay), {
      kind: "complete",
      restored: 1,
    });
    assert.equal(requests, 3);
    assert.deepEqual(
      await intake.snapshot("a", "source", "sync"),
      normalCursor,
    );
    assert.deepEqual(
      await intake.body("a", "source", "qso", "q0", "source"),
      original,
    );
    assert.equal((await storage())[1].cold, 0);
    assert.deepEqual(await stepInventoryBodyReplay(store, replay), {
      kind: "idle",
    });

    await updateInventoryRetentionPolicy(f.db, 89);
    assert.equal(await collectInventoryColdBodies(f.store), 0);
    assert.equal((await storage())[1].cold, 0);
    await f.db
      .prepare(
        "UPDATE inventory_body_replay_requests SET requested_at=?1,restored_at=?1 WHERE state='restored'",
      )
      .bind(aged)
      .run();
    await updateInventoryRetentionPolicy(f.db, 88);
    assert.equal(await collectInventoryColdBodies(f.store), 1);
    assert.equal(bodies.size, 0);
    assert.equal((await storage())[1].cold, 1);
    assert.equal(
      await f.db
        .prepare(
          "SELECT json_extract(envelope,'$.archive.replayOnly') AS replay FROM inventory_payloads WHERE cold=1",
        )
        .first("replay"),
      1,
    );
    await assert.rejects(
      f.inventory.body("a", "source", "qso", "q0", "source"),
      InventoryBodyArchiveUnavailable,
    );
    await new Promise((resolve) => setTimeout(resolve, 5100));
    const replayOnly: typeof fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/v1/sync");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.meta.sync.qsos.cursor, undefined);
      return Response.json({
        account: { uuid: "source" },
        operations: [],
        qsos: [record],
        meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
      });
    };
    assert.deepEqual(await stepInventoryBodyReplay(f.store, replayOnly), {
      kind: "complete",
      restored: 1,
    });
    assert.deepEqual(
      await intake.snapshot("a", "source", "sync"),
      normalCursor,
    );
    assert.deepEqual(
      await f.inventory.body("a", "source", "qso", "q0", "source"),
      original,
    );
    assert.equal((await storage())[1].cold, 0);
  } finally {
    await runtime.mf.dispose();
  }
});
