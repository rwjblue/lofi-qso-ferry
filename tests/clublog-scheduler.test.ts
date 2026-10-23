import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAdif,
  serializeAdifRecord,
  type AdifRecord,
} from "../src/adif.ts";
import { tick } from "../src/service.ts";
import { FIXTURE_NOW, schedulerFixture } from "./runtime-fixtures.ts";

const key = (destination: string, qso = "q1") => ({
  tenant: "a",
  source: "source",
  qso,
  destination,
});
const minute = 60_000;

async function fixture() {
  const h = await schedulerFixture();
  try {
    h.env.CLUBLOG_API_KEY = "synthetic-clublog-application-key";
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','clublog','clublog','synthetic-clublog','Synthetic Club Log','active','fixture-clublog',?,0)",
        JSON.stringify({ stationCallsign: "W1AW", readAccess: true }),
      )
      .run();
    await (
      await h.store.putPrivate(
        "a",
        "clublog",
        "fixture-clublog",
        "credential",
        {
          email: "synthetic@example.invalid",
          password: "synthetic-password",
          callsign: "W1AW",
        },
      )
    ).run();
    const clublogRecords: AdifRecord[] = [{ ...h.initial }];
    const clublogMutations: AdifRecord[] = [];
    const clublogCalls = { reads: 0, live: 0, background: 0 };
    const clublogErrors = { auth: false };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/lotwuser/lotwreport.adi") {
        // Respect the query partition: the shared fixture returns its entire
        // inventory, which would make unrelated history look ambiguous.
        h.calls.lotwQueries++;
        if (h.errors.lotw) throw new Error("synthetic LoTW outage");
        const start = url.searchParams
          .get("qso_startdate")
          ?.replaceAll("-", "");
        const end = url.searchParams.get("qso_enddate")?.replaceAll("-", "");
        const station = url.searchParams.get("qso_owncall");
        const call = url.searchParams.get("qso_callsign");
        const records = h.lotwRecords.filter(
          (record) =>
            (!start || record.QSO_DATE >= start) &&
            (!end || record.QSO_DATE <= end) &&
            (!station || record.STATION_CALLSIGN === station) &&
            (!call || record.CALL === call),
        );
        return new Response(
          `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(records.length).length}>${records.length}<EOH>${records.map(serializeAdifRecord).join("")}<APP_LOTW_EOF>`,
        );
      }
      if (url.hostname !== "clublog.org") return h.fetcher(input, init);
      assert.equal(init?.method, "POST");
      if (url.pathname === "/getadif.php") {
        clublogCalls.reads++;
        if (clublogErrors.auth)
          return new Response("synthetic-password must never escape", {
            status: 403,
          });
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("call"), "W1AW");
        assert.equal(body.get("type"), null);
        return new Response(
          `<ADIF_VER:5>3.1.6<PROGRAMID:7>ClubLog<EOH>\n${clublogRecords.map(serializeAdifRecord).join("\n")}\n`,
        );
      }
      let adif: string;
      let callsign: string | null;
      if (url.pathname === "/realtime.php") {
        clublogCalls.live++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("clear"), null);
        assert.equal(body.get("api"), h.env.CLUBLOG_API_KEY);
        adif = body.get("adif") ?? "";
        callsign = body.get("callsign");
      } else {
        assert.equal(url.pathname, "/putlogs.php");
        clublogCalls.background++;
        assert.ok(init?.body instanceof FormData);
        assert.equal(init.body.get("clear"), null);
        assert.equal(init.body.get("api"), h.env.CLUBLOG_API_KEY);
        const file = init.body.get("file");
        assert.ok(file instanceof Blob);
        adif = await file.text();
        const call = init.body.get("callsign");
        callsign = typeof call === "string" ? call : null;
      }
      assert.equal(callsign, "W1AW");
      const records = parseAdif(adif).records;
      assert.equal(records.length, 1);
      for (const record of records) {
        // Readback derives from the transmitted artifact, never source state.
        clublogMutations.push(record);
        clublogRecords.push({ ...record, STATION_CALLSIGN: "W1AW" });
      }
      return new Response("OK");
    };
    return {
      ...h,
      fetcher,
      clublogRecords,
      clublogMutations,
      clublogCalls,
      clublogErrors,
    };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("scheduler independently adopts QRZ, LoTW and Club Log history without writes", async () => {
  const h = await fixture();
  try {
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 0);
    assert.equal(result.contacts, 1);
    for (const destination of ["destination", "lotw", "clublog"]) {
      const row = await h.store.ledger(key(destination));
      assert.ok(row);
      assert.equal(row.state, "adopted_existing");
      assert.equal(row.provenance, "adopted");
      assert.equal(row.source_hash, row.baseline_hash);
      assert.equal(row.sent_hash, null);
      assert.ok(row.remote_id);
    }
    assert.equal(
      h.calls.qrzWrites +
        h.calls.lotwUploads +
        h.clublogCalls.live +
        h.clublogCalls.background,
      0,
    );
    assert.equal(h.clublogCalls.reads, 1);
    const attempts = await h.store
      .statement("SELECT COUNT(*) n FROM attempts")
      .first<{ n: number }>();
    assert.equal(attempts?.n, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("a new forward contact waits for quiet time and Club Log resolves only after artifact readback", async () => {
  const h = await fixture();
  try {
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    h.enable();
    h.env.ROLLOUT_QSO_IDS_JSON = '["q1","q2"]';
    await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * minute);
    h.changes.qsos.push({
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
    });
    const arrived = await tick(h.env, h.fetcher, FIXTURE_NOW + 10 * minute);
    assert.equal(arrived.errors, 0);
    assert.equal(
      (await h.store.ledger(key("clublog", "q2")))?.state,
      "missing_current_identity",
    );
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT phase FROM source_births WHERE tenant='a' AND source='source' AND qso='q2'",
          )
          .first<{ phase: string }>()
      )?.phase,
      "forward_new",
    );
    await tick(h.env, h.fetcher, FIXTURE_NOW + 20 * minute);
    assert.equal(h.clublogCalls.live + h.clublogCalls.background, 0);
    const sent = await tick(h.env, h.fetcher, FIXTURE_NOW + 41 * minute);
    assert.equal(sent.errors, 0);
    assert.equal(h.clublogCalls.live, 1);
    assert.equal(h.clublogCalls.background, 0);
    assert.equal(h.calls.qrzWrites, 1);
    assert.equal(h.calls.lotwUploads, 1);
    assert.equal(
      (await h.store.ledger(key("clublog", "q2")))?.state,
      "submitted",
    );
    assert.equal(h.clublogMutations[0].QSO_DATE, "20210101");
    assert.equal(h.clublogMutations[0].FREQ, "14.074");
    assert.equal(h.clublogMutations[0].MY_GRIDSQUARE, undefined);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 46 * minute);
    const observed = await h.store.ledger(key("clublog", "q2"));
    assert.equal(observed?.state, "observed");
    assert.equal(observed?.confirmed, 0);
    assert.ok(observed?.sent_hash);
    assert.equal(observed?.baseline_hash, observed?.source_hash);
    assert.equal(h.clublogCalls.live, 1);
    assert.equal(
      (await h.store.ledger(key("destination", "q2")))?.state,
      "delivered",
    );
    assert.equal((await h.store.ledger(key("lotw", "q2")))?.state, "observed");
  } finally {
    await h.mf.dispose();
  }
});

