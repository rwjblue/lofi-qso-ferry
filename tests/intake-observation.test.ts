import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  type ContactObservation,
  observeContacts,
  pendingContacts,
  pollSource,
  rereadOperation,
} from "../src/intake.ts";
import { sourceFingerprint } from "../src/projection.ts";
import { Store } from "../src/store.ts";
import { database, seed } from "./helpers.ts";

const at = 1792684800000;
const syncResponse = (qsos: unknown[], operations: unknown[] = []) =>
  new Response(
    JSON.stringify({
      account: { uuid: "account-1" },
      operations,
      qsos,
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    }),
  );

async function setup(count = 4) {
  const state = await database();
  for (const file of [
    "0004_intake.sql",
    "0005_cutover.sql",
    "0009_vendor_requests.sql",
    "0010_source_priority.sql",
    "0018_reconciliation_work.sql",
  ]) {
    const sql = await readFile(
      new URL(`../migrations/${file}`, import.meta.url),
      "utf8",
    );
    let statement = "";
    for (const line of sql.split("\n")) {
      statement += `${line}\n`;
      const trigger = statement.trimStart().startsWith("CREATE TRIGGER");
      if (
        line.trimEnd().endsWith(";") &&
        (!trigger ||
          line.trim() === "END;" ||
          line.trimStart().startsWith("CREATE TRIGGER"))
      ) {
        await state.db.prepare(statement).run();
        statement = "";
      }
    }
  }
  const { store } = state;
  await seed(store);
  await (
    await store.putPrivate("a", "source", "v2", "credential", {
      key: "browser:fixture",
      secret: "fixture-secret",
      token: "fixture-token",
    })
  ).run();
  await store
    .statement(
      "UPDATE connections SET credential_version='v2',config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "account-1" }),
    )
    .run();
  await store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','lotw','lotw','lotw-1','LoTW','active','v1',0)",
    )
    .run();
  const source = await store.connection("a", "source");
  assert.ok(source);
  const destinations = (await store.connections("a")).filter(
    (c) => c.kind !== "lofi",
  );
  const raw = Array.from({ length: count }, (_, index) => ({
    uuid: `qso-${String(index).padStart(2, "0")}`,
    operation: index === 1 ? "op-1" : null,
    startAtMillis: at + index * 60_000,
    freq: 14074,
    band: "20m",
    mode: "FT8",
    their: { call: "W1AW" },
    our: { stationCall: "N0CALL", grid: "FN31AA", dxccCode: 291 },
    notes: "initial notes",
    syncedAtMillis: 100 + index,
  }));
  const now = Date.now();
  await pollSource(
    store,
    source,
    async () =>
      syncResponse(
        raw,
        count > 1
          ? [
              {
                uuid: "op-1",
                stationCall: "N0CALL",
                grid: "FN31AA",
                syncedAtMillis: 99,
              },
            ]
          : [],
      ),
    now,
  );
  if (count > 1)
    await rereadOperation(
      store,
      source,
      async () =>
        new Response(
          JSON.stringify({
            qsos: [raw[1]],
            meta: { qsos: { records_left: 0 } },
          }),
        ),
      now + 1,
    );
  const contacts = (await pendingContacts(store, source, 40, now + 2)).sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  assert.equal(contacts.length, count);
  return { ...state, source, destinations, contacts, raw, now: now + 2 };
}

function measuredStore(
  store: Store,
  before?: (call: number, size: number) => Promise<void>,
) {
  const batches: number[] = [];
  const db = new Proxy(store.db, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          batches.push(statements.length);
          await before?.(batches.length, statements.length);
          return target.batch(statements);
        };
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { store: new Store(db, store.keys), batches };
}

const key = (qso: string, destination = "lotw") => ({
  tenant: "a",
  source: "source",
  qso,
  destination,
});

async function assertNoGuards(store: Store) {
  assert.equal(
    (
      await store
        .statement("SELECT COUNT(*) n FROM projection_guards")
        .first<{ n: number }>()
    )?.n,
    0,
  );
}

