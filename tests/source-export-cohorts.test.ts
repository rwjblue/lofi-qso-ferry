import assert from "node:assert/strict";
import test from "node:test";
import type { SourceRecord } from "../src/lofi.ts";
import { tick } from "../src/service.ts";
import { qrzUploadWorkload } from "./qrz-upload-workload.ts";
import { sourceExportFixture } from "./source-export-fixtures.ts";

test("one source collection proves six contacts across unchanged fair dispatch rounds", async () => {
  const [run] = await qrzUploadWorkload("direct-six");
  assert.equal(run.uploads, 6);
  assert.equal(run.proofs, 6);
  assert(
    run.database.calls < 410,
    "the scheduler must use bulk preparation and dispatch",
  );
  assert(
    run.rounds >= 3,
    "proof sharing preserves the per-round dispatch limit",
  );
  assert.equal(
    run.sourceRequests,
    3,
    "one canonical poll, one collection and one final drain",
  );
  assert.deepEqual(run.requests, {
    target: 12,
    status: 0,
    cover: 0,
    insert: 6,
  });
});

test("source-only lookahead never uploads an unscanned contact or overruns QRZ quota", async () => {
  const [run] = await qrzUploadWorkload("fallback-six");
  assert.equal(run.uploads, 4);
  assert.equal(run.proofs, 6);
  assert.equal(run.sourceRequests, 3);
  assert.equal(
    Object.values(run.requests).reduce((sum, count) => sum + count, 0),
    24,
  );
  assert(
    run.contacts <= 8,
    "exhausted QRZ quota stops another deferred contact turn",
  );
  assert(
    run.database.calls < 340,
    "the fallback workload must retain bulk execution savings",
  );
});

test("idle work stays bounded while canonical polling remains fresh", async () => {
  const [, idle] = await qrzUploadWorkload("direct");
  assert.equal(idle.uploads, 0);
  assert.equal(idle.sourceRequests, 1);
  assert.equal(
    idle.rounds,
    1,
    "an empty fresh poll does not schedule another idle round",
  );
  assert.equal(
    Object.values(idle.requests).reduce((sum, count) => sum + count, 0),
    0,
  );
  assert(idle.database.calls <= 60);
  assert(idle.database.statements <= 90);
});

test("a request-limited lookahead resumes only its proven non-prefix contacts without collecting again", async (t) => {
  const h = await sourceExportFixture(
    t,
    (state, qsos) => {
      state.qrzRecords.length = 0;
      state.qso.syncedAtMillis = 1000;
      for (let i = 2; i <= 6; i++)
        qsos.push({
          ...structuredClone(state.qso),
          uuid: `q${i}`,
          their: { call: `K${i}FIT` },
          syncedAtMillis: 1000 + (i - 1) * 50,
        });
    },
    40,
    "inventory_pending",
  );
  h.enable();
  h.env.SOURCE_BOUNDARY_VERIFIED = "false";
  h.env.QRZ_FRESH_INSERTS_ENABLED = "true";
  h.env.LOTW_FRESH_INSERTS_ENABLED = "false";
  h.env.ROLLOUT_QSO_IDS_JSON = JSON.stringify(h.qsos.map((qso) => qso.uuid));
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  const spread = h.qsos.flatMap((qso) => [
    qso,
    ...Array.from({ length: 24 }, (_, i) => ({
      ...qso,
      uuid: `${qso.uuid}-neighbor-${i}`,
      syncedAtMillis: Number(qso.syncedAtMillis) - i - 1,
    })),
  ]);
  let collections = 0;
  let unprovenReads = 0;
  const before = h.calls.sourceSync;
  const result = await tick(h.env, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/v1/sync") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("OPTION")?.split(",").includes("CALL:K3FIT"))
        unprovenReads++;
      return h.fetcher(input, init);
    }
    const sync = JSON.parse(String(init?.body)).meta.sync;
    if (sync.qsos.syncedSinceMillis !== undefined)
      return h.fetcher(input, init);
    collections++;
    h.calls.sourceSync++;
    const page = (rows: SourceRecord[], upper: number) =>
      rows
        .filter((row) => Number(row.syncedAtMillis) < upper)
        .sort((a, b) => Number(b.syncedAtMillis) - Number(a.syncedAtMillis))
        .slice(0, 25);
    return Response.json({
      account: { uuid: "account-fixture" },
      operations: page(h.operations, sync.operations.syncedUntilMillis),
      qsos: page(spread, sync.qsos.syncedUntilMillis),
      meta: {
        operations: { records_left: 0 },
        qsos: { records_left: 1, next_cursor: `page-${collections}` },
      },
    });
  });
  assert.equal(result.errors, 0);
  assert(result.deferred > 0);
  assert.equal(collections, 3);
  assert.equal(
    h.calls.sourceSync - before,
    5,
    "one canonical poll plus the four-request proof allowance",
  );
  const attempts = (
    await h.store
      .statement("SELECT qso FROM attempts ORDER BY qso")
      .all<{ qso: string }>()
  ).results;
  assert.deepEqual(
    attempts.map((row) => row.qso),
    ["q4", "q5", "q6"],
  );
  assert.equal(h.calls.qrzWrites, 3);
  assert.equal(
    unprovenReads,
    0,
    "exhausted collection allowance cannot wake an unproved lookahead",
  );
});
