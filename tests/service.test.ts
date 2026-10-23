import assert from "node:assert/strict";
import test from "node:test";
import { tick } from "../src/service.ts";
import { seed } from "./helpers.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
import { schedulerFixture, FIXTURE_NOW } from "./runtime-fixtures.ts";
const key = (destination: string) => ({
  tenant: "a",
  source: "source",
  qso: "q1",
  destination,
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

test("failed sources and confirmation turns cannot starve a third isolated tenant", async () => {
  const h = await schedulerFixture();
  try {
    for (const tenant of ["b", "c"]) {
      await seed(h.store, tenant);
      await h.store
        .statement(
          "UPDATE connections SET kind='lotw' WHERE tenant=? AND id='destination'",
          tenant,
        )
        .run();
    }
    const unavailable = async () =>
      new Response("unavailable", { status: 503 });
    await tick(h.env, unavailable as typeof fetch, FIXTURE_NOW);
    await tick(h.env, unavailable as typeof fetch, FIXTURE_NOW + 300000);
    const sources = (
      await h.store
        .statement(
          "SELECT tenant,last_poll_at FROM connections WHERE kind='lofi' ORDER BY tenant",
        )
        .all<{ tenant: string; last_poll_at: number | null }>()
    ).results;
    assert.equal(sources.length, 3);
    assert(sources.every((row) => row.last_poll_at !== null));
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

test("unresolved attempts yield bounded outbox slots without becoming retryable", async () => {
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
          "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,'submitted',0,0)",
          id,
        )
        .run();
    }
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(
      await count(h, "attempt_state", `updated_at=${FIXTURE_NOW}`),
      8,
    );
    await tick(h.env, h.fetcher, FIXTURE_NOW + 1);
    const row = await h.store
      .statement(
        "SELECT state,updated_at FROM attempt_state WHERE tenant='a' AND attempt='unresolved-8'",
      )
      .first<{ state: string; updated_at: number }>();
    assert.equal(row?.state, "submitted");
    assert.equal(row?.updated_at, FIXTURE_NOW + 1);
    assert.equal(h.calls.qrzWrites + h.calls.lotwUploads, 0);
    assert.equal(await count(h, "attempts"), 9);
  } finally {
    await h.mf.dispose();
  }
});