for (const field of ["FREQ", "RST_SENT"] as const)
  test(`same-identity ${field} edits require Club Log review while other providers continue`, async () => {
    const h = await fixture();
    try {
      if (field === "RST_SENT") {
        h.qso.our = { ...(h.qso.our as Record<string, unknown>), sent: "599" };
        h.qrzRecords[0].RST_SENT = "599";
        h.clublogRecords[0].RST_SENT = "599";
      }
      await tick(h.env, h.fetcher, FIXTURE_NOW);
      h.enable();
      if (field === "FREQ") h.qso.freq = 14075;
      else
        h.qso.our = { ...(h.qso.our as Record<string, unknown>), sent: "579" };
      h.qso.syncedAtMillis = 200;
      h.changes.qsos.push(h.qso);
      await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * minute);
      assert.equal((await h.store.ledger(key("clublog")))?.state, "changed");
      const sent = await tick(h.env, h.fetcher, FIXTURE_NOW + 36 * minute);
      assert.equal(sent.errors, 0);
      const blocked = await h.store.ledger(key("clublog"));
      assert.equal(blocked?.state, "changed");
      assert.equal(
        blocked?.reason,
        "clublog_same_identity_correction_requires_review",
      );
      assert.equal(h.clublogCalls.live + h.clublogCalls.background, 0);
      assert.equal(h.calls.qrzWrites, 1);
      assert.equal(h.calls.lotwUploads, field === "FREQ" ? 1 : 0);
      assert.equal(
        h.clublogRecords[0][field],
        field === "FREQ" ? "14.07400" : "599",
      );
    } finally {
      await h.mf.dispose();
    }
  });

