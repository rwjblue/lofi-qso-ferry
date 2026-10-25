import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { bindLegacyQrzIdentity } from "../src/identity-claims.ts";
import { rereadOperation } from "../src/intake.ts";
import type { SourceRecord } from "../src/lofi.ts";
import {
  isEventRecord,
  projectContact,
  sourceFingerprint,
} from "../src/projection.ts";
import { mergeQrzCorrection } from "../src/qrz.ts";
import { canonical, sha256 } from "../src/security.ts";
import { tick } from "../src/service.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";

async function fixture(
  t: TestContext,
  setup?: (
    h: Awaited<ReturnType<typeof schedulerFixture>>,
    qsos: SourceRecord[],
    operations: SourceRecord[],
  ) => void,
  baselineAgeMinutes = 40,
  initialState = "adopted_existing",
  vendor: "qrz" | "lotw" = "qrz",
  qrzBaseline: "ferry_created" | "historical" = "ferry_created",
) {
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  await h.store
    .statement(
      "UPDATE connections SET status='disabled' WHERE id=?",
      vendor === "qrz" ? "lotw" : "destination",
    )
    .run();
  await h.store
    .statement("UPDATE accounts SET quiet_minutes=20 WHERE id='a'")
    .run();
  const operations = [h.operation];
  const qsos = [h.qso];
  setup?.(h, qsos, operations);
  // Correction/proof scheduling starts from retained Ferry-created mappings.
  // Fresh historical adoption is now permanently association-only, including
  // exact matches, and must not be used to manufacture a writable baseline.
  const retainedQrz =
    vendor === "qrz" &&
    initialState === "adopted_existing" &&
    qrzBaseline === "ferry_created";
  if (retainedQrz) {
    for (const qso of qsos.filter((row) => !isEventRecord(row))) {
      const contact = await projectContact(
        qso,
        operations.find((operation) => operation.uuid === qso.operation) ??
          null,
        qsos.filter(
          (row) => isEventRecord(row) && row.operation === qso.operation,
        ),
        { operationComplete: true },
      );
      const remote = h.qrzRecords.find(
        (record) => record.CALL === contact.call,
      );
      assert(remote?.APP_QRZLOG_LOGID);
      const hash = await sourceFingerprint(contact, "qrz");
      const sentHash = await sha256(
        canonical(mergeQrzCorrection(remote, remote, "template_bound")),
      );
      await h.store
        .statement(
          "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,baseline_hash,remote_hash,sent_hash,state,remote_id,provenance,narrative,template_version,due_at,updated_at) VALUES('a','source',?,'destination',?,?,?,?,?,'delivered',?,'ferry_created','template_bound',?,0,?)",
          contact.id,
          contact.generation,
          hash,
          hash,
          sentHash,
          sentHash,
          remote.APP_QRZLOG_LOGID,
          h.template,
          Date.now() - baselineAgeMinutes * 60_000,
        )
        .run();
      // The normal exact-LOGID recovery binds the retained identity claim; no
      // proof, attempt, stage guard, or association-only marker is fabricated.
      assert(
        await bindLegacyQrzIdentity(
          h.store,
          {
            tenant: "a",
            source: "source",
            qso: contact.id,
            destination: "destination",
          },
          remote,
          contact.generation,
          "fixture-qrz",
          Date.now(),
        ),
      );
    }
    assert.equal(
      await h.store
        .statement("SELECT count(*) n FROM historical_associations")
        .first<number>("n"),
      0,
    );
  }
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
    const operation = /^\/v1\/operations\/([^/]+)\/qsos$/.exec(
      url.pathname,
    )?.[1];
    if (operation) {
      h.calls.reread++;
      if (h.errors.reread) throw new Error("synthetic reread failure");
      return Response.json({
        qsos: qsos.filter((row) => row.operation === operation),
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
    await tick(
      h.env,
      fetcher,
      vendor === "lotw" && initialState === "adopted_existing"
        ? Date.now()
        : Date.now() - (baselineAgeMinutes - turn * 5) * 60_000,
    );
    if (
      await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: "q1",
        destination: vendor === "qrz" ? "destination" : "lotw",
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
        destination: vendor === "qrz" ? "destination" : "lotw",
      })
    )?.state,
    retainedQrz ? "delivered" : initialState,
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

test("a historical QRZ association stays read-only after a source correction", async (t) => {
  const h = await fixture(
    t,
    undefined,
    40,
    "adopted_existing",
    "qrz",
    "historical",
  );
  await h.observeDueEdit();
  h.enable();
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.errors, 0);
  assert.equal(h.calls.qrzWrites, 0);
  assert.equal(await h.count("attempts"), 0);
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM historical_associations")
      .first<number>("n"),
    1,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM historical_remote_owners")
      .first<number>("n"),
    1,
  );
  const row = await h.store.ledger({
    tenant: "a",
    source: "source",
    qso: "q1",
    destination: "destination",
  });
  assert.equal(row?.reason, "historical_association_read_only");
  assert.equal(row?.narrative, "remote_preserved");
  assert.equal(h.qrzRecords[0].FREQ, "14.07400");
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

async function scatteredFixture(t: TestContext, disjointOperations = false) {
  const h = await fixture(
    t,
    (state, rows, operations) => {
      state.qso.syncedAtMillis = 1000;
      for (let index = 1; index < 12; index++) {
        const call = `K1A${String.fromCharCode(65 + index)}`;
        rows.push({
          ...state.qso,
          uuid: `q${index + 1}`,
          their: { call },
          syncedAtMillis: 1000 + index * 50,
        });
        state.qrzRecords.push({
          ...state.qrzRecords[0],
          CALL: call,
          APP_QRZLOG_LOGID: String(500 + index),
        });
      }
      if (disjointOperations) {
        state.operation.syncedAtMillis = 1550;
        for (let index = 1; index < rows.length; index++) {
          const operation = {
            ...state.operation,
            uuid: `op-neighbor-${index}`,
            syncedAtMillis: 1550 - index * 50,
          };
          operations.push(operation);
          rows[index].operation = operation.uuid;
        }
      }
    },
    disjointOperations ? 120 : 40,
  );
  const source = await h.store.connection("a", "source");
  assert(source);
  if (disjointOperations) {
    // Establish each real operation context through the normal read path.
    for (let index = 0; index < h.operations.length; index++)
      await rereadOperation(
        h.store,
        source,
        h.fetcher,
        Date.now() - (100 - index * 5) * 60_000,
        "background",
      );
    await tick(h.env, h.fetcher, Date.now() - 25 * 60_000);
  }
  const selected = h.qsos.filter((_, index) => index % 2 === 0);
  h.qsos.forEach((row, index) => {
    row.syncedAtMillis = 3000 + index * 50;
    if (index % 2 === 0) row.freq = 14075;
  });
  await tick(h.env, h.fetcher, Date.now() - 21 * 60_000);
  for (const row of selected)
    assert.equal(
      (
        await h.store.ledger({
          tenant: "a",
          source: "source",
          qso: String(row.uuid),
          destination: "destination",
        })
      )?.state,
      "changed",
    );
  const spread = (rows: SourceRecord[], targets: SourceRecord[]) => [
    ...rows,
    ...targets.flatMap((row) =>
      Array.from({ length: 24 }, (_, index) => ({
        ...row,
        uuid: `${row.uuid}-neighbor-${index}`,
        syncedAtMillis: Number(row.syncedAtMillis) - index - 1,
      })),
    ),
  ];
  const qsos = spread(h.qsos, selected);
  const operations = disjointOperations
    ? spread(
        h.operations,
        h.operations.filter((_, index) => index % 2 === 0),
      )
    : h.operations;
  let collectionReads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname !== "/v1/sync")
      return h.fetcher(input, init);
    const sync = JSON.parse(String(init?.body)).meta.sync;
    if (sync.qsos.syncedSinceMillis !== undefined)
      return h.fetcher(input, init);
    collectionReads++;
    h.calls.sourceSync++;
    const page = (rows: SourceRecord[], upper: number) =>
      rows
        .filter((row) => Number(row.syncedAtMillis) < upper)
        .sort((a, b) => Number(b.syncedAtMillis) - Number(a.syncedAtMillis))
        .slice(0, 25);
    return Response.json({
      account: { uuid: "account-fixture" },
      operations: page(operations, sync.operations.syncedUntilMillis),
      qsos: page(qsos, sync.qsos.syncedUntilMillis),
      meta: {
        operations: disjointOperations
          ? { records_left: 1, next_cursor: `ops-${collectionReads}` }
          : { records_left: 0 },
        qsos: { records_left: 1, next_cursor: `qsos-${collectionReads}` },
      },
    });
  };
  h.enable();
  h.env.ROLLOUT_QSO_IDS_JSON = JSON.stringify(selected.map((row) => row.uuid));
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  return { ...h, fetcher, selected, collections: () => collectionReads };
}

