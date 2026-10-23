import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Work } from "../src/intake.ts";
import { contactAdif } from "../src/delivery.ts";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import {
  contactPriority,
  expireSource,
  observeContact,
  pendingContactBatch,
  pendingContacts,
  pollSource,
  rereadOperation,
} from "../src/intake.ts";
import {
  type LoFiCredentials,
  LoFiError,
  type SourceRecord,
} from "../src/lofi.ts";
import { purgeResolvedSource } from "../src/maintenance.ts";
import { sourceFingerprint } from "../src/projection.ts";
import { adoptHistory } from "../src/reconcile.ts";
import { seal } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { database, seed } from "./helpers.ts";

const at = 1792684800000;
const op: SourceRecord = {
  uuid: "op-1",
  stationCall: "N0CALL",
  grid: "FN31AA",
  syncedAtMillis: 100,
};
const qso: SourceRecord = {
  uuid: "qso-1",
  operation: "op-1",
  startAtMillis: at,
  freq: 14074,
  band: "20m",
  mode: "FT8",
  their: { call: "W1AW" },
  our: { dxccCode: 291 },
  syncedAtMillis: 101,
};
const loose: SourceRecord = {
  ...qso,
  uuid: "loose-1",
  operation: null,
  our: { stationCall: "N0CALL", grid: "FN42CC", dxccCode: 291 },
  syncedAtMillis: 102,
};
const boundary: SourceRecord = {
  uuid: "event-1",
  operation: "op-1",
  band: "event",
  startAtMillis: at,
  event: { event: "break", operation: { grid: "FN32BB" } },
  syncedAtMillis: 99,
};
const response = (operations: SourceRecord[], qsos: SourceRecord[], left = 0) =>
  new Response(
    JSON.stringify({
      account: { uuid: "account-1" },
      operations,
      qsos,
      meta: {
        operations: { records_left: 0 },
        qsos: {
          records_left: left,
          ...(left ? { next_cursor: "qso-page-2" } : {}),
        },
      },
    }),
  );
const operationResponse = (qsos: SourceRecord[], left = 0, next?: number) =>
  new Response(
    JSON.stringify({
      qsos,
      meta: {
        qsos: {
          records_left: left,
          ...(next ? { next_synced_until_millis: next } : {}),
        },
      },
    }),
  );
const fetcher =
  (
    handler: (url: URL, init?: RequestInit) => Promise<Response>,
  ): typeof fetch =>
  async (input, init) =>
    handler(new URL(String(input)), init);
async function setup() {
  const state = await database();
  const sql = (
    await Promise.all(
      [
        "0004_intake.sql",
        "0005_cutover.sql",
        "0009_vendor_requests.sql",
        "0010_source_priority.sql",
        "0018_reconciliation_work.sql",
        "0023_outbound_identity_claims.sql",
      ].map((file) =>
        readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
  let current = "";
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    const trigger = current.trimStart().startsWith("CREATE TRIGGER");
    if (
      line.trimEnd().endsWith(";") &&
      (!trigger ||
        line.trim() === "END;" ||
        line.trimStart().startsWith("CREATE TRIGGER"))
    ) {
      await state.db.prepare(current).run();
      current = "";
    }
  }
  const key = await seed(state.store);
  await (
    await state.store.putPrivate("a", "source", "v2", "credential", {
      key: "browser:fixture",
      secret: "fixture-secret",
      token: "fixture-token",
    })
  ).run();
  await state.store
    .statement(
      "UPDATE connections SET credential_version='v2',config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "account-1" }),
    )
    .run();
  const source = await state.store.connection("a", "source");
  assert.ok(source);
  return { ...state, key, source, now: Date.now() };
}
async function work(
  state: Awaited<ReturnType<typeof setup>>,
  id: string,
  kind = "qso",
) {
  return state.store
    .statement(
      "SELECT * FROM source_work WHERE tenant='a' AND source='source' AND id=? AND kind=?",
      id,
      kind,
    )
    .first<Work & { processed_at: number }>();
}

function countedStore(store: Store) {
  const calls: { method: string; sql?: string; statements?: number }[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const statement = (value: D1PreparedStatement, sql: string) => {
    const wrapped = new Proxy(value, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), sql);
        const member = Reflect.get(target, property);
        if (["first", "all", "run", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            calls.push({ method: String(property), sql });
            return member.apply(target, args);
          };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    originals.set(wrapped, value);
    return wrapped;
  };
  const db = new Proxy(store.db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => statement(target.prepare(sql), sql);
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          calls.push({ method: "batch", statements: statements.length });
          return target.batch(statements.map((s) => originals.get(s) ?? s));
        };
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { store: new Store(db, store.keys), calls };
}

test("observations batch fresh contact metadata and preserve adopted narrative across tenants", async (t) => {
  const { store, source, now, mf } = await setup();
  t.after(() => mf.dispose());
  await seed(store, "other");
  const foreignKey = {
    tenant: "other",
    source: source.id,
    qso: String(loose.uuid),
    destination: "destination",
  };
  await store.observe(foreignKey, "foreign", "foreign-hash", 55, false, now);
  await store
    .statement(
      "UPDATE ledger SET narrative='remote_preserved' WHERE tenant='other'",
    )
    .run();
  await store
    .statement("UPDATE accounts SET quiet_minutes=25 WHERE id='a'")
    .run();
  await store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','lotw','lotw','lotw-1','LoTW','active',0)",
    )
    .run();
  const destinations = (await store.connections("a")).filter(
    (destination) => destination.kind !== "lofi",
  );
  await pollSource(
    store,
    source,
    async () => response([], [{ ...loose, notes: "original source notes" }]),
    now,
  );
  const [first] = await pendingContacts(store, source, 40, now + 1);
  assert.ok(first);
  const measured = countedStore(store);
  await observeContact(measured.store, source, first, now + 1, destinations);
  assert.equal(measured.calls.length, 2);
  assert.deepEqual(
    measured.calls.map((call) => call.method),
    ["batch", "batch"],
  );
  assert.equal(measured.calls[0].statements, 2);
  t.diagnostic(
    `observing two routed destinations: ${measured.calls.length} database calls`,
  );
  for (const destination of destinations) {
    const ledger = await store.ledger({
      ...foreignKey,
      tenant: "a",
      destination: destination.id,
    });
    assert.equal(ledger?.due_at, now + 1 + 25 * 60_000);
    assert.equal(
      ledger?.source_hash,
      await sourceFingerprint(first, destination.kind as "qrz" | "lotw"),
    );
  }
  const adoptedHash = await sourceFingerprint(first, "qrz", true);
  await store
    .statement(
      "UPDATE ledger SET state='adopted_existing',narrative='remote_preserved',source_hash=?,baseline_hash=?,remote_id='adopted-logid',provenance='adopted' WHERE tenant='a' AND destination='destination'",
      adoptedHash,
      adoptedHash,
    )
    .run();
  await pollSource(
    store,
    source,
    async () =>
      response(
        [],
        [{ ...loose, notes: "edited source notes", syncedAtMillis: 200 }],
      ),
    now + 2,
  );
  const [edited] = await pendingContacts(store, source, 40, now + 3);
  assert.ok(edited);
  measured.calls.length = 0;
  await observeContact(measured.store, source, edited, now + 3, destinations);
  assert.equal(measured.calls.length, 2);
  const adopted = await store.ledger({ ...foreignKey, tenant: "a" });
  assert.equal(adopted?.state, "adopted_existing");
  assert.equal(adopted?.source_hash, adoptedHash);
  assert.equal(adopted?.baseline_hash, adoptedHash);
  assert.equal(adopted?.remote_id, "adopted-logid");
  assert.equal(adopted?.narrative, "remote_preserved");
  assert.equal((await store.ledger(foreignKey))?.source_hash, "foreign-hash");
  measured.calls.length = 0;
  await observeContact(measured.store, source, edited, now + 4);
  assert.equal(measured.calls.length, 2);
  assert.equal(measured.calls[0].statements, 3);
  t.diagnostic(
    `observing discovered destinations: ${measured.calls.length} database calls`,
  );
});

test("synced test operations remain retained without destination work while ordinary contacts continue", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const operations = ["N0CALL/test", "T", "N0CALL, W1AW/T"].map(
    (stationCall, index) => ({
      ...op,
      uuid: `test-op-${index}`,
      stationCall,
    }),
  );
  const tests = operations.map((operation, index) => ({
    ...qso,
    uuid: `test-qso-${index}`,
    operation: operation.uuid,
  }));
  await pollSource(
    store,
    source,
    async () => response(operations, [...tests, loose]),
    now,
  );
  for (let index = 0; index < operations.length; index++)
    await rereadOperation(
      store,
      source,
      fetcher(async (url) =>
        operationResponse(
          tests.filter(
            (record) =>
              url.pathname === `/v1/operations/${record.operation}/qsos`,
          ),
        ),
      ),
      now + index + 1,
    );
  const contacts = await pendingContacts(store, source, 40, now + 4);
  assert.deepEqual(
    contacts.map((contact) => contact.id),
    ["loose-1"],
  );
  await observeContact(store, source, contacts[0], now + 4);
  for (const record of tests) {
    const saved = await work(state, record.uuid);
    assert.equal(saved?.state, "test");
    assert.equal(saved?.reason, "test_operation_not_exported");
    assert.deepEqual(
      await store.private("a", "source", saved!.private_id, "source"),
      record,
    );
    assert.equal(await store.ledger({ ...state.key, qso: record.uuid }), null);
    assert.equal(
      (
        await store
          .statement(
            "SELECT eligible FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso=?",
            record.uuid,
          )
          .first<{ eligible: number }>()
      )?.eligible,
      0,
    );
  }
  assert.equal(
    (await store.ledger({ ...state.key, qso: "loose-1" }))?.state,
    "inventory_pending",
  );
  assert.equal(
    (
      await store
        .statement("SELECT COUNT(*) n FROM attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await store
        .statement("SELECT COUNT(*) n FROM projection_guards")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  await store
    .statement("UPDATE source_work SET expires_at=? WHERE state='test'", now)
    .run();
  await expireSource(store, now + 5);
  for (const record of tests) {
    assert.equal((await work(state, record.uuid))?.state, "test");
    assert.equal(
      (await work(state, record.uuid))?.reason,
      "test_operation_not_exported",
    );
  }
  assert.equal(
    await store
      .statement("SELECT * FROM cursors WHERE stream='repair'")
      .first(),
    null,
    "expired test payloads do not schedule repeated recovery reads",
  );
});

test("operation test edits cancel only prepared attempts and restoration preserves history", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const states = ["prepared", "submitted", "uncertain", "delivered"] as const;
  const records = states.map((status) => ({ ...qso, uuid: `qso-${status}` }));
  await pollSource(store, source, async () => response([op], records), now);
  await rereadOperation(
    store,
    source,
    async () => operationResponse(records),
    now + 1,
  );
  const contacts = await pendingContacts(store, source, 40, now + 2);
  assert.equal(contacts.length, records.length);
  const template = await store.saveTemplate("a", "destination", {
    fields: { COMMENT: "Preserved template" },
  });
  const attempts = new Map<string, string>();
  for (const contact of contacts) {
    const status = contact.id.slice("qso-".length);
    const key = { ...state.key, qso: contact.id };
    await observeContact(store, source, contact, now + 2);
    await store
      .statement(
        "UPDATE ledger SET state='live_new',due_at=? WHERE tenant='a' AND qso=?",
        now,
        contact.id,
      )
      .run();
    const attempt = await store.stage(
      key,
      contact.generation,
      { immutable: status },
      "v1",
      template,
      now + 2,
    );
    attempts.set(status, attempt);
    await store
      .statement(
        "UPDATE attempt_state SET state=?,reason='original evidence' WHERE tenant='a' AND attempt=?",
        status,
        attempt,
      )
      .run();
    await store
      .statement(
        "UPDATE ledger SET state=?,baseline_hash=source_hash,remote_hash=?,sent_hash=?,remote_id=?,provenance='created' WHERE tenant='a' AND qso=?",
        status === "prepared" ? "live_new" : status,
        `remote-${status}`,
        `sent-${status}`,
        status === "prepared" ? null : `remote-id-${status}`,
        contact.id,
      )
      .run();
  }
  const before = (
    await store.statement("SELECT * FROM ledger ORDER BY qso").all()
  ).results;
  const immutable = (
    await store.statement("SELECT * FROM attempts ORDER BY id").all()
  ).results;
  await pollSource(
    store,
    source,
    async () =>
      response(
        [{ ...op, stationCall: "N0CALL/TEST", syncedAtMillis: 200 }],
        [],
      ),
    now + 3,
  );
  await rereadOperation(
    store,
    source,
    async () => operationResponse(records),
    now + 4,
  );
  assert.deepEqual(await pendingContacts(store, source, 40, now + 5), []);
  assert.deepEqual(
    (await store.statement("SELECT * FROM ledger ORDER BY qso").all()).results,
    before.map((row) => ({ ...row, reason: "test_operation_not_exported" })),
    "classification preserves ledger state, baselines, mappings and template bindings",
  );
  assert.deepEqual(
    (await store.statement("SELECT * FROM attempts ORDER BY id").all()).results,
    immutable,
  );
  for (const status of states) {
    assert.equal((await work(state, `qso-${status}`))?.state, "test");
    const attempt = attempts.get(status)!;
    const saved = await store
      .statement(
        "SELECT state,reason FROM attempt_state WHERE attempt=?",
        attempt,
      )
      .first<{ state: string; reason: string }>();
    assert.deepEqual(saved, {
      state: status === "prepared" ? "cancelled" : status,
      reason:
        status === "prepared"
          ? "test_operation_not_exported"
          : "original evidence",
    });
    assert.deepEqual(
      await store.private("a", "destination", attempt, "outbox"),
      { immutable: status },
    );
  }
  assert.equal(
    (
      await store
        .statement(
          "SELECT COUNT(*) n FROM attempt_events WHERE state='cancelled' AND reason='test_operation_not_exported'",
        )
        .first<{ n: number }>()
    )?.n,
    1,
  );
  await pollSource(
    store,
    source,
    async () => response([{ ...op, syncedAtMillis: 300 }], []),
    now + 6,
  );
  assert.equal((await work(state, "qso-prepared"))?.state, "pending");
  await rereadOperation(
    store,
    source,
    async () => operationResponse(records),
    now + 7,
  );
  const restored = await pendingContacts(store, source, 40, now + 8);
  assert.equal(restored.length, records.length);
  for (const contact of restored) {
    assert.equal((await work(state, contact.id))?.reason, null);
    await observeContact(store, source, contact, now + 8);
    const ledger = await store.ledger({ ...state.key, qso: contact.id });
    assert.notEqual(ledger?.reason, "test_operation_not_exported");
    assert.equal(ledger?.baseline_hash, ledger?.source_hash);
    assert.equal(ledger?.template_version, template);
  }
  const replacement = restored.find(
    (contact) => contact.id === "qso-prepared",
  )!;
  await store.stage(
    { ...state.key, qso: replacement.id },
    replacement.generation,
    { immutable: "restored" },
    "v1",
    template,
    now + 9,
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT state FROM attempt_state WHERE attempt=?",
          attempts.get("prepared")!,
        )
        .first<{ state: string }>()
    )?.state,
    "cancelled",
    "restoration creates new work without reviving a cancelled payload",
  );
});

test("test segments suppress only their interval and a segment edit releases retained contacts", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const records = [-1000, 0, 1000].map((offset, index) => ({
    ...qso,
    uuid: `segment-qso-${index}`,
    startAtMillis: at + offset,
  }));
  const testBoundary = {
    ...boundary,
    event: { event: "break", operation: { stationCall: "N0CALL/T" } },
  };
  const reset = {
    ...boundary,
    uuid: "event-reset",
    startAtMillis: at + 1000,
  };
  await pollSource(
    store,
    source,
    async () => response([op], [...records, testBoundary, reset]),
    now,
  );
  await rereadOperation(
    store,
    source,
    async () => operationResponse([...records, testBoundary, reset]),
    now + 1,
  );
  const contacts = await pendingContacts(store, source, 40, now + 2);
  assert.deepEqual(contacts.map((contact) => contact.id).sort(), [
    "segment-qso-0",
    "segment-qso-2",
  ]);
  assert.equal((await work(state, "segment-qso-1"))?.state, "test");
  for (const contact of contacts)
    await observeContact(store, source, contact, now + 2);
  assert.equal(
    await store.ledger({ ...state.key, qso: "segment-qso-1" }),
    null,
  );
  const normalBoundary = { ...boundary, syncedAtMillis: 200 };
  await pollSource(
    store,
    source,
    async () => response([], [normalBoundary]),
    now + 3,
  );
  await rereadOperation(
    store,
    source,
    async () => operationResponse([...records, normalBoundary, reset]),
    now + 4,
  );
  const restored = await pendingContacts(store, source, 40, now + 5);
  assert.equal(restored.length, records.length);
  const released = restored.find((contact) => contact.id === "segment-qso-1");
  assert.ok(released);
  assert.equal(released.stationCall, "N0CALL");
  assert.equal((await work(state, released.id))?.reason, null);
  await observeContact(store, source, released, now + 5);
  assert.equal(
    (await store.ledger({ ...state.key, qso: released.id }))?.state,
    "inventory_pending",
  );
});