test("twenty observations share one metadata read and preserve tenant, narrative and quiet-period policy", async (t) => {
  const h = await setup(20);
  t.after(() => h.mf.dispose());
  const { store, source, contacts, destinations, now } = h;
  await store
    .statement("UPDATE accounts SET quiet_minutes=25 WHERE id='a'")
    .run();
  const adoptedHash = await sourceFingerprint(contacts[0], "qrz", true);
  await store.observe(
    key(contacts[0].id, "destination"),
    contacts[0].generation,
    adoptedHash,
    25,
    false,
    now,
  );
  await store
    .statement(
      "UPDATE ledger SET state='adopted_existing',narrative='remote_preserved',baseline_hash=source_hash,remote_id='remote-1',provenance='adopted' WHERE tenant='a'",
    )
    .run();
  await seed(store, "other");
  await store.observe(
    { ...key(contacts[0].id), tenant: "other", destination: "destination" },
    "foreign",
    "foreign-hash",
    55,
    false,
    now,
  );
  const measured = measuredStore(store);
  const results = await observeContacts(
    measured.store,
    source,
    contacts.map((contact) => ({ contact, routedDestinations: destinations })),
    now + 1,
  );
  assert.deepEqual(
    results.map((r) => r.status),
    Array(20).fill("fulfilled"),
  );
  assert.deepEqual(measured.batches, [2, 48, 48, 48, 48, 48]);
  t.diagnostic(
    "20 contacts / two destinations: 6 D1 RPCs, each write transaction contains four complete contacts",
  );
  const adopted = await store.ledger(key(contacts[0].id, "destination"));
  assert.equal(adopted?.state, "adopted_existing");
  assert.equal(adopted?.source_hash, adoptedHash);
  assert.equal(adopted?.baseline_hash, adoptedHash);
  assert.equal(adopted?.remote_id, "remote-1");
  for (const contact of contacts)
    for (const destination of destinations) {
      const row = await store.ledger(key(contact.id, destination.id));
      assert.equal(row?.context_generation, contact.contextGeneration);
      assert.equal(
        row?.source_hash,
        await sourceFingerprint(
          contact,
          destination.kind as "qrz" | "lotw",
          row?.narrative === "remote_preserved",
        ),
      );
      if (contact !== contacts[0] || destination.id !== "destination")
        assert.equal(row?.due_at, now + 1 + 25 * 60_000);
    }
  assert.equal(
    (
      await store.ledger({
        ...key(contacts[0].id, "destination"),
        tenant: "other",
      })
    )?.source_hash,
    "foreign-hash",
  );
  await assertNoGuards(store);
});

test("a failed chunk rolls back edits and cancellation before isolated guarded retries", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  const { store, source, contacts, destinations, now } = h;
  await observeContacts(
    store,
    source,
    contacts.map((contact) => ({ contact, routedDestinations: destinations })),
    now,
  );
  await store
    .statement(
      "UPDATE ledger SET state='live_new',due_at=? WHERE tenant='a'",
      now,
    )
    .run();
  const attempts: string[] = [];
  for (const contact of contacts)
    attempts.push(
      await store.stage(
        key(contact.id),
        contact.generation,
        { immutable: contact.id },
        "v1",
        null,
        now,
      ),
    );
  const oldHash = (await store.ledger(key(contacts[0].id)))?.source_hash;
  const editedRaw = h.raw.map((raw, index) =>
    index === 0
      ? { ...raw, our: { ...raw.our, grid: "FN42CC" }, syncedAtMillis: 200 }
      : raw,
  );
  await pollSource(store, source, async () => syncResponse(editedRaw), now + 1);
  const current = (await pendingContacts(store, source, 40, now + 2)).sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  assert.equal(current.length, 4);
  let inspectedRollback = false;
  const measured = measuredStore(store, async (call) => {
    if (call !== 3) return;
    inspectedRollback = true;
    assert.equal(
      (await store.ledger(key(contacts[0].id)))?.source_hash,
      oldHash,
    );
    assert.equal(
      (
        await store
          .statement(
            "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
            attempts[0],
          )
          .first<{ state: string }>()
      )?.state,
      "prepared",
    );
    assert.ok(await store.private("a", "lotw", attempts[0], "outbox"));
    await assertNoGuards(store);
  });
  const results = await observeContacts(
    measured.store,
    source,
    current.map((contact, index) => ({
      contact:
        index === 1
          ? { ...contact, contextGeneration: contacts[1].contextGeneration }
          : contact,
      routedDestinations:
        index === 2
          ? destinations.filter((d) => d.kind === "qrz")
          : destinations,
    })),
    now + 2,
  );
  assert.equal(inspectedRollback, true);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled", "fulfilled"],
  );
  const states = await Promise.all(
    attempts.map((id) =>
      store
        .statement(
          "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
          id,
        )
        .first<{ state: string }>(),
    ),
  );
  assert.deepEqual(
    states.map((row) => row?.state),
    ["cancelled", "prepared", "cancelled", "prepared"],
  );
  assert.equal(await store.private("a", "lotw", attempts[0], "outbox"), null);
  assert.equal(
    (await store.ledger(key(contacts[1].id)))?.context_generation,
    contacts[1].contextGeneration,
  );
  assert.equal(
    (await store.ledger(key(contacts[2].id)))?.state,
    "retained_old_route",
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT prior_route_state FROM ledger WHERE tenant='a' AND source='source' AND qso=? AND destination='lotw'",
          contacts[2].id,
        )
        .first<{ prior_route_state: string | null }>()
    )?.prior_route_state,
    "live_new",
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT COUNT(*) n FROM attempt_events WHERE state='cancelled'",
        )
        .first<{ n: number }>()
    )?.n,
    2,
  );
  await observeContacts(
    store,
    source,
    [{ contact: current[2], routedDestinations: destinations }],
    now + 3,
  );
  assert.equal((await store.ledger(key(contacts[2].id)))?.state, "live_new");
  assert.equal(
    (
      await store
        .statement(
          "SELECT prior_route_state FROM ledger WHERE tenant='a' AND source='source' AND qso=? AND destination='lotw'",
          contacts[2].id,
        )
        .first<{ prior_route_state: string | null }>()
    )?.prior_route_state,
    null,
  );
  await assertNoGuards(store);
});