test("a request-limited source cohort dispatches only its fully proved non-prefix subset", async (t) => {
  const h = await scatteredFixture(t);
  const before = h.calls.sourceSync;
  const started = Date.now();
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.errors, 0);
  assert(result.deferred > 0);
  assert.equal(h.collections(), 3);
  assert.equal(
    h.calls.sourceSync - before,
    5,
    "one canonical poll plus the four-request proof allowance",
  );
  assert.equal(h.calls.qrzWrites, 3);
  const attempts = (
    await h.store
      .statement(
        "SELECT a.qso,s.state,p.proof_id FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id JOIN attempt_source_export_proofs p ON p.tenant=a.tenant AND p.attempt=a.id ORDER BY a.qso",
      )
      .all<{ qso: string; state: string; proof_id: string }>()
  ).results;
  assert.deepEqual(
    attempts.map((row) => row.qso),
    ["q11", "q7", "q9"],
  );
  assert(attempts.every((row) => row.state === "delivered"));
  assert.equal(await h.count("source_export_proofs"), 3);
  const held = (
    await h.store
      .statement(
        "SELECT l.qso,l.reason,w.next_due_at,w.selected_at FROM ledger l JOIN reconciliation_work w ON w.tenant=l.tenant AND w.source=l.source AND w.qso=l.qso WHERE l.state='changed' ORDER BY l.qso",
      )
      .all<{
        qso: string;
        reason: string;
        next_due_at: number;
        selected_at: number;
      }>()
  ).results;
  assert.deepEqual(
    held.map((row) => row.qso),
    ["q1", "q3", "q5"],
  );
  assert(
    held.every((row) => row.reason === "source_export_proof_request_budget"),
  );
  assert(
    held.every(
      (row) =>
        row.next_due_at >= started + 300_000 && row.selected_at >= started,
    ),
  );
});

