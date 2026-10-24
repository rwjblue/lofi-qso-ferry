import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { pollSource, rereadOperation } from "../src/intake.ts";
import type { SourceRecord } from "../src/lofi.ts";
import {
  loadSourcePresence,
  recordSourcePresence,
  type SourcePresenceScope,
  type SourcePresenceTarget,
} from "../src/source-presence-store.ts";
import {
  resetSourceReadPolicy,
  sourceReadPolicy,
} from "../src/source-read-policy.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const contact = (stamp = 100): SourceRecord => ({
  uuid: "qso",
  operation: null,
  syncedAtMillis: stamp,
  startAtMillis: 1_792_684_800_000,
  band: "20m",
  mode: "FT8",
  freq: 14074,
  their: { call: "W1AW" },
  our: { stationCall: "N0CALL", grid: "FN31AA", dxccCode: 291 },
});
const operation: SourceRecord = {
  uuid: "operation",
  syncedAtMillis: 99,
  stationCall: "N0CALL",
  grid: "FN31AA",
};
const reply = (qsos: SourceRecord[] = [], operations: SourceRecord[] = []) =>
  new Response(
    JSON.stringify({
      account: { uuid: "source" },
      operations,
      qsos,
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    }),
  );
interface PresenceRow {
  id: string;
  kind: "operation" | "qso";
  operation_id: string | null;
  revision: string;
  synced_at: number;
  deleted: number;
  is_event: number;
  private_id: string;
  policy_seen_epoch: string | null;
  positive_observed_at: number | null;
  positive_policy_epoch: string | null;
  positive_credential_version: string | null;
}
async function setup(t: TestContext) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET credential_version='v2',config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "v2", "credential", {
      key: "browser:fixture",
      secret: "fixture-secret",
      token: "fixture-token",
    })
  ).run();
  const source = (await h.store.connection("a", "source"))!;
  const start = Date.now();
  let time = start;
  let calls = 0;
  const poll = async (
    qsos: SourceRecord[] = [],
    operations: SourceRecord[] = [],
    stream = "sync",
    beforeReply?: () => Promise<unknown>,
  ) => {
    time = Math.max(time + 1000, Date.now());
    const began = Date.now();
    try {
      return await pollSource(
        h.store,
        source,
        async () => {
          await beforeReply?.();
          return reply(qsos, operations);
        },
        time,
        stream,
        start + ++calls * 300_000,
      );
    } finally {
      time += Math.max(0, Date.now() - began);
    }
  };
  const row = (id = "qso", kind = "qso") =>
    h.store
      .statement(
        "SELECT * FROM source_work WHERE tenant='a' AND source='source' AND id=? AND kind=?",
        id,
        kind,
      )
      .first<PresenceRow>();
  const scope = async (): Promise<SourcePresenceScope> => ({
    tenant: "a",
    source: "source",
    accountId: "source",
    readerPolicy: "all-clients-v1",
    policyEpoch: (await sourceReadPolicy(h.store, "a", "source"))!.epoch,
    credentialVersion: "v2",
  });
  const target = async (
    id = "qso",
    kind = "qso",
  ): Promise<SourcePresenceTarget> => {
    const r = (await row(id, kind))!;
    return {
      kind: r.kind,
      id: r.id,
      operationId: r.operation_id,
      revision: r.revision,
      syncedAtMillis: r.synced_at,
      deleted: r.deleted === 1,
      isEvent: r.is_event === 1,
    };
  };
  const load = async (at = time + 500) =>
    loadSourcePresence(h.store, await scope(), [await target()], at);
  const ready = async (qsos = [contact()], operations: SourceRecord[] = []) => {
    await poll(qsos, operations);
    await poll();
    await poll();
    assert.equal(
      (await sourceReadPolicy(h.store, "a", "source"))!.phase,
      "ready",
    );
  };
  return {
    ...h,
    source,
    start,
    poll,
    row,
    scope,
    target,
    load,
    ready,
    now: () => time,
  };
}

