import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { SourceRecord } from "../src/lofi.ts";
import { tick } from "../src/service.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";

async function fixture(
  t: TestContext,
  setup?: (
    h: Awaited<ReturnType<typeof schedulerFixture>>,
    qsos: SourceRecord[],
  ) => void,
) {
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  await h.store
    .statement("UPDATE connections SET status='disabled' WHERE id='lotw'")
    .run();
  await h.store
    .statement("UPDATE accounts SET quiet_minutes=20 WHERE id='a'")
    .run();
  const operations = [h.operation];
  const qsos = [h.qso];
  setup?.(h, qsos);
  const sourceReads: { forward: boolean; until?: number }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/sync") {
      h.calls.sourceSync++;
      const request = JSON.parse(String(init?.body)).meta.sync;
      assert.equal(request.operations.anyClient, true);
      assert.equal(request.qsos.anyClient, true);
      const forward = request.qsos.syncedSinceMillis !== undefined;
      sourceReads.push({
        forward,
        ...(forward ? {} : { until: request.qsos.syncedUntilMillis }),
      });
      const page = (
        rows: SourceRecord[],
        side: {
          syncedSinceMillis?: number;
          syncedUntilMillis?: number;
          limit: number;
        },
      ) => {
        const filtered = rows
          .filter((row) =>
            side.syncedSinceMillis === undefined
              ? Number(row.syncedAtMillis) < Number(side.syncedUntilMillis)
              : Number(row.syncedAtMillis) > side.syncedSinceMillis,
          )
          .sort(
            (a, b) =>
              (side.syncedSinceMillis === undefined ? -1 : 1) *
              (Number(a.syncedAtMillis) - Number(b.syncedAtMillis)),
          );
        return {
          rows: filtered.slice(0, side.limit),
          remaining: Math.max(0, filtered.length - side.limit),
        };
      };
      const ops = page(operations, request.operations);
      const contacts = page(qsos, request.qsos);
      return Response.json({
        account: { uuid: "account-fixture" },
        operations: ops.rows,
        qsos: contacts.rows,
        meta: {
          operations: { records_left: ops.remaining },
          qsos: { records_left: contacts.remaining },
        },
      });
    }
    if (url.pathname === "/v1/operations/op-fixture/qsos") {
      h.calls.reread++;
      if (h.errors.reread) throw new Error("synthetic reread failure");
      return Response.json({
        qsos: qsos.filter((row) => row.operation === "op-fixture"),
        meta: { qsos: { records_left: 0 } },
      });
    }
    return h.fetcher(input, init);
  };
  const count = async (
    table: "source_export_proofs" | "attempts" | "attempt_source_export_proofs",
  ) =>
    (await h.store
      .statement(`SELECT count(*) AS n FROM ${table}`)
      .first<{ n: number }>())!.n;
  for (let turn = 0; turn < 3; turn++) {
    await tick(h.env, fetcher, Date.now() - (40 - turn * 5) * 60_000);
    if (
      await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: "q1",
        destination: "destination",
      })
    )
      break;
  }
  assert.equal(
    (
      await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: "q1",
        destination: "destination",
      })
    )?.state,
    "adopted_existing",
  );
  const edit = () => {
    h.qso.freq = 14075;
    h.qso.syncedAtMillis = 200;
  };
  const observeDueEdit = async () => {
    edit();
    // A real quiet period has elapsed before the enabled turn; no limit or
    // source proof predicate is disabled to make the fixture immediately due.
    await tick(h.env, fetcher, Date.now() - 21 * 60_000);
  };
  return {
    ...h,
    operations,
    qsos,
    fetcher,
    sourceReads,
    count,
    edit,
    observeDueEdit,
  };
}

