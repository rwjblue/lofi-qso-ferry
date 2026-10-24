import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import { measuredDatabase } from "../src/database-metrics.ts";
import {
  backfillLotwOwnership,
  lookupLotwOwnership,
  lotwOwnershipSnapshotCurrent,
} from "../src/lotw-ownership.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import { canonical, sha256 } from "../src/security.ts";
import { type LedgerKey, Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";

const AT = Date.parse("2026-10-24T12:00:01Z");
const record = (changes: AdifRecord = {}): AdifRecord => ({
  STATION_CALLSIGN: "N0CALL",
  CALL: "W1AW",
  QSO_DATE: "20261024",
  TIME_ON: "120001",
  BAND: "20M",
  MODE: "FT8",
  ...changes,
});
async function fixture(t: TestContext, beforeMigration = false) {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const file of (await readdir(new URL("../migrations", import.meta.url)))
    .filter(
      (s) =>
        s.endsWith(".sql") &&
        s > "0001_foundation.sql" &&
        (!beforeMigration || s < "0035"),
    )
    .sort())
    await applyMigration(h.db, file);
  await seed(h.store);
  await destination(h.store, "signing", "station:N0CALL:291");
  return h;
}
async function destination(
  store: Store,
  id: string,
  remote: string,
  status = "active",
) {
  await store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a',?,'lotw',?,?,?,'v1',0)",
      id,
      remote,
      id,
      status,
    )
    .run();
}
async function owner(
  store: Store,
  qso = "q1",
  destination = "signing",
): Promise<LedgerKey> {
  const key = { tenant: "a", source: "source", qso, destination };
  await store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES(?,?,?,?, '1','source-hash',0,?)",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      AT,
    )
    .run();
  return key;
}
async function identity(
  store: Store,
  key: LedgerKey,
  raw = record(),
  mapped = true,
) {
  const value = canonicalLotwIdentity(raw),
    hash = await lotwRemoteIdentity(value);
  const id = `identity:${await sha256(canonical([key.source, key.qso]))}:${hash}`;
  await (
    await store.lotwIdentityStatement(
      key,
      { remoteId: hash, identity: value },
      "uncertain",
      AT,
      { sql: "1", params: [] },
    )
  ).run();
  if (mapped)
    await store
      .statement(
        "UPDATE ledger SET remote_id=? WHERE tenant=? AND source=? AND qso=? AND destination=?",
        hash,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      )
      .run();
  return { id, hash, value };
}
async function backfill(store: Store, passes = 3) {
  for (let i = 0; i < passes; i++) await backfillLotwOwnership(store, "a");
}
async function observed(store: Store, raw = record()) {
  const result = await lookupLotwOwnership(store, "a", raw);
  assert.equal(result.state, "observed", result.reason);
  assert.equal(result.authoritative, false);
  assert.equal(result.requiresWriteBridge, true);
  assert.ok(result.snapshot);
  return result;
}

test("migration bridges encrypted exact claims across inactive signing-only and query destinations", async (t) => {
  const h = await fixture(t, true),
    key = await owner(h.store);
  const original = await identity(h.store, key);
  await h.store
    .statement(
      "UPDATE connections SET status='revoked' WHERE tenant='a' AND id='signing'",
    )
    .run();
  await destination(h.store, "query", "query:operator");
  await applyMigration(h.db, "0035_lotw_ownership_evidence.sql");
  await backfill(h.store);
  const result = await observed(
    h.store,
    record({ TIME_ON: "1230", MODE: "DATA" }),
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].destination, "signing");
  assert.deepEqual(result.candidates[0].evidence.identity, original.value);
  assert.equal(result.candidates[0].evidence.identity.TIME_ON, "120001");
  assert.equal(result.candidates[0].evidence.remoteId, original.hash);
  assert.equal(
    (await observed(h.store, record({ STATION_CALLSIGN: "N0CALL/P" })))
      .candidates.length,
    0,
  );
  assert.equal(
    (await lookupLotwOwnership(h.store, "different-tenant", record())).state,
    "held",
  );
  assert.equal(
    await h.store.statement("SELECT COUNT(*) n FROM attempts").first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM historical_associations")
      .first("n"),
    0,
  );
});

