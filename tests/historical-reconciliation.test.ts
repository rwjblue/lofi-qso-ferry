import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  adoptHistory,
  classifyHistoricalAssociation,
  classifyHistory,
  comparableRemote,
  type ReconciliationEvidence,
  reconcileQrzAttempt,
} from "../src/reconcile.ts";
import { canonical, sha256 } from "../src/security.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const source: AdifRecord = {
  STATION_CALLSIGN: "W1AW/P",
  CALL: "K1ABC",
  QSO_DATE: "20261022",
  TIME_ON: "120137",
  BAND: "20M",
  MODE: "SSB",
  SUBMODE: "USB",
  FREQ: "14.250",
  MY_GRIDSQUARE: "FN31AA12",
  MY_DXCC: "291",
};
const remote: AdifRecord = {
  ...source,
  TIME_ON: "1215",
  MODE: "SSB",
  SUBMODE: "LSB",
  MY_GRIDSQUARE: "FN31",
  APP_QRZLOG_LOGID: "123",
  COMMENT: "Original remote narrative",
};
const evidence: ReconciliationEvidence = {
  destination: "qrz",
  capturedGeneration: "captured",
  currentGeneration: "captured",
  readAccess: true,
  inventoryComplete: true,
  catchupComplete: true,
  freshCheckComplete: false,
  inventoryPositiveOnly: true,
};

test("wider historical classification preserves raw time, modes and grid and requires an association proof", () => {
  const local = structuredClone(source);
  const observed = structuredClone(remote);
  assert.equal(
    classifyHistory(local, [observed], evidence).state,
    "history_ambiguous",
  );
  const outcome = classifyHistoricalAssociation(local, [observed], evidence);
  assert.equal(outcome.state, "adopted_existing");
  assert.equal(outcome.associationOnly, true);
  assert.equal(outcome.associationProof, undefined);
  assert.equal(outcome.remote, observed);
  assert.deepEqual(local, source);
  assert.deepEqual(observed, remote);
  assert.equal(reconcileQrzAttempt(source, [observed]).state, "unresolved");
});

test("all forward competitors count before location detail filtering, including an exact identity", () => {
  const exact = { ...source, APP_QRZLOG_LOGID: "124" };
  const incompatible = { ...remote, MY_GRIDSQUARE: "EM00" };
  const result = classifyHistoricalAssociation(
    source,
    [exact, incompatible],
    evidence,
  );
  assert.equal(result.state, "history_ambiguous");
  assert.match(result.reason!, /Multiple historical candidates/);
  assert.equal(result.remote, undefined);
});

test("a unique historical identity still reports incompatible or missing operating location", () => {
  assert.equal(
    classifyHistoricalAssociation(
      source,
      [{ ...remote, MY_GRIDSQUARE: "EM00" }],
      evidence,
    ).state,
    "history_mismatch",
  );
  const { MY_GRIDSQUARE: _grid, ...missing } = remote;
  assert.equal(
    classifyHistoricalAssociation(source, [missing], evidence).state,
    "history_ambiguous",
  );
  for (const grid of ["FN", "FN31", "FN31AA", "FN31AA12"])
    assert.equal(
      classifyHistoricalAssociation(
        source,
        [{ ...remote, MY_GRIDSQUARE: grid }],
        evidence,
      ).state,
      "adopted_existing",
    );
});

test("published time matching crosses UTC dates and retains uncertainty at the window edge", () => {
  const local = { ...source, TIME_ON: "235959" };
  const nextDay = { ...remote, QSO_DATE: "20261023", TIME_ON: "0028" };
  assert.equal(
    classifyHistoricalAssociation(local, [nextDay], evidence).state,
    "adopted_existing",
  );
  const edge = { ...remote, TIME_ON: "1231" };
  assert.match(
    classifyHistoricalAssociation(source, [edge], evidence).reason!,
    /precision crosses/,
  );
  assert.notEqual(
    classifyHistoricalAssociation(
      source,
      [{ ...remote, TIME_ON: "1233" }],
      evidence,
    ).state,
    "adopted_existing",
  );
});

test("unknown relevant modes and missing LOGIDs cannot become historical adoptions", () => {
  assert.equal(
    classifyHistoricalAssociation(
      source,
      [{ ...remote, MODE: "UNKNOWN" }],
      evidence,
    ).state,
    "history_ambiguous",
  );
  const { APP_QRZLOG_LOGID: _id, ...missing } = remote;
  assert.match(
    classifyHistoricalAssociation(source, [missing], evidence).reason!,
    /LOGID/,
  );
  const unrelated = { ...remote, CALL: "K9XYZ", MODE: "UNKNOWN" };
  assert.equal(
    classifyHistoricalAssociation(source, [remote, unrelated], evidence).state,
    "adopted_existing",
  );
});