test("a zero-complete budget cohort retries one exact prior-held contact after history refresh", async (t) => {
  const h = await scatteredFixture(t, true);
  const first = await tick(h.env, h.fetcher);
  assert.equal(first.errors, 0);
  assert(first.deferred > 0);
  assert.equal(h.collections(), 3);
  assert.equal(await h.count("source_export_proofs"), 0);
  assert.equal(await h.count("attempts"), 0);
  assert.equal(h.calls.qrzWrites, 0);
  const held = await h.store
    .statement(
      "SELECT count(*) AS n FROM ledger WHERE reason='source_export_proof_request_budget'",
    )
    .first<number>("n");
  assert.equal(held, 6);
  // Simulate the next due scheduler window without aging or modifying source
  // evidence, proofs, identities, or the collector's request allowance.
  await h.store
    .statement(
      "UPDATE reconciliation_work SET next_due_at=0,selected_at=0 WHERE tenant='a' AND source='source'",
    )
    .run();
  await h.store
    .statement(
      "UPDATE source_work SET processed_at=0 WHERE tenant='a' AND source='source' AND kind='qso'",
    )
    .run();
  await h.store.statement("DELETE FROM vendor_requests").run();
  const before = h.calls.sourceSync;
  const second = await tick(h.env, h.fetcher);
  assert.equal(second.errors, 0);
  assert.equal(
    h.calls.sourceSync - before,
    3,
    "canonical poll, singleton collection, final drain",
  );
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(await h.count("source_export_proofs"), 1);
  assert.equal(await h.count("attempts"), 1);
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) AS n FROM ledger WHERE state='changed' AND reason='source_export_proof_request_budget'",
      )
      .first<number>("n"),
    5,
  );
});