test("test classification migration revisits retained holds and guards already classified attempts", async (t) => {
  const state = await setup();
  const { store, db, source, now, mf } = state;
  t.after(() => mf.dispose());
  const ids = [
    "waiting",
    "blocked",
    "expired-work",
    "expired-payload",
    "revoked-payload",
    "event",
    "deleted",
    "test",
    "processed",
  ];
  await pollSource(
    store,
    source,
    async () =>
      response(
        [],
        ids.map((uuid) => ({
          ...loose,
          uuid,
          our: { call: "N0CALL/T" },
        })),
      ),
    now,
  );
  await store
    .statement(
      "UPDATE source_work SET state='blocked',reason='old projection hold' WHERE kind='qso'",
    )
    .run();
  for (const [id, column, value] of [
    ["waiting", "state", "waiting"],
    ["expired-work", "expires_at", now - 60_000],
    ["event", "is_event", 1],
    ["deleted", "deleted", 1],
    ["test", "state", "test"],
    ["processed", "state", "processed"],
  ] as const)
    await store
      .statement(`UPDATE source_work SET ${column}=? WHERE id=?`, value, id)
      .run();
  for (const [id, column] of [
    ["expired-payload", "expires_at"],
    ["revoked-payload", "revoked_at"],
  ] as const)
    await store
      .statement(
        `UPDATE private_data SET ${column}=? WHERE kind='source' AND id=(SELECT private_id FROM source_work WHERE id=?)`,
        now - 60_000,
        id,
      )
      .run();
  await store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,baseline_hash,state,due_at,updated_at) VALUES('a','source','test','destination','generation','source-hash','baseline-hash','live_new',0,0)",
    )
    .run();
  await store
    .statement(
      "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','prior-test-attempt','source','test','destination','generation','frozen-payload','payload-hash','v1',0,'source-hash')",
    )
    .run();
  await store
    .statement(
      "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','prior-test-attempt','prepared',0,0)",
    )
    .run();
  const before = (
    await store.statement("SELECT * FROM source_work ORDER BY id").all()
  ).results;
  const evidence = async () =>
    Promise.all(
      ["ledger", "attempts", "attempt_state", "cursors", "private_data"].map(
        (table) => store.statement(`SELECT * FROM ${table}`).all(),
      ),
    ).then((results) => results.map((result) => result.results));
  const evidenceBefore = await evidence();
  const migration = await readFile(
    new URL("../migrations/0020_test_operation_review.sql", import.meta.url),
    "utf8",
  );
  const triggerAt = migration.indexOf("CREATE TRIGGER");
  assert(triggerAt > 0);
  await db.prepare(migration.slice(0, triggerAt)).run();
  await db.prepare(migration.slice(triggerAt)).run();
  assert.deepEqual(
    (await store.statement("SELECT * FROM source_work ORDER BY id").all())
      .results,
    before.map((row) =>
      ["waiting", "blocked"].includes(String(row.id))
        ? { ...row, state: "pending", reason: "test_classification_pending" }
        : row,
    ),
  );
  assert.deepEqual(await evidence(), evidenceBefore);
  await assert.rejects(
    store
      .statement(
        "UPDATE attempt_state SET state='dispatching' WHERE attempt='prior-test-attempt'",
      )
      .run(),
    /test operation cannot be exported/,
  );
  assert.deepEqual(await pendingContacts(store, source, 40, now + 1), []);
  for (const id of ["waiting", "blocked"]) {
    assert.equal((await work(state, id))?.state, "test");
    assert.equal(
      (await work(state, id))?.reason,
      "test_operation_not_exported",
    );
    assert.equal(await store.ledger({ ...state.key, qso: id }), null);
  }
});

test("page intake RPC counts stay bounded for polling, replay and operation rereads", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const contacts = Array.from({ length: 25 }, (_, index) => ({
    ...qso,
    uuid: `bulk-${index}`,
    syncedAtMillis: 200 + index,
  }));
  const measured = countedStore(store);
  await pollSource(
    measured.store,
    source,
    async () => response([op], contacts),
    now,
  );
  t.diagnostic(`polling 26 records: ${measured.calls.length} database calls`);
  assert.equal(measured.calls.length, 7);
  assert.equal(measured.calls.filter((c) => c.method === "batch").length, 1);
  assert.equal(
    measured.calls.filter((c) => c.sql?.includes("AS replay_resolved")).length,
    1,
  );
  measured.calls.length = 0;
  await rereadOperation(
    measured.store,
    source,
    async () => operationResponse(contacts),
    now + 1,
  );
  t.diagnostic(`rereading 25 records: ${measured.calls.length} database calls`);
  assert.equal(measured.calls.length, 9);
  await store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,baseline_hash,state,due_at,updated_at) SELECT tenant,source,id,'destination','g','h','h','adopted_existing',0,0 FROM source_work WHERE kind='qso'",
    )
    .run();
  await purgeResolvedSource(store);
  measured.calls.length = 0;
  await pollSource(
    measured.store,
    source,
    async () => response([], contacts),
    now + 2,
    "repair",
  );
  t.diagnostic(
    `replaying 25 resolved records: ${measured.calls.length} database calls`,
  );
  assert.equal(measured.calls.length, 7);
  assert.equal(
    (
      await store
        .statement(
          "SELECT COUNT(*) n FROM private_data WHERE kind='source' AND id IN(SELECT private_id FROM source_work WHERE kind='qso')",
        )
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT COUNT(*) n FROM source_work WHERE kind='qso' AND state='archived'",
        )
        .first<{ n: number }>()
    )?.n,
    25,
  );
});

