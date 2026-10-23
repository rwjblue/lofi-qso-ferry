import assert from "node:assert/strict";
import { tick } from "../src/service.ts";
import { schedulerFixture, FIXTURE_NOW } from "../tests/runtime-fixtures.ts";

// Synthetic vendors and local D1/workerd only. This measures request amplification,
// not production latency or the complete 100-account capacity workload.
const fixture = await schedulerFixture();
try {
  assert(fixture.qrzRecords[0].TIME_ON);
  fixture.qrzRecords[0].TIME_ON = fixture.qrzRecords[0].TIME_ON.slice(0, 4);
  fixture.lotwRecords[0].MY_GRIDSQUARE = "FN31";
  for (let index = 1; index < 20; index++) {
    const call = `K1SCALE${index}`;
    fixture.changes.qsos.push({
      ...fixture.qso,
      uuid: `scale-${index}`,
      operation: null,
      their: { call },
      our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
      syncedAtMillis: 110 + index,
    });
    fixture.qrzRecords.push({
      ...fixture.qrzRecords[0],
      CALL: call,
      APP_QRZLOG_LOGID: String(500 + index),
    });
    fixture.lotwRecords.push({ ...fixture.lotwRecords[0], CALL: call });
  }
  for (const [index, scenario] of ["cold", "warm"].entries()) {
    if (index) {
      await fixture.store.db.batch([
        fixture.store.statement(
          "UPDATE reconciliation_checks SET next_due_at=0",
        ),
        fixture.store.statement("UPDATE reconciliation_work SET next_due_at=0"),
      ]);
    }
    const result = await tick(
      fixture.env,
      fixture.fetcher,
      FIXTURE_NOW + index * 300000,
    );
    assert.equal(result.exportsEnabled, false);
    assert.equal(result.errors, 0);
    assert.equal(result.contacts, 20);
    assert(result.throughput);
    assert.equal(result.throughput.classifiedDestinations, 40);
    assert.equal(fixture.calls.qrzWrites, 0);
    assert.equal(fixture.calls.lotwUploads, 0);
    if (index) {
      assert.equal(result.throughput.inventoryFetches, 0);
      assert(result.throughput.reconciliationBatchCalls <= 30);
    }
    console.log(
      JSON.stringify({
        scenario,
        contacts: result.contacts,
        elapsedMs: result.elapsedMs,
        throughput: result.throughput,
      }),
    );
  }
} finally {
  await fixture.mf.dispose();
}
