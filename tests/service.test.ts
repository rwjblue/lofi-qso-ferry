import assert from "node:assert/strict";
import test from "node:test";
import { serializeAdifRecord } from "../src/adif.ts";
import { tick } from "../src/service.ts";
import { seed } from "./helpers.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
import { schedulerFixture, FIXTURE_NOW } from "./runtime-fixtures.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
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
    assert.equal(h.calls.sourceSync, 1);
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
    assert.equal(h.calls.sourceSync, 1);
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
      assert(pages <= 2);
      const body = JSON.parse(String(init?.body));
      if (pages === 2) assert.equal(body.meta.sync.qsos.cursor, "page-two");
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
    assert.equal(pages, 2);
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
    assert.equal(h.calls.sourceSync, 1);
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
    assert.equal(result.errors, 0);
    assert.equal(result.contacts, 0);
    assert.equal(result.attempts, 0);
    assert.equal(h.calls.sourceSync, 1);
    assert.equal(h.calls.reread, 0);
    assert.equal(h.calls.qrzReads, 0);
    assert.equal(h.calls.lotwQueries, 0);
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
    assert.equal(result.errors, 0);
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
    assert.equal(h.calls.sourceSync, 1);
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
        if (body.meta.sync.qsos.anyClient) {
          repairs++;
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