test("own-grid edits change QRZ and LoTW without requeueing Club Log's supported projection", async () => {
  const h = await fixture();
  try {
    await tick(h.env, h.fetcher, FIXTURE_NOW);
    const before = await h.store.ledger(key("clublog"));
    assert.ok(before);
    h.enable();
    h.operation.grid = "FN32BB";
    h.operation.syncedAtMillis = 200;
    h.changes.operations.push(h.operation);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * minute);
    const unchanged = await h.store.ledger(key("clublog"));
    assert.equal(unchanged?.state, "adopted_existing");
    assert.equal(unchanged?.source_hash, before.source_hash);
    assert.equal(unchanged?.baseline_hash, before.baseline_hash);
    for (const destination of ["destination", "lotw"])
      assert.equal((await h.store.ledger(key(destination)))?.state, "changed");
    await tick(h.env, h.fetcher, FIXTURE_NOW + 36 * minute);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 41 * minute);
    assert.equal(h.calls.qrzWrites, 1);
    assert.equal(h.calls.lotwUploads, 1);
    assert.equal(h.qrzMutations[0].MY_GRIDSQUARE, "FN32BB");
    assert.match(h.tq8Texts[0], /<GRIDSQUARE:6>FN32BB/);
    assert.equal(h.clublogCalls.live + h.clublogCalls.background, 0);
    assert.equal(h.clublogCalls.reads, 1);
    assert.equal(
      (await h.store.ledger(key("clublog")))?.state,
      "adopted_existing",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("Club Log auth rejection suspends only its connection and leaves other providers running", async () => {
  const h = await fixture();
  try {
    h.clublogErrors.auth = true;
    const initial = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(initial.errors, 1);
    const clublog = await h.store.connection("a", "clublog");
    assert.equal(clublog?.status, "needs_verification");
    assert.doesNotMatch(clublog?.config ?? "", /synthetic-password/);
    for (const destination of ["destination", "lotw"]) {
      assert.equal(
        (await h.store.connection("a", destination))?.status,
        "active",
      );
      assert.equal(
        (await h.store.ledger(key(destination)))?.state,
        "adopted_existing",
      );
    }
    assert.equal(h.clublogCalls.reads, 1);
    h.enable();
    h.operation.grid = "FN32BB";
    h.operation.syncedAtMillis = 200;
    h.changes.operations.push(h.operation);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 5 * minute);
    await tick(h.env, h.fetcher, FIXTURE_NOW + 36 * minute);
    assert.equal(h.calls.qrzWrites, 1);
    assert.equal(h.calls.lotwUploads, 1);
    assert.equal(h.clublogCalls.reads, 1);
    assert.equal(h.clublogCalls.live + h.clublogCalls.background, 0);
  } finally {
    await h.mf.dispose();
  }
});
