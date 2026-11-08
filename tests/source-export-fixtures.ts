import assert from "node:assert/strict";
import { bindLegacyQrzIdentity } from "../src/identity-claims.ts";
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

export async function sourceExportFixture(
  t: { after(fn: () => Promise<void>): void },
  setup?: (
    h: Awaited<ReturnType<typeof schedulerFixture>>,
    qsos: SourceRecord[],
    operations: SourceRecord[],
  ) => void | Promise<void>,
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
  await setup?.(h, qsos, operations);
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