test("an individually request-limited singleton yields its next queue turn to a fitting neighbor", async (t) => {
  const h = await scatteredFixture(t, true);
  const first = await tick(h.env, h.fetcher);
  assert.equal(first.errors, 0);
  assert.equal(await h.count("attempts"), 0);
  await h.store
    .statement(
      "UPDATE reconciliation_work SET next_due_at=CASE WHEN qso='q1' THEN 0 ELSE 1 END,selected_at=0 WHERE tenant='a' AND source='source'",
    )
    .run();
  await h.store
    .statement(
      "UPDATE source_work SET processed_at=0 WHERE tenant='a' AND source='source' AND kind='qso'",
    )
    .run();
  await h.store.statement("DELETE FROM vendor_requests").run();
  let oversizedPages = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname !== "/v1/sync")
      return h.fetcher(input, init);
    const sync = JSON.parse(String(init?.body)).meta.sync;
    if (
      sync.qsos.syncedUntilMillis !== 3050 &&
      !String(sync.qsos.cursor ?? "").startsWith("oversized-")
    )
      return h.fetcher(input, init);
    oversizedPages++;
    h.calls.sourceSync++;
    // An opaque continuation traverses a legal, dense tied group above q1.
    // Even one contact cannot reach its positive row in three bounded pages.
    return Response.json({
      account: { uuid: "account-fixture" },
      operations: [...h.operations].sort(
        (a, b) => Number(b.syncedAtMillis) - Number(a.syncedAtMillis),
      ),
      qsos: Array.from({ length: 25 }, (_, index) => ({
        ...h.qso,
        uuid: `dense-${oversizedPages}-${index}`,
        syncedAtMillis: 3001,
      })),
      meta: {
        operations: { records_left: 0 },
        qsos: { records_left: 1, next_cursor: `oversized-${oversizedPages}` },
      },
    });
  };
  const started = Date.now();
  const second = await tick(h.env, fetcher);
  assert.equal(second.errors, 0);
  assert.equal(oversizedPages, 3);
  assert.equal(await h.count("source_export_proofs"), 0);
  assert.equal(await h.count("attempts"), 0);
  const delayed = await h.store
    .statement(
      "SELECT next_due_at FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .first<number>("next_due_at");
  assert(delayed && delayed >= started + 10 * 60_000);
  const neighbors = (
    await h.store
      .statement(
        "SELECT w.next_due_at FROM reconciliation_work w JOIN ledger l ON l.tenant=w.tenant AND l.source=w.source AND l.qso=w.qso WHERE w.tenant='a' AND w.source='source' AND w.qso!='q1' AND l.state='changed'",
      )
      .all<{ next_due_at: number }>()
  ).results;
  assert.equal(neighbors.length, 5);
  assert(neighbors.every((row) => row.next_due_at < delayed));
  // Advance only the ordinarily due neighbors; the longer singleton backoff
  // is preserved. No source version, proof, claim or authority is changed.
  await h.store
    .statement(
      "UPDATE reconciliation_work SET next_due_at=0,selected_at=0 WHERE tenant='a' AND source='source' AND next_due_at<?",
      delayed,
    )
    .run();
  await h.store
    .statement(
      "UPDATE source_work SET processed_at=0 WHERE tenant='a' AND source='source' AND kind='qso'",
    )
    .run();
  await h.store.statement("DELETE FROM vendor_requests").run();
  const before = h.calls.sourceSync;
  const third = await tick(h.env, fetcher);
  assert.equal(third.errors, 0);
  assert.equal(h.calls.sourceSync - before, 3);
  assert.equal(
    oversizedPages,
    3,
    "the oversized singleton is not collected again",
  );
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(await h.count("attempts"), 1);
  assert.equal(await h.count("source_export_proofs"), 1);
  assert.equal(
    await h.store
      .statement("SELECT count(*) AS n FROM attempts WHERE qso='q1'")
      .first<number>("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) AS n FROM source_export_proofs WHERE qso='q1'",
      )
      .first<number>("n"),
    0,
  );
});