test("competing owners remain distinct across aliases and copied evidence survives archival", async (t) => {
  const h = await fixture(t),
    first = await owner(h.store);
  await destination(h.store, "query", "query:operator");
  const second = await owner(h.store, "q2", "query");
  await identity(h.store, first);
  await identity(h.store, second, record({ TIME_ON: "120100", MODE: "RTTY" }));
  await backfill(h.store);
  const before = await observed(h.store);
  assert.equal(before.candidates.length, 2);
  await h.store
    .statement(
      "DELETE FROM private_data WHERE tenant='a' AND kind='lotw_identity'",
    )
    .run();
  await h.store
    .statement(
      "UPDATE ledger SET remote_id=NULL,state='source_deleted',source_hash='new' WHERE tenant='a'",
    )
    .run();
  assert.equal(
    await lotwOwnershipSnapshotCurrent(h.store, before.snapshot!),
    false,
  );
  const after = await observed(h.store);
  assert.equal(after.candidates.length, 2);
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    2,
  );
  await assert.rejects(
    h.store.statement("DELETE FROM lotw_ownership_evidence").run(),
    /retained LoTW/,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE lotw_ownership_evidence SET exact_hash=?",
        "x".repeat(43),
      )
      .run(),
    /immutable LoTW/,
  );
});

test("hash-only and malformed legacy evidence holds the entire tenant rather than current configured station", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  await identity(h.store, key);
  const other = await owner(h.store, "unknown");
  await h.store
    .statement(
      "INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES('a','signing','lotw',?,'source',?,?)",
      "x".repeat(43),
      other.qso,
      AT,
    )
    .run();
  await backfill(h.store);
  assert.equal(
    (
      await lookupLotwOwnership(
        h.store,
        "a",
        record({ STATION_CALLSIGN: "K1ABC" }),
      )
    ).reason,
    "coverage_incomplete",
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='held'",
      )
      .first("n"),
    1,
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM destination_identity_claims")
      .first("n"),
    2,
  );
});

test("revoked, expired, malformed, and orphan tuples are not silently omitted", async (t) => {
  const h = await fixture(t);
  for (const [i, cause] of [
    "revoked",
    "expired",
    "malformed",
    "orphan",
  ].entries()) {
    const key = await owner(h.store, `q${i}`),
      retained = await identity(
        h.store,
        key,
        record({ TIME_ON: `120${i}00` }),
        false,
      );
    if (cause === "revoked")
      await h.store
        .statement(
          "UPDATE private_data SET revoked_at=? WHERE kind='lotw_identity' AND id=?",
          AT,
          retained.id,
        )
        .run();
    if (cause === "expired")
      await h.store
        .statement(
          "UPDATE private_data SET expires_at=? WHERE kind='lotw_identity' AND id=?",
          AT,
          retained.id,
        )
        .run();
    if (cause === "malformed")
      await h.store
        .statement(
          "UPDATE private_data SET envelope='{}' WHERE kind='lotw_identity' AND id=?",
          retained.id,
        )
        .run();
    if (cause === "orphan")
      await h.store
        .statement(
          "UPDATE private_data SET id=? WHERE kind='lotw_identity' AND id=?",
          `identity:${"x".repeat(43)}:${retained.hash}`,
          retained.id,
        )
        .run();
  }
  await backfill(h.store);
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    0,
  );
});

test("old-style new tuple, claim, and mapping writes invalidate a previous registry snapshot", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  await identity(h.store, key);
  await backfill(h.store);
  const initial = await observed(h.store);
  await identity(h.store, key, record({ TIME_ON: "121000" }));
  assert.equal(
    await lotwOwnershipSnapshotCurrent(h.store, initial.snapshot!),
    false,
  );
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
  await backfill(h.store);
  assert.equal((await observed(h.store)).candidates.length, 2);
});

