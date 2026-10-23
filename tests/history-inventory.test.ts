import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { serializeAdifRecord, type AdifRecord } from "../src/adif.ts";
import {
  historyCandidates,
  historyInventoryGuard,
  pruneHistoryInventory,
  HISTORY_INVENTORY_TTL,
  type HistoryInventoryInput,
} from "../src/history-inventory.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { database, seed } from "./helpers.ts";

const record: AdifRecord = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  BAND: "20m",
  MODE: "CW",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  MY_GRIDSQUARE: "FN31PR12",
};
async function fixture(kind: "qrz" | "lotw" = "qrz", readAccess = true) {
  const fixture = await database();
  for (const file of [
    "0009_vendor_requests.sql",
    "0017_history_inventory.sql",
  ]) {
    const sql = await readFile(
      new URL(`../migrations/${file}`, import.meta.url),
      "utf8",
    );
    let statement = "";
    for (const line of sql.split("\n")) {
      if (!statement && (!line.trim() || line.trimStart().startsWith("--")))
        continue;
      statement += `${line}\n`;
      if (
        line.trimEnd().endsWith(";") &&
        (!statement.trimStart().startsWith("CREATE TRIGGER") ||
          line.trim() === "END;")
      ) {
        await fixture.store.db.prepare(statement).run();
        statement = "";
      }
    }
  }
  const key = await seed(fixture.store);
  await fixture.store
    .statement("UPDATE connections SET kind=? WHERE id='destination'", kind)
    .run();
  await fixture.store
    .statement(
      "DELETE FROM private_data WHERE connection='destination' AND kind='credential'",
    )
    .run();
  await (
    await fixture.store.putPrivate(
      "a",
      "destination",
      "v1",
      "credential",
      readAccess
        ? kind === "qrz"
          ? { apiKey: "synthetic-key" }
          : {
              query: {
                username: "synthetic-user",
                password: "synthetic-password",
              },
            }
        : { identity: "submission-only" },
    )
  ).run();
  await fixture.store.observe(key, "g1", "hash", 30, false);
  const input: HistoryInventoryInput = {
    source: (await fixture.store.connection("a", "source"))!,
    destination: (await fixture.store.connection("a", "destination"))!,
    qso: key.qso,
    generation: "g1",
    record,
  };
  return { ...fixture, key, input, now: Date.now() + 1000 };
}
function qrzResponse(records: AdifRecord[], count = records.length) {
  return new Response(
    new URLSearchParams({
      RESULT: "OK",
      COUNT: String(count),
      ADIF: records.map(serializeAdifRecord).join(""),
    }).toString(),
  );
}
function lotwResponse(records: AdifRecord[]) {
  return new Response(
    `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(records.length).length}>${records.length}<EOH>${records.map((record) => serializeAdifRecord({ ...record, QSL_RCVD: record.QSL_RCVD ?? "N" })).join("")}<APP_LOTW_EOF>`,
  );
}
test("QRZ resumes bounded pages, completes modification catch-up, and reuses encrypted history across contacts", async () => {
  const { mf, store, input, now } = await fixture();
  try {
    const rows = Array.from({ length: 251 }, (_, index) => ({
      ...record,
      CALL: index < 2 ? record.CALL : `K${index}TEST`,
      MODE: index === 1 ? "SSB" : "CW",
      APP_QRZLOG_LOGID: String(index + 1),
      COMMENT: "do not retain private narrative",
    }));
    let calls = 0;
    const options = {
      now,
      vendorNow: now,
      fetcher: async (_: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("ACTION"), "FETCH");
        const filters = body.get("OPTION")!;
        assert(!filters.includes("CALL:"));
        assert(!filters.includes("MODE:"));
        if (filters.includes("MODSINCE:"))
          return qrzResponse([{ ...rows[0], MY_GRIDSQUARE: "FN31PR" }]);
        const after = Number(/AFTERLOGID:(\d+)/.exec(filters)![1]);
        return qrzResponse(
          rows
            .filter((record) => Number(record.APP_QRZLOG_LOGID) >= after)
            .slice(0, 250),
          rows.length,
        );
      },
    };
    assert.equal(
      (await historyCandidates(store, input, options)).state,
      "pending",
    );
    assert.equal(
      (await historyCandidates(store, input, options)).state,
      "pending",
    );
    const completed = await historyCandidates(store, input, options);
    assert.equal(completed.state, "ready");
    assert.equal(completed.records.length, 2);
    assert.equal(
      completed.records.find((record) => record.APP_QRZLOG_LOGID === "1")
        ?.MY_GRIDSQUARE,
      "FN31PR",
    );
    assert.equal(completed.freshCheckComplete, false);
    assert.equal(completed.completedPartitions.length, 1);
    assert.equal(calls, 3);
    await store.observe(
      { tenant: "a", source: "source", destination: "destination", qso: "q2" },
      "g2",
      "next",
      30,
      false,
    );
    const reused = await historyCandidates(
      store,
      {
        ...input,
        qso: "q2",
        generation: "g2",
        record: { ...record, CALL: "K250TEST" },
      },
      options,
    );
    assert.equal(reused.state, "ready");
    assert.equal(reused.records.length, 1);
    assert.equal(reused.fetched, false);
    assert.equal(calls, 3);
    const data = await store
      .statement(
        "SELECT envelope FROM private_data WHERE kind='history_inventory'",
      )
      .all<{ envelope: string }>();
    assert.equal(data.results.length, 3);
    assert(!JSON.stringify(data.results).includes("W1AW"));
    for (const row of await store
      .statement("SELECT payload_id FROM history_inventory_pages")
      .all<{ payload_id: string }>()
      .then((value) => value.results)) {
      const page = await store.private<AdifRecord[]>(
        "a",
        "destination",
        row.payload_id,
        "history_inventory",
      );
      assert(page?.every((record) => !record.COMMENT));
    }
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM attempts")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
test("QRZ neighborhoods include UTC date edges while filtering calls and bands locally without hiding modes", async () => {
  const { mf, store, input, now } = await fixture();
  try {
    const current = { ...input, record: { ...record, TIME_ON: "000010" } };
    const rows: AdifRecord[] = [
      {
        ...record,
        QSO_DATE: "20261021",
        TIME_ON: "235900",
        APP_QRZLOG_LOGID: "1",
      },
      { ...record, TIME_ON: "000020", MODE: "SSB", APP_QRZLOG_LOGID: "2" },
      { ...record, TIME_ON: "000020", BAND: "40m", APP_QRZLOG_LOGID: "3" },
      { ...record, TIME_ON: "000020", CALL: "W2AW", APP_QRZLOG_LOGID: "4" },
      { ...record, TIME_ON: "010000", APP_QRZLOG_LOGID: "5" },
    ];
    let calls = 0;
    const options = {
      now,
      vendorNow: now,
      fetcher: async (_: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const filters = new URLSearchParams(String(init?.body)).get("OPTION")!;
        if (filters.includes("MODSINCE:")) return qrzResponse([]);
        const [, start, end] = /BETWEEN:([\d-]+)\+([\d-]+)/.exec(filters)!;
        return qrzResponse(
          rows.filter(
            (record) =>
              record.QSO_DATE >= start.replaceAll("-", "") &&
              record.QSO_DATE <= end.replaceAll("-", ""),
          ),
        );
      },
    };
    let outcome = await historyCandidates(store, current, options);
    for (let run = 1; outcome.state === "pending" && run < 5; run++)
      outcome = await historyCandidates(store, current, options);
    assert.equal(outcome.state, "ready");
    assert.deepEqual(
      outcome.records.map((record) => record.APP_QRZLOG_LOGID).sort(),
      ["1", "2"],
    );
    assert.equal(calls, 4);
  } finally {
    await mf.dispose();
  }
});
test("LoTW completes once, shares daily call neighborhoods, and retains lower-precision evidence unchanged", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    let calls = 0;
    const options = {
      now,
      vendorNow: now,
      fetcher: async (url: RequestInfo | URL) => {
        calls++;
        const query = new URL(String(url)).searchParams;
        assert.equal(query.get("qso_owncall"), record.STATION_CALLSIGN);
        assert.equal(query.get("qso_callsign"), null);
        return lotwResponse([
          { ...record, MY_GRIDSQUARE: "FN31PR" },
          { ...record, BAND: "40m", MODE: "SSB" },
          { ...record, CALL: "W2AW" },
          { ...record, QSO_DATE: "20261023" },
        ]);
      },
    };
    const completed = await historyCandidates(store, input, options);
    assert.equal(completed.state, "ready");
    assert.equal(completed.records.length, 2);
    assert.equal(completed.records[0].MY_GRIDSQUARE, "FN31PR");
    assert.equal(completed.freshCheckComplete, false);
    assert.equal(
      (await historyCandidates(store, input, options)).fetched,
      false,
    );
    assert.equal(calls, 1);
  } finally {
    await mf.dispose();
  }
});
test("LoTW oversize responses split durably and a single oversized day never proves absence", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    let calls = 0;
    const ranges: string[] = [];
    const options = {
      now,
      vendorNow: now,
      fetcher: async (url: RequestInfo | URL) => {
        calls++;
        const query = new URL(String(url)).searchParams;
        ranges.push(
          `${query.get("qso_startdate")}/${query.get("qso_enddate")}`,
        );
        return new Response("x".repeat(2 * 1024 * 1024 + 1));
      },
    };
    for (let run = 0; run < 4; run++)
      assert.equal(
        (await historyCandidates(store, input, options)).state,
        "pending",
      );
    const held = await historyCandidates(store, input, options);
    assert.equal(held.state, "unavailable");
    assert.match(held.reason!, /One-day/);
    assert.deepEqual(held.records, []);
    assert.equal(calls, 4);
    assert.equal(ranges.at(-1), "2026-10-22/2026-10-22");
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM history_inventory_pages")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
test("partial history, shared request-budget deferrals, and missing read credentials never produce absence", async () => {
  const { mf, store, input, now } = await fixture("lotw", false);
  try {
    const result = await historyCandidates(store, input, {
      now,
      fetcher: async () =>
        assert.fail("submission-only connection made a read"),
    });
    assert.equal(result.state, "unavailable");
    assert.equal(result.readAccess, false);
    assert.deepEqual(result.records, []);
    await store
      .statement(
        "DELETE FROM private_data WHERE kind='credential' AND connection='destination'",
      )
      .run();
    await (
      await store.putPrivate("a", "destination", "v1", "credential", {
        query: { username: "synthetic", password: "synthetic" },
      })
    ).run();
    const window = Math.floor(now / 300000) * 300000;
    await store
      .statement("INSERT INTO vendor_requests VALUES('lotw',?,8,8,0)", window)
      .run();
    await assert.rejects(
      historyCandidates(store, input, {
        now,
        vendorNow: now,
        fetcher: async () => assert.fail("budget was bypassed"),
      }),
      VendorDeferredError,
    );
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM partitions WHERE state='complete'")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
test("source renewal reuses destination coverage while changed generation, credential, tenant and revoked pages fence it", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    const options = {
      now,
      vendorNow: now,
      fetcher: async () => lotwResponse([record]),
    };
    assert.equal(
      (await historyCandidates(store, input, options)).state,
      "ready",
    );
    await (
      await store.putPrivate("a", "source", "v2", "credential", {
        secret: "renewed",
      })
    ).run();
    await store
      .statement(
        "UPDATE connections SET credential_version='v2',config='{" +
          '"health":"renewed"' +
          "}' WHERE id='source'",
      )
      .run();
    assert.equal(
      (
        await historyCandidates(store, input, {
          ...options,
          fetcher: async () =>
            assert.fail("source renewal refetched destination"),
        })
      ).state,
      "ready",
    );
    for (const changed of [
      { ...input, generation: "stale" },
      { ...input, source: { ...input.source, tenant: "other" } },
      {
        ...input,
        destination: { ...input.destination, credential_version: "v2" },
      },
    ])
      assert.equal(
        (await historyCandidates(store, changed, options)).state,
        "pending",
      );
    await store
      .statement(
        "UPDATE private_data SET revoked_at=? WHERE kind='history_inventory'",
        now,
      )
      .run();
    const revoked = await historyCandidates(store, input, options);
    assert.equal(revoked.state, "unavailable");
    assert.deepEqual(revoked.records, []);
  } finally {
    await mf.dispose();
  }
});
test("credential revocation during a read cannot commit cached evidence and expiry removes ciphertext with indexes", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    await assert.rejects(
      historyCandidates(store, input, {
        now,
        vendorNow: now,
        fetcher: async () => {
          await store
            .statement(
              "UPDATE private_data SET revoked_at=? WHERE connection='destination' AND kind='credential'",
              now,
            )
            .run();
          return lotwResponse([record]);
        },
      }),
      /history connection changed/,
    );
    assert.equal(
      (await store
        .statement(
          "SELECT COUNT(*) n FROM private_data WHERE kind='history_inventory'",
        )
        .first<{ n: number }>())!.n,
      0,
    );
    await store
      .statement(
        "UPDATE private_data SET revoked_at=NULL WHERE kind='credential'",
      )
      .run();
    assert.equal(
      (
        await historyCandidates(store, input, {
          now,
          vendorNow: now,
          fetcher: async () => lotwResponse([record]),
        })
      ).state,
      "ready",
    );
    assert.equal(
      await pruneHistoryInventory(store, now + HISTORY_INVENTORY_TTL),
      1,
    );
    for (const table of [
      "history_inventory_pages",
      "history_inventory_neighborhoods",
    ])
      assert.equal(
        (await store
          .statement(`SELECT COUNT(*) n FROM ${table}`)
          .first<{ n: number }>())!.n,
        0,
      );
    assert.equal(
      (await store
        .statement(
          "SELECT COUNT(*) n FROM private_data WHERE kind='history_inventory'",
        )
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM leases WHERE scope LIKE 'history:%'")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
test("bounded cache capacity evicts completed LRU metadata rather than permanently blocking later dates", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    await store
      .statement(
        "INSERT INTO partitions(tenant,source,destination,id,state,evidence,expires_at,history_scope,history_accessed_at) SELECT 'a','source','destination','old-'||value,'complete','{}',?,'old-scope',value FROM json_each(?)",
        now + HISTORY_INVENTORY_TTL,
        JSON.stringify(Array.from({ length: 2048 }, (_, index) => index)),
      )
      .run();
    const result = await historyCandidates(store, input, {
      now,
      vendorNow: now,
      fetcher: async () => lotwResponse([record]),
    });
    assert.equal(result.state, "ready");
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM partitions")
        .first<{ n: number }>())!.n,
      2048,
    );
    assert.equal(
      await store
        .statement("SELECT 1 n FROM partitions WHERE id='old-0'")
        .first(),
      null,
    );
  } finally {
    await mf.dispose();
  }
});
test("incomplete LoTW framing and generation changes leave no completed coverage", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    await assert.rejects(
      historyCandidates(store, input, {
        now,
        vendorNow: now,
        fetcher: async () =>
          new Response("<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH>"),
      }),
      /Incomplete/,
    );
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM partitions WHERE state='complete'")
        .first<{ n: number }>())!.n,
      0,
    );
    await assert.rejects(
      historyCandidates(store, input, {
        now,
        vendorNow: now,
        fetcher: async () => {
          await store.statement("UPDATE ledger SET generation='g2'").run();
          return lotwResponse([record]);
        },
      }),
      /history source changed/,
    );
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM history_inventory_pages")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
test("LoTW adaptive splitting finishes the requested leaf and reuses it without refetching oversized parents", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    let calls = 0;
    const options = {
      now,
      vendorNow: now,
      fetcher: async (url: RequestInfo | URL) => {
        calls++;
        const query = new URL(String(url)).searchParams;
        if (query.get("qso_startdate") !== query.get("qso_enddate"))
          return new Response("x".repeat(2 * 1024 * 1024 + 1));
        return lotwResponse([record]);
      },
    };
    let result = await historyCandidates(store, input, options);
    for (let run = 1; result.state === "pending" && run < 4; run++)
      result = await historyCandidates(store, input, options);
    assert.equal(result.state, "ready");
    assert.equal(calls, 4);
    assert.equal(
      (await historyCandidates(store, input, options)).fetched,
      false,
    );
    assert.equal(calls, 4);
  } finally {
    await mf.dispose();
  }
});
test("large retained fields use bounded encrypted pages and a bounded statement budget", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    const large = {
      ...record,
      ...Object.fromEntries(
        [
          "MY_STATE",
          "MY_CNTY",
          "MY_DXCC",
          "MY_LAT",
          "MY_LON",
          "MY_CQ_ZONE",
          "MY_ITU_ZONE",
          "MY_IOTA",
        ].map((field) => [field, "x".repeat(256)]),
      ),
    };
    let statements = 0;
    const statement = store.statement.bind(store);
    store.statement = (...params) => {
      statements++;
      return statement(...params);
    };
    const options = {
      now,
      vendorNow: now,
      fetcher: async () =>
        lotwResponse(Array.from({ length: 250 }, () => large)),
    };
    const completed = await historyCandidates(store, input, options);
    assert.equal(completed.state, "ready");
    assert.equal(completed.records.length, 250);
    assert(statements < 200);
    const pages = await store
      .statement("SELECT payload_id FROM history_inventory_pages")
      .all<{ payload_id: string }>();
    assert(pages.results.length > 1);
    for (const page of pages.results) {
      const retained = await store.private<AdifRecord[]>(
        "a",
        "destination",
        page.payload_id,
        "history_inventory",
      );
      assert(
        new TextEncoder().encode(JSON.stringify(retained)).length <= 128 * 1024,
      );
      assert((retained?.length ?? 0) <= 250);
    }
    assert.equal(
      (
        await historyCandidates(store, input, {
          ...options,
          fetcher: async () => assert.fail("cache hit refetched"),
        })
      ).records.length,
      250,
    );
  } finally {
    await mf.dispose();
  }
});
test("expired QRZ coverage starts a new incomplete epoch instead of returning stale evidence", async () => {
  const { mf, store, input, now } = await fixture();
  try {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return qrzResponse([{ ...record, APP_QRZLOG_LOGID: "1" }]);
    };
    const options = { now, vendorNow: now, fetcher };
    assert.equal(
      (await historyCandidates(store, input, options)).state,
      "pending",
    );
    assert.equal(
      (await historyCandidates(store, input, options)).state,
      "ready",
    );
    const expiredAt = now + HISTORY_INVENTORY_TTL + 1;
    const expired = await historyCandidates(store, input, {
      ...options,
      now: expiredAt,
      vendorNow: expiredAt,
    });
    assert.equal(expired.state, "pending");
    assert.deepEqual(expired.records, []);
    assert.equal(calls, 3);
  } finally {
    await mf.dispose();
  }
});
test("QRZ coverage includes the full minute-precision radius across a weekly boundary", async () => {
  const { mf, store, input, now } = await fixture();
  try {
    const current = { ...input, record: { ...record, TIME_ON: "003030" } };
    const remote = {
      ...record,
      QSO_DATE: "20261021",
      TIME_ON: "235940",
      APP_QRZLOG_LOGID: "1",
    };
    const options = {
      now,
      vendorNow: now,
      fetcher: async (_: RequestInfo | URL, init?: RequestInit) => {
        const filters = new URLSearchParams(String(init?.body)).get("OPTION")!;
        return qrzResponse(
          filters.includes("BETWEEN:2026-10-15+2026-10-21") &&
            !filters.includes("MODSINCE:")
            ? [remote]
            : [],
        );
      },
    };
    let result = await historyCandidates(store, current, options);
    for (let run = 1; result.state === "pending" && run < 4; run++)
      result = await historyCandidates(store, current, options);
    assert.equal(result.state, "ready");
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].APP_QRZLOG_LOGID, "1");
  } finally {
    await mf.dispose();
  }
});
test("certificate and login health refreshes preserve pending and completed LoTW coverage", async () => {
  const { mf, store, input, now } = await fixture("lotw");
  try {
    const config = {
      stations: [{ callsign: record.STATION_CALLSIGN, dxcc: 291 }],
      readAccess: true,
      certificateCheckedAt: now,
    };
    await store
      .statement(
        "UPDATE connections SET config=? WHERE id='destination'",
        JSON.stringify(config),
      )
      .run();
    let current = {
      ...input,
      destination: (await store.connection("a", "destination"))!,
    };
    let calls = 0;
    const options = {
      now,
      vendorNow: now,
      fetcher: async () => {
        calls++;
        return calls === 1
          ? new Response("x".repeat(2 * 1024 * 1024 + 1))
          : lotwResponse([record]);
      },
    };
    assert.equal(
      (await historyCandidates(store, current, options)).state,
      "pending",
    );
    await store
      .statement(
        "UPDATE connections SET config=json_set(config,'$.certificateCheckedAt',?,'$.certificates',json(?),'$.loginVerification',json(?)) WHERE id='destination'",
        now + 1,
        JSON.stringify([
          { callsign: record.STATION_CALLSIGN, statusCheckedAt: now + 1 },
        ]),
        JSON.stringify({ status: "verified", checkedAt: now + 1 }),
      )
      .run();
    current = {
      ...current,
      destination: (await store.connection("a", "destination"))!,
    };
    const completed = await historyCandidates(store, current, options);
    assert.equal(completed.state, "ready");
    assert.equal(calls, 2);
    assert(completed.fence);
    await store
      .statement(
        "UPDATE connections SET config=json_set(config,'$.certificateCheckedAt',?) WHERE id='destination'",
        now + 2,
      )
      .run();
    const cached = await historyCandidates(store, current, {
      ...options,
      fetcher: async () =>
        assert.fail("health refresh discarded completed cache"),
    });
    assert.equal(cached.state, "ready");
    const guard = historyInventoryGuard(
      { tenant: "a", source: "source", destination: "destination", qso: "q1" },
      completed.fence,
      now,
    );
    assert(
      await store
        .statement(`SELECT 1 n WHERE ${guard.sql}`, ...guard.params)
        .first(),
    );
    await store
      .statement(
        "UPDATE connections SET config=json_set(config,'$.readAccess',json('false')) WHERE id='destination'",
      )
      .run();
    assert.equal(
      await store
        .statement(`SELECT 1 n WHERE ${guard.sql}`, ...guard.params)
        .first(),
      null,
    );
    const disabled = await historyCandidates(
      store,
      {
        ...current,
        destination: (await store.connection("a", "destination"))!,
      },
      {
        ...options,
        fetcher: async () =>
          assert.fail("disabled read capability made a request"),
      },
    );
    assert.equal(disabled.state, "unavailable");
    assert.equal(disabled.readAccess, false);
  } finally {
    await mf.dispose();
  }
});
test("inventory adoption guard evaluates current credentials, expiry and retained pages atomically", async () => {
  const { mf, store, input, key, now } = await fixture("lotw");
  try {
    const completed = await historyCandidates(store, input, {
      now,
      vendorNow: now,
      fetcher: async () => lotwResponse([record]),
    });
    assert(completed.fence);
    const guard = historyInventoryGuard(key, completed.fence, now);
    assert(
      await store
        .statement(`SELECT 1 n WHERE ${guard.sql}`, ...guard.params)
        .first(),
    );
    const prepared = store.statement(
      `UPDATE ledger SET state='adopted_existing' WHERE tenant='a' AND qso='q1' AND ${guard.sql}`,
      ...guard.params,
    );
    await store
      .statement(
        "UPDATE private_data SET revoked_at=? WHERE connection='destination' AND kind='credential'",
        now,
      )
      .run();
    assert.equal((await prepared.run()).meta.changes, 0);
    await store
      .statement(
        "UPDATE private_data SET revoked_at=NULL WHERE kind='credential'",
      )
      .run();
    const expired = historyInventoryGuard(
      key,
      completed.fence,
      now + HISTORY_INVENTORY_TTL,
    );
    assert.equal(
      await store
        .statement(`SELECT 1 n WHERE ${expired.sql}`, ...expired.params)
        .first(),
      null,
    );
    await store
      .statement("DELETE FROM private_data WHERE kind='history_inventory'")
      .run();
    assert.equal(
      await store
        .statement(`SELECT 1 n WHERE ${guard.sql}`, ...guard.params)
        .first(),
      null,
    );
    assert.equal(
      historyInventoryGuard({ ...key, tenant: "another" }, completed.fence, now)
        .sql,
      "0",
    );
    assert.equal(
      historyInventoryGuard(key, { ...completed.fence, partitions: [] }, now)
        .sql,
      "0",
    );
  } finally {
    await mf.dispose();
  }
});
