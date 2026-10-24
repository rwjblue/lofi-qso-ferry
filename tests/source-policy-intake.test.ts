import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  expireSource,
  pendingContactBatch,
  pollSource,
  rereadOperation,
  type Work,
} from "../src/intake.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { sourceReadPolicy } from "../src/source-read-policy.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const contact = (uuid: string, stamp = 100): SourceRecord => ({
  uuid,
  operation: null,
  syncedAtMillis: stamp,
  startAtMillis: 1_792_684_800_000,
  freq: 14074,
  band: "20m",
  mode: "FT8",
  their: { call: "W1AW" },
  our: { stationCall: "N0CALL", grid: "FN31AA", dxccCode: 291 },
});
const operation: SourceRecord = {
  uuid: "operation",
  syncedAtMillis: 99,
  stationCall: "N0CALL",
  grid: "FN31AA",
};
const reply = (
  qsos: SourceRecord[] = [],
  operations: SourceRecord[] = [],
  remaining = 0,
) =>
  new Response(
    JSON.stringify({
      account: { uuid: "source" },
      operations,
      qsos,
      meta: {
        operations: { records_left: 0 },
        qsos: {
          records_left: remaining,
          ...(remaining
            ? { next_cursor: `next-${qsos[0]?.uuid ?? "empty"}` }
            : {}),
        },
      },
    }),
  );

async function setup(t: TestContext) {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && !name.startsWith("0001_"))
    .sort())
    await applyMigration(h.db, name);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET credential_version='v2',config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "v2", "credential", {
      key: "browser:test",
      secret: "test-secret",
      token: "test-token",
    })
  ).run();
  const source = (await h.store.connection("a", "source"))!;
  const now = Date.now();
  let turn = 0;
  const requests: {
    operations: Record<string, unknown>;
    qsos: Record<string, unknown>;
  }[] = [];
  const poll = (
    qsos: SourceRecord[] = [],
    operations: SourceRecord[] = [],
    remaining = 0,
    stream = "sync",
  ) =>
    pollSource(
      h.store,
      source,
      async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(Object.keys(body), ["meta"]);
        requests.push(body.meta.sync);
        return reply(qsos, operations, remaining);
      },
      now + ++turn * 300_000,
      stream,
    );
  const row = (id: string, kind = "qso") =>
    h.store
      .statement(
        "SELECT * FROM source_work WHERE tenant='a' AND source='source' AND id=? AND kind=?",
        id,
        kind,
      )
      .first<Work>();
  const policy = () => sourceReadPolicy(h.store, "a", "source");
  const context = async () =>
    JSON.parse(
      (await h.store
        .statement(
          "SELECT cursor FROM cursors WHERE tenant='a' AND connection='source' AND stream='context'",
        )
        .first<{ cursor: string }>())!.cursor,
    );
  return { ...h, source, now, requests, poll, row, policy, context };
}

test("all-client baseline and forward drain stay historical until a fresh final handoff", async (t) => {
  const h = await setup(t);
  const baseline = await h.poll([contact("baseline")]);
  assert.equal(baseline.complete, false);
  assert.equal(baseline.policyProgress, true);
  assert.equal((await h.policy())?.phase, "drain");
  assert.equal((await h.context()).complete, false);
  assert.equal((await h.poll([contact("drain", 101)])).complete, false);
  assert.equal((await h.policy())?.phase, "quarantine");
  assert.equal((await h.context()).complete, false);
  const partial = await h.poll([contact("partial", 102)], [], 1);
  assert.equal(partial.complete, false);
  assert.equal(partial.policyProgress, undefined);
  assert.equal((await h.policy())?.phase, "quarantine");
  assert.equal((await h.context()).complete, false);
  assert.equal((await h.poll([contact("handoff", 103)])).complete, true);
  const ready = (await h.policy())!;
  assert.equal(ready.phase, "ready");
  assert.equal((await h.context()).complete, true);
  assert.equal(
    (await h.poll([contact("later", 104)])).policyProgress,
    undefined,
  );
  const births = (
    await h.store
      .statement("SELECT qso,phase FROM source_births ORDER BY qso")
      .all()
  ).results;
  assert.deepEqual(births, [
    { qso: "baseline", phase: "history" },
    { qso: "drain", phase: "history" },
    { qso: "handoff", phase: "history" },
    { qso: "later", phase: "forward_new" },
    { qso: "partial", phase: "history" },
  ]);
  assert.ok(
    h.requests.every(
      (r) => r.operations.anyClient === true && r.qsos.anyClient === true,
    ),
  );
  assert.deepEqual(
    h.requests.map((r) => r.qsos.limit),
    [25, 25, 25, 25, 100],
  );
  assert.equal((await h.row("baseline"))?.policy_seen_epoch, ready.epoch);
});