test("publication CAS rejects a replaced tuple and preserves pending evidence", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  const original = await identity(h.store, key);
  let raced = false;
  const db = Object.create(h.db) as D1Database;
  db.prepare = h.db.prepare.bind(h.db);
  db.batch = async (statements) => {
    // Owner hash batch is first; identity publication batch is second.
    if (!raced && statements.length === 2) {
      raced = true;
      await h.store
        .statement(
          "UPDATE private_data SET envelope='{}' WHERE kind='lotw_identity' AND id=?",
          original.id,
        )
        .run();
    }
    return h.db.batch(statements);
  };
  await backfillLotwOwnership(new Store(db, keys), "a");
  assert.equal(raced, true);
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    0,
  );
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
});

test("key rewrap preserves locality; losing a required decrypting key holds evidence", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  await identity(h.store, key);
  await backfill(h.store);
  const before = await observed(h.store);
  const rotated = new Store(h.db, { ...keys, active: "2" });
  await backfill(rotated);
  const after = await observed(rotated);
  assert.equal(before.snapshot!.keyId, after.snapshot!.keyId);
  assert.deepEqual(before.candidates, after.candidates);
  const missing = new Store(h.db, {
    active: "2",
    keys: { "2": keys.keys["2"] },
  });
  assert.equal(
    (await lookupLotwOwnership(missing, "a", record())).reason,
    "evidence_unavailable",
  );
});

test("owner and input passes are bounded and an overflowing lookup never returns partial candidates", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < 3; i++)
    await identity(
      h.store,
      await owner(h.store, `q${i}`),
      record({ TIME_ON: `120${i}00` }),
      false,
    );
  const pass = await backfillLotwOwnership(h.store, "a", { limit: 1 });
  assert.equal(pass.ownersHashed, 1);
  assert.equal(pass.examined, 1);
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
  await backfill(h.store);
  const overflow = await lookupLotwOwnership(h.store, "a", record(), {
    limit: 2,
  });
  assert.equal(overflow.reason, "candidate_bound");
  assert.deepEqual(overflow.candidates, []);
  const plans = (
    await h.store
      .statement(
        "EXPLAIN QUERY PLAN SELECT id FROM lotw_ownership_evidence INDEXED BY lotw_ownership_bucket WHERE tenant=? AND key_id=? AND bucket=?",
        "a",
        "k",
        "b",
      )
      .all<{ detail: string }>()
  ).results;
  assert.ok(plans.some((p) => /SEARCH.*lotw_ownership_bucket/.test(p.detail)));
  await assert.rejects(
    backfillLotwOwnership(h.store, "a", { limit: 101 }),
    /bound/,
  );
  await assert.rejects(
    lookupLotwOwnership(h.store, "a", record(), { limit: 129 }),
    /bound/,
  );
});

test("legacy attempts require original immutable identity and known state; missing artifacts remain opaque holds", async (t) => {
  const h = await database();
  t.after(() => h.mf.dispose());
  await seed(h.store);
  await destination(h.store, "signing", "station:N0CALL:291");
  const key = await owner(h.store);
  const raw = await identity(h.store, key);
  await h.store
    .statement(
      "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','legacy','source','q1','signing','1','missing','hash','v1',?,'source-hash')",
      AT,
    )
    .run();
  for (const file of (await readdir(new URL("../migrations", import.meta.url)))
    .filter((s) => s.endsWith(".sql") && s > "0001_foundation.sql")
    .sort())
    await applyMigration(h.db, file);
  await backfill(h.store);
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
  await h.store
    .statement(
      "INSERT INTO attempt_identity_claims(tenant,attempt,destination,vendor,identity_hash,source,qso) VALUES('a','legacy','signing','lotw',?,'source','q1')",
      raw.hash,
    )
    .run();
  await backfill(h.store);
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
    "an exact tuple alone does not repair missing attempt state",
  );
  await h.store
    .statement(
      "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','legacy','uncertain',0,?)",
      AT,
    )
    .run();
  let removed = false;
  const racedDb = interceptBatches(h.db, async (sql) => {
    if (
      !removed &&
      sql.some((query) => query.startsWith("WITH matching AS MATERIALIZED"))
    ) {
      removed = true;
      await h.store
        .statement(
          "DELETE FROM attempt_state WHERE tenant='a' AND attempt='legacy'",
        )
        .run();
    }
  });
  await backfillLotwOwnership(new Store(racedDb, keys), "a");
  assert.equal(removed, true);
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
  await h.store
    .statement(
      "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','legacy','uncertain',0,?)",
      AT,
    )
    .run();
  await backfill(h.store);
  assert.equal((await observed(h.store)).candidates.length, 1);
  const snapshot = (await observed(h.store)).snapshot!;
  await h.store
    .statement(
      "DELETE FROM attempt_state WHERE tenant='a' AND attempt='legacy'",
    )
    .run();
  assert.equal(await lotwOwnershipSnapshotCurrent(h.store, snapshot), false);
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
  assert.equal(
    await h.store.statement("SELECT COUNT(*) n FROM attempts").first("n"),
    1,
  );
});

