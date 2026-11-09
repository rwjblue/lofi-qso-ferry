import assert from "node:assert/strict";
import { test } from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import {
  inventoryLotwConfirmation,
  pollInventoryLotwConfirmations,
} from "../src/inventory-lotw-confirmations.ts";
import { lotwInventoryObservations } from "../src/inventory-observations.ts";
import { lotwRemoteIdentity } from "../src/reconcile.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const target = {
  tenant: "a",
  scope: "lotw",
  selection: {
    startDate: "2026-10-22",
    endDate: "2026-10-23",
    stationCallsign: "W1AW",
    confirmedSince: "2026-10-24 01:00:00",
  },
};
const stamp = "2026-10-25 01:00:00";
const receipt = {
  STATION_CALLSIGN: "W1AW",
  CALL: "K1ABC",
  QSO_DATE: "20261022",
  TIME_ON: "123456",
  BAND: "20m",
  MODE: "FT8",
  QSL_RCVD: "N",
  MY_GRIDSQUARE: "FN31",
};
const confirmation = { ...receipt, QSL_RCVD: "Y", APP_LOTW_RXQSL: stamp };
function report(records: AdifRecord[]) {
  const count = String(records.length);
  const through = records[0]?.APP_LOTW_RXQSL;
  return new Response(
    `<PROGRAMID:4>LoTW<APP_LoTW_NUMREC:${count.length}>${count}${through ? `<APP_LoTW_LASTQSL:19>${through}` : ""}<EOH>${records.map(serializeAdifRecord).join("\n")}<APP_LoTW_EOF>`,
  );
}