test("retained batches share operation ciphertext reads while preserving complete projection", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const contacts = Array.from({ length: 20 }, (_, index) => ({
    ...qso,
    uuid: `bulk-${index}`,
  }));
  await pollSource(
    store,
    source,
    async () => response([op], [...contacts, boundary]),
    now,
  );
  await rereadOperation(
    store,
    source,
    async () => operationResponse([...contacts, boundary]),
    now + 1,
  );
  await store
    .statement("UPDATE source_work SET state='context' WHERE is_event=1")
    .run();
  const measured = countedStore(store);
  const batch = await pendingContactBatch(
    measured.store,
    source,
    20,
    now + 2,
    "background",
    undefined,
    now + 2,
  );
  t.diagnostic(
    `projecting 20 contacts with a shared operation/event: ${measured.calls.length} database calls`,
  );
  assert.equal(batch.selected, 20);
  assert.equal(batch.contacts.length, 20);
  assert(batch.contacts.every((contact) => contact.grid === "FN32BB"));
  assert.equal(
    batch.contacts[0].reconciliationVersion,
    (
      await store
        .statement(
          "SELECT version FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso=?",
          batch.contacts[0].id,
        )
        .first<{ version: number }>()
    )?.version,
  );
  assert.equal(measured.calls.length, 5);
  assert.equal(measured.calls.filter((c) => c.method === "batch").length, 1);
  assert.equal(
    measured.calls.filter((c) =>
      c.sql?.includes("FROM source_work w LEFT JOIN private_data"),
    ).length,
    1,
  );
});

test("full forward pages prefetch bounded metadata without splitting the atomic checkpoint", async (t) => {
  const { store, source, now, mf } = await setup();
  t.after(() => mf.dispose());
  await pollSource(store, source, async () => response([], []), now);
  const operations = Array.from({ length: 100 }, (_, index) => ({
    ...op,
    uuid: `operation-${index}`,
  }));
  const contacts = Array.from({ length: 100 }, (_, index) => ({
    ...loose,
    uuid: `contact-${index}`,
  }));
  const measured = countedStore(store);
  const result = await pollSource(
    measured.store,
    source,
    async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.meta.sync.operations.limit, 100);
      assert.equal(request.meta.sync.qsos.limit, 100);
      return response(operations, contacts);
    },
    now + 1,
  );
  assert.equal(result.records, 200);
  assert.equal(measured.calls.length, 8);
  assert.equal(
    measured.calls.filter((c) => c.sql?.includes("AS replay_resolved")).length,
    2,
  );
  const checkpoints = measured.calls.filter((c) => c.method === "batch");
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].statements, 1307);
  t.diagnostic(
    `full forward page: ${measured.calls.length} database calls, ${checkpoints[0].statements} statements in one atomic checkpoint`,
  );
});

test("prefetched replay resolution remains destination specific and rejects unresolved attempts", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  await pollSource(store, source, async () => response([], [loose]), now);
  await store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,created_at) VALUES('a','other','qrz','other','other',0)",
    )
    .run();
  for (const [destination, ledgerState] of [
    ["destination", "adopted_existing"],
    ["other", "history_mismatch"],
  ])
    await store
      .statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,baseline_hash,state,due_at,updated_at) VALUES('a','source','loose-1',?,'g','h','h',?,0,0)",
        destination,
        ledgerState,
      )
      .run();
  const expire = async () => {
    await store
      .statement(
        "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND kind='source'",
      )
      .run();
    await store
      .statement(
        "UPDATE source_work SET expires_at=0,state='archived' WHERE tenant='a' AND source='source' AND id='loose-1'",
      )
      .run();
  };
  await expire();
  await pollSource(
    store,
    source,
    async () => response([], [loose]),
    now + 1,
    "rescan:destination",
  );
  assert.equal(
    (await work(state, "loose-1"))?.state,
    "archived",
    "the resolved destination can skip a replay despite another destination's hold",
  );
  await pollSource(
    store,
    source,
    async () => response([], [loose]),
    now + 2,
    "repair",
  );
  assert.equal(
    (await work(state, "loose-1"))?.state,
    "pending",
    "global repair requires every destination to be resolved",
  );
  await expire();
  await store
    .statement(
      "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','unresolved','source','loose-1','destination','g','payload','hash','v1',0,'h')",
    )
    .run();
  await store
    .statement(
      "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','unresolved','uncertain',0,0)",
    )
    .run();
  await store
    .statement("DELETE FROM cursors WHERE stream='rescan:destination'")
    .run();
  await pollSource(
    store,
    source,
    async () => response([], [loose]),
    now + 3,
    "rescan:destination",
  );
  assert.equal(
    (await work(state, "loose-1"))?.state,
    "pending",
    "an unresolved attempt prevents skipping the resolved ledger's replay",
  );
});

test("page metadata overlays repeated UUIDs in server order and keeps record kinds independent", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const first = { ...loose, uuid: "same", syncedAtMillis: 100 };
  const newer = { ...first, notes: "current", syncedAtMillis: 300 };
  await pollSource(
    store,
    source,
    async () =>
      response(
        [{ ...op, uuid: "same" }],
        [
          first,
          { ...first, syncedAtMillis: 200 },
          newer,
          { ...first, syncedAtMillis: 250 },
          newer,
        ],
      ),
    now,
  );
  const saved = await work(state, "same");
  assert.equal(saved?.synced_at, 300);
  assert.equal(
    (
      await store.private<SourceRecord>(
        "a",
        "source",
        saved!.private_id,
        "source",
      )
    )?.notes,
    "current",
  );
  assert.equal((await work(state, "same", "operation"))?.synced_at, 100);
  assert.equal(
    (
      await store
        .statement("SELECT COUNT(*) n FROM private_data WHERE kind='source'")
        .first<{ n: number }>()
    )?.n,
    2,
  );
  assert.equal(
    (
      await store
        .statement("SELECT COUNT(*) n FROM source_births WHERE qso='same'")
        .first<{ n: number }>()
    )?.n,
    1,
  );
  const cursor = await store
    .statement("SELECT * FROM cursors WHERE stream='sync'")
    .first();
  await assert.rejects(
    pollSource(
      store,
      source,
      async () =>
        response(
          [],
          [
            { ...loose, uuid: "rollback", syncedAtMillis: 400 },
            { ...newer, notes: "conflicting tie" },
          ],
        ),
      now + 1,
    ),
    /conflicting_server_timestamp/,
  );
  assert.equal(await work(state, "rollback"), null);
  assert.deepEqual(
    await store.statement("SELECT * FROM cursors WHERE stream='sync'").first(),
    cursor,
  );
  assert.equal(
    (
      await store
        .statement("SELECT COUNT(*) n FROM private_data WHERE kind='source'")
        .first<{ n: number }>()
    )?.n,
    2,
  );
});

test("prefetched source versions still reject a concurrent writer atomically", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  await pollSource(store, source, async () => response([], [loose]), now);
  const cursor = await store
    .statement("SELECT * FROM cursors WHERE stream='sync'")
    .first();
  const raced = new Store(store.db, store.keys);
  const putPrivate = raced.putPrivate.bind(raced);
  let changed = false;
  raced.putPrivate = async (...args: Parameters<Store["putPrivate"]>) => {
    if (!changed && args[3] === "source") {
      changed = true;
      await store
        .statement(
          "UPDATE source_work SET revision='concurrent',synced_at=999 WHERE tenant='a' AND source='source' AND id='loose-1' AND kind='qso'",
        )
        .run();
    }
    return putPrivate(...args);
  };
  await assert.rejects(
    pollSource(
      raced,
      source,
      async () =>
        response(
          [],
          [{ ...loose, notes: "stale change", syncedAtMillis: 200 }],
        ),
      now + 1,
    ),
    /source row changed/,
  );
  assert.equal((await work(state, "loose-1"))?.revision, "concurrent");
  assert.deepEqual(
    await store.statement("SELECT * FROM cursors WHERE stream='sync'").first(),
    cursor,
  );
  assert.equal(
    (
      await store
        .statement("SELECT COUNT(*) n FROM private_data WHERE kind='source'")
        .first<{ n: number }>()
    )?.n,
    1,
  );
  assert.equal(
    (
      await store
        .statement("SELECT COUNT(*) n FROM source_write_guards")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("page metadata and retained ciphertext reads stay tenant scoped for colliding IDs", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  await seed(store, "b");
  const foreign = { ...loose, our: { stationCall: "K2ABC", grid: "FN33DD" } };
  await (
    await store.putPrivate(
      "b",
      "source",
      "collision",
      "source",
      foreign,
      now + 60000,
    )
  ).run();
  await store
    .statement(
      "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,expires_at,synced_at) VALUES('b','source','loose-1','qso',NULL,'collision','foreign',?,999)",
      now + 60000,
    )
    .run();
  await pollSource(store, source, async () => response([], [loose]), now);
  const local = await work(state, "loose-1");
  const body = await store.private("a", "source", local!.private_id, "source");
  await (
    await store.putPrivate(
      "a",
      "source",
      "collision",
      "source",
      body,
      now + 60000,
    )
  ).run();
  await store
    .statement(
      "UPDATE source_work SET private_id='collision' WHERE tenant='a' AND id='loose-1'",
    )
    .run();
  const contacts = await pendingContacts(store, source, 20, now + 1);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].stationCall, "N0CALL");
  assert.equal(contacts[0].grid, "FN42CC");
  assert.equal(
    (
      await store
        .statement("SELECT revision FROM source_work WHERE tenant='b'")
        .first<{ revision: string }>()
    )?.revision,
    "foreign",
  );
});