test("failed atomic publication leaves neither a copied tuple nor covered input", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  await identity(h.store, key);
  await h.store
    .statement(
      "CREATE TRIGGER fail_publication BEFORE UPDATE OF status ON lotw_ownership_inputs WHEN NEW.status='covered' BEGIN SELECT RAISE(ABORT,'synthetic publication race'); END",
    )
    .run();
  await assert.rejects(
    backfillLotwOwnership(h.store, "a"),
    /synthetic publication race/,
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='covered'",
      )
      .first("n"),
    0,
  );
});

test("new input during comparison invalidates the observed snapshot without returning candidates", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  await identity(h.store, key);
  await backfill(h.store);
  const db = Object.create(h.db) as D1Database;
  db.prepare = h.db.prepare.bind(h.db);
  let raced = false;
  db.batch = async <T>(statements: D1PreparedStatement[]) => {
    const result = await h.db.batch<T>(statements);
    if (!raced) {
      raced = true;
      await h.store
        .statement(
          "INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES('a','signing','lotw',?,'source','q1',?)",
          "x".repeat(43),
          AT,
        )
        .run();
    }
    return result;
  };
  const result = await lookupLotwOwnership(new Store(db, keys), "a", record());
  assert.equal(result.reason, "scope_changed");
  assert.deepEqual(result.candidates, []);
});

test("oversized encrypted input is held without fetching or copying the body", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  const raw = await identity(h.store, key, record(), false);
  await h.store
    .statement(
      "UPDATE private_data SET envelope=CAST(zeroblob(?) AS TEXT) WHERE kind='lotw_identity' AND id=?",
      4 * 1024 * 1024 + 1,
      raw.id,
    )
    .run();
  const result = await backfillLotwOwnership(h.store, "a");
  assert.equal(result.covered, 0);
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    0,
  );
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
});