test("unchanged current rows gain membership without replacing bodies; older replay does not certify newer retained versions", async (t) => {
  const h = await setup(t);
  await h.poll([contact("same"), contact("newer", 300)], [], 0, "repair");
  const before = (await h.row("same"))!;
  await h.poll([contact("same"), contact("newer", 200)]);
  const epoch = (await h.policy())!.epoch;
  const same = (await h.row("same"))!;
  assert.equal(same.private_id, before.private_id);
  assert.equal(same.policy_seen_epoch, epoch);
  assert.equal((await h.row("newer"))?.policy_seen_epoch, null);
  const emptyDrain = await h.poll();
  assert.equal(emptyDrain.records, 0);
  assert.equal(emptyDrain.policyProgress, true);
  await h.poll();
  assert.equal((await h.row("newer"))?.state, "missing_from_inventory");
  assert.equal((await h.row("newer"))?.deleted, 0);
  await h.poll([contact("newer", 300)]);
  assert.equal((await h.row("newer"))?.state, "pending");
  assert.equal((await h.row("newer"))?.policy_seen_epoch, epoch);
});

test("quarantine is bounded, holds all record kinds, and cancels only linked prepared attempts", async (t) => {
  const h = await setup(t);
  const keys = Array.from(
    { length: 102 },
    (_, i) => `old-${String(i).padStart(3, "0")}`,
  );
  for (const id of keys)
    await h.store
      .statement(
        "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at,deleted,is_event) VALUES('a','source',?,'qso',?,'old',?,?,?)",
        id,
        id,
        h.now + 86400_000,
        Number(id === keys[0]),
        Number(id === keys[1]),
      )
      .run();
  await h.store
    .statement(
      "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,expires_at) VALUES('a','source','absent-base','operation','absent-base','absent-body','old',?)",
      h.now + 86400_000,
    )
    .run();
  for (const [id, status] of [
    ["prepared", "prepared"],
    ["sent", "uncertain"],
  ]) {
    const qso = keys[id === "prepared" ? 0 : 1];
    await h.store.observe(
      { tenant: "a", source: "source", qso, destination: "destination" },
      "generation",
      "hash",
      20,
      false,
      h.now,
    );
    await h.store
      .statement(
        "INSERT INTO attempts VALUES('a',?,'source',?,'destination','generation',?,'hash',NULL,'v1',?,'hash')",
        id,
        qso,
        `payload-${id}`,
        h.now,
      )
      .run();
    await h.store
      .statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,?,?,?)",
        id,
        status,
        h.now,
        h.now,
      )
      .run();
    await (
      await h.store.putPrivate("a", "destination", `payload-${id}`, "outbox", {
        sample: true,
      })
    ).run();
  }
  await h.poll();
  await h.poll();
  assert.equal((await h.poll()).complete, false);
  assert.equal((await h.policy())?.phase, "quarantine");
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) n FROM source_work WHERE state='missing_from_inventory'",
      )
      .first("n"),
    100,
  );
  assert.equal((await h.context()).complete, false);
  assert.equal((await h.poll()).complete, true);
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) n FROM source_work WHERE state='missing_from_inventory'",
      )
      .first("n"),
    103,
  );
  assert.equal(
    (await h.row("absent-base", "operation"))?.state,
    "missing_from_inventory",
  );
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt='prepared'")
      .first("state"),
    "cancelled",
  );
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt='sent'")
      .first("state"),
    "uncertain",
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM private_data WHERE kind='outbox'")
      .first("n"),
    1,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM source_work WHERE deleted=1")
      .first("n"),
    1,
  );
});

test("operation rereads cannot bypass baseline or restore missing canonical membership", async (t) => {
  const h = await setup(t);
  const qso = { ...contact("member"), operation: "operation" };
  await h.poll([qso], [operation]);
  let calls = 0;
  const reread = (rows: SourceRecord[]) =>
    rereadOperation(
      h.store,
      h.source,
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ qsos: rows, meta: { qsos: { records_left: 0 } } }),
        );
      },
      h.now + 1_800_000 + calls * 300_000,
    );
  assert.equal((await reread([qso])).pages, 0);
  assert.equal(calls, 0);
  await h.poll();
  await h.poll();
  await h.store
    .statement(
      "UPDATE source_work SET policy_seen_epoch=NULL,state='missing_from_inventory' WHERE id='member'",
    )
    .run();
  await reread([qso]);
  assert.equal((await h.row("member"))?.policy_seen_epoch, null);
  assert.equal((await h.row("member"))?.state, "missing_from_inventory");
  assert.equal(
    (await pendingContactBatch(h.store, h.source, 20, h.now + 2_000_000))
      .contacts.length,
    0,
  );
  await h.poll([qso]);
  assert.equal(
    (await h.row("member"))?.policy_seen_epoch,
    (await h.policy())?.epoch,
  );
  await h.store
    .statement("UPDATE source_work SET state='pending' WHERE kind='operation'")
    .run();
  await reread([{ ...qso, syncedAtMillis: 101 }]);
  assert.equal(
    (await h.row("member"))?.policy_seen_epoch,
    null,
    "a newer REST-only version needs canonical validation",
  );
});