test("fresh QRZ first-insert mode proves and inserts an unmapped contact with the boundary closed", async (t) => {
  const h = await fixture(
    t,
    (state) => {
      state.qrzRecords.length = 0;
    },
    40,
    "inventory_pending",
  );
  h.enable();
  h.env.SOURCE_BOUNDARY_VERIFIED = "false";
  h.env.QRZ_FRESH_INSERTS_ENABLED = "true";
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination","lotw"]';
  await h.store
    .statement("UPDATE connections SET status='active' WHERE id='lotw'")
    .run();
  const readsBefore = h.calls.qrzReads;
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.errors, 0);
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(
    h.calls.qrzReads - readsBefore,
    2,
    "reconciliation and dispatch each read; preparation reuses the same-turn empty result",
  );
  assert.equal(h.calls.lotwUploads, 0);
  assert.equal(await h.count("attempts"), 1);
  assert.equal(await h.count("source_export_proofs"), 1);
  assert.equal(
    await h.store
      .statement("SELECT count(*) AS n FROM source_cutovers")
      .first<number>("n"),
    0,
  );
  const attempt = await h.store
    .statement(
      "SELECT a.destination,p.authorization_mode FROM attempts a JOIN attempt_source_export_proofs p ON p.tenant=a.tenant AND p.attempt=a.id",
    )
    .first<{ destination: string; authorization_mode: string }>();
  assert.deepEqual(attempt, {
    destination: "destination",
    authorization_mode: "qrz_fresh_insert",
  });
  assert.equal(h.env.SOURCE_BOUNDARY_VERIFIED, "false");
});

test("fresh QRZ mode stays closed by default and never collects correction proofs", async (t) => {
  const h = await fixture(t);
  await h.observeDueEdit();
  h.enable();
  h.env.SOURCE_BOUNDARY_VERIFIED = "false";
  for (const flag of ["false", "true"]) {
    h.env.QRZ_FRESH_INSERTS_ENABLED = flag;
    await h.store
      .statement("UPDATE reconciliation_work SET next_due_at=0,selected_at=0")
      .run();
    await h.store
      .statement("UPDATE source_work SET processed_at=0 WHERE kind='qso'")
      .run();
    const before = h.calls.sourceSync;
    const result = await tick(h.env, h.fetcher);
    assert.equal(result.errors, 0);
    assert.equal(
      h.calls.sourceSync - before,
      1,
      "only ordinary canonical polling runs",
    );
    assert.equal(await h.count("source_export_proofs"), 0);
    assert.equal(await h.count("attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
  }
  assert.equal(
    await h.store
      .statement("SELECT count(*) AS n FROM source_cutovers")
      .first<number>("n"),
    0,
  );
});

test("fresh LoTW first-insert mode proves and submits only its scoped route with the boundary closed", async (t) => {
  const h = await fixture(
    t,
    (state) => {
      state.lotwRecords.length = 0;
    },
    40,
    "inventory_pending",
    "lotw",
  );
  h.enable();
  h.env.SOURCE_BOUNDARY_VERIFIED = "false";
  h.env.LOTW_FRESH_INSERTS_ENABLED = "true";
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination","lotw"]';
  await h.store
    .statement("UPDATE connections SET status='active' WHERE id='destination'")
    .run();
  h.qrzRecords.length = 0;
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.errors, 0);
  assert.equal(h.calls.qrzWrites, 0);
  assert.equal(
    h.calls.lotwUploads,
    1,
    JSON.stringify({
      result,
      calls: h.calls,
      ledger: await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: "q1",
        destination: "lotw",
      }),
    }),
  );
  assert.equal(await h.count("attempts"), 1);
  assert.equal(await h.count("source_export_proofs"), 1);
  assert.equal(
    await h.store
      .statement("SELECT count(*) AS n FROM source_cutovers")
      .first<number>("n"),
    0,
  );
  assert.deepEqual(
    await h.store
      .statement(
        "SELECT a.destination,p.authorization_mode,s.state FROM attempts a JOIN attempt_source_export_proofs p ON p.tenant=a.tenant AND p.attempt=a.id JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id",
      )
      .first(),
    {
      destination: "lotw",
      authorization_mode: "lotw_fresh_insert",
      state: "observed",
    },
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) n FROM attempt_events WHERE state='submitted'",
      )
      .first<number>("n"),
    1,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM attempt_events WHERE state='observed'")
      .first<number>("n"),
    1,
  );
  assert.equal(h.env.SOURCE_BOUNDARY_VERIFIED, "false");
});