test("full lookup caps dense bucket reads before sorting and ignores unrelated buckets", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  await identity(h.store, key);
  await backfill(h.store);
  // Synthetic encrypted metadata density: no overflow body is decrypted or
  // returned. Reuse a real row's locality while preserving unique owner keys.
  let denseRows = 0;
  for (const [prefix, count, matching] of [
    ["near", 180, true],
    ["far", 1000, false],
  ] as const) {
    for (let offset = 0; offset < count; offset += 50)
      await h.db.batch(
        Array.from({ length: Math.min(50, count - offset) }, (_, i) =>
          h.store.statement(
            "INSERT INTO lotw_ownership_evidence(tenant,id,destination,source,qso,exact_hash,key_id,bucket,envelope,created_at) SELECT tenant,?,destination,source,?,exact_hash,key_id,CASE WHEN ? THEN bucket ELSE ? END,envelope,created_at FROM lotw_ownership_evidence WHERE id=(SELECT MIN(id) FROM lotw_ownership_evidence)",
            `${prefix}-${offset + i}`,
            `${prefix}-${offset + i}`,
            matching ? 1 : 0,
            `unrelated-${offset + i}`,
          ),
        ),
      );
    if (matching) {
      const meter = measuredDatabase(h.db);
      assert.equal(
        (
          await lookupLotwOwnership(
            new Store(meter.database, keys),
            "a",
            record(),
          )
        ).reason,
        "candidate_bound",
      );
      denseRows = meter.metrics.rowsRead;
    }
  }
  const meter = measuredDatabase(h.db);
  const sql: string[] = [];
  const db = Object.create(meter.database) as D1Database;
  db.prepare = (query) => {
    sql.push(query);
    return meter.database.prepare(query);
  };
  db.batch = meter.database.batch.bind(meter.database);
  const result = await lookupLotwOwnership(new Store(db, keys), "a", record());
  assert.equal(result.reason, "candidate_bound");
  assert.deepEqual(result.candidates, []);
  assert.ok(
    meter.metrics.rowsRead < 1500,
    `bounded rows read: ${meter.metrics.rowsRead}`,
  );
  assert.equal(
    meter.metrics.rowsRead,
    denseRows,
    "1,000 unrelated rows do not increase lookup reads",
  );
  const query = sql.find((text) =>
    text.startsWith("WITH bounded AS MATERIALIZED"),
  );
  assert.ok(query);
  const row = await h.store
    .statement(
      "SELECT key_id,bucket FROM lotw_ownership_evidence WHERE id NOT LIKE 'near-%' AND id NOT LIKE 'far-%' LIMIT 1",
    )
    .first<{ key_id: string; bucket: string }>();
  assert.ok(row);
  const plan = (
    await h.store
      .statement(
        `EXPLAIN QUERY PLAN ${query}`,
        JSON.stringify([row.bucket]),
        "a",
        row.key_id,
        129,
        4 * 1024 * 1024,
      )
      .all<{ detail: string }>()
  ).results;
  assert.ok(
    plan.some((p) =>
      /SEARCH e USING INDEX lotw_ownership_bucket \(tenant=\? AND key_id=\? AND bucket=\?\)/.test(
        p.detail,
      ),
    ),
  );
  const cappedEnd = plan.findIndex((p) => /SCAN bounded/.test(p.detail));
  assert.ok(cappedEnd > 0);
  assert.ok(
    !plan.slice(0, cappedEnd).some((p) => /TEMP B-TREE/.test(p.detail)),
    "no sort before materializing the capped bucket result",
  );
});

test("comparison uses one captured identity even if the caller changes it during a database await", async (t) => {
  const h = await fixture(t),
    key = await owner(h.store);
  await identity(h.store, key);
  await backfill(h.store);
  const supplied = record();
  const db = Object.create(h.db) as D1Database;
  db.prepare = h.db.prepare.bind(h.db);
  db.batch = async <T>(statements: D1PreparedStatement[]) => {
    const result = await h.db.batch<T>(statements);
    supplied.CALL = "K9XYZ";
    supplied.TIME_ON = "230000";
    return result;
  };
  const result = await lookupLotwOwnership(new Store(db, keys), "a", supplied);
  assert.equal(result.state, "observed", result.reason);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].evidence.identity.CALL, "W1AW");
});

test("bounded mixed backfill shares RPCs while preserving all exact tuples", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < 30; i++)
    await identity(
      h.store,
      await owner(h.store, `batch-${i}`),
      record({ TIME_ON: String(120000 + i) }),
    );
  const meter = measuredDatabase(h.db);
  const stats = await backfillLotwOwnership(
    new Store(meter.database, keys),
    "a",
  );
  assert.equal(stats.ownersHashed, 30);
  assert.equal(stats.examined, 90);
  assert.equal(stats.covered, 90);
  assert.equal(stats.authoritative, false);
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    30,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status!='covered'",
      )
      .first("n"),
    0,
  );
  assert.equal((await observed(h.store)).candidates.length, 30);
  assert.equal(
    meter.metrics.calls,
    11,
    "188 RPC baseline for the same 30-contact fixture",
  );
  assert.equal(
    meter.metrics.statements,
    188,
    "248 SQL baseline; nonidentity links are one statement",
  );
  t.diagnostic(
    JSON.stringify({
      calls: meter.metrics.calls,
      statements: meter.metrics.statements,
    }),
  );
});

