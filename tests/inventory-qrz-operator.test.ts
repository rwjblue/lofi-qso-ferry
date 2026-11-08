import assert from "node:assert/strict";
import test from "node:test";
import { adifStationCallsign } from "../src/adif.ts";
import { InventoryProjections } from "../src/inventory-projections.ts";
import { receiptFixture } from "./inventory-receipt-fixtures.ts";

test("ADIF operator fallback preserves explicit station fields and does not mutate input", () => {
  const record = { OPERATOR: "N1RWJ" };
  assert.equal(adifStationCallsign(record), "N1RWJ");
  assert.deepEqual(record, { OPERATOR: "N1RWJ" });
  assert.equal(
    adifStationCallsign({ ...record, STATION_CALLSIGN: "W1AW" }),
    "W1AW",
  );
  assert.equal(adifStationCallsign({ ...record, STATION_CALLSIGN: "" }), "");
  assert.equal(
    adifStationCallsign({ ...record, STATION_CALLSIGN: null }),
    undefined,
  );
  assert.equal(adifStationCallsign({}), undefined);
});

for (const provider of ["qrz", "lotw"] as const)
  test(`${provider} receipt projection preserves raw operator-only evidence`, async () => {
    const f = await receiptFixture(provider);
    try {
      const stream = await f.inventory.snapshot("a", "destination", "receipt");
      assert.ok(stream);
      const raw = {
        OPERATOR: "N1RWJ",
        CALL: "W1AW",
        QSO_DATE: "20261108",
        TIME_ON: "1230",
        BAND: "20m",
        MODE: "CW",
        APP_QRZLOG_LOGID: "3",
      };
      await f.inventory.publish(
        await f.inventory.prepare({
          stream,
          lease: f.lease,
          pageId: "operator-only",
          facet: "receipt",
          requestStartedAt: Date.now(),
          origin: "historical",
          nextResume: {},
          observations: [
            {
              family: "qso",
              subtype: "qso",
              key: "3",
              status: "active",
              order: null,
              revision: "r1",
              body: raw,
            },
          ],
        }),
      );
      const publisher = new InventoryProjections(f.store);
      await publisher.project("a", f.generation, "destination", ["3"]);
      const projected = await publisher.body(
        "a",
        f.generation,
        "destination",
        "3",
        "receipt",
      );
      assert.ok(projected);
      assert.equal(projected.body.state, provider === "qrz" ? "ready" : "held");
      assert.equal(
        projected.body.record.STATION_CALLSIGN,
        provider === "qrz" ? "N1RWJ" : undefined,
      );
      assert.equal(projected.body.record.OPERATOR, undefined);
      assert.deepEqual(
        await f.inventory.body("a", "destination", "qso", "3", "receipt"),
        raw,
      );
    } finally {
      await f.mf.dispose();
    }
  });