test("enabled due correction collects once and dispatches its immutable proof in the same source turn", async (t) => {
  const h = await fixture(t);
  await h.observeDueEdit();
  h.enable();
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  const before = h.calls.sourceSync;
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.errors, 0);
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(h.calls.lotwUploads, 0);
  assert.equal(await h.count("attempts"), 1);
  assert.equal(await h.count("attempt_source_export_proofs"), 1);
  assert.equal(await h.count("source_export_proofs"), 1);
  assert.equal(
    h.calls.sourceSync - before,
    3,
    "canonical poll, shared positive collection, then one qualifying final drain",
  );
  assert.equal(result.attempts, 1);
  assert.equal(
    (
      await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: "q1",
        destination: "destination",
      })
    )?.state,
    "delivered",
  );
  assert.equal(h.qrzMutations[0].FREQ, "14.075");
});

test("closed export gates keep source proof collection and attempts off for an actionable correction", async (t) => {
  const h = await fixture(t);
  await h.observeDueEdit();
  const before = h.calls.sourceSync;
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.errors, 0);
  assert.equal(h.calls.sourceSync - before, 1);
  assert.equal(await h.count("source_export_proofs"), 0);
  assert.equal(await h.count("attempts"), 0);
  assert.equal(h.calls.qrzWrites, 0);
});

test("quiet-period eligibility is checked before any source proof collection", async (t) => {
  const h = await fixture(t);
  h.enable();
  await h.store
    .statement("UPDATE accounts SET quiet_minutes=30 WHERE id='a'")
    .run();
  h.edit();
  const before = h.calls.sourceSync;
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.errors, 0);
  assert.equal(h.calls.sourceSync - before, 1);
  assert.equal(await h.count("source_export_proofs"), 0);
  assert.equal(await h.count("attempts"), 0);
  assert.equal(h.calls.qrzWrites, 0);
  const row = await h.store.ledger({
    tenant: "a",
    source: "source",
    qso: "q1",
    destination: "destination",
  });
  assert.equal(row?.state, "changed");
  assert(row && row.due_at > Date.now());
});

test("a failed route history read cannot enter source proof collection", async (t) => {
  const h = await fixture(t);
  await h.observeDueEdit();
  // An unmapped eligible route must obtain destination evidence before its
  // otherwise current source can enter the export preparation cohort.
  await h.store
    .statement(
      "UPDATE ledger SET remote_id=NULL,state='missing_current_identity',due_at=0 WHERE tenant='a' AND destination='destination'",
    )
    .run();
  await h.store
    .statement("DELETE FROM reconciliation_checks WHERE tenant='a'")
    .run();
  await h.store
    .statement(
      "DELETE FROM partitions WHERE tenant='a' AND history_scope IS NOT NULL",
    )
    .run();
  h.errors.qrz = true;
  h.enable();
  const before = h.calls.sourceSync;
  const result = await tick(h.env, h.fetcher);
  assert(result.errors > 0);
  assert.equal(h.calls.sourceSync - before, 1);
  assert.equal(await h.count("source_export_proofs"), 0);
  assert.equal(await h.count("attempts"), 0);
  assert.equal(h.calls.qrzWrites, 0);
  assert.match(
    (
      await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: "q1",
        destination: "destination",
      })
    )?.reason ?? "",
    /reconciliation failed/,
  );
});