test("general-log station migration requeues only retained projection holds without changing export evidence", async (t) => {
  const state = await setup();
  const { store, db, source, now, mf } = state;
  t.after(() => mf.dispose());
  const ids = [
    "eligible",
    "operation",
    "other-kind",
    "event",
    "deleted",
    "other-reason",
    "other-state",
    "expired-work",
    "expired-payload",
    "revoked-payload",
    "missing-payload",
    "wrong-payload-kind",
    "wrong-payload-connection",
  ];
  await pollSource(
    store,
    source,
    async () =>
      response(
        [],
        ids.map((uuid) => ({
          ...loose,
          uuid,
          our: { call: "N0CALL", grid: "FN42CC" },
        })),
      ),
    now,
  );
  await store
    .statement(
      "UPDATE source_work SET state='blocked',reason='missing_or_ambiguous_station_call',processed_at=? WHERE kind='qso'",
      now,
    )
    .run();
  for (const [id, column, value] of [
    ["operation", "operation_id", "op-1"],
    ["other-kind", "kind", "operation"],
    ["event", "is_event", 1],
    ["deleted", "deleted", 1],
    ["other-reason", "reason", "no_matching_destination"],
    ["other-state", "state", "waiting"],
    ["expired-work", "expires_at", now - 60_000],
  ] as const)
    await store
      .statement(`UPDATE source_work SET ${column}=? WHERE id=?`, value, id)
      .run();
  for (const [id, column, value] of [
    ["expired-payload", "expires_at", now - 60_000],
    ["revoked-payload", "revoked_at", now - 60_000],
    ["wrong-payload-kind", "kind", "outbox"],
    ["wrong-payload-connection", "connection", "destination"],
  ] as const)
    await store
      .statement(
        `UPDATE private_data SET ${column}=? WHERE kind='source' AND id=(SELECT private_id FROM source_work WHERE id=?)`,
        value,
        id,
      )
      .run();
  await store
    .statement(
      "DELETE FROM private_data WHERE kind='source' AND id=(SELECT private_id FROM source_work WHERE id='missing-payload')",
    )
    .run();
  const rows = () =>
    store.statement("SELECT * FROM source_work ORDER BY id").all<Work>();
  const evidence = async () =>
    Promise.all(
      ["cursors", "private_data", "ledger", "attempts", "source_cutovers"].map(
        (table) => store.statement(`SELECT * FROM ${table}`).all(),
      ),
    ).then((results) => results.map((result) => result.results));
  const before = (await rows()).results;
  const evidenceBefore = await evidence();
  const migration = await readFile(
    new URL(
      "../migrations/0016_reproject_general_log_station.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await db.prepare(migration).run();
  assert.deepEqual(
    (await rows()).results,
    before.map((row) =>
      row.id === "eligible" ? { ...row, state: "pending", reason: null } : row,
    ),
  );
  assert.deepEqual(await evidence(), evidenceBefore);
  const batch = await pendingContactBatch(
    store,
    source,
    1,
    now + 1,
    undefined,
    "eligible",
  );
  assert.equal(batch.selected, 1);
  assert.equal(batch.contacts[0]?.stationCall, "N0CALL");
  assert.equal(batch.contacts[0]?.operationId, null);
  assert.equal(
    (await store.statement("SELECT * FROM ledger").all()).results.length,
    0,
  );
  assert.equal(
    (await store.statement("SELECT * FROM attempts").all()).results.length,
    0,
  );
});

test("source polls and operation rereads retain renewed bearers after success, failure and budget deferral", async (t) => {
  for (const read of ["poll", "reread"] as const) {
    for (const outcome of ["success", "failure", "deferred"] as const) {
      await t.test(`${read}: ${outcome}`, async (t) => {
        const { store, source, now, mf } = await setup();
        t.after(() => mf.dispose());
        await pollSource(store, source, async () => response([op], []), now);
        const at = Math.floor(now / 300_000) * 300_000 + 300_001;
        if (outcome === "deferred")
          await store
            .statement(
              "UPDATE vendor_requests SET window_start=?,requests=2,background_requests=2 WHERE vendor='lofi'",
              at - 1,
            )
            .run();
        const requests: string[] = [];
        const pages = fetcher(async (url, init) => {
          requests.push(url.pathname);
          if (url.pathname === "/v1/client")
            return Response.json({ token: "renewed-token" });
          if (
            new Headers(init?.headers).get("Authorization") !==
            "Bearer renewed-token"
          )
            return new Response(null, { status: 401 });
          if (outcome === "failure") return new Response(null, { status: 500 });
          assert.notEqual(
            outcome,
            "deferred",
            "budget must reject the retry before I/O",
          );
          return read === "poll" ? response([], []) : operationResponse([qso]);
        });
        const run = (fetcher: typeof fetch, time: number) =>
          read === "poll"
            ? pollSource(store, source, fetcher, time, "rescan:fixture")
            : rereadOperation(store, source, fetcher, time);
        const before = await store
          .statement(
            "SELECT cursor FROM cursors WHERE stream=?",
            read === "poll" ? "rescan:fixture" : "reread:op-1",
          )
          .first();
        if (outcome === "success") await run(pages, at);
        else {
          await assert.rejects(run(pages, at), (error: unknown) =>
            outcome === "deferred"
              ? error instanceof VendorDeferredError && !error.requestSent
              : error instanceof LoFiError &&
                error.message === "vendor_http_error",
          );
          assert.deepEqual(
            await store
              .statement(
                "SELECT cursor FROM cursors WHERE stream=?",
                read === "poll" ? "rescan:fixture" : "reread:op-1",
              )
              .first(),
            before,
            "credential renewal cannot advance source coverage",
          );
        }
        assert.equal(requests.length, outcome === "deferred" ? 2 : 3);
        assert.equal(
          requests.filter((path) => path === "/v1/client").length,
          1,
        );
        const saved = await store.private<LoFiCredentials>(
          "a",
          "source",
          "v2",
          "credential",
        );
        assert.deepEqual(saved, {
          key: "browser:fixture",
          secret: "fixture-secret",
          token: "renewed-token",
        });
        assert.equal(
          (await store.connection("a", "source"))?.credential_version,
          "v2",
        );
        await store
          .statement("DELETE FROM cursors WHERE stream='rescan:fixture'")
          .run();
        await store
          .statement(
            "UPDATE source_work SET state='pending' WHERE kind='operation'",
          )
          .run();
        let subsequentRequests = 0;
        await run(
          fetcher(async (url, init) => {
            subsequentRequests++;
            assert.notEqual(url.pathname, "/v1/client");
            assert.equal(
              new Headers(init?.headers).get("Authorization"),
              "Bearer renewed-token",
            );
            return read === "poll"
              ? response([], [])
              : operationResponse([qso]);
          }),
          at + 300_000,
        );
        assert.equal(
          subsequentRequests,
          1,
          "the next page must reuse the saved bearer",
        );
      });
    }
  }
});

test("late source renewals cannot overwrite a concurrent renewal or changed connection credentials", async (t) => {
  for (const read of ["poll", "reread"] as const) {
    for (const change of [
      "renewal",
      "replacement",
      "revocation",
      "identity",
    ] as const) {
      await t.test(`${read}: ${change}`, async (t) => {
        const { store, source, now, mf } = await setup();
        t.after(() => mf.dispose());
        await pollSource(store, source, async () => response([op], []), now);
        const at = Math.floor(now / 300_000) * 300_000 + 300_001;
        const readEnvelope = () =>
          store
            .statement(
              "SELECT envelope FROM private_data WHERE tenant='a' AND connection='source' AND id='v2' AND kind='credential'",
            )
            .first<{ envelope: string }>();
        let expected = (await readEnvelope())!.envelope;
        const pages = fetcher(async (url, init) => {
          if (url.pathname === "/v1/client")
            return Response.json({ token: "late-token" });
          if (
            new Headers(init?.headers).get("Authorization") !==
            "Bearer late-token"
          )
            return new Response(null, { status: 401 });
          if (change === "renewal") {
            expected = JSON.stringify(
              await seal(
                {
                  key: "browser:fixture",
                  secret: "fixture-secret",
                  token: "concurrent-token",
                },
                {
                  tenant: "a",
                  connection: "source",
                  id: "v2",
                  kind: "credential",
                  purpose: "storage",
                },
                store.keys,
              ),
            );
            await store
              .statement(
                "UPDATE private_data SET envelope=? WHERE tenant='a' AND connection='source' AND id='v2' AND kind='credential'",
                expected,
              )
              .run();
          } else if (change === "replacement") {
            await (
              await store.putPrivate("a", "source", "v3", "credential", {
                key: "browser:replacement",
                secret: "new-secret",
                token: "new-token",
              })
            ).run();
            await store
              .statement(
                "UPDATE connections SET credential_version='v3' WHERE tenant='a' AND id='source'",
              )
              .run();
          } else if (change === "revocation") {
            await store
              .statement(
                "UPDATE private_data SET revoked_at=? WHERE tenant='a' AND connection='source' AND id='v2' AND kind='credential'",
                now,
              )
              .run();
            await store
              .statement(
                "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source'",
              )
              .run();
          } else {
            await store
              .statement(
                "UPDATE connections SET remote_identity='another-account' WHERE tenant='a' AND id='source'",
              )
              .run();
          }
          return read === "poll" ? response([], []) : operationResponse([qso]);
        });
        const pending =
          read === "poll"
            ? pollSource(store, source, pages, at)
            : rereadOperation(store, source, pages, at);
        if (change === "replacement" || change === "revocation")
          await assert.rejects(pending, /source connection changed/);
        else await pending;
        assert.equal((await readEnvelope())?.envelope, expected);
        if (change === "replacement")
          assert.equal(
            (
              await store.private<LoFiCredentials>(
                "a",
                "source",
                "v3",
                "credential",
              )
            )?.token,
            "new-token",
          );
      });
    }
  }
});

test("contact batches count invalid selections and exclude work already handled in the drain", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  assert.deepEqual(
    await pendingContactBatch(
      store,
      source,
      1,
      now,
      "background",
      undefined,
      now,
    ),
    { contacts: [], selected: 0 },
  );
  await pollSource(
    store,
    source,
    fetcher(async () =>
      response(
        [],
        [
          { ...loose, uuid: "a-invalid", their: {} },
          { ...loose, uuid: "b-valid" },
        ],
      ),
    ),
    now,
  );
  const first = await pendingContactBatch(
    store,
    source,
    1,
    now,
    "background",
    undefined,
    now,
  );
  assert.deepEqual(first, { contacts: [], selected: 1 });
  assert.equal((await work(state, "a-invalid"))?.state, "blocked");
  assert.equal((await work(state, "a-invalid"))?.processed_at, now);
  const second = await pendingContactBatch(
    store,
    source,
    1,
    now + 1,
    "background",
    undefined,
    now,
  );
  assert.equal(second.selected, 1);
  assert.deepEqual(
    second.contacts.map((contact) => contact.id),
    ["b-valid"],
  );
  assert.equal((await work(state, "b-valid"))?.processed_at, now + 1);
  assert.deepEqual(
    await pendingContactBatch(
      store,
      source,
      1,
      now + 2,
      "background",
      undefined,
      now,
    ),
    { contacts: [], selected: 0 },
  );
  const direct = await pendingContacts(
    store,
    source,
    1,
    now + 2,
    undefined,
    "b-valid",
  );
  assert.deepEqual(
    direct.map((contact) => contact.id),
    ["b-valid"],
  );
  assert.equal((await work(state, "b-valid"))?.processed_at, now + 1);
});

test("contact turns prefer ready retained context over older operation holds within each priority", async (t) => {
  for (const priority of ["live", "background"] as const) {
    await t.test(priority, async (t) => {
      const state = await setup();
      const { store, source, now, mf } = state;
      t.after(() => mf.dispose());
      const ready = { ...qso, uuid: "z-ready", operation: "a-ready" };
      const missing = {
        ...qso,
        uuid: "a-missing-base",
        operation: "z-missing",
      };
      const held = { ...qso, uuid: "b-held", operation: "z-pending" };
      const general = { ...loose, uuid: "zz-general" };
      await pollSource(
        store,
        source,
        async () =>
          response(
            [
              { ...op, uuid: "a-ready" },
              { ...op, uuid: "z-missing" },
              { ...op, uuid: "z-pending" },
            ],
            [missing, held, ready, general],
          ),
        now,
      );
      await rereadOperation(
        store,
        source,
        async () => operationResponse([ready]),
        now + 1,
      );
      await store
        .statement(
          "UPDATE source_work SET state='context' WHERE kind='operation' AND id='z-missing'",
        )
        .run();
      await store
        .statement(
          "DELETE FROM private_data WHERE kind='source' AND id=(SELECT private_id FROM source_work WHERE kind='operation' AND id='z-missing')",
        )
        .run();
      await store
        .statement(
          "UPDATE source_work SET priority=? WHERE kind='qso'",
          priority,
        )
        .run();
      await store
        .statement(
          "UPDATE source_work SET processed_at=? WHERE kind='qso' AND id IN('z-ready','zz-general')",
          now - 1,
        )
        .run();

      const take = (time: number) =>
        pendingContactBatch(store, source, 1, time, priority, undefined, now);
      assert.deepEqual(
        (await take(now + 2)).contacts.map((contact) => contact.id),
        [ready.uuid],
      );
      assert.deepEqual(
        (await take(now + 3)).contacts.map((contact) => contact.id),
        [general.uuid],
      );
      assert.deepEqual(
        await pendingContactBatch(
          store,
          source,
          1,
          now + 4,
          priority,
          undefined,
          now,
          true,
        ),
        { contacts: [], selected: 0 },
      );
      for (const waiting of [missing, held]) {
        const retained = await work(state, String(waiting.uuid));
        assert.equal(
          retained?.state,
          "pending",
          "prioritization does not discard held contacts",
        );
        assert.equal(retained?.processed_at, 0);
        assert(
          await store.private("a", "source", retained!.private_id, "source"),
        );
      }
      assert.deepEqual(await take(now + 4), { contacts: [], selected: 1 });
      assert.deepEqual(await take(now + 5), { contacts: [], selected: 1 });
      for (const waiting of [missing, held]) {
        const retained = await work(state, String(waiting.uuid));
        assert.equal(retained?.state, "blocked");
        assert.equal(retained?.reason, "operation_context_unavailable");
      }
      assert.deepEqual(await take(now + 6), { contacts: [], selected: 0 });
    });
  }
});

test("ready-context ordering preserves live precedence, explicit selection and incomplete-source blocking", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const held = { ...qso, uuid: "a-live-held" };
  await pollSource(
    store,
    source,
    async () => response([op], [held, loose]),
    now,
  );
  await store
    .statement("UPDATE source_work SET priority='live' WHERE id='a-live-held'")
    .run();
  assert.deepEqual(await pendingContactBatch(store, source, 1, now + 1), {
    contacts: [],
    selected: 1,
  });
  assert.equal(
    (await work(state, held.uuid))?.reason,
    "operation_context_unavailable",
  );
  assert.equal((await work(state, String(loose.uuid)))?.state, "pending");
  await store
    .statement(
      "UPDATE source_work SET state='pending',priority='background' WHERE id='a-live-held'",
    )
    .run();
  assert.deepEqual(
    await pendingContactBatch(
      store,
      source,
      1,
      now + 2,
      "background",
      held.uuid,
    ),
    { contacts: [], selected: 1 },
  );
  await store
    .statement(
      "UPDATE cursors SET cursor=json_set(cursor,'$.complete',json('false')) WHERE stream='context'",
    )
    .run();
  assert.deepEqual(
    await pendingContactBatch(store, source, 1, now + 3, "background"),
    { contacts: [], selected: 0 },
  );
  assert.equal((await work(state, String(loose.uuid)))?.state, "pending");
});

