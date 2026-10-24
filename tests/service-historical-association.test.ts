import assert from "node:assert/strict";
import test from "node:test";
import { tick } from "../src/service.ts";
import { FIXTURE_NOW, schedulerFixture } from "./runtime-fixtures.ts";

test("reconciliation checks reverse competitors around the remote time, not only the selected source time", async () => {
  const h = await schedulerFixture();
  try {
    h.changes.qsos.push({
      ...h.qso,
      uuid: "competing-source-uuid",
      operation: null,
      our: {
        stationCall: "W1AW",
        grid: "FN31AA",
        dxccCode: 291,
        cqZone: 5,
        ituZone: 8,
      },
      startAtMillis: Number(h.qso.startAtMillis) + 55 * 60_000,
      syncedAtMillis: 102,
    });
    h.qrzRecords[0].TIME_ON = "122959";
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 0);
    assert.equal(result.exportsEnabled, false);
    for (const qso of [h.qso.uuid, "competing-source-uuid"]) {
      const ledger = await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: String(qso),
        destination: "destination",
      });
      assert.equal(ledger?.state, "history_ambiguous");
      assert.match(ledger.reason!, /Multiple source contacts/);
      assert.equal(ledger.remote_id, null);
    }
    assert.equal(
      (
        await h.store
          .statement("SELECT count(*) n FROM historical_associations")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT count(*) n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});