test("an oversized dependency set yields its queue turn while a bounded neighbor exports", async (t) => {
  const h = await fixture(t, (state, rows) => {
    for (let i = 0; i < 63; i++)
      rows.push({
        uuid: `event-${i}`,
        operation: "op-fixture",
        band: "event",
        event: {},
        startAtMillis: Number(state.qso.startAtMillis) - 1,
        syncedAtMillis: 2 + i,
      });
    rows.push({
      ...state.qso,
      uuid: "q2",
      operation: null,
      their: { call: "K2DEF" },
      our: {
        stationCall: "W1AW",
        grid: "FN31AA",
        state: "CT",
        county: "Tolland",
        dxccCode: 291,
        cqZone: 5,
        ituZone: 8,
      },
      syncedAtMillis: 102,
    });
    state.qrzRecords.push({
      ...state.qrzRecords[0],
      CALL: "K2DEF",
      APP_QRZLOG_LOGID: "501",
    });
  });
  await h.observeDueEdit();
  const neighbor = h.qsos.find((row) => row.uuid === "q2")!;
  neighbor.freq = 14075;
  neighbor.syncedAtMillis = 201;
  await tick(h.env, h.fetcher, Date.now() - 21 * 60_000);
  h.enable();
  h.env.ROLLOUT_QSO_IDS_JSON = '["q1","q2"]';
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  const before = Date.now();
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.errors, 0);
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(h.qrzMutations[0]?.CALL, "K2DEF");
  assert.equal(await h.count("source_export_proofs"), 1);
  const held = await h.store.ledger({
    tenant: "a",
    source: "source",
    qso: "q1",
    destination: "destination",
  });
  assert.equal(held?.state, "changed");
  assert.equal(held?.reason, "source_export_proof_unavailable");
  const turn = await h.store
    .statement(
      "SELECT next_due_at,selected_at FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .first<{ next_due_at: number; selected_at: number }>();
  assert(turn && turn.next_due_at >= before + 5 * 60_000);
  assert(turn.selected_at >= before);
});

test("a delayed known-unsent attempt is cancelled and re-prepared after a new canonical generation", async (t) => {
  const h = await fixture(t);
  await h.observeDueEdit();
  h.enable();
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  const busy = await h.store.claim(
    "a",
    "delivery:destination",
    Date.now(),
    120_000,
  );
  assert(busy);
  const first = await tick(h.env, h.fetcher);
  assert.equal(first.errors, 0);
  assert.equal(h.calls.qrzWrites, 0);
  const prior = await h.store
    .statement(
      "SELECT s.attempt,s.state,p.proof_id FROM attempt_state s JOIN attempt_source_export_proofs p ON p.tenant=s.tenant AND p.attempt=s.attempt",
    )
    .first<{ attempt: string; state: string; proof_id: string }>();
  assert.equal(prior?.state, "prepared");
  assert(prior);
  await h.store.release(busy);
  // Make the scheduler's next due turn available without changing any source,
  // proof, lease or immutable attempt evidence or introducing a future clock.
  await h.store
    .statement(
      "UPDATE reconciliation_work SET next_due_at=0,selected_at=0 WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .run();
  await h.store
    .statement(
      "UPDATE source_work SET processed_at=0 WHERE tenant='a' AND source='source' AND id='q1' AND kind='qso'",
    )
    .run();
  const second = await tick(h.env, h.fetcher);
  assert.equal(second.errors, 0);
  assert.equal(h.calls.qrzWrites, 1);
  const attempts = (
    await h.store
      .statement(
        "SELECT s.attempt,s.state,p.proof_id FROM attempt_state s JOIN attempt_source_export_proofs p ON p.tenant=s.tenant AND p.attempt=s.attempt ORDER BY s.updated_at,s.attempt",
      )
      .all<{ attempt: string; state: string; proof_id: string }>()
  ).results;
  assert.equal(attempts.length, 2);
  assert.equal(
    attempts.find((row) => row.attempt === prior.attempt)?.state,
    "cancelled",
  );
  assert.equal(
    attempts.find((row) => row.attempt === prior.attempt)?.proof_id,
    prior.proof_id,
  );
  assert.equal(attempts.filter((row) => row.state === "delivered").length, 1);
  assert.notEqual(
    attempts.find((row) => row.state === "delivered")?.proof_id,
    prior.proof_id,
  );
  assert.equal(
    (
      await h.store
        .statement(
          "SELECT count(*) AS n FROM destination_identity_claims WHERE tenant='a' AND destination='destination' AND source='source' AND qso='q1'",
        )
        .first<{ n: number }>()
    )?.n,
    1,
  );
});
