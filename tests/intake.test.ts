import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  expireSource,
  observeContact,
  pendingContacts,
  pollSource,
  rereadOperation,
} from "../src/intake.ts";
import type { Work } from "../src/intake.ts";
import { LoFiError, type SourceRecord } from "../src/lofi.ts";
import { sourceFingerprint } from "../src/projection.ts";
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
      ["0004_intake.sql", "0005_cutover.sql"].map((file) =>
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
    .first<Work>();
}

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
    rereadOperation(store, source, pages, now + 4),
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
    await rereadOperation(store, source, pages, now + 9);
    assert.equal((await work(state, "op-1", "operation"))?.state, "context");
    assert.equal(
      (await pendingContacts(store, source, 40, now + 10)).find(
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
        now + 10 + operation,
      );
    assert.ok(
      (await pendingContacts(store, source, 40, now + 13)).some(
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
    const lease = await store.claim("a", "delivery", now + 3);
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