test("fresh LoTW mode stays closed by default and cannot collect correction proofs", async (t) => {
  const h = await fixture(t, undefined, 40, "adopted_existing", "lotw");
  await h.observeDueEdit();
  h.enable();
  h.env.SOURCE_BOUNDARY_VERIFIED = "false";
  for (const flag of ["false", "true"]) {
    h.env.LOTW_FRESH_INSERTS_ENABLED = flag;
    await h.store
      .statement("UPDATE reconciliation_work SET next_due_at=0,selected_at=0")
      .run();
    await h.store
      .statement("UPDATE source_work SET processed_at=0 WHERE kind='qso'")
      .run();
    const before = h.calls.sourceSync;
    const result = await tick(h.env, h.fetcher);
    assert.equal(result.errors, 0);
    assert.equal(h.calls.sourceSync - before, 1);
    assert.equal(await h.count("source_export_proofs"), 0);
    assert.equal(await h.count("attempts"), 0);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(h.calls.qrzWrites, 0);
  }
});

test("two oversized fresh negatives yield to fitting unscanned neighbors in the next invocation", async (t) => {
  const h = await fixture(
    t,
    async (state, qsos) => {
      state.qrzRecords.length = 0;
      for (let i = 0; i < 63; i++)
        qsos.push({
          uuid: `event-${i}`,
          operation: "op-fixture",
          band: "event",
          event: {},
          startAtMillis: Number(state.qso.startAtMillis) - 1,
          syncedAtMillis: 2 + i,
        });
      qsos.push({
        ...structuredClone(state.qso),
        uuid: "q2",
        their: { call: "K2BLOCK" },
        syncedAtMillis: 102,
        startAtMillis: Number(state.qso.startAtMillis) + 120000,
      });
      for (let i = 3; i <= 4; i++)
        qsos.push({
          ...structuredClone(state.qso),
          uuid: `q${i}`,
          operation: null,
          their: { call: `K${i}FIT` },
          our: {
            stationCall: "W1AW",
            grid: "FN31AA",
            state: "CT",
            county: "Tolland",
            dxccCode: 291,
            cqZone: 5,
            ituZone: 8,
          },
          syncedAtMillis: 100 + i,
          startAtMillis: Number(state.qso.startAtMillis) + i * 120000,
        });
    },
    40,
    "inventory_pending",
  );
  h.enable();
  h.env.SOURCE_BOUNDARY_VERIFIED = "false";
  h.env.QRZ_FRESH_INSERTS_ENABLED = "true";
  h.env.LOTW_FRESH_INSERTS_ENABLED = "false";
  h.env.ROLLOUT_QSO_IDS_JSON = '["q1","q2","q3","q4"]';
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  const before = Date.now();
  const first = await tick(h.env, h.fetcher);
  const queued = (
    await h.store
      .statement(
        "SELECT w.qso,w.version,w.next_due_at,w.selected_at,l.state,l.reason FROM reconciliation_work w JOIN ledger l ON l.tenant=w.tenant AND l.source=w.source AND l.qso=w.qso AND l.destination='destination' WHERE w.tenant='a' ORDER BY w.qso",
      )
      .all()
  ).results;
  const checks = (
    await h.store
      .statement(
        "SELECT qso,count(*) n FROM reconciliation_checks GROUP BY qso ORDER BY qso",
      )
      .all()
  ).results;
  assert.equal(first.errors, 0);
  assert.equal(h.calls.qrzWrites, 0);
  assert.equal(await h.count("attempts"), 0);
  for (const row of queued) {
    if (["q1", "q2"].includes(String(row.qso))) {
      assert.equal(row.reason, "source_export_proof_unavailable");
      assert(Number(row.next_due_at) >= before + 300000);
    } else {
      assert(Number(row.next_due_at) <= before);
      assert.equal(row.state, "inventory_pending");
    }
  }
  assert(
    checks.every((row) => ["q1", "q2"].includes(String(row.qso))),
    "unscanned neighbors receive no absence memo",
  );
  // Real later invocation, with all durable cursors, proofs, budgets and clocks intact.
  const second = await tick(h.env, h.fetcher);
  assert.equal(second.errors, 0);
  assert(
    h.calls.qrzWrites > 0,
    "fitting neighbors progress without retrying the blocked prefix",
  );
  assert(h.qrzMutations.every((row) => ["K3FIT", "K4FIT"].includes(row.CALL)));
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM attempts WHERE qso IN('q1','q2')")
      .first<number>("n"),
    0,
  );
});