test("canonical positives retain call-start freshness across empty handoff and cache reuse", async (t) => {
  const h = await setup(t);
  await h.poll([contact()], [operation]);
  const first = (await h.row())!;
  assert.ok(first.positive_observed_at! >= h.start + 1000);
  assert.ok(first.positive_observed_at! <= h.now());
  assert.equal(first.positive_credential_version, "v2");
  assert.deepEqual(
    await h.load(),
    [null],
    "baseline observations are not ready-policy evidence",
  );
  await h.poll();
  await h.poll();
  assert.equal(
    (await h.row())!.positive_observed_at,
    first.positive_observed_at,
  );
  const witness = (await h.load())[0]!;
  assert.equal(witness.requestStartedAt, first.positive_observed_at);
  assert.deepEqual(
    await h.load(),
    [witness],
    "cached reads retain original freshness",
  );
  const operationTarget = await h.target("operation", "operation");
  assert.equal(operationTarget.operationId, "operation");
  assert.equal(
    (
      await loadSourcePresence(
        h.store,
        await h.scope(),
        [operationTarget],
        h.now() + 500,
      )
    )[0]?.requestStartedAt,
    first.positive_observed_at,
  );
  assert.deepEqual(Object.keys(witness).sort(), [
    "requestStartedAt",
    "scope",
    "target",
  ]);
  const queries: { sql: string; params: (string | number | null)[] }[] = [];
  const inspected = new Proxy(h.store, {
    get(store, property, receiver) {
      if (property === "statement")
        return (sql: string, ...params: (string | number | null)[]) => {
          queries.push({ sql, params });
          return store.statement(sql, ...params);
        };
      return Reflect.get(store, property, receiver);
    },
  });
  await loadSourcePresence(
    inspected,
    await h.scope(),
    [await h.target()],
    h.now() + 500,
  );
  assert.equal(queries.length, 1);
  const plan = await h.store
    .statement(`EXPLAIN QUERY PLAN ${queries[0].sql}`, ...queries[0].params)
    .all<{ detail: string }>();
  const lookup = plan.results.find((row) =>
    row.detail.startsWith("SEARCH w "),
  )?.detail;
  assert.ok(
    lookup?.includes("(tenant=? AND source=? AND id=? AND kind=?)"),
    "source lookup must constrain each requested identity, not scan the whole epoch",
  );
  assert.equal(
    await h.store.statement("SELECT count(*) FROM attempts").first("count(*)"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_cutovers")
      .first("count(*)"),
    0,
  );
});

test("only accepted exact current versions renew; older same-page replays cannot", async (t) => {
  const h = await setup(t);
  await h.ready([contact(100), contact(200)]);
  const first = (await h.row())!;
  assert.equal(first.synced_at, 200);
  await h.poll([contact(100)]);
  assert.equal(
    (await h.row())!.positive_observed_at,
    first.positive_observed_at,
  );
  await h.poll([contact(200), contact(100)]);
  const refreshed = (await h.row())!;
  assert.equal(refreshed.synced_at, 200);
  assert.ok(refreshed.positive_observed_at! > first.positive_observed_at!);
  const result = (await h.load())[0]!;
  assert.equal(result.target.syncedAtMillis, 200);
  assert.equal(result.requestStartedAt, refreshed.positive_observed_at);
});

test("same-stamp conflicting bodies roll back all page observations", async (t) => {
  const h = await setup(t);
  await h.ready();
  const before = await h.row();
  const cursor = await h.store
    .statement(
      "SELECT generation FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
    )
    .first("generation");
  await assert.rejects(
    h.poll([contact(), { ...contact(), mode: "CW" }]),
    /conflicting_server_timestamp/,
  );
  assert.deepEqual(await h.row(), before);
  assert.equal(
    await h.store
      .statement(
        "SELECT generation FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
      )
      .first("generation"),
    cursor,
  );
});

test("lost checkpoint lease rolls back positive renewal and new rows together", async (t) => {
  const h = await setup(t);
  await h.ready();
  const before = await h.row();
  await assert.rejects(
    h.poll([contact(), { ...contact(200), uuid: "new-qso" }], [], "sync", () =>
      h.store
        .statement(
          "UPDATE leases SET fence=fence+1 WHERE tenant='a' AND scope='poll:source:sync'",
        )
        .run(),
    ),
  );
  assert.deepEqual(await h.row(), before);
  assert.equal(await h.row("new-qso"), null);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM checkpoint_guards")
      .first("count(*)"),
    0,
  );
});