function interceptBatches(
  raw: D1Database,
  before: (sql: string[]) => Promise<void> | void,
) {
  const sql = new WeakMap<D1PreparedStatement, string>();
  const db = Object.create(raw) as D1Database;
  db.prepare = (query) => {
    const statement = raw.prepare(query);
    sql.set(statement, query);
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => {
            const bound = target.bind(...values);
            sql.set(bound, query);
            return bound;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  db.batch = async <T>(statements: D1PreparedStatement[]) => {
    await before(statements.map((statement) => sql.get(statement) ?? ""));
    return raw.batch<T>(statements);
  };
  return db;
}

test("one hundred identity inputs retain bounded native batches and full tuple coverage", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < 100; i++)
    await identity(
      h.store,
      await owner(h.store, `chunk-${i}`),
      record({
        TIME_ON: `12${String(Math.floor(i / 60)).padStart(2, "0")}${String(i % 60).padStart(2, "0")}`,
      }),
      false,
    );
  const sizes: number[] = [];
  const db = interceptBatches(h.db, (sql) => {
    sizes.push(sql.length);
    assert.ok(sql.length <= 100);
  });
  const result = await backfillLotwOwnership(new Store(db, keys), "a");
  assert.equal(result.examined, 100);
  assert.equal(result.covered, 100);
  assert.equal(result.ownersHashed, 100);
  assert.equal(
    sizes.filter((n) => n === 100).length,
    4,
    "owner hashes, owner lookups, and two guarded publication chunks",
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    100,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status!='covered'",
      )
      .first("n"),
    0,
  );
});

test("failure in a later identity rolls back earlier publications in the same native batch", async (t) => {
  const h = await fixture(t);
  const first = await identity(
    h.store,
    await owner(h.store, "atomic-first"),
    record(),
    false,
  );
  await identity(
    h.store,
    await owner(h.store, "atomic-second"),
    record({ TIME_ON: "120002" }),
    false,
  );
  const ids = (
    await h.store
      .statement(
        "SELECT reference FROM lotw_ownership_inputs WHERE kind='identity' ORDER BY reference",
      )
      .all<{ reference: string }>()
  ).results;
  assert.equal(ids.length, 2);
  assert.ok(first.id);
  await h.store
    .statement(
      `CREATE TRIGGER fail_second_identity BEFORE UPDATE OF status ON lotw_ownership_inputs WHEN NEW.status='covered' AND NEW.reference='${ids[1].reference}' BEGIN SELECT RAISE(ABORT,'synthetic second identity failure'); END`,
    )
    .run();
  await assert.rejects(
    backfillLotwOwnership(h.store, "a"),
    /synthetic second identity failure/,
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='covered'",
      )
      .first("n"),
    0,
  );
});

test("nonidentity native links retain input version CAS after lookup and publication", async (t) => {
  const h = await fixture(t);
  await identity(h.store, await owner(h.store));
  let raced = false;
  const db = interceptBatches(h.db, async (sql) => {
    if (
      !raced &&
      sql.some((q) => q.startsWith("WITH matching AS MATERIALIZED"))
    ) {
      raced = true;
      await h.store
        .statement(
          "UPDATE lotw_ownership_inputs SET version=version+1,checked_at=0 WHERE kind='mapping'",
        )
        .run();
    }
  });
  const result = await backfillLotwOwnership(new Store(db, keys), "a");
  assert.equal(raced, true);
  assert.equal(result.covered, 2);
  const mapping = await h.store
    .statement(
      "SELECT status,checked_at FROM lotw_ownership_inputs WHERE kind='mapping'",
    )
    .first<{ status: string; checked_at: number }>();
  assert.deepEqual(mapping, { status: "pending", checked_at: 0 });
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
  assert.equal((await backfillLotwOwnership(h.store, "a")).covered, 1);
  assert.equal((await observed(h.store)).candidates.length, 1);
});