test("quiet-period prefix does not consume the fitting neighbors' planning slots", async (t) => {
  const h = await fixture(
    t,
    async (state, qsos) => {
      state.qrzRecords.length = 0;
      for (let i = 2; i <= 4; i++)
        qsos.push({
          ...structuredClone(state.qso),
          uuid: `q${i}`,
          their: { call: `K${i}FIT` },
          syncedAtMillis: 100 + i,
          startAtMillis: Number(state.qso.startAtMillis) + i * 120000,
        });
    },
    40,
    "inventory_pending",
  );
  // Actual source edits and normal observation put only the first two contacts
  // back into quiet time; no queue/proof/budget or eligibility rows are forged.
  h.qso.freq = 14075;
  h.qso.syncedAtMillis = 200;
  const q2 = h.qsos.find((q) => q.uuid === "q2")!;
  q2.freq = 14075;
  q2.syncedAtMillis = 201;
  await tick(h.env, h.fetcher, Date.now() - 60000);
  h.enable();
  h.env.SOURCE_BOUNDARY_VERIFIED = "false";
  h.env.QRZ_FRESH_INSERTS_ENABLED = "true";
  h.env.LOTW_FRESH_INSERTS_ENABLED = "false";
  h.env.ROLLOUT_QSO_IDS_JSON = '["q1","q2","q3","q4"]';
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  const before = (
    await h.store
      .statement(
        "SELECT qso,due_at FROM ledger WHERE destination='destination' ORDER BY qso",
      )
      .all()
  ).results;
  const now = Date.now();
  assert(
    before
      .filter((r) => ["q1", "q2"].includes(String(r.qso)))
      .every((r) => Number(r.due_at) > now),
  );
  assert(
    before
      .filter((r) => ["q3", "q4"].includes(String(r.qso)))
      .every((r) => Number(r.due_at) <= now),
  );
  const result = await tick(h.env, h.fetcher);
  const attempts = (
    await h.store.statement("SELECT qso FROM attempts ORDER BY qso").all()
  ).results;
  assert.equal(result.errors, 0);
  assert(h.calls.qrzWrites > 0);
  assert(attempts.every((a) => ["q3", "q4"].includes(String(a.qso))));
  assert(h.qrzMutations.every((row) => ["K3FIT", "K4FIT"].includes(row.CALL)));
});

