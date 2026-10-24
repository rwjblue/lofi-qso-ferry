import assert from "node:assert/strict";
import test from "node:test";
import { contactReconciliationAdif } from "../src/delivery.ts";
import {
  HISTORY_READ_RETRY_DELAY,
  historyCandidates,
  historyInventoryGuard,
} from "../src/history-inventory.ts";
import { pendingContactBatch } from "../src/intake.ts";
import { classifyHistoricalAssociation } from "../src/reconcile.ts";
import { tick } from "../src/service.ts";
import { FIXTURE_NOW, schedulerFixture } from "./runtime-fixtures.ts";

test("twenty distinct history weeks share inventory while guarding wider source associations", async (t) => {
  const h = await schedulerFixture();
  try {
    h.qrzRecords[0].TIME_ON = "1200";
    h.lotwRecords[0].MY_GRIDSQUARE = "FN31";
    for (let index = 1; index < 20; index++) {
      const call = `K1MIX${index}`;
      const startAtMillis =
        Number(h.qso.startAtMillis) - index * 7 * 86_400_000;
      const qsoDate = new Date(startAtMillis)
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "");
      h.changes.qsos.push({
        ...h.qso,
        uuid: `mixed-${index}`,
        operation: null,
        startAtMillis,
        their: { call },
        our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
        syncedAtMillis: 110 + index,
      });
      h.qrzRecords.push({
        ...h.qrzRecords[0],
        CALL: call,
        QSO_DATE: qsoDate,
        APP_QRZLOG_LOGID: String(500 + index),
      });
      h.lotwRecords.push({
        ...h.lotwRecords[0],
        CALL: call,
        QSO_DATE: qsoDate,
      });
    }
    // Populate source projections first, with unavailable synthetic destinations.
    // Priming below is outside the measured tick and uses only fixture responses.
    h.errors.qrz = true;
    h.errors.lotw = true;
    const first = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(first.contacts, 20);
    h.errors.qrz = false;
    h.errors.lotw = false;
    const source = (await h.store.connection("a", "source"))!;
    const destinations = (await h.store.connections("a")).filter(
      (connection) => connection.kind !== "lofi",
    );
    // The intentional first-read failures now hold their partitions until the
    // bounded retry is due; priming must honor that production scheduling rule.
    const primeAt = FIXTURE_NOW + HISTORY_READ_RETRY_DELAY;
    const batch = await pendingContactBatch(h.store, source, 20, primeAt);
    assert.equal(batch.contacts.length, 20);
    const expected = [];
    const fences: D1PreparedStatement[] = [];
    const warmAt = primeAt + 300_000;
    for (const contact of batch.contacts) {
      const record = contactReconciliationAdif(contact);
      for (const destination of destinations) {
        const input = {
          source,
          destination,
          qso: contact.id,
          generation: contact.generation,
          record,
        };
        const options = {
          fetcher: h.fetcher,
          now: primeAt,
          vendorNow: primeAt,
          priority: "live" as const,
        };
        let inventory = await historyCandidates(h.store, input, options);
        if (inventory.state === "pending")
          inventory = await historyCandidates(h.store, input, options);
        assert.equal(inventory.state, "ready");
        assert.equal(inventory.records.length, 1);
        assert.equal(inventory.records[0].CALL, record.CALL);
        assert.equal(inventory.records[0].QSO_DATE, record.QSO_DATE);
        assert(inventory.fence);
        const outcome = classifyHistoricalAssociation(
          record,
          inventory.records,
          {
            destination: destination.kind as "qrz" | "lotw",
            capturedGeneration: contact.generation,
            currentGeneration: contact.generation,
            readAccess: true,
            inventoryComplete: true,
            catchupComplete: true,
            freshCheckComplete: false,
            inventoryPositiveOnly: true,
            provenNewAfterCutover: false,
          },
        );
        assert.equal(outcome.state, "adopted_existing");
        const key = {
          tenant: source.tenant,
          source: source.id,
          qso: contact.id,
          destination: destination.id,
        };
        expected.push({ key, generation: contact.generation, outcome });
        const guard = historyInventoryGuard(key, inventory.fence, warmAt);
        fences.push(
          h.store.statement(`SELECT ${guard.sql} valid`, ...guard.params),
        );
      }
    }
    await h.store.db.batch([
      h.store.statement("UPDATE reconciliation_checks SET next_due_at=0"),
      h.store.statement("UPDATE reconciliation_work SET next_due_at=0"),
    ]);
    const before = { ...h.calls };
    const result = await tick(h.env, h.fetcher, warmAt);
    assert.equal(result.contacts, 20);
    assert.equal(result.errors, 0);
    assert.equal(result.exportsEnabled, false);
    assert(result.throughput);
    assert.equal(result.throughput.classifiedDestinations, 40);
    assert.equal(result.throughput.adoptedDestinations, 40);
    assert.equal(result.throughput.inventoryFetches, 0);
    assert.equal(result.throughput.inventoryCacheHits, 40);
    // Inventory remains shared. Each wider QRZ association additionally inspects
    // a bounded, indexed reverse cohort and rechecks it before the atomic commit.
    t.diagnostic(
      `mixed-week warm tick: ${result.throughput.reconciliationBatchCalls} cohort RPCs; ${result.throughput.database.calls} total RPCs; ${result.throughput.database.statements} statements`,
    );
    assert(result.throughput.reconciliationBatchCalls <= 220);
    assert.equal(h.calls.qrzReads, before.qrzReads);
    assert.equal(h.calls.lotwQueries, before.lotwQueries);
    for (const { key, generation, outcome } of expected) {
      const ledger = await h.store.ledger(key);
      assert.equal(ledger?.generation, generation);
      assert.equal(ledger?.state, outcome.state);
      assert.equal(ledger?.reason, outcome.reason);
    }
    for (const result of await h.store.db.batch<{ valid: number }>(fences))
      assert.equal(result.results[0].valid, 1);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(
      (
        await h.store
          .statement("SELECT count(*) n FROM historical_associations")
          .first<{ n: number }>()
      )?.n,
      20,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});