test("ready-only contact selection leaves operation holds available for same-drain reread recovery", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  await pollSource(store, source, async () => response([op], [qso]), now);
  assert.deepEqual(
    await pendingContactBatch(
      store,
      source,
      1,
      now + 1,
      "background",
      undefined,
      now,
      true,
    ),
    { contacts: [], selected: 0 },
  );
  assert.equal((await work(state, String(qso.uuid)))?.state, "pending");
  assert.equal((await work(state, String(qso.uuid)))?.processed_at, 0);
  await rereadOperation(
    store,
    source,
    async () => operationResponse([qso]),
    now + 2,
  );
  const recovered = await pendingContactBatch(
    store,
    source,
    1,
    now + 3,
    "background",
    undefined,
    now,
  );
  assert.equal(recovered.selected, 1);
  assert.deepEqual(
    recovered.contacts.map((contact) => contact.id),
    [qso.uuid],
  );
});

test("finishing an operation reread releases context-blocked contacts from every page", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const earlier = { ...qso, uuid: "qso-earlier", syncedAtMillis: 90 };
  await pollSource(
    store,
    source,
    fetcher(async () => response([op], [qso, earlier])),
    now,
  );
  assert.deepEqual(await pendingContacts(store, source, 40, now + 1), []);
  for (const contact of [qso, earlier]) {
    const row = await work(state, String(contact.uuid));
    assert.equal(row?.state, "blocked");
    assert.equal(row?.reason, "operation_context_unavailable");
  }

  const partial = await rereadOperation(
    store,
    source,
    fetcher(async () => operationResponse([qso], 1, 95)),
    now + 2,
  );
  assert.equal(partial.complete, false);
  assert.equal((await work(state, "op-1", "operation"))?.state, "pending");
  assert.deepEqual(await pendingContacts(store, source, 40, now + 3), []);
  assert.equal((await work(state, "qso-1"))?.state, "blocked");

  const complete = await rereadOperation(
    store,
    source,
    fetcher(async (url) => {
      assert.equal(url.searchParams.get("syncedUntilMillis"), "95");
      return operationResponse([earlier]);
    }),
    now + 4,
  );
  assert.equal(complete.complete, true);
  assert.equal((await work(state, "op-1", "operation"))?.state, "context");
  for (const contact of [qso, earlier]) {
    const row = await work(state, String(contact.uuid));
    assert.equal(row?.state, "pending");
    assert.equal(row?.reason, null);
  }
  assert.deepEqual(
    (await pendingContacts(store, source, 40, now + 5))
      .map((contact) => contact.id)
      .sort(),
    ["qso-1", "qso-earlier"],
  );
});

test("historical pages stay small while forward arrivals and edits retain live priority", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const limits: number[] = [];
  const page = (qsos: SourceRecord[]) =>
    fetcher(async (_url, init) => {
      limits.push(JSON.parse(String(init?.body)).meta.sync.qsos.limit);
      return response([], qsos);
    });
  const historical = { ...loose, uuid: "a-history" };
  const edited = { ...loose, uuid: "z-edited", startAtMillis: at - 86400_000 };
  await pollSource(store, source, page([historical, edited]), now);
  assert.equal(await contactPriority(store, source, edited.uuid), "background");

  // A timestamp-only replay has no meaningful source change to promote.
  await pollSource(
    store,
    source,
    page([{ ...edited, syncedAtMillis: 103 }]),
    now + 1,
  );
  assert.equal(await contactPriority(store, source, edited.uuid), "background");
  const correction = { ...edited, notes: "corrected", syncedAtMillis: 104 };
  const newlyArrived = { ...loose, uuid: "new-arrival", syncedAtMillis: 105 };
  await pollSource(store, source, page([correction, newlyArrived]), now + 2);
  assert.equal(await contactPriority(store, source, edited.uuid), "live");
  assert.equal(await contactPriority(store, source, newlyArrived.uuid), "live");
  assert.equal((await work(state, edited.uuid))?.priority, "live");

  const rescanned = { ...loose, uuid: "older-rescan", syncedAtMillis: 50 };
  await pollSource(
    store,
    source,
    page([correction, rescanned]),
    now + 3,
    "rescan:new-destination",
  );
  assert.equal((await work(state, edited.uuid))?.priority, "live");
  assert.equal(
    await contactPriority(store, source, rescanned.uuid),
    "background",
  );
  assert.deepEqual(limits, [25, 100, 100, 25]);
  assert.deepEqual(
    (await pendingContacts(store, source, 2, now + 4)).map((c) => c.id),
    [newlyArrived.uuid, edited.uuid],
  );
  assert.deepEqual(
    (await pendingContacts(store, source, 20, now + 4, "background")).map(
      (c) => c.id,
    ),
    [historical.uuid, rescanned.uuid],
  );
  assert.deepEqual(
    (await pendingContacts(store, source, 20, now + 4, "live")).map(
      (c) => c.id,
    ),
    [newlyArrived.uuid, edited.uuid],
  );
  assert.deepEqual(
    (
      await pendingContacts(
        store,
        source,
        1,
        now + 4,
        undefined,
        historical.uuid,
      )
    ).map((c) => c.id),
    [historical.uuid],
    "an exact saved attempt can refresh its context ahead of the queue limit",
  );
  assert.deepEqual(
    await pendingContacts(store, source, 1, now + 4, "live", historical.uuid),
    [],
    "an exact filter still observes the priority and source-context guards",
  );
  await store
    .statement("DELETE FROM source_work WHERE id=?", newlyArrived.uuid)
    .run();
  assert.equal(
    await contactPriority(store, source, newlyArrived.uuid),
    "live",
    "forward birth retains priority after source payload metadata is purged",
  );
});

test("historical inventory baselines stay background until a forward correction arrives", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const absent = { ...loose, uuid: "absent" };
  const unverified = { ...loose, uuid: "unverified" };
  await pollSource(
    store,
    source,
    fetcher(async () => response([], [absent, unverified])),
    now,
  );
  for (const contact of await pendingContacts(store, source, 20, now + 1)) {
    await observeContact(store, source, contact, now + 1);
    const missing = contact.id === absent.uuid;
    const result = await adoptHistory(
      store,
      {
        tenant: source.tenant,
        source: source.id,
        qso: contact.id,
        destination: "destination",
      },
      contact.generation,
      {
        state: missing ? "missing_current_identity" : "historical_unverified",
        reason: null,
        evidence: {
          destination: "qrz",
          capturedGeneration: contact.generation,
          currentGeneration: contact.generation,
          readAccess: missing,
          inventoryComplete: missing,
          catchupComplete: missing,
          freshCheckComplete: missing,
        },
      },
      now + 1,
    );
    assert.equal(result.applied, true);
    const ledger = await store.ledger({
      tenant: source.tenant,
      source: source.id,
      qso: contact.id,
      destination: "destination",
    });
    assert.ok(ledger?.baseline_hash);
    assert.equal(
      await contactPriority(store, source, contact.id),
      "background",
    );
  }
  assert.deepEqual(
    await pendingContacts(store, source, 20, now + 2, "live"),
    [],
  );
  assert.equal(
    (await pendingContacts(store, source, 20, now + 2, "background")).length,
    2,
  );
  await pollSource(
    store,
    source,
    fetcher(async () =>
      response([], [{ ...absent, notes: "corrected", syncedAtMillis: 103 }]),
    ),
    now + 3,
  );
  assert.equal(await contactPriority(store, source, absent.uuid), "live");
  assert.equal(
    await contactPriority(store, source, unverified.uuid),
    "background",
  );
});

test("expired general-log history gets a resumable repair without resetting forward coverage", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  const archived = { ...loose, uuid: "already-resolved" };
  const absent = { ...loose, uuid: "not-returned" };
  await pollSource(
    store,
    source,
    fetcher(async () => response([], [loose, archived, absent])),
    now,
  );
  for (const contact of await pendingContacts(store, source, 20, now + 1))
    await observeContact(store, source, contact, now + 1);
  await store
    .statement(
      "UPDATE ledger SET state='observed',baseline_hash=source_hash,remote_id='7' WHERE qso=?",
      archived.uuid,
    )
    .run();
  await purgeResolvedSource(store);
  assert.equal((await work(state, archived.uuid))?.state, "archived");
  const canonical = await store
    .statement("SELECT cursor,generation FROM cursors WHERE stream='sync'")
    .first();
  const context = await store
    .statement("SELECT cursor,generation FROM cursors WHERE stream='context'")
    .first();
  await store
    .statement(
      "UPDATE source_work SET expires_at=? WHERE id IN(?,?)",
      now - 1,
      String(loose.uuid),
      absent.uuid,
    )
    .run();
  await expireSource(store, now + 2);
  const repair = () =>
    store
      .statement(
        "SELECT cursor,generation,updated_at FROM cursors WHERE stream='repair'",
      )
      .first<{ cursor: string; generation: number; updated_at: number }>();
  const started = await repair();
  assert.ok(started);
  assert.equal(JSON.parse(started.cursor).mode, "backfill");
  assert.deepEqual(
    await store
      .statement("SELECT cursor,generation FROM cursors WHERE stream='sync'")
      .first(),
    canonical,
  );
  assert.deepEqual(
    await store
      .statement("SELECT cursor,generation FROM cursors WHERE stream='context'")
      .first(),
    context,
  );
  await expireSource(store, now + 3);
  assert.deepEqual(await repair(), started);
  await pollSource(
    store,
    source,
    fetcher(async () => response([], [archived], 1)),
    now + 4,
    "repair",
  );
  const partial = await repair();
  assert.equal(JSON.parse(partial!.cursor).qsos.cursor, "qso-page-2");
  assert.equal((await work(state, archived.uuid))?.state, "archived");
  assert.equal(
    await store.private(
      "a",
      "source",
      (await work(state, archived.uuid))!.private_id,
      "source",
    ),
    null,
  );
  await expireSource(store, now + 5);
  assert.deepEqual(await repair(), partial);
  await pollSource(
    store,
    source,
    fetcher(async (_url, init) => {
      assert.equal(
        JSON.parse(String(init?.body)).meta.sync.qsos.cursor,
        "qso-page-2",
      );
      return response([], [loose]);
    }),
    now + 6,
    "repair",
  );
  const completed = await repair();
  assert.equal(JSON.parse(completed!.cursor).rescanComplete, true);
  assert.equal((await work(state, String(loose.uuid)))?.state, "pending");
  assert.ok(
    (await pendingContacts(store, source, 20, now + 7)).some(
      (contact) => contact.id === loose.uuid,
    ),
  );
  assert.equal((await work(state, absent.uuid))?.state, "expired");
  await expireSource(store, now + 8);
  assert.deepEqual(
    await repair(),
    completed,
    "an old absent row cannot restart completed repair every tick",
  );
  assert.deepEqual(
    await store
      .statement("SELECT cursor,generation FROM cursors WHERE stream='sync'")
      .first(),
    canonical,
  );
  await store
    .statement(
      "UPDATE source_work SET expires_at=? WHERE id=?",
      now + 9,
      String(loose.uuid),
    )
    .run();
  await expireSource(store, now + 10);
  assert.equal(JSON.parse((await repair())!.cursor).rescanComplete, false);
});