test("source credential replacement during a page cannot record a positive", async (t) => {
  const h = await setup(t);
  await h.ready();
  const before = await h.row();
  await assert.rejects(
    h.poll([contact()], [], "sync", () =>
      h.store
        .statement(
          "UPDATE connections SET credential_version='replacement' WHERE tenant='a' AND id='source'",
        )
        .run(),
    ),
  );
  assert.deepEqual(await h.row(), before);
  assert.deepEqual(await h.load(), [null]);
});

test("REST rereads, ciphertext renewal and destination rescans never renew a positive", async (t) => {
  const h = await setup(t);
  const qso = { ...contact(), operation: "operation" };
  await h.ready([qso], [operation]);
  const before = (await h.row())!;
  await h.store
    .statement(
      "UPDATE source_work SET expires_at=0 WHERE tenant='a' AND source='source' AND id='qso'",
    )
    .run();
  await h.store
    .statement(
      "UPDATE private_data SET expires_at=0 WHERE tenant='a' AND connection='source' AND id=?",
      before.private_id,
    )
    .run();
  await rereadOperation(
    h.store,
    h.source,
    async () => reply([qso]),
    h.now() + 1000,
    undefined,
    h.now() + 300_000,
  );
  const renewed = (await h.row())!;
  assert.notEqual(renewed.private_id, before.private_id);
  assert.equal(renewed.positive_observed_at, before.positive_observed_at);
  assert.equal(renewed.policy_seen_epoch, before.policy_seen_epoch);
  await h.poll([qso], [], "rescan:destination");
  assert.equal(
    (await h.row())!.positive_observed_at,
    before.positive_observed_at,
  );
  assert.equal(
    (await h.load())[0]?.requestStartedAt,
    before.positive_observed_at,
  );
});

test("old-worker semantic and metadata changes clear positives instead of inheriting them", async (t) => {
  const h = await setup(t);
  for (const [field, value] of [
    ["revision", "changed"],
    ["synced_at", 101],
    ["operation_id", "different"],
    ["deleted", 1],
    ["is_event", 1],
  ] as const) {
    // Fresh canonical records populate a separate witness for each mutation.
    const id = `row-${field}`;
    await h.poll([{ ...contact(), uuid: id }]);
    assert.notEqual((await h.row(id))!.positive_observed_at, null);
    await h.store
      .statement(
        `UPDATE source_work SET ${field}=? WHERE tenant='a' AND source='source' AND id=? AND kind='qso'`,
        value,
        id,
      )
      .run();
    const changed = (await h.row(id))!;
    assert.equal(changed.positive_observed_at, null);
    assert.equal(changed.positive_policy_epoch, null);
    assert.equal(changed.positive_credential_version, null);
  }
});

test("exact target, tenant, account, credential and policy scope are mandatory", async (t) => {
  const h = await setup(t);
  await h.ready();
  const scope = await h.scope();
  const target = await h.target();
  const now = h.now() + 500;
  for (const changed of [
    { tenant: "other" },
    { source: "destination" },
    { accountId: "other" },
    { credentialVersion: "v1" },
    { policyEpoch: "other" },
  ])
    assert.deepEqual(
      await loadSourcePresence(
        h.store,
        { ...scope, ...changed },
        [target],
        now,
      ),
      [null],
    );
  for (const changed of [
    { id: "other" },
    { revision: "other" },
    { syncedAtMillis: 101 },
    { operationId: "other" },
    { deleted: true },
    { isEvent: true },
  ])
    assert.deepEqual(
      await loadSourcePresence(
        h.store,
        scope,
        [{ ...target, ...changed }],
        now,
      ),
      [null],
    );
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "other" }),
    )
    .run();
  assert.deepEqual(await h.load(), [null]);
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await h.store
    .statement("UPDATE accounts SET status='revoked' WHERE id='a'")
    .run();
  assert.deepEqual(await h.load(), [null]);
});

