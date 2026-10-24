import assert from "node:assert/strict";
import test from "node:test";
import { serializeAdifRecord } from "../src/adif.ts";
import { tick } from "../src/service.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { seed } from "./helpers.ts";
import { FIXTURE_NOW, schedulerFixture } from "./runtime-fixtures.ts";

const key = (destination: string) => ({
  tenant: "a",
  source: "source",
  qso: "q1",
  destination,
});

test("scheduler refreshes certificate status without downloading trust roots", async () => {
  const h = await schedulerFixture();
  try {
    await h.store
      .statement(
        "UPDATE connections SET status='needs_verification',config=json_set(config,'$.certificates[0].trusted',json('false')) WHERE kind='lotw'",
      )
      .run();
    let rootDownloads = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/lotwuser/certs.tq6") {
        rootDownloads++;
        throw new Error("Root discovery must be removed");
      }
      return h.fetcher(input, init);
    };
    const first = await tick(h.env, fetcher, FIXTURE_NOW);
    assert.equal(first.errors, 0);
    assert.equal(h.calls.sourceSync, 3); // Baseline, forward drain, quarantine handoff.
    const connection = (await h.store.connections("a")).find(
      (item) => item.kind === "lotw",
    )!;
    assert.equal(connection.status, "active");
    assert.equal(
      JSON.parse(connection.config).certificates[0].trusted,
      undefined,
    );
    await tick(h.env, fetcher, FIXTURE_NOW + 5 * 60_000);
    assert.equal(rootDownloads, 0);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(h.calls.qrzWrites, 0);
  } finally {
    await h.mf.dispose();
  }
});
async function count(
  h: Awaited<ReturnType<typeof schedulerFixture>>,
  table: string,
  where = "1=1",
) {
  // Test-only fixed schema identifiers; never request-provided SQL.
  return (await h.store
    .statement(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)
    .first<{ n: number }>())!.n;
}
test("an idle drain polls a completed source and processes each contact only once", async (t) => {
  const h = await schedulerFixture();
  const wallClock = t.mock.method(Date, "now", () => FIXTURE_NOW);
  try {
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.stopReason, "idle");
    assert.equal(result.elapsedMs, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.contacts, 1);
    assert.equal(result.attempts, 0);
    assert.equal(h.calls.sourceSync, 3);
    assert.equal(h.calls.reread, 1);
    assert.equal(h.calls.qrzReads, 2); // Shared base inventory plus modification catch-up.
    assert.equal(h.calls.lotwQueries, 1);
  } finally {
    wallClock.mock.restore();
    await h.mf.dispose();
  }
});
test("read-only reconciliation retries fractional source timestamps and adopts whole-second history", async () => {
  const h = await schedulerFixture();
  try {
    h.qso.startAtMillis = Number(h.qso.startAtMillis) + 789;
    h.errors.qrz = true;
    h.errors.lotw = true;
    const first = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(first.errors, 2);
    h.errors.qrz = false;
    h.errors.lotw = false;
    const retry = await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * 60_000);
    assert.equal(retry.errors, 0);
    assert(h.calls.qrzReads > 0);
    assert(h.calls.lotwQueries > 0);
    for (const destination of ["destination", "lotw"]) {
      const row = (await h.store.ledger(key(destination)))!;
      assert.equal(row.state, "adopted_existing");
      assert.equal(row.reason, null);
      assert.equal(row.sent_hash, null);
      assert.equal(row.source_hash, row.baseline_hash);
    }
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(Number(h.qso.startAtMillis) % 1000, 789);
  } finally {
    await h.mf.dispose();
  }
});
test("closed export gates preserve ambiguous and mismatched history reasons", async () => {
  const h = await schedulerFixture();
  try {
    h.qrzRecords.push({ ...h.qrzRecords[0], APP_QRZLOG_LOGID: "501" });
    h.lotwRecords[0].MY_GRIDSQUARE = "FN32BB";
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 0);
    const qrz = (await h.store.ledger(key("destination")))!;
    const lotw = (await h.store.ledger(key("lotw")))!;
    assert.equal(qrz.state, "history_ambiguous");
    assert.equal(lotw.state, "history_mismatch");
    for (const row of [qrz, lotw]) {
      assert(row.reason);
      assert.notEqual(row.reason, "qso_outside_rollout_scope");
    }
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});
test("source identity conflicts remain visible without repeating vendor reads", async () => {
  const h = await schedulerFixture();
  try {
    h.qso.startAtMillis = Number(h.qso.startAtMillis) + 123;
    const second = {
      ...h.qso,
      uuid: "q2",
      startAtMillis: Number(h.qso.startAtMillis) + 456,
      syncedAtMillis: 102,
    };
    h.changes.qsos.push(second);
    const fetcher: typeof fetch = async (input, init) => {
      const response = await h.fetcher(input, init);
      if (new URL(String(input)).pathname === "/v1/operations/op-fixture/qsos")
        return Response.json({
          ...((await response.json()) as Record<string, unknown>),
          qsos: [h.qso, second],
        });
      return response;
    };
    const first = await tick(h.env, fetcher, FIXTURE_NOW);
    assert.equal(first.errors, 0);
    for (const qso of ["q1", "q2"])
      for (const destination of ["destination", "lotw"]) {
        const row = (await h.store.ledger({ ...key(destination), qso }))!;
        assert.equal(row.state, "history_ambiguous");
        assert.equal(row.provenance, "adoption_conflict");
        assert(row.reason);
      }
    const reads = [h.calls.qrzReads, h.calls.lotwQueries];
    const retry = await tick(h.env, fetcher, FIXTURE_NOW + 5 * 60_000);
    assert.equal(retry.errors, 0);
    assert.deepEqual([h.calls.qrzReads, h.calls.lotwQueries], reads);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});
test("source ADIF errors are distinguished from destination failures without exposing payloads", async () => {
  const h = await schedulerFixture();
  try {
    h.operation.county = "MA,private-county-value";
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 2);
    for (const destination of ["destination", "lotw"])
      assert.equal(
        (await h.store.ledger(key(destination)))!.reason,
        "Source fields cannot be represented in ADIF; review contact",
      );
    assert.equal(h.calls.qrzReads, 0);
    assert.equal(h.calls.lotwQueries, 0);
    assert.equal(await count(h, "attempts"), 0);
  } finally {
    await h.mf.dispose();
  }
});
test("unexpected readback failures retain only a fixed safe diagnostic", async () => {
  const h = await schedulerFixture();
  try {
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).hostname === "logbook.qrz.com")
        throw new Error("private-api-key-and-vendor-response");
      return h.fetcher(input, init);
    };
    const result = await tick(h.env, fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 1);
    assert.deepEqual(
      { ...result.throughput?.failures },
      {
        "reconciliation:qrz:qrz_transient": { events: 1, affected: 1 },
      },
    );
    assert(!JSON.stringify(result).includes("private-api-key"));
    assert.equal(
      (await h.store.ledger(key("destination")))!.reason,
      "Destination reconciliation failed; retry automatically",
    );
    assert.equal(
      (await h.store.ledger(key("lotw")))!.state,
      "adopted_existing",
    );
    assert.equal(await count(h, "attempts"), 0);
  } finally {
    await h.mf.dispose();
  }
});
test("one invocation resumes incomplete source pages and stops polling at completion", async () => {
  const h = await schedulerFixture();
  try {
    await h.store
      .statement("UPDATE connections SET status='disabled' WHERE kind!='lofi'")
      .run();
    let pages = 0;
    const pagedSource: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname !== "/v1/sync")
        return h.fetcher(input, init);
      pages++;
      assert(pages <= 4);
      const body = JSON.parse(String(init?.body));
      if (pages === 2) assert.equal(body.meta.sync.qsos.cursor, "page-two");
      if (pages > 2)
        return Response.json({
          account: { uuid: "account-fixture" },
          operations: [],
          qsos: [],
          meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
        });
      return Response.json({
        account: { uuid: "account-fixture" },
        operations: [],
        qsos: [
          {
            ...h.qso,
            uuid: `page-${pages}`,
            operation: null,
            our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
            syncedAtMillis: 200 - pages,
          },
        ],
        meta: {
          operations: { records_left: 0 },
          qsos:
            pages === 1
              ? { records_left: 1, next_cursor: "page-two" }
              : { records_left: 0 },
        },
      });
    };
    const result = await tick(h.env, pagedSource, FIXTURE_NOW);
    assert.equal(result.stopReason, "idle");
    assert.equal(result.errors, 0);
    assert.equal(result.contacts, 2);
    assert(result.rounds > 1);
    assert.equal(pages, 4); // Two baseline pages, then drain and quarantine.
    assert.equal(h.calls.reread, 0);
  } finally {
    await h.mf.dispose();
  }
});
test("an empty incomplete source page yields without repeatedly spending the vendor budget", async (t) => {
  const h = await schedulerFixture();
  const wallClock = t.mock.method(Date, "now", () => FIXTURE_NOW);
  let pages = 0;
  const emptySource: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname !== "/v1/sync")
      return h.fetcher(input, init);
    pages++;
    return Response.json({
      account: { uuid: "account-fixture" },
      operations: [],
      qsos: [],
      meta: {
        operations: { records_left: 0 },
        qsos: { records_left: 1 },
      },
    });
  };
  try {
    const result = await tick(h.env, emptySource, FIXTURE_NOW);
    assert.equal(result.stopReason, "idle");
    assert.equal(result.errors, 0);
    assert.equal(result.deferred, 0);
    assert.equal(result.contacts, 0);
    assert.equal(pages, 1);
    const cursor = await h.store
      .statement("SELECT cursor FROM cursors WHERE stream='sync'")
      .first<{ cursor: string }>();
    assert.equal(JSON.parse(cursor!.cursor).mode, "backfill");
  } finally {
    wallClock.mock.restore();
    await h.mf.dispose();
  }
});
test("failed operation context reads yield the invocation instead of spinning", async (t) => {
  const h = await schedulerFixture();
  h.errors.reread = true;
  const wallClock = t.mock.method(Date, "now", () => FIXTURE_NOW);
  try {
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.stopReason, "idle");
    assert.equal(result.errors, 1);
    assert.equal(result.contacts, 0);
    assert.equal(h.calls.sourceSync, 3);
    assert.equal(h.calls.reread, 1);
  } finally {
    wallClock.mock.restore();
    await h.mf.dispose();
  }
});
test("the wall-time deadline stops a drain before starting more vendor work", async (t) => {
  const h = await schedulerFixture();
  let wall = FIXTURE_NOW;
  const wallClock = t.mock.method(Date, "now", () => wall);
  const slowSource: typeof fetch = async (input, init) => {
    const response = await h.fetcher(input, init);
    if (new URL(String(input)).pathname === "/v1/sync") wall += 90_001;
    return response;
  };
  try {
    const result = await tick(h.env, slowSource, FIXTURE_NOW);
    assert.equal(result.stopReason, "deadline");
    assert.equal(result.elapsedMs, 90_001);
    assert.equal(result.errors, 1); // The response outlived its source lease.
    assert.equal(result.contacts, 0);
    assert.equal(result.attempts, 0);
    assert.equal(h.calls.sourceSync, 1);
    assert.equal(h.calls.reread, 0);
    assert.equal(h.calls.qrzReads, 0);
    assert.equal(h.calls.lotwQueries, 0);
    assert.equal(await count(h, "source_work"), 0);
    assert.equal(await count(h, "source_read_policy_ready"), 0);
  } finally {
    wallClock.mock.restore();
    await h.mf.dispose();
  }
});
test("retained background history reconciles after source polling and before a slow rescan exhausts the deadline", async (t) => {
  const h = await schedulerFixture();
  let wall = FIXTURE_NOW;
  const wallClock = t.mock.method(Date, "now", () => wall);
  try {
    // Retain an unresolved contact with complete operation context from a
    // previous cycle, as happens when readback temporarily fails.
    h.errors.qrz = true;
    h.errors.lotw = true;
    const initial = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(initial.errors, 2);
    assert.equal(initial.contacts, 1);
    h.errors.qrz = false;
    h.errors.lotw = false;
    // Select the retained-first lane explicitly; baseline phases also rotate
    // background admission, so their count must not choose this test's lane.
    await h.store
      .statement("DELETE FROM cursors WHERE stream='scheduler:background'")
      .run();
    await h.store
      .statement(
        "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','rescan:destination',?,0,?)",
        JSON.stringify({
          mode: "backfill",
          operations: {},
          qsos: {},
          accountId: "account-fixture",
          rescanComplete: false,
        }),
        FIXTURE_NOW,
      )
      .run();
    wall += 5 * 60_000;
    const phases: string[] = [];
    let syncs = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync") {
        phases.push(++syncs === 1 ? "source-poll" : "background-rescan");
        if (syncs === 2) {
          for (const destination of ["destination", "lotw"])
            assert.equal(
              (await h.store.ledger(key(destination)))!.state,
              "adopted_existing",
            );
          wall += 90_001;
        }
      } else if (url.hostname === "logbook.qrz.com") {
        assert.equal(
          new URLSearchParams(String(init?.body)).get("ACTION"),
          "FETCH",
        );
        phases.push("qrz-readback");
      } else if (url.pathname === "/lotwuser/lotwreport.adi")
        phases.push("lotw-readback");
      return h.fetcher(input, init);
    };
    const result = await tick(h.env, fetcher, wall);
    assert.deepEqual(phases, [
      "source-poll",
      "qrz-readback",
      "qrz-readback",
      "lotw-readback",
      "background-rescan",
    ]);
    assert.equal(result.stopReason, "deadline");
    assert.equal(result.elapsedMs, 90_001);
    assert.equal(result.errors, 1); // Expired rescan lease cannot commit a page.
    assert.equal(result.contacts, 1);
    assert.equal(result.attempts, 0);
    assert.equal(h.calls.reread, 1);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    wallClock.mock.restore();
    await h.mf.dispose();
  }
});
test("full scheduler adopts both vendors read-only, purges raw source and ignores template-only changes", async () => {
  const h = await schedulerFixture();
  try {
    const initial = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(initial.errors, 0);
    assert.equal(initial.contacts, 1);
    for (const destination of ["destination", "lotw"]) {
      const row = (await h.store.ledger(key(destination)))!;
      assert.equal(row.state, "adopted_existing");
      assert.equal(row.sent_hash, null);
      assert.equal(row.source_hash, row.baseline_hash);
    }
    const qrz = (await h.store.ledger(key("destination")))!;
    assert.equal(qrz.narrative, "remote_preserved");
    assert.equal(qrz.template_version, null);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(h.calls.certificateStatus, 0);
    assert.equal(
      await count(
        h,
        "source_work",
        "kind='qso' AND is_event=0 AND state!='archived'",
      ),
      0,
    );
    assert.equal(
      await count(
        h,
        "private_data",
        "kind='source' AND id IN(SELECT private_id FROM source_work WHERE kind='qso' AND is_event=0)",
      ),
      0,
    );
    const reads = h.calls.qrzReads + h.calls.lotwQueries;
    await h.store.saveTemplate("a", "destination", {
      profile: TEMPLATE_PROFILE,
      fields: { COMMENT: "Future text only" },
      fallbackNotes: true,
    });
    await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * 60000);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzReads + h.calls.lotwQueries, reads);
    assert.equal(
      (await h.store.ledger(key("destination")))!.template_version,
      null,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("unchanged adopted QRZ narrative and LoTW receive no work from source-note changes", async () => {
  const h = await schedulerFixture();
  try {
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    h.enable();
    h.qso.notes = "Corrected source note";
    h.qso.syncedAtMillis = 200;
    h.changes.qsos.push(h.qso);
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * 60000);
    assert.equal(result.errors, 0);
    for (const destination of ["destination", "lotw"])
      assert.equal(
        (await h.store.ledger(key(destination)))!.state,
        "adopted_existing",
      );
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(h.calls.certificateStatus, 0);
    assert.equal(h.qrzRecords[0]!.COMMENT, "Adopted narrative & + = 100%");
    assert.equal(
      await count(
        h,
        "source_work",
        "kind='qso' AND is_event=0 AND state!='archived'",
      ),
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("operation-only location correction waits per-contact then preserves QRZ text and signs correct LoTW station", async () => {
  const h = await schedulerFixture();
  try {
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    h.enable();
    h.operation.grid = "FN32BB";
    h.operation.syncedAtMillis = 200;
    h.changes.operations.push(h.operation);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * 60000);
    for (const destination of ["destination", "lotw"]) {
      const row = (await h.store.ledger(key(destination)))!;
      assert.equal(row.state, "changed");
      assert.equal(row.due_at, FIXTURE_NOW + 35 * 60000);
    }
    assert.equal(await count(h, "attempts"), 0);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 20 * 60000);
    assert.equal(await count(h, "attempts"), 0);
    const sent = await tick(h.env, h.fetcher, FIXTURE_NOW + 36 * 60000);
    assert.equal(sent.errors, 0);
    assert.equal(h.calls.qrzWrites, 1);
    assert.equal(h.calls.lotwUploads, 1);
    assert.equal(h.qrzMutations[0]!.MY_GRIDSQUARE, "FN32BB");
    assert.equal(h.qrzMutations[0]!.COMMENT, "Adopted narrative & + = 100%");
    assert.match(h.tq8Texts[0]!, /<GRIDSQUARE:6>FN32BB/);
    assert.equal(
      (await h.store.ledger(key("destination")))!.state,
      "delivered",
    );
    assert.equal(
      (await h.store.ledger(key("destination")))!.narrative,
      "remote_preserved",
    );
    assert.equal((await h.store.ledger(key("lotw")))!.state, "submitted");
    await tick(h.env, h.fetcher, FIXTURE_NOW + 41 * 60000);
    assert.equal((await h.store.ledger(key("lotw")))!.state, "observed");
    assert.equal((await h.store.ledger(key("lotw")))!.confirmed, 0);
    assert.equal(h.calls.lotwUploads, 1);
    assert.equal(
      await count(
        h,
        "source_work",
        "kind='qso' AND is_event=0 AND state!='archived'",
      ),
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("QRZ outage leaves LoTW corrections independent and visible for later QRZ recovery", async () => {
  const h = await schedulerFixture();
  try {
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    h.enable();
    h.errors.qrz = true;
    h.operation.grid = "FN32BB";
    h.operation.syncedAtMillis = 200;
    h.changes.operations.push(h.operation);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * 60000);
    assert.equal((await h.store.ledger(key("lotw")))!.state, "changed");
    await tick(h.env, h.fetcher, FIXTURE_NOW + 36 * 60000);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 1);
    assert.equal((await h.store.ledger(key("lotw")))!.state, "submitted");
    assert((await h.store.ledger(key("destination")))!.reason);
    h.errors.qrz = false;
    await tick(h.env, h.fetcher, FIXTURE_NOW + 41 * 60000);
    assert.equal(h.calls.qrzWrites, 1);
    assert.equal(h.calls.lotwUploads, 1);
  } finally {
    await h.mf.dispose();
  }
});
test("read-only rollout never signs or submits a due correction", async () => {
  const h = await schedulerFixture();
  try {
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    h.env.ROLLOUT_QSO_IDS_JSON = '["q1"]';
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["*"]';
    h.operation.grid = "FN32BB";
    h.operation.syncedAtMillis = 200;
    h.changes.operations.push(h.operation);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * 60000);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 36 * 60000);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(h.calls.certificateStatus, 0);
    assert.equal(await count(h, "attempts", "destination='lotw'"), 0);
    assert.equal((await h.store.ledger(key("lotw")))!.state, "changed");
  } finally {
    await h.mf.dispose();
  }
});
test("an unproven source boundary cannot authorize backfill even with live-write transport gates set", async () => {
  const h = await schedulerFixture();
  try {
    h.qrzRecords.splice(0);
    h.lotwRecords.splice(0);
    h.enable();
    h.env.SOURCE_BOUNDARY_VERIFIED = "false";
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 40 * 60000);
    assert.equal(
      (await h.store.ledger(key("destination")))!.state,
      "inventory_pending",
    );
    assert.equal(
      (await h.store.ledger(key("lotw")))!.state,
      "inventory_pending",
    );
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(h.calls.certificateStatus, 0);
  } finally {
    await h.mf.dispose();
  }
});
test("no-query LoTW permits only a durably new forward UUID after cutover, including offline old dates", async () => {
  const h = await schedulerFixture();
  try {
    const credential = await h.store.private<{ signingCredentials: unknown[] }>(
      "a",
      "lotw",
      "fixture-lotw",
      "credential",
    );
    assert(credential);
    await h.store
      .statement(
        "DELETE FROM private_data WHERE tenant='a' AND connection='lotw' AND kind='credential'",
      )
      .run();
    await (
      await h.store.putPrivate("a", "lotw", "fixture-lotw", "credential", {
        signingCredentials: credential.signingCredentials,
      })
    ).run();
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(
      (await h.store.ledger(key("lotw")))!.state,
      "historical_unverified",
    );
    h.enable();
    h.env.ROLLOUT_QSO_IDS_JSON = '["q1","q2"]';
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["*"]';
    await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * 60000); // establish immutable cutoff before arrival
    const offline = {
      ...h.qso,
      uuid: "q2",
      operation: null,
      startAtMillis: Date.parse("2021-01-01T12:00:01Z"),
      our: {
        stationCall: "W1AW",
        grid: "FN31AA",
        state: "CT",
        county: "Tolland",
        dxccCode: 291,
        cqZone: 5,
        ituZone: 8,
      },
      syncedAtMillis: 300,
    };
    h.changes.qsos.push(offline);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 10 * 60000);
    const liveKey = { ...key("lotw"), qso: "q2" };
    assert.equal((await h.store.ledger(liveKey))!.state, "live_new");
    assert.equal(h.calls.lotwUploads, 0);
    h.qso.notes = "Historical correction stays unverified";
    h.qso.syncedAtMillis = 301;
    h.changes.qsos.push(h.qso);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 15 * 60000);
    assert.equal(
      (await h.store.ledger(key("lotw")))!.state,
      "historical_unverified",
    );
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW + 41 * 60000);
    assert.equal(result.errors, 0);
    assert.equal(h.calls.lotwQueries, 0);
    assert.equal(h.calls.lotwUploads, 1);
    assert.match(h.tq8Texts[0]!, /<QSO_DATE:10>2021-01-01/);
    assert.equal((await h.store.ledger(liveKey))!.state, "submitted");
    assert.equal(
      (await h.store.ledger(key("lotw")))!.state,
      "historical_unverified",
    );
    assert.equal(
      (await h.store
        .statement(
          "SELECT phase FROM source_births WHERE tenant='a' AND qso='q1'",
        )
        .first<{ phase: string }>())!.phase,
      "history",
    );
    assert.equal(
      (await h.store
        .statement(
          "SELECT phase FROM source_births WHERE tenant='a' AND qso='q2'",
        )
        .first<{ phase: string }>())!.phase,
      "forward_new",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("one invocation visits every failed source and confirmation turns remain fair", async () => {
  const h = await schedulerFixture();
  try {
    const lotw = await h.store.private<Record<string, unknown>>(
      "a",
      "lotw",
      "fixture-lotw",
      "credential",
    );
    assert.ok(lotw);
    const config = (await h.store.connection("a", "lotw"))!.config;
    for (const tenant of ["b", "c"]) {
      await seed(h.store, tenant);
      await (
        await h.store.putPrivate(
          tenant,
          "destination",
          "fixture-lotw",
          "credential",
          lotw,
        )
      ).run();
      await h.store
        .statement(
          "UPDATE connections SET kind='lotw',credential_version='fixture-lotw',config=? WHERE tenant=? AND id='destination'",
          config,
          tenant,
        )
        .run();
    }
    const unavailable = async () =>
      new Response("unavailable", { status: 503 });
    await tick(h.env, unavailable as typeof fetch, FIXTURE_NOW);
    const sources = (
      await h.store
        .statement(
          "SELECT tenant,last_poll_at FROM connections WHERE kind='lofi' ORDER BY tenant",
        )
        .all<{ tenant: string; last_poll_at: number | null }>()
    ).results;
    assert.equal(sources.length, 3);
    assert(sources.every((row) => row.last_poll_at !== null));
    await tick(h.env, unavailable as typeof fetch, FIXTURE_NOW + 300000);
    const health = (
      await h.store
        .statement("SELECT config FROM connections WHERE kind='lofi'")
        .all<{ config: string }>()
    ).results.map((row) => JSON.parse(row.config));
    assert(health.every((config) => config.lastSyncFailureAt >= FIXTURE_NOW));
    const turns = (
      await h.store
        .statement(
          "SELECT tenant,fence FROM leases WHERE scope='confirmation-refresh' ORDER BY tenant",
        )
        .all<{ tenant: string; fence: number }>()
    ).results;
    assert.deepEqual(
      turns.map((row) => row.tenant),
      ["a", "b", "c"],
    );
    assert(turns.every((row) => row.fence >= 1));
    assert.equal(h.calls.qrzWrites + h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("one invocation drains unresolved attempts without repeating them or making them retryable", async () => {
  const h = await schedulerFixture();
  try {
    for (let i = 0; i < 9; i++) {
      const id = `unresolved-${i}`;
      const ledgerKey = { ...key("lotw"), qso: id };
      await h.store.observe(
        ledgerKey,
        "g1",
        "h1",
        30,
        false,
        FIXTURE_NOW - 3600000,
      );
      await h.store
        .statement(
          "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a',?,'source',?,'lotw','g1',?,'h1','fixture-lotw',0,'h1')",
          id,
          id,
          id,
        )
        .run();
      // A missing artifact cannot be sent or inferred absent. It still must
      // yield its scheduler slot to the next durable unresolved attempt.
      await h.store
        .statement(
          "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at,priority) VALUES('a',?,'submitted',0,0,'live')",
          id,
        )
        .run();
    }
    const first = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(first.attempts, 9);
    assert.equal(
      await count(h, "attempt_state", `updated_at=${FIXTURE_NOW}`),
      9,
    );
    const repeated = await tick(h.env, h.fetcher, FIXTURE_NOW + 1);
    assert.equal(repeated.attempts, 0);
    const row = await h.store
      .statement(
        "SELECT state,updated_at FROM attempt_state WHERE tenant='a' AND attempt='unresolved-8'",
      )
      .first<{ state: string; updated_at: number }>();
    assert.equal(row?.state, "submitted");
    assert.equal(row?.updated_at, FIXTURE_NOW);
    assert.equal(h.calls.qrzWrites + h.calls.lotwUploads, 0);
    assert.equal(await count(h, "attempts"), 9);
  } finally {
    await h.mf.dispose();
  }
});

test("new forward arrivals precede historical reconciliation, even with old QSO dates", async () => {
  const h = await schedulerFixture();
  try {
    for (let i = 0; i < 10; i++)
      h.changes.qsos.push({
        ...h.qso,
        uuid: `history-${i}`,
        operation: null,
        their: { call: `K1OLD${i}` },
        our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
        syncedAtMillis: 110 + i,
      });
    const first = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(first.errors, 0);
    assert.equal(first.contacts, 11);
    assert(first.rounds > 1);
    assert.equal(first.stopReason, "idle");
    assert.equal(h.calls.sourceSync, 3);
    h.changes.qsos.push({
      ...h.qso,
      uuid: "offline-new",
      operation: null,
      their: { call: "N9LIVE" },
      our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
      startAtMillis: Date.parse("2021-01-01T12:00:01Z"),
      syncedAtMillis: 200,
    });
    const lookups: string[] = [];
    const observed: typeof fetch = async (input, init) => {
      if (new URL(String(input)).hostname === "logbook.qrz.com") {
        const form = new URLSearchParams(String(init?.body));
        if (form.get("ACTION") === "FETCH")
          lookups.push(form.get("OPTION") ?? "");
      }
      return h.fetcher(input, init);
    };
    const second = await tick(h.env, observed, FIXTURE_NOW + 300000);
    assert.equal(second.errors, 0);
    // Shared inventory settles the old contacts once; their review holds stay quiet.
    assert.equal(second.contacts, 1);
    assert.match(lookups[0]!, /BETWEEN:202[01]-/);
    assert(await h.store.ledger({ ...key("destination"), qso: "offline-new" }));
    assert.equal(
      await count(
        h,
        "source_work",
        "id LIKE 'history-%' AND priority='background'",
      ),
      10,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("successive fair rounds drain live and historical attempts in one invocation", async () => {
  const h = await schedulerFixture();
  try {
    for (const priority of ["background", "live"] as const)
      for (let i = 0; i < 9; i++) {
        const id = `${priority}-${i}`;
        await h.store.observe(
          { ...key("lotw"), qso: id },
          "g1",
          "h1",
          30,
          false,
          FIXTURE_NOW - 3600000,
        );
        await h.store
          .statement(
            "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a',?,'source',?,'lotw','g1',?,'h1','fixture-lotw',0,'h1')",
            id,
            id,
            id,
          )
          .run();
        await h.store
          .statement(
            "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at,priority) VALUES('a',?,'submitted',0,?,?)",
            id,
            priority === "background" ? 0 : 1,
            priority,
          )
          .run();
      }
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 0);
    assert.equal(result.attempts, 18);
    assert(result.rounds > 1);
    assert.equal(result.stopReason, "idle");
    assert.equal(
      await count(
        h,
        "attempt_state",
        `priority='live' AND updated_at=${FIXTURE_NOW}`,
      ),
      9,
    );
    assert.equal(
      await count(
        h,
        "attempt_state",
        `priority='background' AND updated_at=${FIXTURE_NOW}`,
      ),
      9,
    );
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("live delivery progresses within bounded vendor and database turns", async () => {
  const h = await schedulerFixture();
  const scopedReadback: typeof fetch = async (input, init) => {
    const response = await h.fetcher(input, init);
    const url = new URL(String(input));
    if (url.pathname !== "/lotwuser/lotwreport.adi") return response;
    await response.body?.cancel();
    const date = url.searchParams.get("qso_startdate")!.replaceAll("-", "");
    const records = h.lotwRecords.filter((record) => record.QSO_DATE === date);
    return new Response(
      `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(records.length).length}>${records.length}<EOH>${records.map(serializeAdifRecord).join("")}<APP_LOTW_EOF>`,
    );
  };
  try {
    await tick(h.env, scopedReadback, FIXTURE_NOW);
    await h.store
      .statement("UPDATE connections SET status='disabled' WHERE kind='qrz'")
      .run();
    h.enable();
    h.env.ROLLOUT_QSO_IDS_JSON = '["*"]';
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["*"]';
    for (let i = 1; i <= 10; i++)
      h.changes.qsos.push({
        ...h.qso,
        uuid: `live-upload-${i}`,
        operation: null,
        startAtMillis: Number(h.qso.startAtMillis) + i * 86400000,
        our: {
          stationCall: "W1AW",
          grid: "FN31AA",
          state: "CT",
          county: "Tolland",
          dxccCode: 291,
          cqZone: 5,
          ituZone: 8,
        },
        syncedAtMillis: 200 + i,
      });
    const observed = await tick(h.env, scopedReadback, FIXTURE_NOW + 5 * 60000);
    assert.equal(observed.errors, 0);
    assert.equal(observed.contacts, 10);
    assert.equal(h.calls.lotwUploads, 0);
    assert.equal(
      await count(
        h,
        "source_work",
        "id LIKE 'live-upload-%' AND priority='live'",
      ),
      10,
    );
    const due = await tick(h.env, scopedReadback, FIXTURE_NOW + 36 * 60000);
    assert.equal(due.errors, 0);
    assert(["idle", "database_budget"].includes(due.stopReason));
    assert(h.calls.lotwUploads > 0);
    if (due.stopReason === "database_budget") {
      assert(due.throughput!.database.calls >= 850);
      assert(due.throughput!.database.calls < 950);
    }
    let uploads = h.calls.lotwUploads;
    for (let turn = 1; turn <= 3 && h.calls.lotwUploads < 10; turn++) {
      const resumed = await tick(
        h.env,
        scopedReadback,
        FIXTURE_NOW + (36 + turn * 5) * 60000,
      );
      assert.equal(resumed.errors, 0);
      assert(h.calls.lotwUploads > uploads);
      uploads = h.calls.lotwUploads;
      const budget = await h.store
        .statement("SELECT requests FROM vendor_requests WHERE vendor='lotw'")
        .first<{ requests: number }>();
      assert((budget?.requests ?? 0) <= 40);
    }
    assert.equal(h.calls.lotwUploads, 10);
    assert.equal(
      await count(
        h,
        "attempt_state",
        "state='prepared' AND attempt IN(SELECT id FROM attempts WHERE destination='lotw')",
      ),
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("vendor cooldown pauses all of its work while other vendors continue", async () => {
  const h = await schedulerFixture();
  try {
    let requests = 0;
    const throttled: typeof fetch = async (input, init) => {
      if (new URL(String(input)).hostname === "logbook.qrz.com") {
        requests++;
        return new Response("throttled", {
          status: 429,
          headers: { "Retry-After": "900" },
        });
      }
      return h.fetcher(input, init);
    };
    const first = await tick(h.env, throttled, FIXTURE_NOW);
    assert.equal(first.errors, 0);
    assert(first.deferred > 0);
    assert.equal(requests, 1);
    assert.equal(
      (await h.store.ledger(key("lotw")))!.state,
      "adopted_existing",
    );
    assert.equal(
      (await h.store.ledger(key("destination")))!.state,
      "inventory_pending",
    );
    const second = await tick(h.env, throttled, FIXTURE_NOW + 300000);
    assert.equal(second.errors, 0);
    assert(second.deferred > 0);
    assert.equal(requests, 1);
    assert.equal(
      JSON.parse((await h.store.connection("a", "source"))!.config).lastError,
      undefined,
    );
    const resumed = await tick(h.env, h.fetcher, FIXTURE_NOW + 900000);
    assert.equal(resumed.errors, 0);
    assert.equal(
      (await h.store.ledger(key("destination")))!.state,
      "adopted_existing",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("saved historical uploads progress before inventory can exhaust the next background budget", async () => {
  const h = await schedulerFixture();
  try {
    h.enable();
    h.env.ROLLOUT_QSO_IDS_JSON = '["*"]';
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["*"]';
    await h.store
      .statement(
        "UPDATE connections SET status='disabled' WHERE id='destination'",
      )
      .run();
    h.lotwRecords.splice(0);
    for (let i = 1; i < 4; i++)
      h.changes.qsos.push({
        ...h.qso,
        uuid: `history-upload-${i}`,
        operation: null,
        startAtMillis: Number(h.qso.startAtMillis) + i * 86400000,
        our: {
          stationCall: "W1AW",
          grid: "FN31AA",
          state: "CT",
          county: "Tolland",
          dxccCode: 291,
          cqZone: 5,
          ituZone: 8,
        },
        syncedAtMillis: 110 + i,
      });
    assert.equal((await tick(h.env, h.fetcher, FIXTURE_NOW)).errors, 0);
    const deferUploads: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/lotw/upload")
        throw new VendorDeferredError(FIXTURE_NOW + 41 * 60000);
      return h.fetcher(input, init);
    };
    const due = await tick(h.env, deferUploads, FIXTURE_NOW + 36 * 60000);
    assert.equal(due.errors, 0);
    assert(
      await count(
        h,
        "attempt_state",
        "state='prepared' AND priority='background'",
      ),
    );
    const order: string[] = [];
    const observed: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (
        path === "/lotw/crl" ||
        path === "/lotw/upload" ||
        path === "/lotwuser/lotwreport.adi"
      )
        order.push(path);
      return h.fetcher(input, init);
    };
    const next = await tick(h.env, observed, FIXTURE_NOW + 41 * 60000);
    assert.equal(next.errors, 0);
    assert.deepEqual(order.slice(0, 2), ["/lotw/crl", "/lotw/upload"]);
    assert(h.calls.lotwUploads > 0);
    assert.equal(await count(h, "attempt_state", "priority='live'"), 0);
  } finally {
    await h.mf.dispose();
  }
});

test("expired history resumes through background repair without resetting forward sync", async () => {
  const h = await schedulerFixture();
  try {
    h.changes.operations.splice(0);
    h.qso.operation = null;
    h.qso.our = {
      stationCall: "W1AW",
      grid: "FN31AA",
      state: "CT",
      county: "Tolland",
      dxccCode: 291,
      cqZone: 5,
      ituZone: 8,
    };
    await h.store
      .statement("UPDATE connections SET status='disabled' WHERE kind!='lofi'")
      .run();
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    await h.store
      .statement("UPDATE connections SET status='active' WHERE kind!='lofi'")
      .run();
    let repairs = 0;
    const restored: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/sync") {
        const body = JSON.parse(String(init?.body));
        if ("syncedUntilMillis" in body.meta.sync.qsos) {
          repairs++;
          assert.equal(body.meta.sync.qsos.anyClient, true);
          assert.equal(body.meta.sync.qsos.limit, 25);
          return Response.json({
            account: { uuid: "account-fixture" },
            operations: [],
            qsos: [h.qso],
            meta: {
              operations: { records_left: 0 },
              qsos: { records_left: 0 },
            },
          });
        }
      }
      return h.fetcher(input, init);
    };
    const result = await tick(h.env, restored, FIXTURE_NOW + 8 * 86400000);
    assert.equal(result.errors, 0);
    assert.equal(repairs, 1);
    assert.equal(
      (await h.store.ledger(key("destination")))!.state,
      "adopted_existing",
    );
    const sync = await h.store
      .statement("SELECT cursor FROM cursors WHERE stream='sync'")
      .first<{ cursor: string }>();
    assert.equal(JSON.parse(sync!.cursor).mode, "forward");
    const repair = await h.store
      .statement("SELECT cursor FROM cursors WHERE stream='repair'")
      .first<{ cursor: string }>();
    assert.equal(JSON.parse(repair!.cursor).rescanComplete, true);
  } finally {
    await h.mf.dispose();
  }
});

test("read-only background history overlaps at most four contacts and preserves every classification", async () => {
  const h = await schedulerFixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const qrz = { ...h.qrzRecords[0] };
    const lotw = { ...h.lotwRecords[0] };
    h.qrzRecords.length = 0;
    h.lotwRecords.length = 0;
    h.changes.operations.length = 0;
    h.changes.qsos.length = 0;
    for (let index = 0; index < 8; index++) {
      const startAtMillis = Date.UTC(2025, index, 15, 12, 0, 1);
      const call = `K1PAR${index}`;
      h.changes.qsos.push({
        ...h.qso,
        uuid: `parallel-${index}`,
        operation: null,
        startAtMillis,
        their: { call },
        our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
        syncedAtMillis: 110 + index,
      });
      const fields = {
        CALL: call,
        QSO_DATE: new Date(startAtMillis)
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", ""),
      };
      h.qrzRecords.push({
        ...qrz,
        ...fields,
        APP_QRZLOG_LOGID: String(500 + index),
      });
      h.lotwRecords.push({ ...lotw, ...fields });
    }
    let active = 0;
    let maximum = 0;
    let arrivals = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const history =
        url.pathname === "/lotwuser/lotwreport.adi" ||
        (url.hostname === "logbook.qrz.com" &&
          new URLSearchParams(String(init?.body)).get("ACTION") === "FETCH");
      if (!history) return h.fetcher(input, init);
      timeout ??= setTimeout(() => release(), 10_000);
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (++arrivals <= 4) {
          if (arrivals === 4) release();
          await barrier;
        }
        return await h.fetcher(input, init);
      } finally {
        active--;
      }
    };
    const result = await tick(h.env, fetcher, FIXTURE_NOW);
    assert.equal(maximum, 4);
    assert.equal(result.errors, 0);
    assert.equal(result.contacts, 8);
    assert.equal(result.throughput?.classifiedDestinations, 16);
    const database = result.throughput!.database;
    assert(database.wallMs <= result.elapsedMs);
    assert(database.durationMs >= database.wallMs);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    clearTimeout(timeout);
    release();
    await h.mf.dispose();
  }
});

test("twenty historical contacts share inventory and unchanged review holds stay quiet", async () => {
  const h = await schedulerFixture();
  try {
    h.qrzRecords[0].TIME_ON = h.qrzRecords[0].TIME_ON!.slice(0, 4);
    h.lotwRecords[0].MY_GRIDSQUARE = "FN31";
    for (let index = 1; index < 20; index++) {
      const call = `K1SCALE${index}`;
      h.changes.qsos.push({
        ...h.qso,
        uuid: `scale-${index}`,
        operation: null,
        their: { call },
        our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
        syncedAtMillis: 110 + index,
      });
      h.qrzRecords.push({
        ...h.qrzRecords[0],
        CALL: call,
        APP_QRZLOG_LOGID: String(500 + index),
      });
      h.lotwRecords.push({ ...h.lotwRecords[0], CALL: call });
    }
    const first = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(first.errors, 0);
    assert.equal(first.contacts, 20);
    assert.equal(first.throughput?.classifiedDestinations, 40);
    assert.equal(first.throughput?.inventoryFetches, 3);
    assert((first.throughput?.inventoryCacheHits ?? 0) >= 38);
    assert.equal(h.calls.qrzReads, 2);
    assert.equal(h.calls.lotwQueries, 1);
    assert.equal(await count(h, "ledger", "state='history_ambiguous'"), 40);
    const reads = [h.calls.qrzReads, h.calls.lotwQueries];
    const next = await tick(h.env, h.fetcher, FIXTURE_NOW + 300000);
    assert.equal(next.contacts, 0);
    assert.deepEqual([h.calls.qrzReads, h.calls.lotwQueries], reads);
    await h.store.db.batch([
      h.store.statement("UPDATE reconciliation_checks SET next_due_at=0"),
      h.store.statement("UPDATE reconciliation_work SET next_due_at=0"),
    ]);
    // Source verification must not add per-contact proof reads for readable history.
    h.env.SOURCE_BOUNDARY_VERIFIED = "true";
    const warm = await tick(h.env, h.fetcher, FIXTURE_NOW + 600000);
    assert.equal(warm.contacts, 20);
    assert.equal(warm.errors, 0);
    assert.equal(warm.throughput?.classifiedDestinations, 40);
    assert.equal(warm.throughput?.inventoryCacheHits, 40);
    assert.equal(warm.throughput?.inventoryFetches, 0);
    assert(
      warm.throughput!.reconciliationBatchCalls <= 30,
      `warm cohort made ${warm.throughput!.reconciliationBatchCalls} database RPCs`,
    );
    assert.deepEqual([h.calls.qrzReads, h.calls.lotwQueries], reads);
    assert.equal(await count(h, "ledger", "state='history_ambiguous'"), 40);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("source changes during shared history cannot commit a stale association", async () => {
  for (const mutation of [
    null,
    "UPDATE cursors SET generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='context'",
    "UPDATE source_work SET revision='concurrent-revision' WHERE tenant='a' AND source='source' AND id='q1' AND kind='qso'",
    "UPDATE source_work SET expires_at=0 WHERE tenant='a' AND source='source' AND id='event-race' AND kind='qso'",
    "UPDATE private_data SET expires_at=0 WHERE tenant='a' AND connection='source' AND kind='source' AND id=(SELECT private_id FROM source_work WHERE tenant='a' AND source='source' AND id='event-race' AND kind='qso')",
    "UPDATE private_data SET revoked_at=1 WHERE tenant='a' AND connection='source' AND kind='source' AND id=(SELECT private_id FROM source_work WHERE tenant='a' AND source='source' AND id='event-race' AND kind='qso')",
    "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND kind='source' AND id=(SELECT private_id FROM source_work WHERE tenant='a' AND source='source' AND id='event-race' AND kind='qso')",
  ]) {
    const h = await schedulerFixture();
    try {
      const event = {
        uuid: "event-race",
        operation: h.qso.operation,
        band: "event",
        startAtMillis: Number(h.qso.startAtMillis) - 1000,
        event: { event: "break", operation: { grid: "FN32BB" } },
        syncedAtMillis: 102,
      };
      h.changes.qsos.push(event);
      h.qrzRecords[0].MY_GRIDSQUARE = "FN32BB";
      h.lotwRecords[0].MY_GRIDSQUARE = "FN32BB";
      let changed = false;
      const concurrent: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/operations/op-fixture/qsos") {
          const response = await h.fetcher(input, init);
          const page = (await response.json()) as {
            qsos: unknown[];
          };
          page.qsos.push(event);
          return Response.json(page);
        }
        if (!changed && url.hostname === "logbook.qrz.com") {
          changed = true;
          if (mutation) await h.store.statement(mutation).run();
        }
        return h.fetcher(input, init);
      };
      const result = await tick(h.env, concurrent, FIXTURE_NOW);
      assert(changed);
      assert.equal(result.errors, 0);
      for (const destination of ["destination", "lotw"]) {
        const ledger = await h.store.ledger(key(destination));
        if (mutation) assert.equal(ledger?.remote_id, null, mutation);
        else {
          assert(ledger?.remote_id, "valid retained event context adopts");
          assert.equal(ledger.state, "adopted_existing");
        }
      }
      assert.equal(result.throughput?.adoptedDestinations, mutation ? 0 : 2);
      assert.equal(await count(h, "attempts"), 0);
      assert.equal(h.calls.qrzWrites, 0);
      assert.equal(h.calls.lotwUploads, 0);
    } finally {
      await h.mf.dispose();
    }
  }
});

test("a stale source in a reconciliation cohort cannot overwrite or delay its newer work", async () => {
  const h = await schedulerFixture();
  try {
    h.changes.operations.length = 0;
    h.changes.qsos[0] = {
      ...h.qso,
      operation: null,
      our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
    };
    for (let index = 1; index < 4; index++) {
      const call = `K1COHORT${index}`;
      h.changes.qsos.push({
        ...h.qso,
        uuid: `cohort-${index}`,
        operation: null,
        their: { call },
        our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
        syncedAtMillis: 110 + index,
      });
      h.qrzRecords.push({
        ...h.qrzRecords[0],
        CALL: call,
        APP_QRZLOG_LOGID: String(700 + index),
      });
      h.lotwRecords.push({ ...h.lotwRecords[0], CALL: call });
    }
    let changed = false;
    const concurrent: typeof fetch = async (input, init) => {
      if (!changed && new URL(String(input)).hostname === "logbook.qrz.com") {
        changed = true;
        await h.store
          .statement(
            "UPDATE source_work SET revision='newer-cohort-revision' WHERE tenant='a' AND source='source' AND id='q1' AND kind='qso'",
          )
          .run();
      }
      return h.fetcher(input, init);
    };
    const result = await tick(h.env, concurrent, FIXTURE_NOW);
    assert(changed);
    assert.equal(result.errors, 0);
    assert.equal(result.contacts, 4);
    assert(result.throughput!.reconciliationBatchCalls > 0);
    assert.equal(
      await count(h, "ledger", "qso='q1' AND remote_id IS NOT NULL"),
      0,
    );
    assert.equal(
      await count(h, "ledger", "qso!='q1' AND state='adopted_existing'"),
      6,
    );
    const newer = await h.store
      .statement(
        "SELECT next_due_at FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso='q1'",
      )
      .first<{ next_due_at: number }>();
    assert.equal(newer?.next_due_at, 0);
    assert.equal(await count(h, "reconciliation_checks", "qso='q1'"), 0);
    assert.equal(await count(h, "history_adoption_guards"), 0);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("a failed contact finalizer retains the source lease until delayed workers settle", async () => {
  const h = await schedulerFixture();
  const slowDate = "2025-02-15";
  let releaseSlow!: () => void;
  const slowBarrier = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let announceSlow!: () => void;
  const slowStarted = new Promise<void>((resolve) => {
    announceSlow = resolve;
  });
  let announceFailure!: () => void;
  const failureInjected = new Promise<void>((resolve) => {
    announceFailure = resolve;
  });
  let announcePrematureRelease!: () => void;
  const prematureRelease = new Promise<void>((resolve) => {
    announcePrematureRelease = resolve;
  });
  let announceFinished!: () => void;
  const slowFinished = new Promise<void>((resolve) => {
    announceFinished = resolve;
  });
  let injected = false;
  let delayed = false;
  let finalized = false;
  let tickSettled = false;
  let running: ReturnType<typeof tick> | undefined;
  try {
    const qrz = { ...h.qrzRecords[0] };
    const lotw = { ...h.lotwRecords[0] };
    h.qrzRecords.length = 0;
    h.lotwRecords.length = 0;
    h.changes.operations.length = 0;
    h.changes.qsos.length = 0;
    for (const [index, id] of ["finalizer-fails", "worker-delayed"].entries()) {
      const startAtMillis = Date.UTC(2025, index, 15, 12, 0, 1);
      const call = `K1WAIT${index}`;
      h.changes.qsos.push({
        ...h.qso,
        uuid: id,
        operation: null,
        startAtMillis,
        their: { call },
        our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
        syncedAtMillis: 110 + index,
      });
      const fields = {
        CALL: call,
        QSO_DATE: new Date(startAtMillis)
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", ""),
      };
      h.qrzRecords.push({
        ...qrz,
        ...fields,
        APP_QRZLOG_LOGID: String(500 + index),
      });
      h.lotwRecords.push({ ...lotw, ...fields });
    }
    const wrap = (
      statement: D1PreparedStatement,
      sql: string,
      values: unknown[] = [],
    ): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...bound: unknown[]) =>
              wrap(target.bind(...bound), sql, bound);
          const member = Reflect.get(target, property, target);
          if (property === "run" || property === "all")
            return async () => {
              if (
                sql.startsWith(
                  "UPDATE reconciliation_work SET next_due_at=COALESCE",
                )
              ) {
                if (values[4] === "finalizer-fails" && !injected) {
                  injected = true;
                  announceFailure();
                  throw new Error("synthetic finalizer database failure");
                }
                const result = await member.call(target);
                if (values[4] === "worker-delayed") {
                  finalized = true;
                  announceFinished();
                }
                return result;
              }
              if (values[1] === "cycle:source" && injected && !finalized)
                announcePrematureRelease();
              return member.call(target);
            };
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    const database = new Proxy(h.env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.startsWith(
              "UPDATE reconciliation_work SET next_due_at=COALESCE",
            ) || sql.startsWith("UPDATE leases SET expires_at=0")
              ? wrap(statement, sql)
              : statement;
          };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (!delayed && url.hostname === "logbook.qrz.com") {
        const options =
          new URLSearchParams(String(init?.body)).get("OPTION") ?? "";
        const range = /BETWEEN:([\d-]+)\+([\d-]+)/.exec(options);
        if (range && range[1] <= slowDate && slowDate <= range[2]) {
          delayed = true;
          announceSlow();
          await slowBarrier;
        }
      }
      return h.fetcher(input, init);
    };
    running = tick({ ...h.env, DB: database }, fetcher, FIXTURE_NOW).finally(
      () => {
        tickSettled = true;
      },
    );
    await Promise.all([slowStarted, failureInjected]);
    const releasedEarly = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 500);
      void prematureRelease.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    assert.equal(
      releasedEarly,
      false,
      "failed worker must not release another worker's cycle lease",
    );
    assert.equal(tickSettled, false, "tick must wait for every started worker");
    const lease = await h.store
      .statement(
        "SELECT expires_at FROM leases WHERE tenant='a' AND scope='cycle:source'",
      )
      .first<{ expires_at: number }>();
    assert((lease?.expires_at ?? 0) > FIXTURE_NOW);
    releaseSlow();
    const result = await running;
    assert(finalized);
    assert.equal(result.errors, 1);
    assert.equal(result.contacts, 2);
    assert.equal(
      await count(h, "leases", "scope='cycle:source' AND expires_at>0"),
      0,
    );
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    releaseSlow();
    if (running) await running.catch(() => undefined);
    if (delayed && !finalized) await slowFinished;
    await h.mf.dispose();
  }
});

test("background lanes rotate across deadlines and failures while source polling stays first", async (t) => {
  const h = await schedulerFixture();
  let wall = FIXTURE_NOW;
  const wallClock = t.mock.method(Date, "now", () => wall);
  try {
    h.errors.qrz = true;
    h.errors.lotw = true;
    const initial = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(initial.contacts, 1);
    assert.equal(initial.errors, 2);
    h.errors.qrz = false;
    h.errors.lotw = false;
    await h.store
      .statement("DELETE FROM cursors WHERE stream='scheduler:background'")
      .run();
    await h.store
      .statement(
        "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','rescan:destination',?,0,?)",
        JSON.stringify({
          mode: "backfill",
          operations: {},
          qsos: {},
          accountId: "account-fixture",
          rescanComplete: false,
        }),
        FIXTURE_NOW,
      )
      .run();
    await (
      await h.store.putPrivate("a", "source", "pending-context", "source", {
        ...h.operation,
        uuid: "op-pending",
      })
    ).run();
    await h.store
      .statement(
        "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at,priority,policy_seen_epoch) VALUES('a','source','op-pending','operation','pending-context','synthetic-operation-revision',?,'background',(SELECT epoch FROM source_read_policies WHERE tenant='a' AND source='source'))",
        FIXTURE_NOW + 86_400_000,
      )
      .run();
    for (const [index, expected] of [
      "retained",
      "rescan",
      "reread",
    ].entries()) {
      wall = FIXTURE_NOW + (index + 1) * 5 * 60_000;
      const phases: string[] = [];
      let syncs = 0;
      const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/sync") {
          phases.push(++syncs === 1 ? "source-poll" : "rescan");
          if (syncs > 1) wall += 90_001;
        } else if (url.pathname === "/v1/operations/op-pending/qsos") {
          phases.push("reread");
          wall += 90_001;
          return Response.json({
            qsos: [],
            meta: { qsos: { records_left: 0 } },
          });
        } else if (url.hostname === "logbook.qrz.com") {
          phases.push("retained");
          wall += 90_001;
          throw new Error("synthetic slow history outage");
        }
        return h.fetcher(input, init);
      };
      const result = await tick(h.env, fetcher, wall);
      assert.deepEqual(phases, ["source-poll", expected]);
      assert.equal(result.stopReason, "deadline");
      assert.equal(result.exportsEnabled, false);
      assert.equal(result.contacts, index === 0 ? 1 : 0);
      assert.equal(result.errors, 1);
      assert.equal(result.throughput?.rescanPages, 0);
      assert.equal(result.throughput?.rereadPages, 0);
      const turn = await h.store
        .statement(
          "SELECT generation,cursor FROM cursors WHERE tenant='a' AND connection='source' AND stream='scheduler:background'",
        )
        .first<{ generation: number; cursor: string }>();
      assert.deepEqual(turn, { generation: index + 1, cursor: "{}" });
    }
    assert.equal(
      await count(h, "source_work", "id='op-pending' AND state='context'"),
      0,
      "the expired reread cannot publish context",
    );
    wall = FIXTURE_NOW + 20 * 60_000;
    const recovered = await tick(
      h.env,
      async (input, init) => {
        if (
          new URL(String(input)).pathname === "/v1/operations/op-pending/qsos"
        )
          return Response.json({
            qsos: [],
            meta: { qsos: { records_left: 0 } },
          });
        return h.fetcher(input, init);
      },
      wall,
    );
    assert.equal(recovered.errors, 0);
    assert.equal(
      await count(h, "source_work", "id='op-pending' AND state='context'"),
      1,
    );
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(await count(h, "source_cutovers"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    wallClock.mock.restore();
    await h.mf.dispose();
  }
});

test("background rotation cannot advance after the source cycle lease is lost", async () => {
  for (const loss of ["expired", "replaced"] as const) {
    const h = await schedulerFixture();
    try {
      h.errors.qrz = true;
      h.errors.lotw = true;
      await tick(h.env, h.fetcher, FIXTURE_NOW);
      h.errors.qrz = false;
      h.errors.lotw = false;
      const saved = await h.store
        .statement(
          "SELECT generation,updated_at FROM cursors WHERE tenant='a' AND connection='source' AND stream='scheduler:background'",
        )
        .first<{ generation: number; updated_at: number }>();
      const before = { ...h.calls };
      let invalidated = false;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property) {
            if (property === "bind")
              return (...values: unknown[]) => wrap(target.bind(...values));
            const member = Reflect.get(target, property, target);
            if (property === "first")
              return async () => {
                invalidated = true;
                await h.store
                  .statement(
                    loss === "expired"
                      ? "UPDATE leases SET expires_at=0 WHERE tenant='a' AND scope='cycle:source'"
                      : "UPDATE leases SET token='replacement-worker',fence=fence+1 WHERE tenant='a' AND scope='cycle:source'",
                  )
                  .run();
                return member.call(target);
              };
            return typeof member === "function" ? member.bind(target) : member;
          },
        });
      const database = new Proxy(h.env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              return sql.startsWith("INSERT INTO cursors(") &&
                sql.includes("'scheduler:background'")
                ? wrap(statement)
                : statement;
            };
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      const result = await tick(
        { ...h.env, DB: database },
        h.fetcher,
        FIXTURE_NOW + 5 * 60_000,
      );
      assert(invalidated, loss);
      assert.equal(result.contacts, 0, loss);
      assert.equal(result.errors, 0, loss);
      assert.deepEqual(
        await h.store
          .statement(
            "SELECT generation,updated_at FROM cursors WHERE tenant='a' AND connection='source' AND stream='scheduler:background'",
          )
          .first(),
        saved,
        loss,
      );
      assert.equal(h.calls.qrzReads, before.qrzReads, loss);
      assert.equal(h.calls.lotwQueries, before.lotwQueries, loss);
      assert.equal(h.calls.reread, before.reread, loss);
      assert.equal(await count(h, "attempts"), 0);
      assert.equal(h.calls.qrzWrites, 0);
      assert.equal(h.calls.lotwUploads, 0);
    } finally {
      await h.mf.dispose();
    }
  }
});

test("a slow forward-source background batch cannot strand a paired account's initial import", async (t) => {
  const h = await schedulerFixture();
  let wall = FIXTURE_NOW;
  const wallClock = t.mock.method(Date, "now", () => wall);
  try {
    h.errors.qrz = true;
    h.errors.lotw = true;
    await tick(h.env, h.fetcher, wall);
    h.errors.qrz = false;
    h.errors.lotw = false;
    await seed(h.store, "b");
    await (
      await h.store.putPrivate("b", "source", "import-source", "credential", {
        key: "browser:synthetic-import",
        secret: "synthetic-import",
        token: "synthetic-import",
      })
    ).run();
    await h.store
      .statement(
        "UPDATE connections SET credential_version='import-source',remote_identity='account-import',config=? WHERE tenant='b' AND id='source'",
        JSON.stringify({ accountId: "account-import" }),
      )
      .run();
    await h.store
      .statement("DELETE FROM cursors WHERE stream='scheduler:background'")
      .run();
    await h.store
      .statement("UPDATE scheduler_background_accounts SET last_turn=0")
      .run();
    await h.store
      .statement("UPDATE scheduler_background_sources SET last_turn=0")
      .run();
    const phases: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync") {
        if (
          new Headers(init?.headers).get("Authorization") ===
          "Bearer synthetic-import"
        ) {
          phases.push("import-poll");
          // Even the selected source's canonical prelude can consume its
          // entire turn; admission must already be durable at this point.
          const admission = await h.store
            .statement(
              "SELECT last_turn FROM scheduler_background_sources WHERE tenant='b' AND source='source'",
            )
            .first<{ last_turn: number }>();
          assert((admission?.last_turn ?? 0) > 0);
          wall += 90_001;
          return Response.json({
            account: { uuid: "account-import" },
            operations: [],
            qsos: [],
            meta: {
              operations: { records_left: 0 },
              qsos: { records_left: 0 },
            },
          });
        }
        phases.push("forward-poll");
      } else if (url.hostname === "logbook.qrz.com") {
        phases.push("slow-history");
        wall += 90_001;
        throw new Error("synthetic slow history failure");
      }
      return h.fetcher(input, init);
    };
    wall = FIXTURE_NOW + 300_000;
    const first = await tick(h.env, transport, wall);
    assert.deepEqual(phases, ["forward-poll", "slow-history"]);
    assert.equal(first.stopReason, "deadline");
    assert.equal(first.errors, 1);
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT last_turn FROM scheduler_background_sources WHERE tenant='b' AND source='source'",
          )
          .first<{ last_turn: number }>()
      )?.last_turn,
      0,
    );
    wall = FIXTURE_NOW + 600_000;
    phases.length = 0;
    // A new invocation reconstructs all in-memory state. Its live pair still
    // starts with the forward account, but durable background order starts b.
    const second = await tick(h.env, transport, wall);
    assert.deepEqual(phases, ["forward-poll", "import-poll"]);
    assert.equal(second.stopReason, "deadline");
    assert.equal(second.sources, 1); // Only the forward page committed.
    assert.equal(second.errors, 1); // The admitted import exceeded its lease.
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT json_extract(cursor,'$.mode') mode FROM cursors WHERE tenant='b' AND connection='source' AND stream='sync'",
          )
          .first<{ mode: string }>()
      )?.mode,
      "backfill",
    );
    assert.equal(first.exportsEnabled, false);
    assert.equal(second.exportsEnabled, false);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(await count(h, "source_cutovers"), 0);
    assert.equal(h.calls.qrzWrites + h.calls.lotwUploads, 0);
  } finally {
    wallClock.mock.restore();
    await h.mf.dispose();
  }
});

test("slow failed background imports yield to every account across fresh invocations", async (t) => {
  const h = await schedulerFixture();
  let wall = FIXTURE_NOW;
  const wallClock = t.mock.method(Date, "now", () => wall);
  try {
    for (const tenant of ["b", "c"]) {
      await seed(h.store, tenant);
      await (
        await h.store.putPrivate(
          tenant,
          "source",
          "import-source",
          "credential",
          {
            key: `browser:synthetic-${tenant}`,
            secret: "synthetic",
            token: `synthetic-${tenant}`,
          },
        )
      ).run();
      await h.store
        .statement(
          "UPDATE connections SET credential_version='import-source',remote_identity=?,config=? WHERE tenant=? AND id='source'",
          `account-${tenant}`,
          JSON.stringify({ accountId: `account-${tenant}` }),
          tenant,
        )
        .run();
    }
    await h.store
      .statement("UPDATE connections SET status='disabled' WHERE kind!='lofi'")
      .run();
    const visited: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/v1/sync");
      const token = new Headers(init?.headers).get("Authorization");
      visited.push(token === "Bearer synthetic" ? "a" : token!.slice(-1));
      wall += 90_001;
      throw new Error("synthetic slow source outage");
    };
    for (let index = 0; index < 3; index++) {
      wall = FIXTURE_NOW + index * 300_000;
      const result = await tick(h.env, transport, wall);
      assert.equal(result.stopReason, "deadline");
      assert.equal(result.errors, 1);
      assert.equal(result.exportsEnabled, false);
    }
    assert.deepEqual(visited, ["a", "b", "c"]);
    assert.deepEqual(
      (
        await h.store
          .statement(
            "SELECT tenant,last_turn FROM scheduler_background_accounts ORDER BY last_turn",
          )
          .all()
      ).results,
      [
        { tenant: "a", last_turn: 1 },
        { tenant: "b", last_turn: 2 },
        { tenant: "c", last_turn: 3 },
      ],
    );
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(await count(h, "cursors", "stream='sync'"), 3);
    assert.equal(await count(h, "source_read_policies", "phase='backfill'"), 3);
    assert.equal(await count(h, "source_read_policy_ready"), 0);
    assert.equal(await count(h, "source_work"), 0);
    assert.equal(h.calls.qrzWrites + h.calls.lotwUploads, 0);
  } finally {
    wallClock.mock.restore();
    await h.mf.dispose();
  }
});

test("an independently admitted forward source is refreshed once before its later live roster turn", async () => {
  const h = await schedulerFixture();
  try {
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    for (const tenant of ["b", "c"]) {
      await seed(h.store, tenant);
      await (
        await h.store.putPrivate(
          tenant,
          "source",
          "forward-source",
          "credential",
          {
            key: `browser:synthetic-${tenant}`,
            secret: "synthetic",
            token: `synthetic-${tenant}`,
          },
        )
      ).run();
      await h.store
        .statement(
          "UPDATE connections SET credential_version='forward-source',remote_identity=?,config=? WHERE tenant=? AND id='source'",
          `account-${tenant}`,
          JSON.stringify({ accountId: `account-${tenant}` }),
          tenant,
        )
        .run();
    }
    const visited: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/sync") {
        const token = new Headers(init?.headers).get("Authorization");
        const tenant = token === "Bearer synthetic" ? "a" : token!.slice(-1);
        visited.push(tenant);
        if (tenant !== "a")
          return Response.json({
            account: { uuid: `account-${tenant}` },
            operations: [],
            qsos: [],
            meta: {
              operations: { records_left: 0 },
              qsos: { records_left: 0 },
            },
          });
      }
      return h.fetcher(input, init);
    };
    // Complete each independent source's real tagged baseline before measuring
    // the established-forward scheduling order. A copied cursor is not proof.
    // Six baseline/drain/handoff reads for b+c span two shared background
    // budget windows; none of this fixture setup may bypass that admission.
    for (const offset of [300_000, 600_000]) {
      const baseline = await tick(h.env, transport, FIXTURE_NOW + offset);
      assert.equal(baseline.errors, 0);
    }
    assert.equal(await count(h, "source_read_policy_ready"), 3);
    visited.length = 0;
    await h.store
      .statement(
        "UPDATE connections SET last_poll_at=CASE tenant WHEN 'a' THEN 0 WHEN 'b' THEN 1 ELSE 2 END WHERE kind='lofi'",
      )
      .run();
    await h.store
      .statement(
        "UPDATE scheduler_background_accounts SET last_turn=CASE tenant WHEN 'c' THEN 0 ELSE 1 END",
      )
      .run();
    const result = await tick(h.env, transport, FIXTURE_NOW + 900_000);
    assert.equal(result.stopReason, "idle");
    assert.equal(result.errors, 0);
    assert.equal(result.sources, 3);
    assert.deepEqual(visited, ["a", "b", "c"]);
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites + h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("one failed QRZ boundary partition does not hold healthy contacts in the same week", async () => {
  const h = await schedulerFixture();
  try {
    h.changes.operations.length = 0;
    h.changes.qsos[0] = {
      ...h.qso,
      operation: null,
      startAtMillis: Date.parse("2026-10-22T00:30:30Z"),
      our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
    };
    for (let index = 1; index < 4; index++) {
      const call = `K1EDGE${index}`;
      h.changes.qsos.push({
        ...h.qso,
        uuid: `edge-${index}`,
        operation: null,
        their: { call },
        our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
        syncedAtMillis: 110 + index,
      });
      h.qrzRecords.push({
        ...h.qrzRecords[0],
        CALL: call,
        APP_QRZLOG_LOGID: String(700 + index),
      });
      h.lotwRecords.push({ ...h.lotwRecords[0], CALL: call });
    }
    let failedReads = 0;
    const transport: typeof fetch = async (input, init) => {
      if (new URL(String(input)).hostname === "logbook.qrz.com") {
        const filters =
          new URLSearchParams(String(init?.body)).get("OPTION") ?? "";
        if (filters.includes("BETWEEN:2026-10-15+2026-10-21")) {
          failedReads++;
          throw new Error(
            "synthetic prior-week outage contains private marker",
          );
        }
      }
      return h.fetcher(input, init);
    };
    const result = await tick(h.env, transport, FIXTURE_NOW);
    assert.equal(result.errors, 1);
    assert.deepEqual(
      { ...result.throughput?.failures },
      {
        "history_read:qrz:qrz_transient": { events: 1, affected: 1 },
      },
    );
    assert(!JSON.stringify(result).includes("private marker"));
    assert.equal(
      failedReads,
      1,
      "failed evidence is not retried by a healthy sibling's second pass",
    );
    assert.equal(result.throughput?.classifiedDestinations, 7);
    assert.equal(
      await count(
        h,
        "ledger",
        "destination='destination' AND qso!='q1' AND state='adopted_existing'",
      ),
      3,
    );
    const held = await h.store.ledger(key("destination"));
    assert.equal(held?.remote_id, null);
    assert.equal(
      held?.reason,
      "Destination reconciliation failed; retry automatically",
    );
    assert.equal(
      await count(
        h,
        "reconciliation_checks",
        "destination='destination' AND qso='q1'",
      ),
      0,
    );
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("shared reconciliation failures count one event and each affected route", async () => {
  const h = await schedulerFixture();
  try {
    h.changes.operations.length = 0;
    h.changes.qsos.length = 0;
    for (let index = 0; index < 4; index++) {
      const call = `K1FAIL${index}`;
      h.changes.qsos.push({
        ...h.qso,
        uuid: `failed-cohort-${index}`,
        operation: null,
        their: { call },
        our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
        syncedAtMillis: 110 + index,
      });
      h.lotwRecords.push({ ...h.lotwRecords[0], CALL: call });
    }
    let failedReads = 0;
    const transport: typeof fetch = async (input, init) => {
      if (new URL(String(input)).hostname === "logbook.qrz.com") {
        failedReads++;
        throw new Error("private-vendor-response-and-credential");
      }
      return h.fetcher(input, init);
    };
    const result = await tick(h.env, transport, FIXTURE_NOW);
    assert.equal(failedReads, 1);
    assert.equal(result.errors, 4);
    assert.deepEqual(
      { ...result.throughput?.failures },
      {
        "history_read:qrz:qrz_transient": { events: 1, affected: 4 },
      },
    );
    assert.equal(result.throughput?.classifiedDestinations, 4);
    assert.equal(result.throughput?.adoptedDestinations, 4);
    assert(!JSON.stringify(result).includes("private-vendor"));
    assert.equal(await count(h, "attempts"), 0);
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});