test("real-clock LoFi cooldown starts when the vendor response arrives", async (t) => {
  const { store, source, now, mf } = await setup();
  t.after(() => mf.dispose());
  let actual = now + 30_000;
  t.mock.method(Date, "now", () => actual);
  await assert.rejects(
    pollSource(
      store,
      source,
      fetcher(async () => {
        actual += 60_000;
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "600" },
        });
      }),
      now,
      "sync",
      null,
    ),
    (error: unknown) =>
      error instanceof VendorDeferredError &&
      error.retryAt === actual + 600_000,
  );
});

test("operation context for live work runs first and vendor deferrals preserve progress", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  await pollSource(
    store,
    source,
    fetcher(async () =>
      response(
        [
          { ...op, uuid: "a-history" },
          { ...op, uuid: "z-live" },
        ],
        [{ ...qso, operation: "z-live" }],
      ),
    ),
    now,
  );
  await pollSource(
    store,
    source,
    fetcher(async () =>
      response(
        [{ ...op, uuid: "z-live", grid: "FN32BB", syncedAtMillis: 200 }],
        [],
      ),
    ),
    now + 1,
  );
  assert.equal(await contactPriority(store, source, String(qso.uuid)), "live");
  const paths: string[] = [];
  const pages = fetcher(async (url) => {
    paths.push(url.pathname);
    if (url.pathname.includes("z-live")) {
      assert.equal(url.searchParams.get("limit"), "100");
      return operationResponse([{ ...qso, operation: "z-live" }]);
    }
    assert.equal(url.searchParams.get("limit"), "25");
    return operationResponse([], 1);
  });
  await rereadOperation(store, source, pages, now + 2);
  await rereadOperation(store, source, pages, now + 3);
  assert.deepEqual(paths, [
    "/v1/operations/z-live/qsos",
    "/v1/operations/a-history/qsos",
  ]);
  const before = await work(state, "a-history", "operation");
  const cursorBefore = await store
    .statement(
      "SELECT cursor,generation FROM cursors WHERE stream='reread:a-history'",
    )
    .first();
  let dispatched = 0;
  const throttled = fetcher(async () => {
    dispatched++;
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": "600" },
    });
  });
  await assert.rejects(
    rereadOperation(store, source, throttled, now + 4),
    (error: unknown) =>
      error instanceof VendorDeferredError &&
      error.requestSent &&
      error.retryAt === now + 600_004,
  );
  assert.deepEqual(await work(state, "a-history", "operation"), before);
  assert.deepEqual(
    await store
      .statement(
        "SELECT cursor,generation FROM cursors WHERE stream='reread:a-history'",
      )
      .first(),
    cursorBefore,
  );
  await assert.rejects(
    pollSource(store, source, throttled, now + 5),
    (error: unknown) =>
      error instanceof VendorDeferredError && !error.requestSent,
  );
  assert.equal(dispatched, 1);
});

test("operation rereads skip tombstones and failed or partial pages yield fairly without inventing coverage", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  await pollSource(
    store,
    source,
    async () =>
      response(
        [
          { ...op, uuid: "a-deleted", deleted: true },
          { ...op, uuid: "b-failing" },
          { ...op, uuid: "c-partial" },
          { ...op, uuid: "d-healthy" },
        ],
        [],
      ),
    now,
  );
  const seen: string[] = [];
  const pages = fetcher(async (url) => {
    seen.push(url.pathname);
    if (url.pathname.includes("b-failing")) throw new Error("synthetic outage");
    if (url.pathname.includes("c-partial"))
      return operationResponse(
        [{ ...qso, uuid: "partial-qso", operation: "c-partial" }],
        1,
        200,
      );
    if (url.pathname.includes("d-healthy")) return operationResponse([]);
    throw new Error("Deleted operation must not be queried");
  });
  await assert.rejects(
    rereadOperation(store, source, pages, now + 1),
    /synthetic outage/,
  );
  assert.equal((await work(state, "b-failing", "operation"))?.state, "pending");
  assert.equal(
    (await work(state, "b-failing", "operation"))?.reason,
    "operation_read_failed_retrying",
  );
  assert.equal(
    await store
      .statement("SELECT cursor FROM cursors WHERE stream='reread:b-failing'")
      .first(),
    null,
  );
  assert.equal(
    (await rereadOperation(store, source, pages, now + 2)).complete,
    false,
  );
  assert.equal((await work(state, "c-partial", "operation"))?.state, "pending");
  assert.equal(
    (await rereadOperation(store, source, pages, now + 3)).complete,
    true,
  );
  assert.equal((await work(state, "d-healthy", "operation"))?.state, "context");
  assert.deepEqual(seen, [
    "/v1/operations/b-failing/qsos",
    "/v1/operations/c-partial/qsos",
    "/v1/operations/d-healthy/qsos",
  ]);
  await assert.rejects(
    rereadOperation(store, source, pages, now + 300_004),
    /synthetic outage/,
  );
  assert.equal(
    seen.at(-1),
    "/v1/operations/b-failing/qsos",
    "failed operation is retried after other work has a turn",
  );
});

test("successful source sync records separate success health and clears a stale failure", async (t) => {
  const { store, source, now, mf } = await setup();
  t.after(() => mf.dispose());
  await store
    .statement(
      "UPDATE connections SET config=json_set(config,'$.lastError','Source sync requires attention') WHERE tenant='a' AND id='source'",
    )
    .run();
  await pollSource(store, source, async () => response([], []), now);
  const saved = JSON.parse((await store.connection("a", "source"))!.config);
  assert.equal(saved.lastError, undefined);
  assert.equal(saved.lastSuccessfulPollAt, now);
});

test("canonical sync refreshes account email without using immutable names, pending emails or rescan metadata", async (t) => {
  const { store, source, now, mf } = await setup();
  t.after(() => mf.dispose());
  await store
    .statement(
      "UPDATE connections SET label='iPad' WHERE tenant='a' AND id='source'",
    )
    .run();
  const page =
    (account: SourceRecord): typeof fetch =>
    async () => {
      const body = (await response([], []).json()) as SourceRecord;
      return Response.json({ ...body, account });
    };
  await pollSource(
    store,
    source,
    page({ uuid: "account-1", name: "iPad", email: "owner@example.test" }),
    now,
  );
  assert.equal(
    (await store.connection("a", "source"))?.label,
    "owner@example.test",
  );
  assert.equal(
    JSON.parse((await store.connection("a", "source"))!.config).accountEmail,
    "owner@example.test",
  );
  await pollSource(
    store,
    source,
    page({
      uuid: "account-1",
      name: "iPad",
      pending_email: "pending@example.test",
    }),
    now + 1,
  );
  assert.equal(
    (await store.connection("a", "source"))?.label,
    "owner@example.test",
  );
  await pollSource(
    store,
    source,
    page({ uuid: "account-1", email: "older@example.test" }),
    now + 2,
    "rescan:destination",
  );
  assert.equal(
    (await store.connection("a", "source"))?.label,
    "owner@example.test",
  );
  await assert.rejects(
    pollSource(
      store,
      source,
      page({ uuid: "other-account", email: "other@example.test" }),
      now + 3,
    ),
    /account_changed/,
  );
  assert.equal(
    (await store.connection("a", "source"))?.label,
    "owner@example.test",
  );
  await pollSource(
    store,
    source,
    page({
      uuid: "account-1",
      email: null,
      pending_email: "pending@example.test",
    }),
    now + 4,
  );
  assert.equal(
    (await store.connection("a", "source"))?.label,
    "Email unavailable",
  );
  assert.equal(
    JSON.parse((await store.connection("a", "source"))!.config).accountEmail,
    null,
  );
});

test("late failed operation reads cannot mark a newer lease's pending progress as failed", async (t) => {
  const state = await setup();
  const { store, source, now, mf } = state;
  t.after(() => mf.dispose());
  await pollSource(store, source, async () => response([op], []), now);
  let failOld: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const old = rereadOperation(
    store,
    source,
    async () => {
      reached?.();
      await new Promise<void>((_resolve, reject) => {
        failOld = () => reject(new Error("late old outage"));
      });
      throw new Error("unreachable");
    },
    now + 1,
  );
  const refused = assert.rejects(old, /late old outage/);
  await started;
  await rereadOperation(
    store,
    source,
    async () => operationResponse([{ ...qso }], 1, 200),
    now + 90_002,
  );
  const newer = await work(state, "op-1", "operation");
  failOld?.();
  await refused;
  assert.deepEqual(await work(state, "op-1", "operation"), newer);
  assert.equal(newer?.reason, null);
  assert.equal(newer?.state, "pending");
});

test("raw intake and cursor commit together, overlapping poll lease cannot skip a page", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: (() => void) | undefined;
    const reachedFetch = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const fetch = fetcher(async () => {
      reached?.();
      await waiting;
      return response([op], [qso]);
    });
    const first = pollSource(store, source, fetch, now);
    await reachedFetch;
    assert.equal((await pollSource(store, source, fetch, now)).pages, 0);
    release?.();
    await first;
    assert.ok(await work(state, "qso-1"));
    assert.ok(
      await store
        .statement("SELECT * FROM cursors WHERE stream='sync'")
        .first(),
    );
    const before = (await work(state, "qso-1"))?.revision;
    await assert.rejects(
      pollSource(
        store,
        source,
        fetcher(async () => {
          await store
            .statement(
              "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source'",
            )
            .run();
          return response(
            [],
            [{ ...qso, notes: "changed", syncedAtMillis: 200 }],
          );
        }),
        now + 1,
      ),
    );
    assert.equal((await work(state, "qso-1"))?.revision, before);
    assert.equal(
      (
        await store
          .statement("SELECT generation FROM cursors WHERE stream='sync'")
          .first<{ generation: number }>()
      )?.generation,
      1,
    );
  } finally {
    await mf.dispose();
  }
});

test("operation-only location edit rereads a purged contact and preserves its adopted baseline", async () => {
  const state = await setup();
  const { store, source, now, mf, key } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([op], [qso])),
      now,
    );
    assert.deepEqual(
      await pendingContacts(store, source, 40, now),
      [],
      "operation must finish its event inventory",
    );
    await rereadOperation(
      store,
      source,
      fetcher(async () => operationResponse([qso])),
      now + 1,
    );
    const [original] = await pendingContacts(store, source, 40, now + 2);
    assert.ok(original);
    assert.equal(original.grid, "FN31AA");
    await observeContact(store, source, original, now + 2);
    const ledgerKey = { ...key, qso: qso.uuid as string };
    await store
      .statement(
        "UPDATE ledger SET state='adopted_existing',narrative='remote_preserved',baseline_hash=source_hash,remote_id='historical-1',provenance='adopted' WHERE tenant='a'",
      )
      .run();
    const body = await work(state, "qso-1");
    assert.ok(body);
    await store
      .statement(
        "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND id=?",
        body.private_id,
      )
      .run();
    await store
      .statement("DELETE FROM source_work WHERE tenant='a' AND id='qso-1'")
      .run();
    await pollSource(
      store,
      source,
      fetcher(async () =>
        response([{ ...op, grid: "FN42CC", syncedAtMillis: 200 }], []),
      ),
      now + 3,
    );
    assert.equal(
      (await store.ledger(ledgerKey))?.state,
      "adopted_existing",
      "context reads preserve adoption state",
    );
    await rereadOperation(
      store,
      source,
      fetcher(async (url) => {
        assert.equal(url.pathname, "/v1/operations/op-1/qsos");
        return operationResponse([qso]);
      }),
      now + 4,
    );
    const [corrected] = await pendingContacts(store, source, 40, now + 5);
    assert.ok(corrected);
    assert.equal(corrected.grid, "FN42CC");
    await observeContact(store, source, corrected, now + 5);
    const ledger = await store.ledger(ledgerKey);
    assert.equal(ledger?.state, "changed");
    assert.equal(ledger?.narrative, "remote_preserved");
    assert.equal(ledger?.remote_id, "historical-1");
    assert.equal(ledger?.provenance, "adopted");
    assert.notEqual(ledger?.baseline_hash, ledger?.source_hash);
  } finally {
    await mf.dispose();
  }
});