test("source revocation, context generation changes and operation expiry between read and commit stay fenced", async (t) => {
  for (const change of ["source", "generation", "operation"] as const)
    await t.test(change, async (t) => {
      const h = await setup();
      t.after(() => h.mf.dispose());
      const { store, source, contacts, destinations, now } = h;
      const measured = measuredStore(store, async (call) => {
        if (call !== 2) return;
        if (change === "source")
          await store
            .statement(
              "UPDATE connections SET status='revoked' WHERE tenant='a' AND id='source'",
            )
            .run();
        else if (change === "generation")
          await store
            .statement(
              "UPDATE cursors SET generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='context'",
            )
            .run();
        else
          await store
            .statement(
              "UPDATE source_work SET expires_at=? WHERE tenant='a' AND source='source' AND id='op-1' AND kind='operation'",
              now,
            )
            .run();
      });
      const results = await observeContacts(
        measured.store,
        source,
        contacts.map((contact) => ({
          contact,
          routedDestinations: destinations,
        })),
        now + 1,
      );
      assert.deepEqual(
        results.map((r) => r.status),
        change === "operation"
          ? ["fulfilled", "rejected", "fulfilled", "fulfilled"]
          : Array(4).fill("rejected"),
      );
      assert.equal(
        (
          await store
            .statement("SELECT COUNT(*) n FROM ledger WHERE tenant='a'")
            .first<{ n: number }>()
        )?.n,
        change === "operation" ? 6 : 0,
      );
      await assertNoGuards(store);
    });
});

test("invalid destinations and oversized members are isolated without splitting a contact", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  const { store, source, destinations, now } = h;
  const many = Array.from({ length: 32 }, (_, index) => ({
    ...destinations[0],
    id: `many-${index}`,
    remote_identity: `many-${index}`,
  }));
  for (const destination of many)
    await store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a',?,'qrz',?,'many','active',0)",
        destination.id,
        destination.remote_identity,
      )
      .run();
  // New routes invalidate queued work; select the current version before
  // testing statement limits rather than knowingly passing stale projections.
  const contacts = (await pendingContacts(store, source, 40, now)).sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  const measured = measuredStore(store);
  const results = await observeContacts(
    measured.store,
    source,
    [
      { contact: contacts[0], routedDestinations: destinations },
      {
        contact: contacts[1],
        routedDestinations: [{ ...destinations[0], tenant: "foreign" }],
      },
      { contact: contacts[2], routedDestinations: many },
      { contact: contacts[3], routedDestinations: destinations },
    ],
    now,
  );
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected", "rejected", "fulfilled"],
  );
  assert.deepEqual(measured.batches, [2, 24]);
  assert.equal(
    (
      await store
        .statement(
          "SELECT COUNT(*) n FROM ledger WHERE qso IN(?,?)",
          contacts[1].id,
          contacts[2].id,
        )
        .first<{ n: number }>()
    )?.n,
    0,
  );
  const input: ContactObservation = {
    contact: contacts[0],
    routedDestinations: destinations,
  };
  await assert.rejects(
    observeContacts(store, source, Array(21).fill(input), now),
    /exceeds_20/,
  );
  await assert.rejects(
    observeContacts(store, source, [input, input], now),
    /duplicate_observation/,
  );
  assert.deepEqual(await observeContacts(store, source, [], now), []);
  await assertNoGuards(store);
});