async function fixture() {
  const f = await database();
  try {
    await seed(f.store);
    for (const migration of [
      "0009_vendor_requests.sql",
      "0039_inventory_ingestion.sql",
      "0040_inventory_runs.sql",
      "0118_inventory_lotw_confirmations.sql",
    ])
      await applyMigration(f.db, migration);
    await f.db.batch([
      f.db.prepare(
        `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at)
         VALUES('a','lotw','lotw','lotw','LoTW','active','v1','{"readAccess":true}',0)`,
      ),
    ]);
    await (
      await f.store.putPrivate("a", "lotw", "v1", "credential", {
        query: { username: "fixture", password: "fixture" },
      })
    ).run();
    const inventory = new InventoryIngestion(f.store);
    await inventory.initialize(
      {
        tenant: "a",
        scope: "lotw",
        connection: "lotw",
        provider: "lotw",
        logicalIdentity: "lotw",
        adapterBinding: "fixture-v1",
        ordering: "serialized",
      },
      "receipts",
      "receipt-v1",
    );
    return {
      ...f,
      inventory,
      async acceptReceipt(body: AdifRecord) {
        const stream = await inventory.snapshot("a", "lotw", "receipts");
        const lease = await f.store.claim("a", "inventory:lotw");
        assert.ok(stream && lease);
        try {
          const observations = await lotwInventoryObservations([body]);
          await inventory.publish(
            await inventory.prepare({
              pageId: crypto.randomUUID(),
              stream,
              lease,
              requestStartedAt: Date.now(),
              origin: "historical",
              facet: "receipt",
              observations,
              nextResume: {},
            }),
          );
          return observations[0].key;
        } finally {
          await f.store.release(lease);
        }
      },
      receiptState: async () =>
        (
          await f.db.batch([
            f.db.prepare("SELECT * FROM inventory_scopes"),
            f.db.prepare(
              "SELECT * FROM inventory_streams WHERE stream_id='receipts'",
            ),
            f.db.prepare("SELECT * FROM inventory_record_facets"),
            f.db.prepare("SELECT * FROM inventory_coverage"),
            f.db.prepare("SELECT * FROM inventory_partition_membership"),
            f.db.prepare("SELECT * FROM inventory_work"),
            f.db.prepare("SELECT * FROM private_data"),
          ])
        ).map((result) => result.results),
    };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}

test("QSL pages persist inclusive progress and resolve only one known receipt variant", async () => {
  const f = await fixture();
  try {
    const identity = await lotwRemoteIdentity(receipt);
    const resolve = () =>
      inventoryLotwConfirmation(f.store, "a", "lotw", identity);
    const poll = (rows: AdifRecord[], lower = stamp) =>
      pollInventoryLotwConfirmations(f.store, target, async (input) => {
        const { searchParams } = new URL(String(input));
        assert.equal(searchParams.get("qso_qsl"), "yes");
        assert.equal(searchParams.get("qso_qslsince"), lower);
        assert.equal(searchParams.get("qso_qsorxsince"), null);
        return report(rows);
      });
    const before = await f.receiptState();
    const first = await poll([confirmation], target.selection.confirmedSince);
    assert.equal(first.state, "complete");
    assert.equal(first.added, 1);
    assert.equal(first.confirmedThrough, stamp);
    assert.deepEqual(await f.receiptState(), before);
    assert.equal((await resolve()).state, "missing_receipt");

    const receiptKey = await f.acceptReceipt(receipt);
    const correlated = await resolve();
    assert.equal(correlated.state, "confirmed");
    assert.equal(correlated.receipt, receiptKey);
    assert.deepEqual(correlated.record, confirmation);
    const receiptState = await f.receiptState();
    const replay = await poll([confirmation]);
    assert.equal(replay.state, "complete");
    assert.equal(replay.added, 0);
    assert.deepEqual(await resolve(), correlated);
    const empty = await poll([]);
    assert.equal(empty.state, "complete");
    assert.equal(empty.confirmedThrough, stamp);
    const narrower = await pollInventoryLotwConfirmations(
      f.store,
      {
        ...target,
        selection: { ...target.selection, workedCallsign: receipt.CALL },
      },
      async (input) => {
        const { searchParams } = new URL(String(input));
        assert.equal(searchParams.get("qso_callsign"), receipt.CALL);
        assert.equal(
          searchParams.get("qso_qslsince"),
          target.selection.confirmedSince,
        );
        return report([confirmation]);
      },
    );
    assert.equal(narrower.state, "complete");
    assert.notEqual(narrower.streamId, first.streamId);
    assert.equal(narrower.added, 0);
    assert.deepEqual(await f.receiptState(), receiptState);
    assert.equal(
      (
        await f.inventory.body<AdifRecord>(
          "a",
          "lotw",
          "qso",
          receiptKey,
          "receipt",
        )
      )?.QSL_RCVD,
      "N",
    );

    const conflict = await poll([{ ...confirmation, MY_GRIDSQUARE: "FN32" }]);
    assert.equal(conflict.state, "complete");
    assert.equal(conflict.added, 1);
    assert.equal((await resolve()).state, "ambiguous_confirmation");
    await f.acceptReceipt({ ...receipt, MY_GRIDSQUARE: "FN32" });
    assert.equal((await resolve()).state, "ambiguous_receipt");
    const encrypted = await f.db
      .prepare("SELECT envelope FROM inventory_lotw_confirmations")
      .all();
    assert.ok(
      encrypted.results.every((row) => !JSON.stringify(row).includes("K1ABC")),
    );
  } finally {
    await f.mf.dispose();
  }
});

test("QSL publication fences credentials and rolls back a rejected batch", async () => {
  const f = await fixture();
  try {
    const poll = (fetcher: typeof fetch) =>
      pollInventoryLotwConfirmations(f.store, target, fetcher);
    const checkpoint = () =>
      f.db
        .prepare(
          "SELECT checkpoint_version,committed_checkpoint FROM inventory_streams WHERE stream_id LIKE 'lotw-confirmation-v1:%'",
        )
        .first();
    const count = () =>
      f.db
        .prepare("SELECT count(*) AS n FROM inventory_lotw_confirmations")
        .first();
    const first = await poll(async () => report([confirmation]));
    assert.equal(first.state, "complete");
    const saved = await checkpoint();
    const later = { ...confirmation, APP_LOTW_RXQSL: "2026-10-26 01:00:00" };
    await f.db
      .prepare(
        `CREATE TRIGGER fixture_qsl_failure BEFORE UPDATE OF checkpoint_version ON inventory_streams
       WHEN NEW.stream_id LIKE 'lotw-confirmation-v1:%'
       BEGIN SELECT RAISE(ABORT,'fixture checkpoint failure'); END`,
      )
      .run();
    await assert.rejects(
      poll(async () => report([later])),
      /fixture checkpoint failure/,
    );
    assert.deepEqual(await checkpoint(), saved);
    assert.deepEqual(await count(), { n: 1 });
    await f.db.prepare("DROP TRIGGER fixture_qsl_failure").run();
    await assert.rejects(
      poll(async () => {
        await f.db
          .prepare(
            "UPDATE connections SET credential_version='v2' WHERE id='lotw'",
          )
          .run();
        return report([later]);
      }),
      /inventory authority changed/,
    );
    assert.deepEqual(await checkpoint(), saved);
    assert.deepEqual(await count(), { n: 1 });
  } finally {
    await f.mf.dispose();
  }
});