test("stale composite context cannot update a ledger or stage an immutable attempt", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [loose])),
      now,
    );
    const [captured] = await pendingContacts(store, source, 40, now + 1);
    assert.ok(captured);
    await observeContact(store, source, captured, now + 1);
    const key = {
      tenant: "a",
      source: "source",
      qso: "loose-1",
      destination: "destination",
    };
    await store
      .statement(
        "UPDATE ledger SET state='live_new',due_at=? WHERE tenant='a'",
        now,
      )
      .run();
    await pollSource(
      store,
      source,
      fetcher(async () =>
        response([], [{ ...loose, notes: "later", syncedAtMillis: 200 }]),
      ),
      now + 2,
    );
    await assert.rejects(observeContact(store, source, captured, now + 3));
    const version = await store.saveTemplate("a", "destination", {
      profile: "fixture",
      fields: { COMMENT: "Synthetic" },
    });
    await assert.rejects(
      store.stage(
        key,
        captured.generation,
        { frozen: "old" },
        "v1",
        version,
        now + 3,
      ),
    );
    assert.equal(
      (
        await store
          .statement("SELECT count(*) n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});

test("null-operation records project independently and sparse tombstones cancel only unsent work", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [loose])),
      now,
    );
    const [contact] = await pendingContacts(store, source, 40, now + 1);
    assert.ok(contact);
    assert.equal(contact.operationId, null);
    await observeContact(store, source, contact, now + 1);
    const key = {
      tenant: "a",
      source: "source",
      qso: "loose-1",
      destination: "destination",
    };
    await store
      .statement(
        "UPDATE ledger SET state='live_new',due_at=? WHERE tenant='a'",
        now,
      )
      .run();
    const version = await store.saveTemplate("a", "destination", {
      profile: "fixture",
      fields: { COMMENT: "Synthetic" },
    });
    const attempt = await store.stage(
      key,
      contact.generation,
      { frozen: true },
      "v1",
      version,
      now + 2,
    );
    await pollSource(
      store,
      source,
      fetcher(async () =>
        response(
          [],
          [
            {
              uuid: "loose-1",
              operation: null,
              deleted: 1,
              syncedAtMillis: 201,
            },
          ],
        ),
      ),
      now + 3,
    );
    assert.deepEqual(await pendingContacts(store, source, 40, now + 4), []);
    assert.equal((await store.ledger(key))?.state, "source_deleted");
    assert.equal(
      (
        await store
          .statement(
            "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
            attempt,
          )
          .first<{ state: string }>()
      )?.state,
      "cancelled",
    );
  } finally {
    await mf.dispose();
  }
});

test("event expiry and missing membership never erase a segment or block an unrelated general log", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([op], [qso, boundary, loose])),
      now,
    );
    await rereadOperation(
      store,
      source,
      fetcher(async () => operationResponse([qso, boundary])),
      now + 1,
    );
    assert.equal(
      (await pendingContacts(store, source, 40, now + 2)).find(
        (c) => c.id === "qso-1",
      )?.grid,
      "FN32BB",
    );
    await store
      .statement(
        "UPDATE source_work SET expires_at=? WHERE id='event-1'",
        now - 1,
      )
      .run();
    await expireSource(store, now + 3);
    let contacts = await pendingContacts(store, source, 40, now + 4);
    assert.equal(
      contacts.some((c) => c.id === "qso-1"),
      false,
    );
    assert.equal(
      contacts.some((c) => c.id === "loose-1"),
      true,
    );
    await rereadOperation(
      store,
      source,
      fetcher(async () => operationResponse([qso])),
      now + 5,
    );
    assert.equal(
      (await work(state, "op-1", "operation"))?.reason,
      "event_absence_requires_reconciliation",
    );
    assert.ok(
      await work(state, "event-1"),
      "compact missing event evidence survives",
    );
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [])),
      now + 6,
    );
    contacts = await pendingContacts(store, source, 40, now + 7);
    assert.equal(
      contacts.some((c) => c.id === "qso-1"),
      false,
      "empty forward poll cannot restore incomplete op",
    );
    assert.equal(
      contacts.some((c) => c.id === "loose-1"),
      true,
    );
    let page = 0;
    const pages = fetcher(async (url) => {
      page++;
      if (page === 1) return operationResponse([qso], 1, 100);
      assert.equal(url.searchParams.get("syncedUntilMillis"), "100");
      return operationResponse([boundary]);
    });
    await rereadOperation(store, source, pages, now + 8);
    assert.equal((await work(state, "op-1", "operation"))?.state, "pending");
    await rereadOperation(store, source, pages, now + 300_009);
    assert.equal((await work(state, "op-1", "operation"))?.state, "context");
    assert.equal(
      (await pendingContacts(store, source, 40, now + 300_010)).find(
        (c) => c.id === "qso-1",
      )?.grid,
      "FN32BB",
    );
  } finally {
    await mf.dispose();
  }
});

test("expired operation recovery preserves backfill progress across scheduler cycles", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([op], [qso])),
      now,
    );
    await store
      .statement(
        "UPDATE source_work SET expires_at=? WHERE id='op-1' AND kind='operation'",
        now - 1,
      )
      .run();
    const readCursor = () =>
      store
        .statement(
          "SELECT cursor,generation FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
        )
        .first<{ cursor: string; generation: number }>();
    await expireSource(store, now + 1);
    assert.equal(JSON.parse((await readCursor())!.cursor).mode, "backfill");
    const seen: (string | undefined)[] = [];
    const pages = fetcher(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const cursor: string | undefined = request.meta.sync.operations.cursor;
      seen.push(cursor);
      if (cursor === "recovery-page-3") return response([op], [qso]);
      const next = cursor === "recovery-page-2" ? 3 : 2;
      return new Response(
        JSON.stringify({
          account: { uuid: "account-1" },
          operations: [
            {
              ...op,
              uuid: `newer-operation-${next}`,
              syncedAtMillis: 400 - next,
            },
          ],
          qsos: [],
          meta: {
            operations: {
              records_left: 1,
              next_cursor: `recovery-page-${next}`,
            },
            qsos: { records_left: 0 },
          },
        }),
      );
    });
    for (let cycle = 0; cycle < 3; cycle++) {
      const saved = await readCursor();
      await expireSource(store, now + 2 + cycle * 2);
      assert.deepEqual(
        await readCursor(),
        saved,
        "an in-progress expiry backfill must retain its committed page",
      );
      await pollSource(store, source, pages, now + 3 + cycle * 2);
    }
    assert.deepEqual(seen, [undefined, "recovery-page-2", "recovery-page-3"]);
    assert.equal(JSON.parse((await readCursor())!.cursor).mode, "forward");
    assert.ok((await work(state, "op-1", "operation"))!.expires_at > now);
    const completed = await readCursor();
    await expireSource(store, now + 9);
    assert.deepEqual(await readCursor(), completed);
    for (let operation = 0; operation < 3; operation++)
      await rereadOperation(
        store,
        source,
        fetcher(async (url) =>
          operationResponse(
            url.pathname === "/v1/operations/op-1/qsos" ? [qso] : [],
          ),
        ),
        now + 300_010 + operation,
      );
    assert.ok(
      (await pendingContacts(store, source, 40, now + 300_013)).some(
        (contact) => contact.id === "qso-1",
      ),
      "the operation on the final recovery page becomes usable again",
    );
  } finally {
    await mf.dispose();
  }
});

test("older operation snapshot cannot replace newer sync rows and conflicting server ties stay unresolved", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    const latest = {
      ...qso,
      notes: "newer source version",
      syncedAtMillis: 300,
    };
    await pollSource(
      store,
      source,
      fetcher(async () => response([op], [latest])),
      now,
    );
    await rereadOperation(
      store,
      source,
      fetcher(async () =>
        operationResponse([{ ...qso, notes: "stale", syncedAtMillis: 200 }]),
      ),
      now + 1,
    );
    const [contact] = await pendingContacts(store, source, 40, now + 2);
    assert.equal(contact?.notes, "newer source version");
    assert.equal((await work(state, "qso-1"))?.synced_at, 300);
    await store
      .statement(
        "UPDATE source_work SET state='pending' WHERE kind='operation'",
      )
      .run();
    const cursor = await store
      .statement("SELECT generation FROM cursors WHERE stream='reread:op-1'")
      .first<{ generation: number }>();
    await assert.rejects(
      rereadOperation(
        store,
        source,
        fetcher(async () =>
          operationResponse([{ ...latest, notes: "conflict" }]),
        ),
        now + 3,
      ),
    );
    assert.equal(
      (
        await store
          .statement(
            "SELECT generation FROM cursors WHERE stream='reread:op-1'",
          )
          .first<{ generation: number }>()
      )?.generation,
      cursor?.generation,
    );
  } finally {
    await mf.dispose();
  }
});

test("payload expiry retains version evidence so an older reread cannot resurrect stale content", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    const latest = {
      ...qso,
      notes: "latest before expiry",
      syncedAtMillis: 300,
    };
    await pollSource(
      store,
      source,
      fetcher(async () => response([op], [latest])),
      now,
    );
    await rereadOperation(
      store,
      source,
      fetcher(async () => operationResponse([latest])),
      now + 1,
    );
    const record = await work(state, "qso-1");
    assert.ok(record);
    await store
      .statement(
        "UPDATE source_work SET expires_at=? WHERE id='qso-1'",
        now - 1,
      )
      .run();
    await store
      .statement(
        "UPDATE private_data SET expires_at=? WHERE tenant='a' AND id=?",
        now - 1,
        record.private_id,
      )
      .run();
    await expireSource(store, now + 2);
    await store.recover(now + 2);
    assert.equal((await work(state, "qso-1"))?.synced_at, 300);
    assert.equal((await work(state, "qso-1"))?.state, "expired");
    await store
      .statement(
        "UPDATE source_work SET state='pending' WHERE kind='operation'",
      )
      .run();
    await rereadOperation(
      store,
      source,
      fetcher(async () =>
        operationResponse([
          { ...qso, notes: "stale after expiry", syncedAtMillis: 200 },
        ]),
      ),
      now + 3,
    );
    assert.equal((await work(state, "qso-1"))?.synced_at, 300);
    assert.equal((await pendingContacts(store, source, 40, now + 4)).length, 0);
    await store
      .statement(
        "UPDATE source_work SET state='pending' WHERE kind='operation'",
      )
      .run();
    await rereadOperation(
      store,
      source,
      fetcher(async () => operationResponse([latest])),
      now + 5,
    );
    assert.equal(
      (await pendingContacts(store, source, 40, now + 6))[0]?.notes,
      "latest before expiry",
    );
  } finally {
    await mf.dispose();
  }
});