test("registry key change rejects the whole captured identity publication batch", async (t) => {
  const h = await fixture(t);
  await identity(h.store, await owner(h.store));
  let raced = false;
  const db = interceptBatches(h.db, async (sql) => {
    if (
      !raced &&
      sql.some((q) => q.startsWith("INSERT INTO lotw_ownership_evidence"))
    ) {
      raced = true;
      await h.store
        .statement(
          "UPDATE lotw_ownership_state SET key_id=? WHERE tenant='a'",
          "x".repeat(43),
        )
        .run();
    }
  });
  await assert.rejects(
    backfillLotwOwnership(new Store(db, keys), "a"),
    /LoTW ownership key changed/,
  );
  assert.equal(raced, true);
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='covered'",
      )
      .first("n"),
    0,
  );
});

test("an unavailable stable index secret never starts owner or evidence publication", async (t) => {
  const h = await fixture(t);
  await identity(h.store, await owner(h.store));
  await h.store
    .statement(
      "UPDATE source_historical_state SET key_envelope='{}',clock=clock+1 WHERE tenant='a'",
    )
    .run();
  const result = await backfillLotwOwnership(h.store, "a");
  assert.equal(result.reason, "key_unavailable");
  assert.equal(result.ownersHashed, 0);
  assert.equal(result.examined, 0);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_owners WHERE owner_hash IS NOT NULL",
      )
      .first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    0,
  );
});

test("a later failed publication chunk preserves only prior fully committed chunks", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < 60; i++)
    await identity(
      h.store,
      await owner(h.store, `partial-${i}`),
      record({ TIME_ON: `1200${String(i).padStart(2, "0")}` }),
      false,
    );
  const rows = (
    await h.store
      .statement(
        "SELECT reference FROM lotw_ownership_inputs WHERE kind='identity' ORDER BY reference",
      )
      .all<{ reference: string }>()
  ).results;
  await h.store
    .statement(
      `CREATE TRIGGER fail_later_chunk BEFORE UPDATE OF status ON lotw_ownership_inputs WHEN NEW.status='covered' AND NEW.reference='${rows[55].reference}' BEGIN SELECT RAISE(ABORT,'synthetic later chunk failure'); END`,
    )
    .run();
  await assert.rejects(
    backfillLotwOwnership(h.store, "a"),
    /synthetic later chunk failure/,
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    50,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='covered'",
      )
      .first("n"),
    50,
  );
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", record())).reason,
    "coverage_incomplete",
  );
  await h.store.statement("DROP TRIGGER fail_later_chunk").run();
  const remaining = await backfillLotwOwnership(h.store, "a");
  assert.equal(remaining.covered, 10);
  assert.equal((await observed(h.store)).candidates.length, 60);
});

test("an unknown publication acknowledgement is thrown without a second native submission", async (t) => {
  const h = await fixture(t);
  await identity(h.store, await owner(h.store), record(), false);
  const sql: string[] = [];
  let publications = 0;
  const db = interceptBatches(h.db, (queries) => {
    sql.splice(0, sql.length, ...queries);
  });
  const batch = db.batch.bind(db);
  db.batch = async <T>(statements: D1PreparedStatement[]) => {
    const result = await batch<T>(statements);
    if (
      sql.some((query) =>
        query.startsWith("INSERT INTO lotw_ownership_evidence"),
      )
    ) {
      publications++;
      throw Error("synthetic lost acknowledgement");
    }
    return result;
  };
  await assert.rejects(
    backfillLotwOwnership(new Store(db, keys), "a"),
    /synthetic lost acknowledgement/,
  );
  assert.equal(publications, 1);
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_ownership_evidence")
      .first("n"),
    1,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='covered'",
      )
      .first("n"),
    1,
  );
});