test("wider discovery preserves generation, coverage and read-access holds", () => {
  for (const change of [
    { currentGeneration: "different" },
    { inventoryComplete: false },
    { catchupComplete: false },
    { inventoryPositiveOnly: false },
  ])
    assert.equal(
      classifyHistoricalAssociation(source, [remote], {
        ...evidence,
        ...change,
      }).state,
      "inventory_pending",
    );
  assert.equal(
    classifyHistoricalAssociation(source, [remote], {
      ...evidence,
      readAccess: false,
    }).state,
    "historical_unverified",
  );
  assert.equal(
    classifyHistoricalAssociation(source, [], evidence).state,
    "inventory_pending",
  );
});

test("frequency differences remain visible after a unique historical match", () => {
  const outcome = classifyHistoricalAssociation(
    source,
    [{ ...remote, FREQ: "14.251" }],
    evidence,
  );
  assert.equal(outcome.state, "history_mismatch");
  assert.match(outcome.reason!, /frequency/);
  assert.equal(outcome.associationOnly, undefined);
});

test("wider adoption requires both comparison and inventory guards and creates no outbound claim", async () => {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    const key = await seed(h.store);
    await h.store.observe(key, "captured", "source-hash", 30);
    const outcome = classifyHistoricalAssociation(source, [remote], evidence);
    assert.equal(
      (
        await adoptHistory(h.store, key, "captured", outcome, 100, "baseline", {
          sql: "1",
          params: [],
        })
      ).reason,
      "historical_comparison_proof_required",
    );
    outcome.associationProof = {
      bookIdentity: "destination",
      commitGuard: () => ({ sql: "0", params: [] }),
    };
    assert.equal(
      (
        await adoptHistory(h.store, key, "captured", outcome, 100, "baseline", {
          sql: "1",
          params: [],
        })
      ).applied,
      false,
    );
    assert.equal((await h.store.ledger(key))?.remote_id, null);
    outcome.associationProof.commitGuard = () => ({ sql: "1", params: [] });
    assert.equal(
      (
        await adoptHistory(h.store, key, "captured", outcome, 100, "baseline", {
          sql: "0",
          params: [],
        })
      ).applied,
      false,
    );
    assert.equal(
      (
        await adoptHistory(h.store, key, "captured", outcome, 100, "baseline", {
          sql: "1",
          params: [],
        })
      ).applied,
      true,
    );
    const ledger = (await h.store.ledger(key))!;
    assert.equal(ledger.remote_id, remote.APP_QRZLOG_LOGID);
    assert.equal(ledger.baseline_hash, "baseline");
    assert.equal(ledger.source_hash, "baseline");
    assert.equal(ledger.narrative, "remote_preserved");
    assert.equal(
      ledger.remote_hash,
      await sha256(canonical(comparableRemote(remote))),
    );
    const counts = await h.store
      .statement(`SELECT
      (SELECT count(*) FROM historical_associations) AS associations,
      (SELECT count(*) FROM historical_remote_owners) AS owners,
      (SELECT count(*) FROM destination_identity_claims WHERE vendor='qrz') AS outbound,
      (SELECT count(*) FROM legacy_qrz_identity_reservations) AS legacy,
      (SELECT count(*) FROM attempts) AS attempts`)
      .first();
    assert.deepEqual(counts, {
      associations: 1,
      owners: 1,
      outbound: 0,
      legacy: 0,
      attempts: 0,
    });
  } finally {
    await h.mf.dispose();
  }
});

test("two wider source associations cannot acquire one retained QRZ LOGID", async () => {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    const key = await seed(h.store);
    const other = { ...key, qso: "second-source-contact" };
    await h.store.observe(key, "captured", "first", 30);
    await h.store.observe(other, "captured", "second", 30);
    const outcome = classifyHistoricalAssociation(source, [remote], evidence);
    outcome.associationProof = {
      bookIdentity: "destination",
      commitGuard: () => ({ sql: "1", params: [] }),
    };
    const guard = { sql: "1", params: [] };
    assert.equal(
      (
        await adoptHistory(
          h.store,
          key,
          "captured",
          outcome,
          100,
          "first",
          guard,
        )
      ).applied,
      true,
    );
    const conflict = await adoptHistory(
      h.store,
      other,
      "captured",
      outcome,
      101,
      "second",
      guard,
    );
    assert.equal(conflict.applied, false);
    assert.equal(conflict.reason, "remote_identity_claim_conflict");
    assert.equal((await h.store.ledger(key))?.state, "history_ambiguous");
    assert.equal((await h.store.ledger(other))?.state, "history_ambiguous");
    assert.equal((await h.store.ledger(other))?.remote_id, null);
    assert.equal(
      (
        await h.store
          .statement("SELECT count(*) n FROM historical_remote_owners")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT count(*) n FROM historical_associations")
          .first<{ n: number }>()
      )?.n,
      1,
    );
  } finally {
    await h.mf.dispose();
  }
});