test("explicit destination routing avoids phantom books and preserves adopted associations across route changes", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','other-book','qrz','book-2','Other station book','active',0)",
      )
      .run();
    const original = await store.connection("a", "destination");
    const other = await store.connection("a", "other-book");
    assert.ok(original && other);
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [loose])),
      now,
    );
    const [first] = await pendingContacts(store, source, 40, now + 1);
    assert.ok(first);
    await observeContact(store, source, first, now + 1, [original]);
    assert.equal(
      (
        await store
          .statement("SELECT count(*) n FROM ledger")
          .first<{ n: number }>()
      )?.n,
      1,
      "unrouted active book has no pending row",
    );
    const adoptionHash = await sourceFingerprint(first, "qrz", true);
    await store
      .statement(
        "UPDATE ledger SET state='adopted_existing',narrative='remote_preserved',source_hash=?,baseline_hash=?,remote_id='adopted-logid',provenance='adopted' WHERE tenant='a'",
        adoptionHash,
        adoptionHash,
      )
      .run();
    const key = {
      tenant: "a",
      source: "source",
      qso: "loose-1",
      destination: "destination",
    };
    const baseline = (await store.ledger(key))?.baseline_hash;
    const moved = {
      ...loose,
      our: { stationCall: "W2XYZ", grid: "FN42CC", dxccCode: 291 },
      syncedAtMillis: 200,
    };
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [moved])),
      now + 2,
    );
    const [second] = await pendingContacts(store, source, 40, now + 3);
    assert.ok(second);
    await observeContact(store, source, second, now + 3, [other]);
    const retained = await store.ledger(key);
    assert.equal(retained?.state, "retained_old_route");
    assert.equal(retained?.remote_id, "adopted-logid");
    assert.equal(retained?.baseline_hash, baseline);
    assert.equal(retained?.provenance, "adopted");
    assert.equal(retained?.narrative, "remote_preserved");
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [{ ...loose, syncedAtMillis: 300 }])),
      now + 4,
    );
    const [returned] = await pendingContacts(store, source, 40, now + 5);
    assert.ok(returned);
    await observeContact(store, source, returned, now + 5, [original]);
    const restored = await store.ledger(key);
    assert.equal(restored?.state, "adopted_existing");
    assert.equal(restored?.baseline_hash, baseline);
    assert.equal(restored?.sent_hash, null);
    assert.equal(
      (
        await store
          .statement("SELECT count(*) n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await assert.rejects(
      observeContact(store, source, returned, now + 6, [
        { ...other, tenant: "different" },
      ]),
    );
  } finally {
    await mf.dispose();
  }
});

test("a new-destination backfill uses its own cursor and preserves ongoing forward completeness", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [loose])),
      now,
    );
    const forward = await store
      .statement(
        "SELECT cursor,generation FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
      )
      .first<{ cursor: string; generation: number }>();
    assert.ok(forward);
    await store
      .statement(
        "INSERT INTO cursors VALUES('a','source','rescan:new-book',?,0,?)",
        JSON.stringify({
          mode: "backfill",
          operations: {},
          qsos: {},
          accountId: "account-1",
          requested: true,
        }),
        now,
      )
      .run();
    await store
      .statement(
        "UPDATE source_work SET expires_at=? WHERE id='loose-1'",
        now - 1,
      )
      .run();
    await expireSource(store, now + 1);
    let count = 0;
    const read = fetcher(async (_url, init) => {
      count++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.meta.sync.qsos.anyClient, true);
      if (count === 1) return response([], [loose], 1);
      assert.equal(request.meta.sync.qsos.cursor, "qso-page-2");
      return response(
        [],
        [
          {
            ...loose,
            uuid: "older-loose",
            startAtMillis: at - 60_000,
            syncedAtMillis: 100,
          },
        ],
      );
    });
    const partial = await pollSource(
      store,
      source,
      read,
      now + 2,
      "rescan:new-book",
    );
    assert.equal(partial.complete, false);
    assert.equal(
      (
        JSON.parse(
          (
            await store
              .statement("SELECT cursor FROM cursors WHERE stream='context'")
              .first<{ cursor: string }>()
          )?.cursor ?? "{}",
        ) as { complete: boolean }
      ).complete,
      true,
      "partial historical recovery does not stop forward contacts",
    );
    assert.equal(
      (await pendingContacts(store, source, 40, now + 3)).some(
        (contact) => contact.id === "loose-1",
      ),
      true,
      "expired body is recovered from current source read",
    );
    assert.equal(
      (await pollSource(store, source, read, now + 4, "rescan:new-book"))
        .complete,
      true,
    );
    const after = await store
      .statement(
        "SELECT cursor,generation FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
      )
      .first<{ cursor: string; generation: number }>();
    assert.deepEqual(after, forward);
    const finished = await pollSource(
      store,
      source,
      fetcher(async () => {
        throw new Error("completed rescan must not refetch");
      }),
      now + 5,
      "rescan:new-book",
    );
    assert.equal(finished.pages, 0);
  } finally {
    await mf.dispose();
  }
});

test("a refused source cursor parks prepared work, preserves history, and restarts read-only reconciliation", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [loose])),
      now,
    );
    const [contact] = await pendingContacts(store, source, 40, now + 1);
    assert.ok(contact);
    await observeContact(store, source, contact, now + 1);
    const key = {
      tenant: "a",
      source: "source",
      qso: "loose-1",
      destination: "destination",
    };
    await store
      .statement(
        "UPDATE ledger SET state='live_new',due_at=? WHERE tenant='a'",
        now,
      )
      .run();
    const version = await store.saveTemplate("a", "destination", {
      fields: { COMMENT: "Frozen" },
    });
    const attempt = await store.stage(
      key,
      contact.generation,
      { immutable: "prepared" },
      "v1",
      version,
      now + 1,
      undefined,
      undefined,
      undefined,
      {
        claim: await destinationIdentityClaim("qrz", contactAdif(contact)),
        sourceVersion: contact.reconciliationVersion,
      },
    );
    const oldCursor = (
      await store
        .statement("SELECT cursor FROM cursors WHERE stream='sync'")
        .first<{ cursor: string }>()
    )?.cursor;
    await assert.rejects(
      pollSource(
        store,
        source,
        fetcher(
          async () =>
            new Response(
              JSON.stringify({
                account: { uuid: "account-1" },
                operations: [],
                qsos: [],
                meta: {
                  operations: { records_left: 0 },
                  qsos: { records_left: 0 },
                },
                errors: { qsos: { pagination: { cursor: "expired" } } },
              }),
            ),
        ),
        now + 2,
      ),
      LoFiError,
    );
    const reset = JSON.parse(
      (
        await store
          .statement("SELECT cursor FROM cursors WHERE stream='sync'")
          .first<{ cursor: string }>()
      )?.cursor ?? "{}",
    );
    assert.equal(reset.mode, "backfill");
    assert.equal(reset.accountId, "account-1");
    assert.deepEqual(reset.qsos, {});
    const gap = await store
      .statement("SELECT cursor FROM cursors WHERE stream LIKE 'gap:%'")
      .first<{ cursor: string }>();
    assert.ok(gap);
    assert.deepEqual(
      JSON.parse(gap.cursor).previous,
      JSON.parse(oldCursor ?? "null"),
    );
    const lease = await store.claim("a", "delivery:destination", now + 3);
    assert.ok(lease);
    await assert.rejects(store.claimAttempt("a", attempt, lease, now + 3));
    assert.equal(
      (
        await store
          .statement("SELECT state FROM attempt_state WHERE attempt=?", attempt)
          .first<{ state: string }>()
      )?.state,
      "prepared",
    );
    assert.equal((await store.ledger(key))?.template_version, version);
    assert.equal(
      (
        await store
          .statement("SELECT phase FROM source_births WHERE qso='loose-1'")
          .first<{ phase: string }>()
      )?.phase,
      "history",
    );
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [loose])),
      now + 4,
    );
    const [reconciled] = await pendingContacts(store, source, 40, now + 5);
    assert.ok(reconciled);
    await observeContact(store, source, reconciled, now + 5);
    assert.equal(
      await store.claimAttempt("a", attempt, lease, now + 5),
      true,
      "same exact payload may dispatch only after source revalidation",
    );
    const after = (
      await store
        .statement("SELECT cursor FROM cursors WHERE stream='sync'")
        .first<{ cursor: string }>()
    )?.cursor;
    await assert.rejects(
      pollSource(
        store,
        source,
        fetcher(async () => {
          throw new Error("network unavailable");
        }),
        now + 6,
      ),
    );
    assert.equal(
      (
        await store
          .statement("SELECT cursor FROM cursors WHERE stream='sync'")
          .first<{ cursor: string }>()
      )?.cursor,
      after,
      "network failure never resets cursor",
    );
  } finally {
    await mf.dispose();
  }
});

test("observing a newer destination input cancels only unsent payload and retains the pinned template", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [loose])),
      now,
    );
    const [first] = await pendingContacts(store, source, 40, now + 1);
    assert.ok(first);
    await observeContact(store, source, first, now + 1);
    const key = {
      tenant: "a",
      source: "source",
      qso: "loose-1",
      destination: "destination",
    };
    await store
      .statement(
        "UPDATE ledger SET state='live_new',due_at=? WHERE tenant='a'",
        now,
      )
      .run();
    const pinned = await store.saveTemplate("a", "destination", {
      fields: { COMMENT: "Original" },
    });
    const attempt = await store.stage(
      key,
      first.generation,
      { immutable: "old" },
      "v1",
      pinned,
      now + 1,
    );
    const replacement = await store.saveTemplate("a", "destination", {
      fields: { COMMENT: "New default" },
    });
    assert.notEqual(pinned, replacement);
    await pollSource(
      store,
      source,
      fetcher(async () =>
        response(
          [],
          [{ ...loose, notes: "actual source change", syncedAtMillis: 200 }],
        ),
      ),
      now + 2,
    );
    const [changed] = await pendingContacts(store, source, 40, now + 3);
    assert.ok(changed);
    await observeContact(store, source, changed, now + 3);
    assert.equal(
      (
        await store
          .statement("SELECT state FROM attempt_state WHERE attempt=?", attempt)
          .first<{ state: string }>()
      )?.state,
      "cancelled",
    );
    assert.equal(
      await store.private("a", "destination", attempt, "outbox"),
      null,
    );
    assert.equal((await store.ledger(key))?.template_version, pinned);
    assert.equal(
      (
        await store
          .statement(
            "SELECT count(*) n FROM attempt_events WHERE attempt=? AND state='cancelled'",
            attempt,
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    await store
      .statement("UPDATE ledger SET due_at=? WHERE tenant='a'", now)
      .run();
    await store.stage(
      key,
      changed.generation,
      { immutable: "corrected with original" },
      "v1",
      pinned,
      now + 4,
    );
    assert.equal((await store.ledger(key))?.template_version, pinned);
  } finally {
    await mf.dispose();
  }
});

test("a first-seen forward tombstone reserves a historical UUID through later restoration", async () => {
  const state = await setup();
  const { store, source, now, mf } = state;
  try {
    await pollSource(
      store,
      source,
      fetcher(async () => response([], [loose])),
      now,
    );
    await pollSource(
      store,
      source,
      fetcher(async () =>
        response(
          [],
          [
            {
              uuid: "restored-old",
              operation: null,
              deleted: 1,
              syncedAtMillis: 300,
            },
          ],
        ),
      ),
      now + 1,
    );
    assert.equal(
      (
        await store
          .statement(
            "SELECT phase FROM source_births WHERE tenant='a' AND source='source' AND qso='restored-old'",
          )
          .first<{ phase: string }>()
      )?.phase,
      "history",
    );
    await pollSource(
      store,
      source,
      fetcher(async () =>
        response([], [{ ...loose, uuid: "restored-old", syncedAtMillis: 400 }]),
      ),
      now + 2,
    );
    assert.equal(
      (
        await store
          .statement(
            "SELECT phase FROM source_births WHERE tenant='a' AND source='source' AND qso='restored-old'",
          )
          .first<{ phase: string }>()
      )?.phase,
      "history",
      "restoration is not proof of new post-cutover creation",
    );
  } finally {
    await mf.dispose();
  }
});