test("adopted narrative and route policy changed after the shared read cannot be overwritten", async (t) => {
  for (const change of ["narrative", "route"] as const)
    await t.test(change, async (t) => {
      const h = await setup(2);
      t.after(() => h.mf.dispose());
      const { store, source, contacts, destinations, now } = h;
      const observations = contacts.map((contact, index) => ({
        // Exercise the explicit route snapshot fence separately from the
        // queue-version invalidation that current scheduler contacts also get.
        contact:
          change === "route"
            ? { ...contact, reconciliationVersion: undefined }
            : contact,
        routedDestinations: destinations.filter(
          (d) => d.kind === (index === 0 ? "qrz" : "lotw"),
        ),
      }));
      await observeContacts(store, source, observations, now);
      const trustedHash = await sourceFingerprint(contacts[0], "qrz", true);
      const measured = measuredStore(store, async (call) => {
        if (call !== 2) return;
        if (change === "narrative")
          await store
            .statement(
              "UPDATE ledger SET narrative='remote_preserved',source_hash=?,baseline_hash=?,remote_id='adopted',provenance='adopted',state='adopted_existing' WHERE tenant='a' AND source='source' AND qso=? AND destination='destination'",
              trustedHash,
              trustedHash,
              contacts[0].id,
            )
            .run();
        else
          await store
            .statement(
              "UPDATE connections SET config=json_object('stationCallsign','NEWCALL') WHERE tenant='a' AND id='destination'",
            )
            .run();
      });
      const results = await observeContacts(
        measured.store,
        source,
        observations,
        now + 1,
      );
      assert.deepEqual(
        results.map((r) => r.status),
        ["rejected", "fulfilled"],
      );
      if (change === "narrative") {
        const ledger = await store.ledger(key(contacts[0].id, "destination"));
        assert.equal(ledger?.source_hash, trustedHash);
        assert.equal(ledger?.baseline_hash, trustedHash);
        assert.equal(ledger?.narrative, "remote_preserved");
        assert.equal(ledger?.state, "adopted_existing");
      }
      await assertNoGuards(store);
    });
});

test("source work and retained ciphertext remain current at each observation commit", async (t) => {
  for (const change of [
    "revision",
    "queue_version",
    "source_payload",
    "operation_payload",
  ] as const)
    await t.test(change, async (t) => {
      const h = await setup(2);
      t.after(() => h.mf.dispose());
      const { store, source, contacts, destinations, now } = h;
      const changedIndex = change === "operation_payload" ? 1 : 0;
      const measured = measuredStore(store, async (call) => {
        if (call !== 2) return;
        if (change === "revision")
          await store
            .statement(
              "UPDATE source_work SET revision='new-revision' WHERE tenant='a' AND source='source' AND id=? AND kind='qso'",
              contacts[0].id,
            )
            .run();
        else if (change === "queue_version")
          await store
            .statement(
              "UPDATE reconciliation_work SET version=version+1 WHERE tenant='a' AND source='source' AND qso=?",
              contacts[0].id,
            )
            .run();
        else
          await store
            .statement(
              "UPDATE private_data SET revoked_at=? WHERE tenant='a' AND connection='source' AND kind='source' AND id=(SELECT private_id FROM source_work WHERE tenant='a' AND source='source' AND id=? AND kind=?)",
              now,
              change === "operation_payload" ? "op-1" : contacts[0].id,
              change === "operation_payload" ? "operation" : "qso",
            )
            .run();
      });
      const results = await observeContacts(
        measured.store,
        source,
        contacts.map((contact) => ({
          contact,
          routedDestinations: destinations,
        })),
        now + 1,
      );
      assert.deepEqual(
        results.map((r) => r.status),
        contacts.map((_, index) =>
          index === changedIndex ? "rejected" : "fulfilled",
        ),
      );
      assert.equal(await store.ledger(key(contacts[changedIndex].id)), null);
      assert.ok(await store.ledger(key(contacts[1 - changedIndex].id)));
      await assertNoGuards(store);
    });
});
