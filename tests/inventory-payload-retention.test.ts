import assert from "node:assert/strict";
import test from "node:test";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { qrzInventoryObservations } from "../src/inventory-observations.ts";
import { collectInventoryPayloads } from "../src/inventory-payload-retention.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("retirement is atomic with the page and only collects due unpinned bodies", async (t) => {
  const f = await database();
  t.after(() => f.mf.dispose());
  await applyAdditionalMigrations(f.db);
  const ingestion = new InventoryIngestion(f.store);

  async function book(tenant: string, count: number) {
    await seed(f.store, tenant);
    await ingestion.initialize(
      {
        tenant,
        scope: "book",
        connection: "destination",
        provider: "qrz",
        logicalIdentity: "destination",
        adapterBinding: "test-v1",
        ordering: "serialized",
      },
      "receipt",
      "book-v1",
    );
    const lease = await f.store.claim(
      tenant,
      "inventory:book",
      Date.now(),
      90_000,
    );
    assert.ok(lease);
    return async (downloaded: string) => {
      const stream = await ingestion.snapshot(tenant, "book", "receipt");
      assert.ok(stream);
      return ingestion.prepare({
        pageId: crypto.randomUUID(),
        stream,
        lease,
        requestStartedAt: Date.now(),
        facet: "receipt",
        origin: "historical",
        nextResume: { after: stream.version + 1 },
        observations: await qrzInventoryObservations(
          Array.from({ length: count }, (_, i) => ({
            APP_QRZLOG_LOGID: String(i + 1),
            QRZCOM_QSO_DOWNLOAD_DATE: downloaded,
          })),
        ),
      });
    };
  }
  const prepare = await book("a", 257);
  const other = await book("locked", 1);
  const earliest = "20261108";
  const latest = "20261109";
  await ingestion.publish(await prepare(earliest));
  await ingestion.publish(await other(earliest));
  await ingestion.publish(await prepare(earliest));
  const counts = () =>
    f.db
      .prepare(`SELECT (SELECT count(*) FROM inventory_payloads) AS bodies,
      (SELECT count(*) FROM inventory_payload_retirements) AS queued`)
      .first();
  assert.deepEqual(await counts(), { bodies: 258, queued: 0 });

  const changed = await prepare(latest);
  await f.db
    .prepare(`CREATE TRIGGER fixture_page_fails BEFORE UPDATE OF state ON ingestion_pages
    WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'fixture page failed'); END`)
    .run();
  await assert.rejects(ingestion.publish(changed), /fixture page failed/);
  assert.deepEqual(await counts(), { bodies: 258, queued: 0 });
  await f.db.prepare("DROP TRIGGER fixture_page_fails").run();
  const earliestRetirement = Date.now() + 7 * 86_400_000;
  await ingestion.publish(changed);
  await ingestion.publish(await other(latest));
  assert.deepEqual(await counts(), { bodies: 516, queued: 258 });
  assert.ok(
    (await f.db
      .prepare(
        "SELECT min(eligible_at) AS due FROM inventory_payload_retirements",
      )
      .first<number>("due"))! >= earliestRetirement,
  );
  assert.equal(await collectInventoryPayloads(f.store), 0);
  await assert.rejects(
    f.db
      .prepare(
        "DELETE FROM inventory_payloads WHERE payload_id=(SELECT payload_id FROM inventory_payload_retirements LIMIT 1)",
      )
      .run(),
    /inventory payload retained/,
  );

  // Age the local fixture queue without changing the production clock.
  await f.db
    .prepare(
      "UPDATE inventory_payload_retirements SET eligible_at=CASE tenant WHEN 'locked' THEN 1 ELSE 2 END",
    )
    .run();
  await f.db
    .prepare("UPDATE accounts SET status='restore_locked' WHERE id='locked'")
    .run();
  await f.db
    .prepare(`CREATE TRIGGER fixture_collection_fails BEFORE DELETE ON inventory_payloads
    WHEN (SELECT count(*) FROM inventory_payloads)<516
    BEGIN SELECT RAISE(ABORT,'fixture collection failed'); END`)
    .run();
  await assert.rejects(
    collectInventoryPayloads(f.store),
    /fixture collection failed/,
  );
  assert.deepEqual(await counts(), { bodies: 516, queued: 258 });
  await f.db.prepare("DROP TRIGGER fixture_collection_fails").run();

  assert.equal(await collectInventoryPayloads(f.store), 256);
  assert.equal(await collectInventoryPayloads(f.store), 1);
  assert.equal(await collectInventoryPayloads(f.store), 0);
  assert.deepEqual(await counts(), { bodies: 259, queued: 1 });
  assert.equal(
    await f.db
      .prepare("SELECT tenant FROM inventory_payload_retirements")
      .first("tenant"),
    "locked",
  );
  assert.deepEqual(await ingestion.body("a", "book", "qso", "1", "receipt"), {
    APP_QRZLOG_LOGID: "1",
    QRZCOM_QSO_DOWNLOAD_DATE: latest,
  });
  assert.equal((await ingestion.recover(changed))?.recovered, true);
  assert.equal((await ingestion.snapshot("a", "book", "receipt"))?.version, 3);
});