test("expired, future, revoked and over-age evidence fails closed without renewal", async (t) => {
  const h = await setup(t);
  await h.ready();
  const scope = await h.scope();
  const target = await h.target();
  const observed = (await h.row())!.positive_observed_at!;
  assert.deepEqual(
    await loadSourcePresence(h.store, scope, [target], observed - 1),
    [null],
  );
  assert.deepEqual(
    await loadSourcePresence(
      h.store,
      scope,
      [target],
      observed + 300_000,
      999_999,
    ),
    [null],
    "override cannot exceed five minutes, including the exact expiry boundary",
  );
  await assert.rejects(
    loadSourcePresence(h.store, scope, [target], NaN),
    /invalid_source_presence_request/,
  );
  await assert.rejects(
    loadSourcePresence(
      h.store,
      scope,
      Array.from({ length: 65 }, () => target),
      observed,
    ),
    /invalid_source_presence_request/,
  );
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=1 WHERE tenant='a' AND connection='source' AND kind='credential' AND id='v2'",
    )
    .run();
  assert.deepEqual(await h.load(), [null]);
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=NULL WHERE tenant='a' AND connection='source' AND kind='credential' AND id='v2'",
    )
    .run();
  await h.store
    .statement(
      "UPDATE private_data SET expires_at=? WHERE tenant='a' AND connection='source' AND kind='source'",
      h.now(),
    )
    .run();
  assert.deepEqual(await h.load(), [null]);
  assert.equal((await h.row())!.positive_observed_at, observed);
});

test("policy reset invalidates retained witnesses without rewriting their times", async (t) => {
  const h = await setup(t);
  await h.ready();
  const before = (await h.row())!;
  const oldScope = await h.scope();
  const target = await h.target();
  const lease = (await h.store.claim(
    "a",
    "poll:source:sync",
    h.now() + 2000,
    90_000,
  ))!;
  const cursor = (await h.store
    .statement(
      "SELECT generation FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
    )
    .first<{ generation: number }>())!;
  await resetSourceReadPolicy(
    h.store,
    h.source,
    lease,
    { epoch: oldScope.policyEpoch, generation: cursor.generation },
    "cursor_gap",
    h.now() + 2000,
  );
  assert.deepEqual(
    await loadSourcePresence(h.store, oldScope, [target], h.now() + 2500),
    [null],
  );
  assert.deepEqual(await h.load(h.now() + 2500), [null]);
  assert.equal(
    (await h.row())!.positive_observed_at,
    before.positive_observed_at,
  );
  await h.store.release(lease);
});

test("observation writes require a canonical checkpoint and never move time backward", async (t) => {
  const h = await setup(t);
  await h.ready();
  const scope = await h.scope();
  const target = await h.target();
  const before = (await h.row())!.positive_observed_at!;
  await assert.rejects(
    recordSourcePresence(
      h.store,
      h.source,
      target,
      scope.policyEpoch,
      h.now() + 1000,
    ).run(),
    /canonical checkpoint/,
  );
  assert.equal((await h.row())!.positive_observed_at, before);
  const lease = (await h.store.claim(
    "a",
    "poll:source:sync",
    h.now() + 2000,
    90_000,
  ))!;
  const saved = (await h.store
    .statement(
      "SELECT generation,cursor FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
    )
    .first<{ generation: number; cursor: string }>())!;
  await h.store.checkpoint(
    lease,
    "source",
    "sync",
    saved.generation,
    JSON.parse(saved.cursor),
    [
      recordSourcePresence(
        h.store,
        h.source,
        target,
        scope.policyEpoch,
        before - 1,
      ),
    ],
    h.now() + 2000,
  );
  assert.equal((await h.row())!.positive_observed_at, before);
  await h.store.release(lease);
});