test("two nine-read negative plans retain enough normal quota for one final nine-read scan and INSERT", async (t) => {
  const h = await fixture(
    t,
    async (state, qsos) => {
      state.qrzRecords.length = 0;
      state.qrzRecords.push({
        ...state.initial,
        CALL: "K9OTHER",
        APP_QRZLOG_LOGID: "500",
      });
      const d = (await state.store.connection("a", "destination"))!;
      await state.store
        .statement(
          "UPDATE connections SET config=? WHERE tenant='a' AND id='destination'",
          JSON.stringify({
            ...JSON.parse(d.config),
            bookId: "synthetic-book",
            readAccess: true,
          }),
        )
        .run();
      qsos.push({
        ...structuredClone(state.qso),
        uuid: "q2",
        their: { call: "K2NEXT" },
        syncedAtMillis: 102,
        startAtMillis: Number(state.qso.startAtMillis) + 120000,
      });
    },
    40,
    "inventory_pending",
  );
  h.enable();
  h.env.SOURCE_BOUNDARY_VERIFIED = "false";
  h.env.QRZ_FRESH_INSERTS_ENABLED = "true";
  h.env.LOTW_FRESH_INSERTS_ENABLED = "false";
  h.env.ROLLOUT_QSO_IDS_JSON = '["q1","q2"]';
  h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
  const count = { target: 0, status: 0, cover: 0, insert: 0 };
  let coverPage = 0;
  const encode = (value: Record<string, string>) =>
    new Response(new URLSearchParams(value).toString());
  const page = (call: string, start: number, length: number) =>
    encode({
      RESULT: "OK",
      COUNT: String(length),
      ADIF: Array.from({ length }, (_, i) =>
        serializeAdifRecord({
          ...h.initial,
          CALL: call,
          TIME_ON: "000000",
          APP_QRZLOG_LOGID: String(start + i),
        } as AdifRecord),
      ).join(""),
    });
  const raw: typeof fetch = async (input, init) => {
    if (new URL(String(input)).hostname !== "logbook.qrz.com")
      return h.fetcher(input, init);
    const form = new URLSearchParams(String(init?.body));
    const action = form.get("ACTION");
    if (action === "INSERT") {
      count.insert++;
      return h.fetcher(input, init);
    }
    if (action === "STATUS") {
      count.status++;
      coverPage = 0;
      return encode({
        RESULT: "OK",
        BOOKID: "synthetic-book",
        CALLSIGN: "W1AW",
        START_DATE: "2020-01-01",
        END_DATE: "2030-12-31",
      });
    }
    assert.equal(action, "FETCH");
    const fields = (form.get("OPTION") ?? "").split(",");
    const value = (key: string) =>
      fields.find((x) => x.startsWith(`${key}:`))?.slice(key.length + 1);
    const call = value("CALL");
    if (call) {
      count.target++;
      const after = Number(value("AFTERLOGID") ?? 0);
      return after >= 1750
        ? encode({ RESULT: "FAIL", COUNT: "0" })
        : page(call, after ? after : 1001, 250);
    }
    count.cover++;
    coverPage++;
    return coverPage === 4
      ? page("K9OTHER", 748, 1)
      : page("K9OTHER", (coverPage - 1) * 249 + 1, 250);
  };
  const result = await tick(h.env, raw);
  const budget = await h.store
    .statement(
      "SELECT requests,background_requests FROM vendor_requests WHERE vendor='qrz'",
    )
    .first();
  const attempts = (
    await h.store
      .statement(
        "SELECT a.qso,s.state FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id",
      )
      .all()
  ).results;
  assert.equal(result.errors, 0);
  assert.equal(count.insert, 1);
  assert.equal(count.target + count.status + count.cover + count.insert, 24);
  assert.equal(budget?.requests, 24);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.qso, "q1");
  assert.equal(attempts[0]?.state, "delivered");
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM reconciliation_checks WHERE qso='q2'")
      .first<number>("n"),
    0,
    "partial second read is not an absence",
  );
});