test("expiry and cursor gaps start fresh tagged epochs without restarting active baseline pages", async (t) => {
  const h = await setup(t);
  await h.poll([], [operation]);
  await h.poll();
  await h.poll();
  const before = (await h.policy())!;
  await h.store
    .statement(
      "UPDATE source_work SET expires_at=? WHERE kind='operation'",
      h.now,
    )
    .run();
  await expireSource(h.store, h.now + 2_000_000);
  assert.equal(
    (await h.policy())?.epoch,
    before.epoch,
    "maintenance only invalidates; reset needs the poll lease",
  );
  await h.poll([contact("page-one")], [], 1);
  const restarted = (await h.policy())!;
  assert.notEqual(restarted.epoch, before.epoch);
  assert.equal(restarted.phase, "backfill");
  await h.poll([contact("page-two", 90)], [], 1);
  assert.equal((await h.policy())?.epoch, restarted.epoch);
  await assert.rejects(
    pollSource(
      h.store,
      h.source,
      async () =>
        new Response(
          JSON.stringify({
            account: { uuid: "source" },
            operations: [],
            qsos: [],
            meta: {
              operations: { records_left: 0 },
              qsos: { records_left: 0 },
            },
            errors: { qsos: { cursor: "expired" } },
          }),
        ),
      h.now + 3_000_000,
    ),
    /cursor_or_record_reconciliation_required/,
  );
  const after = (await h.policy())!;
  assert.notEqual(after.epoch, restarted.epoch);
  assert.equal(after.phase, "backfill");
  const saved = JSON.parse(
    (await h.store
      .statement("SELECT cursor FROM cursors WHERE stream='sync'")
      .first<{ cursor: string }>())!.cursor,
  );
  assert.equal(saved.readerPolicy, "all-clients-v1");
  assert.equal(saved.policyEpoch, after.epoch);
  assert.deepEqual(saved.qsos, {});
  assert.equal((await h.context()).complete, false);
});

test("a current positive witness in the quarantine page wins over the earlier absence selection", async (t) => {
  const h = await setup(t);
  await h.poll([contact("returns")], [], 0, "repair");
  await h.store.observe(
    {
      tenant: "a",
      source: "source",
      qso: "returns",
      destination: "destination",
    },
    "generation",
    "hash",
    20,
    false,
    h.now,
  );
  await h.db.batch([
    h.store.statement(
      "INSERT INTO attempts VALUES('a','preserved','source','returns','destination','generation','preserved-payload','hash',NULL,'v1',?,'hash')",
      h.now,
    ),
    h.store.statement(
      "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','preserved','prepared',?,?)",
      h.now,
      h.now,
    ),
    await h.store.putPrivate(
      "a",
      "destination",
      "preserved-payload",
      "outbox",
      { sample: true },
    ),
  ]);
  await h.poll();
  await h.poll();
  assert.equal((await h.row("returns"))?.policy_seen_epoch, null);
  assert.equal((await h.poll([contact("returns")])).complete, true);
  assert.equal((await h.row("returns"))?.state, "pending");
  assert.equal(
    (await h.row("returns"))?.policy_seen_epoch,
    (await h.policy())?.epoch,
  );
  assert.equal((await h.context()).complete, true);
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt='preserved'")
      .first("state"),
    "prepared",
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM private_data WHERE kind='outbox'")
      .first("n"),
    1,
  );
});

test("a changed source credential rolls back page membership, birth, and phase together", async (t) => {
  const h = await setup(t);
  await assert.rejects(
    pollSource(
      h.store,
      h.source,
      async () => {
        await h.store
          .statement(
            "UPDATE connections SET credential_version='replacement' WHERE tenant='a' AND id='source'",
          )
          .run();
        return reply([contact("not-committed")]);
      },
      h.now,
    ),
    /source connection changed/,
  );
  assert.equal((await h.policy())?.phase, "backfill");
  assert.equal((await h.context()).complete, false);
  assert.equal(await h.row("not-committed"), null);
  assert.equal(
    await h.store.statement("SELECT count(*) n FROM source_births").first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT generation FROM cursors WHERE stream='sync'")
      .first("generation"),
    1,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM source_write_guards")
      .first("n"),
    0,
  );
});

test("an expired exact-version REST body refresh preserves witnessed membership", async (t) => {
  const h = await setup(t);
  const member = { ...contact("member"), operation: "operation" };
  await h.poll([member], [operation]);
  await h.poll();
  await h.poll();
  const before = (await h.row("member"))!;
  await h.store
    .statement("UPDATE source_work SET expires_at=? WHERE id='member'", h.now)
    .run();
  await rereadOperation(
    h.store,
    h.source,
    async () =>
      new Response(
        JSON.stringify({ qsos: [member], meta: { qsos: { records_left: 0 } } }),
      ),
    h.now + 1_800_000,
  );
  const after = (await h.row("member"))!;
  assert.equal(after.revision, before.revision);
  assert.equal(after.synced_at, before.synced_at);
  assert.notEqual(after.private_id, before.private_id);
  assert.equal(after.policy_seen_epoch, before.policy_seen_epoch);
  assert.equal(
    (await pendingContactBatch(h.store, h.source, 20, h.now + 1_800_000))
      .contacts.length,
    1,
  );
});
