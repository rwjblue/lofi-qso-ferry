import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  type AdifRecord,
  parseAdif,
  serializeAdifRecord,
} from "../src/adif.ts";
import {
  contactAdif,
  type DeliveryGates,
  dispatchAttempt,
  prepareDue,
  reconcileAttempt,
  refreshConfirmations,
} from "../src/delivery.ts";
import {
  type Contact,
  projectContact,
  sourceFingerprint,
} from "../src/projection.ts";
import { LOTW_PRIOR_IDENTITY_NOTICE } from "../src/store.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
import {
  VENDOR_POLICIES,
  VendorDeferredError,
} from "../src/vendor-requests.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const gates: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: true,
};
const at = Date.parse("2026-10-22T12:00:01Z");
const now = at + 31 * 60000;
async function deliveryDatabase() {
  const harness = await database();
  await applyAdditionalMigrations(harness.db);
  return harness;
}
async function contact(notes = "source note"): Promise<Contact> {
  return projectContact(
    {
      uuid: "q1",
      operation: "op1",
      startAtMillis: at,
      freq: 14060,
      band: "20m",
      mode: "CW",
      their: { call: "W1AW" },
      notes,
    },
    {
      uuid: "op1",
      stationCall: "N0TEST/P",
      grid: "FN31",
      refs: [{ type: "potaActivation", ref: "US-1234" }],
    },
    [],
    { operationComplete: true },
  );
}
async function setup() {
  const harness = await deliveryDatabase();
  const key = await seed(harness.store);
  const item = await contact();
  await harness.store
    .statement(
      "UPDATE connections SET config=? WHERE kind='qrz'",
      JSON.stringify({
        stationCallsign: "N0TEST/P",
        startDate: "2020-01-01",
        endDate: "2030-01-01",
        replacementContractVerified: true,
      }),
    )
    .run();
  await harness.store
    .statement(
      "DELETE FROM private_data WHERE connection='destination' AND kind='credential'",
    )
    .run();
  await (
    await harness.store.putPrivate("a", "destination", "v1", "credential", {
      apiKey: "synthetic-key",
    })
  ).run();
  const version = await harness.store.saveTemplate("a", "destination", {
    profile: TEMPLATE_PROFILE,
    fields: {
      COMMENT:
        'POTA {{ op.refs | where: "type", "potaActivation" | map: "ref" | sentence }}',
    },
    fallbackNotes: false,
  });
  await harness.store.observe(
    key,
    item.generation,
    await sourceFingerprint(item, "qrz"),
    30,
    false,
    at,
  );
  await harness.store
    .statement("UPDATE ledger SET state='missing_current_identity'")
    .run();
  const records: AdifRecord[] = [];
  const mutations: AdifRecord[] = [];
  const fetcher: typeof fetch = async (_, init) => {
    const body = new URLSearchParams(String(init?.body));
    if (body.get("ACTION") === "FETCH")
      return new Response(
        new URLSearchParams({
          RESULT: "OK",
          COUNT: String(records.length),
          ADIF: records.map(serializeAdifRecord).join(""),
        }).toString(),
      );
    assert.equal(body.get("ACTION"), "INSERT");
    const record = parseAdif(body.get("ADIF")!).records[0]!;
    mutations.push(record);
    records.splice(0, records.length, { ...record, APP_QRZLOG_LOGID: "101" });
    return new Response("RESULT=OK&COUNT=1&LOGID=101");
  };
  return { ...harness, key, item, version, fetcher, records, mutations };
}
test("actual D1 flow prepares a pinned immutable payload and automatically dispatches after quiet period", async () => {
  const h = await setup();
  try {
    assert.equal(
      (
        await prepareDue(h.store, h.key, h.item, gates, {
          fetcher: h.fetcher,
          now: at + 10 * 60000,
        })
      ).state,
      "skipped",
    );
    const ready = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert.equal(ready.state, "prepared");
    assert(ready.attemptId);
    await h.store.saveTemplate("a", "destination", {
      profile: TEMPLATE_PROFILE,
      fields: { COMMENT: "new future template" },
      fallbackNotes: false,
    });
    const payload = await h.store.private<{ record: AdifRecord }>(
      "a",
      "destination",
      ready.attemptId,
      "outbox",
    );
    assert.equal(payload!.record.COMMENT, "POTA US-1234");
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", ready.attemptId, gates, {
          fetcher: h.fetcher,
          now: now + 1,
        })
      ).state,
      "delivered",
    );
    assert.equal(h.mutations.length, 1);
    assert.equal(h.mutations[0]!.COMMENT, "POTA US-1234");
    assert.equal((await h.store.ledger(h.key))!.template_version, h.version);
    assert.equal((await h.store.ledger(h.key))!.provenance, "ferry_created");
    assert.equal(
      await h.store.private("a", "destination", ready.attemptId, "outbox"),
      null,
    );
    assert.equal(
      (
        await prepareDue(h.store, h.key, h.item, gates, {
          fetcher: h.fetcher,
          now: now + 2,
        })
      ).state,
      "skipped",
    );
  } finally {
    await h.mf.dispose();
  }
});
test("lost QRZ response reconciles exact payload without a duplicate insert", async () => {
  const h = await setup();
  try {
    const ready = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert(ready.attemptId);
    const lost: typeof fetch = async (url, init) => {
      const result = await h.fetcher(url, init);
      if (new URLSearchParams(String(init?.body)).get("ACTION") === "INSERT")
        throw new Error("lost response after acceptance");
      return result;
    };
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", ready.attemptId, gates, {
          fetcher: lost,
          now: now + 1,
        })
      ).state,
      "uncertain",
    );
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", ready.attemptId, gates, {
          fetcher: h.fetcher,
          now: now + 2,
        })
      ).state,
      "skipped",
    );
    assert.equal(
      (
        await reconcileAttempt(h.store, "a", ready.attemptId, {
          fetcher: h.fetcher,
          now: now + 3,
        })
      ).state,
      "observed",
    );
    assert.equal(h.mutations.length, 1);
    assert.equal((await h.store.ledger(h.key))!.state, "observed");
    assert.equal((await h.store.ledger(h.key))!.provenance, "unknown");
  } finally {
    await h.mf.dispose();
  }
});
test("dual production gate, source boundary and connection revocation stop writes", async () => {
  const h = await setup();
  try {
    assert.equal(
      (
        await prepareDue(
          h.store,
          h.key,
          h.item,
          { ...gates, sourceBoundaryVerified: false },
          { fetcher: h.fetcher, now },
        )
      ).state,
      "blocked",
    );
    const ready = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert(ready.attemptId);
    for (const gate of [
      "exportsEnabled",
      "liveWriteAuthorized",
      "sourceBoundaryVerified",
    ] as const)
      assert.equal(
        (
          await dispatchAttempt(
            h.store,
            "a",
            ready.attemptId,
            { ...gates, [gate]: false },
            { fetcher: h.fetcher, now: now + 1 },
          )
        ).state,
        "blocked",
      );
    await h.store
      .statement(
        "UPDATE connections SET status='disabled' WHERE id='destination'",
      )
      .run();
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", ready.attemptId, gates, {
          fetcher: h.fetcher,
          now: now + 2,
        })
      ).state,
      "blocked",
    );
    assert.equal(h.mutations.length, 0);
  } finally {
    await h.mf.dispose();
  }
});
test("source changes with an unchanged transmitted template projection cause no second write", async () => {
  const h = await setup();
  try {
    const ready = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert(ready.attemptId);
    await dispatchAttempt(h.store, "a", ready.attemptId, gates, {
      fetcher: h.fetcher,
      now: now + 1,
    });
    const changed = await contact("note not consumed by template");
    await h.store.observe(
      h.key,
      changed.generation,
      await sourceFingerprint(changed, "qrz"),
      30,
      false,
      now + 2,
    );
    const result = await prepareDue(h.store, h.key, changed, gates, {
      fetcher: h.fetcher,
      now: now + 31 * 60000,
    });
    assert.equal(result.state, "skipped");
    assert.equal(result.reason, "transmitted_projection_unchanged");
    assert.equal(h.mutations.length, 1);
  } finally {
    await h.mf.dispose();
  }
});
test("fresh identity collision after preparation blocks a later first insert", async () => {
  const h = await setup();
  try {
    const ready = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert(ready.attemptId);
    h.records.push({
      ...contactAdif(h.item),
      COMMENT: "Existing remotely-owned text",
      APP_QRZLOG_LOGID: "200",
    });
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", ready.attemptId, gates, {
          fetcher: h.fetcher,
          now: now + 1,
        })
      ).state,
      "rejected",
    );
    assert.equal(h.mutations.length, 0);
  } finally {
    await h.mf.dispose();
  }
});
test("LoTW gates precede real signing; immutable per-contact TQ8 is submitted then separately observed", async () => {
  const h = await deliveryDatabase();
  try {
    const key = await seed(h.store);
    const { readFile } = await import("node:fs/promises");
    const { importPkcs12 } = await import("../src/signing.ts");
    const fixture = async (name: string) =>
      readFile(new URL(`../fixtures/signing/${name}`, import.meta.url));
    const signingNow = Date.parse("2027-01-01T00:00:00Z");
    const signing = await importPkcs12(
      await fixture("current.p12"),
      "ferry-fixture",
      {
        now: new Date(signingNow),
        certificateStatus: async () => "unrevoked",
        version: "fixture-v1",
      },
    );
    const historicalSigning = { ...signing, trusted: false, chainPem: [] }; // Extra legacy fields do not prevent use.
    await h.store
      .statement(
        "UPDATE connections SET kind='lotw',config=? WHERE id='destination'",
        JSON.stringify({ stations: [{ callsign: "W1AW", dxcc: 291 }] }),
      )
      .run();
    await h.store
      .statement(
        "DELETE FROM private_data WHERE connection='destination' AND kind='credential'",
      )
      .run();
    await (
      await h.store.putPrivate("a", "destination", "v1", "credential", {
        signingCredentials: [historicalSigning],
        query: { username: "synthetic", password: "synthetic" },
      })
    ).run();
    const item = await projectContact(
      {
        uuid: "q1",
        operation: "op1",
        startAtMillis: at,
        freq: 14074,
        band: "20m",
        mode: "FT8",
        their: { call: "K1ABC" },
        our: {
          stationCall: "W1AW",
          dxccCode: 291,
          grid: "FN31PR",
          state: "CT",
          county: "CT,Tolland",
          cqZone: 5,
          ituZone: 8,
        },
      },
      { uuid: "op1", stationCall: "W1AW" },
      [],
      { operationComplete: true },
    );
    await h.store.observe(
      key,
      item.generation,
      await sourceFingerprint(item, "lotw"),
      30,
      false,
      at,
    );
    await h.store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    const record: AdifRecord = {
      ...contactAdif(item),
      FREQ: "14.07400",
      QSL_RCVD: "N",
    };
    let accepted = false;
    let submissions = 0;
    let network = 0;
    const fetcher: typeof fetch = async (input, init) => {
      network++;
      const url = String(input);
      if (url.includes("/lotw/crl?"))
        return new Response("<Status>Unrevoked</Status>");
      if (url.includes("lotwreport.adi?")) {
        const records = accepted ? [record] : [];
        return new Response(
          `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>${records.length}<EOH>${records.map(serializeAdifRecord).join("")}<APP_LOTW_EOF>`,
        );
      }
      assert.match(url, /lotw\/upload$/);
      assert(init?.body instanceof FormData);
      const upfile = init.body.get("upfile");
      assert(upfile instanceof Blob);
      const bytes = new Uint8Array(await upfile.arrayBuffer());
      assert.equal(bytes[0], 0x1f);
      assert.equal(bytes[1], 0x8b);
      submissions++;
      accepted = true;
      return new Response("<!-- .UPL. accepted -->");
    };
    const disabled = await prepareDue(
      h.store,
      key,
      item,
      { ...gates, exportsEnabled: false },
      { fetcher, now: signingNow },
    );
    assert.equal(disabled.reason, "exports_disabled_before_signing");
    assert.equal(network, 0);
    const prepared = await prepareDue(h.store, key, item, gates, {
      fetcher,
      now: signingNow,
    });
    assert(prepared.attemptId);
    const payload = await h.store.private<{
      kind: string;
      members: { id: string; generation: string }[];
      certificateVersion: string;
      tq8: string;
    }>("a", "destination", prepared.attemptId, "outbox");
    assert.equal(payload!.kind, "lotw");
    assert.deepEqual(payload!.members, [
      { id: "q1", generation: item.generation },
    ]);
    assert.equal(payload!.certificateVersion, "fixture-v1");
    await h.store
      .statement(
        "UPDATE vendor_requests SET requests=? WHERE vendor='lotw'",
        VENDOR_POLICIES.lotw.total - 1,
      )
      .run();
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          fetcher,
          now: signingNow + 1,
        })
      ).state,
      "retry_scheduled",
    );
    assert.equal(submissions, 0);
    assert.deepEqual(
      await h.store.private("a", "destination", prepared.attemptId, "outbox"),
      payload,
    );
    const retry = await h.store
      .statement(
        "SELECT due_at FROM attempt_state WHERE attempt=?",
        prepared.attemptId,
      )
      .first<{ due_at: number }>();
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          fetcher,
          now: retry!.due_at + 1,
        })
      ).state,
      "submitted",
    );
    assert.equal((await h.store.ledger(key))!.state, "submitted");
    assert(
      await h.store.private("a", "destination", prepared.attemptId, "outbox"),
    );
    assert.equal(
      (
        await reconcileAttempt(h.store, "a", prepared.attemptId, {
          fetcher,
          now: retry!.due_at + 2,
        })
      ).state,
      "observed",
    );
    assert.equal((await h.store.ledger(key))!.state, "observed");
    assert.equal((await h.store.ledger(key))!.confirmed, 0);
    assert.equal(
      await h.store.private("a", "destination", prepared.attemptId, "outbox"),
      null,
    );
    const observation = await h.store.private(
      "a",
      "destination",
      `observation:${prepared.attemptId}`,
      "lotw_observation",
    );
    assert(observation);
    record.QSL_RCVD = "Y";
    const refreshed = await refreshConfirmations(h.store, "a", {
      fetcher,
      now: signingNow + 2 * 86400000,
    });
    assert.equal(refreshed.checked, 1);
    assert.equal(refreshed.confirmed, 1);
    assert.equal((await h.store.ledger(key))!.confirmed, 1);
    record.MY_GRIDSQUARE = "FN32";
    record.QSL_RCVD = "N";
    const mismatched = await refreshConfirmations(h.store, "a", {
      fetcher,
      now: signingNow + 4 * 86400000,
    });
    assert.equal(mismatched.unresolved, 1);
    assert.equal((await h.store.ledger(key))!.confirmed, 1);
    assert.equal(submissions, 1);
    const originalIdentity = (await h.store.ledger(key))!.remote_id;
    const changed: Contact = {
      ...item,
      call: "K2XYZ",
      generation: "new-identity",
    };
    changed.generation = await sourceFingerprint(changed, "lotw");
    const changedAt = signingNow + 5 * 86400000;
    const correctedNow = changedAt + 31 * 60000;
    await h.store.observe(
      key,
      changed.generation,
      changed.generation,
      30,
      false,
      changedAt,
    );
    assert.equal(
      (await h.store.ledger(key))!.confirmed,
      0,
      "new source revision cannot inherit the previous confirmation during its quiet period",
    );
    record.MY_GRIDSQUARE = "FN31PR";
    record.QSL_RCVD = "Y";
    const corrected = await prepareDue(h.store, key, changed, gates, {
      fetcher,
      now: correctedNow,
    });
    assert(corrected.attemptId);
    assert.equal(
      (await h.store.ledger(key))!.confirmed,
      0,
      "new identity cannot inherit old confirmation at preparation",
    );
    await refreshConfirmations(h.store, "a", {
      fetcher,
      now: correctedNow + 1,
    });
    assert.equal(
      (await h.store.ledger(key))!.confirmed,
      0,
      "periodic old-identity readback cannot confirm a pending correction",
    );
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", corrected.attemptId, gates, {
          fetcher,
          now: correctedNow + 2,
        })
      ).state,
      "submitted",
    );
    assert.equal((await h.store.ledger(key))!.confirmed, 0);
    assert.equal(
      (await h.store.ledger(key))!.reason,
      LOTW_PRIOR_IDENTITY_NOTICE,
    );
    assert.equal(await h.store.lotwPriorIdentityCount(key), 1);
    record.CALL = changed.call;
    record.QSL_RCVD = "N";
    assert.equal(
      (
        await reconcileAttempt(h.store, "a", corrected.attemptId, {
          fetcher,
          now: correctedNow + 3,
        })
      ).state,
      "observed",
    );
    const correctedRow = (await h.store.ledger(key))!;
    assert.notEqual(correctedRow.remote_id, originalIdentity);
    assert.equal(correctedRow.confirmed, 0);
    assert.equal(correctedRow.reason, LOTW_PRIOR_IDENTITY_NOTICE);
    const identities = await h.store.lotwIdentities(key);
    assert.deepEqual(
      identities.map((identity) => identity.identity.CALL).sort(),
      ["K1ABC", "K2XYZ"],
    );
    assert(
      identities.some((identity) => identity.remoteId === originalIdentity),
    );
    assert(
      identities.some(
        (identity) => identity.remoteId === correctedRow.remote_id,
      ),
    );
    assert(
      identities.every(
        (identity) => !Object.hasOwn(identity.identity, "MY_GRIDSQUARE"),
      ),
    );
    assert.equal((await h.store.lotwIdentities(key, 1)).length, 1);
    assert.equal(
      await h.store.private("a", "destination", corrected.attemptId, "outbox"),
      null,
    );
    assert.equal(
      (await h.store
        .statement(
          "SELECT COUNT(*) n FROM private_data WHERE kind='lotw_observation'",
        )
        .first<{ n: number }>())!.n,
      1,
    );
    assert.equal(submissions, 2);
  } finally {
    await h.mf.dispose();
  }
});
test("readback failure before a mutation retries the same immutable attempt with backoff", async () => {
  const h = await setup();
  try {
    const prepared = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert(prepared.attemptId);
    const original = await h.store.private(
      "a",
      "destination",
      prepared.attemptId,
      "outbox",
    );
    const failedRead: typeof fetch = async () => {
      throw new Error("read timeout");
    };
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          fetcher: failedRead,
          now: now + 1,
        })
      ).state,
      "retry_scheduled",
    );
    const attempt = await h.store
      .statement(
        "SELECT state,due_at FROM attempt_state WHERE attempt=?",
        prepared.attemptId,
      )
      .first<{ state: string; due_at: number }>();
    assert.equal(attempt!.state, "prepared");
    assert(attempt!.due_at >= now + 30000);
    assert.deepEqual(
      await h.store.private("a", "destination", prepared.attemptId, "outbox"),
      original,
    );
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          fetcher: h.fetcher,
          now: attempt!.due_at + 1,
        })
      ).state,
      "delivered",
    );
    assert.equal(h.mutations.length, 1);
  } finally {
    await h.mf.dispose();
  }
});
test("an unresolved immutable attempt skips repeated preparation before vendor reads", async () => {
  const h = await setup();
  try {
    const prepared = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert(prepared.attemptId);
    const original = await h.store.private(
      "a",
      "destination",
      prepared.attemptId,
      "outbox",
    );
    for (const state of [
      "prepared",
      "uncertain",
      "submitted",
      "reconciliation_required",
    ]) {
      await h.store
        .statement(
          "UPDATE attempt_state SET state=? WHERE attempt=?",
          state,
          prepared.attemptId,
        )
        .run();
      assert.deepEqual(
        await prepareDue(h.store, h.key, h.item, gates, {
          now: now + 1,
          fetcher: async () => {
            throw new Error(
              "Unresolved work must not consume another vendor read",
            );
          },
        }),
        { state: "skipped", reason: "unresolved_attempt" },
      );
    }
    assert.equal(
      (await h.store
        .statement("SELECT COUNT(*) n FROM attempts")
        .first<{ n: number }>())!.n,
      1,
    );
    assert.deepEqual(
      await h.store.private("a", "destination", prepared.attemptId, "outbox"),
      original,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("a full background outbox stops new vendor reads while live preparation remains available", async () => {
  const h = await setup();
  try {
    for (const id of ["q1", "q2"]) {
      const key = { ...h.key, qso: id };
      const item = { ...h.item, id };
      if (id !== "q1") {
        await h.store.observe(
          key,
          item.generation,
          await sourceFingerprint(item, "qrz"),
          30,
          false,
          at,
        );
        await h.store
          .statement(
            "UPDATE ledger SET state='missing_current_identity' WHERE qso=?",
            id,
          )
          .run();
      }
      assert.equal(
        (
          await prepareDue(h.store, key, item, gates, {
            fetcher: h.fetcher,
            now,
            priority: "background",
          })
        ).state,
        "prepared",
      );
    }
    const key = { ...h.key, qso: "q3" };
    const item = { ...h.item, id: "q3" };
    await h.store.observe(
      key,
      item.generation,
      await sourceFingerprint(item, "qrz"),
      30,
      false,
      at,
    );
    await h.store
      .statement(
        "UPDATE ledger SET state='missing_current_identity' WHERE qso='q3'",
      )
      .run();
    let reads = 0;
    const fetcher: typeof fetch = async (input, init) => {
      reads++;
      return h.fetcher(input, init);
    };
    assert.deepEqual(
      await prepareDue(h.store, key, item, gates, {
        fetcher,
        now,
        priority: "background",
      }),
      { state: "skipped", reason: "background_outbox_full" },
    );
    assert.equal(reads, 0);
    assert.equal(
      (
        await prepareDue(h.store, key, item, gates, {
          fetcher,
          now,
          priority: "live",
        })
      ).state,
      "prepared",
    );
    assert.equal(reads, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("inactive routes and superseded credentials do not hold other background outboxes full", async () => {
  const h = await setup();
  try {
    const prepare = async (
      qso: string,
      source = "source",
      destination = "destination",
    ) => {
      const key = { tenant: "a", source, qso, destination };
      const item = { ...h.item, id: qso };
      await h.store.observe(
        key,
        item.generation,
        await sourceFingerprint(item, "qrz"),
        30,
        false,
        at,
      );
      await h.store
        .statement(
          "UPDATE ledger SET state='missing_current_identity' WHERE source=? AND qso=? AND destination=?",
          source,
          qso,
          destination,
        )
        .run();
      return prepareDue(h.store, key, item, gates, {
        fetcher: h.fetcher,
        now,
        priority: "background",
      });
    };
    assert.equal((await prepare("q1")).state, "prepared");
    assert.equal((await prepare("q2")).state, "prepared");
    for (const [original, id] of [
      ["source", "available-source"],
      ["destination", "available-destination"],
    ]) {
      const connection = (await h.store.connection("a", original))!;
      await h.store
        .statement(
          "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a',?,?,?,?,'active','v1',?,0)",
          id,
          connection.kind,
          id,
          id,
          connection.config,
        )
        .run();
    }
    await (
      await h.store.putPrivate(
        "a",
        "available-destination",
        "v1",
        "credential",
        { apiKey: "synthetic-key" },
      )
    ).run();
    await h.store.saveTemplate("a", "available-destination", {
      profile: TEMPLATE_PROFILE,
      fields: { COMMENT: "fixture" },
      fallbackNotes: false,
    });
    // Model stale prepared rows that outlast an inactive connection.
    await h.store
      .statement(
        "UPDATE connections SET status='disabled' WHERE id='destination'",
      )
      .run();
    assert.equal(
      (await prepare("q3", "source", "available-destination")).state,
      "prepared",
    );
    await h.store
      .statement("UPDATE connections SET status='disabled' WHERE id='source'")
      .run();
    assert.equal(
      (await prepare("q4", "available-source", "available-destination")).state,
      "prepared",
    );
    await h.store
      .statement("UPDATE connections SET status='active' WHERE id='source'")
      .run();
    await h.store
      .statement(
        "UPDATE connections SET credential_version='v2' WHERE id='available-destination'",
      )
      .run();
    await (
      await h.store.putPrivate(
        "a",
        "available-destination",
        "v2",
        "credential",
        { apiKey: "renewed-synthetic" },
      )
    ).run();
    assert.equal(
      (await prepare("q5", "available-source", "available-destination")).state,
      "prepared",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("request budget denial immediately before upload retains the prepared immutable artifact", async () => {
  const h = await setup();
  try {
    const prepared = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert(prepared.attemptId);
    const original = await h.store.private(
      "a",
      "destination",
      prepared.attemptId,
      "outbox",
    );
    // Leave enough budget for the fresh read, but none for the following INSERT.
    await h.store
      .statement(
        "UPDATE vendor_requests SET requests=? WHERE vendor='qrz'",
        VENDOR_POLICIES.qrz.total - 1,
      )
      .run();
    let network = 0;
    const fetcher: typeof fetch = async (input, init) => {
      network++;
      return h.fetcher(input, init);
    };
    const result = await dispatchAttempt(
      h.store,
      "a",
      prepared.attemptId,
      gates,
      {
        fetcher,
        now: now + 1,
      },
    );
    assert.equal(result.state, "retry_scheduled");
    assert.equal(network, 1);
    assert.equal(h.mutations.length, 0);
    const state = await h.store
      .statement(
        "SELECT state,due_at FROM attempt_state WHERE attempt=?",
        prepared.attemptId,
      )
      .first<{ state: string; due_at: number }>();
    assert.equal(state!.state, "prepared");
    assert(state!.due_at >= Math.floor(now / 300000) * 300000 + 300000);
    assert.deepEqual(
      await h.store.private("a", "destination", prepared.attemptId, "outbox"),
      original,
    );
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          fetcher,
          now: state!.due_at + 1,
        })
      ).state,
      "delivered",
    );
    assert.equal(h.mutations.length, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("an explicit upload throttle remains uncertain and the shared cooldown prevents more network calls", async () => {
  const h = await setup();
  try {
    const prepared = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now,
    });
    assert(prepared.attemptId);
    let uploads = 0;
    let network = 0;
    const fetcher: typeof fetch = async (input, init) => {
      network++;
      if (new URLSearchParams(String(init?.body)).get("ACTION") === "INSERT") {
        uploads++;
        return new Response("private vendor error", {
          status: 429,
          headers: { "Retry-After": "600" },
        });
      }
      return h.fetcher(input, init);
    };
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          fetcher,
          now: now + 1,
        })
      ).state,
      "uncertain",
    );
    assert.equal(uploads, 1);
    assert.equal(network, 2);
    assert(
      await h.store.private("a", "destination", prepared.attemptId, "outbox"),
    );
    await assert.rejects(
      reconcileAttempt(h.store, "a", prepared.attemptId, {
        fetcher,
        now: now + 2,
      }),
      VendorDeferredError,
    );
    assert.equal(network, 2);
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          fetcher,
          now: now + 600001,
        })
      ).state,
      "skipped",
    );
    assert.equal(
      (
        await reconcileAttempt(h.store, "a", prepared.attemptId, {
          fetcher,
          now: now + 600001,
        })
      ).state,
      "unresolved",
    );
    assert.equal(network, 3);
    assert.equal(uploads, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("rollout allowlist bounds first preparation and dispatch to the selected source UUID", async () => {
  const h = await setup();
  try {
    for (const allowedQsoIds of [[], ["another-qso"]])
      assert.equal(
        (
          await prepareDue(
            h.store,
            h.key,
            h.item,
            { ...gates, allowedQsoIds },
            { fetcher: h.fetcher, now },
          )
        ).reason,
        "qso_outside_rollout_scope",
      );
    const ready = await prepareDue(
      h.store,
      h.key,
      h.item,
      { ...gates, allowedQsoIds: ["q1"] },
      { fetcher: h.fetcher, now },
    );
    assert(ready.attemptId);
    assert.equal(
      (
        await dispatchAttempt(
          h.store,
          "a",
          ready.attemptId,
          { ...gates, allowedQsoIds: [] },
          { fetcher: h.fetcher, now: now + 1 },
        )
      ).reason,
      "qso_outside_rollout_scope",
    );
    assert.equal(h.mutations.length, 0);
    assert.equal(
      (
        await dispatchAttempt(
          h.store,
          "a",
          ready.attemptId,
          { ...gates, allowedQsoIds: ["q1"] },
          { fetcher: h.fetcher, now: now + 2 },
        )
      ).state,
      "delivered",
    );
    assert.equal(h.mutations.length, 1);
  } finally {
    await h.mf.dispose();
  }
});
test("prepared narrative context exposes HaLo contact aliases and frozen operation dates", async () => {
  const h = await setup();
  try {
    h.item.context.qso.their = {
      call: "W1AW",
      name: "Alice Example",
      guess: { state: "CT" },
    };
    h.item.context.qso.refs = [{ ourSerial: 7, theirSerial: "12" }];
    h.item.context.op.startAtMillisMin = at;
    h.item.generation = await sourceFingerprint(h.item, "qrz");
    await h.store.observe(
      h.key,
      h.item.generation,
      h.item.generation,
      30,
      false,
      now,
    );
    await h.store.saveTemplate("a", "destination", {
      profile: TEMPLATE_PROFILE,
      fields: {
        COMMENT:
          '{{ qso.name }} {{ qso.state }} #{{ qso.serialSent | pad: 3 }} {{ qso.serialRcvd }} {{ op.startAt | date: "%H:%M" }}',
      },
      fallbackNotes: false,
    });
    const ready = await prepareDue(h.store, h.key, h.item, gates, {
      fetcher: h.fetcher,
      now: now + 31 * 60000,
    });
    assert(ready.attemptId);
    const payload = await h.store.private<{ record: AdifRecord }>(
      "a",
      "destination",
      ready.attemptId,
      "outbox",
    );
    assert.equal(payload!.record.COMMENT, "Alice CT #007 12 12:00");
  } finally {
    await h.mf.dispose();
  }
});

test("LoTW certificate expiry after preparation rejects a signed artifact before upload", async () => {
  const h = await deliveryDatabase();
  try {
    const key = await seed(h.store);
    const { importPkcs12 } = await import("../src/signing.ts");
    const fixture = (name: string) =>
      readFile(new URL(`../fixtures/signing/${name}`, import.meta.url));
    const signingNow = Date.parse("2027-01-01T00:00:00Z");
    const signing = await importPkcs12(
      await fixture("current.p12"),
      "ferry-fixture",
      {
        now: new Date(signingNow),
        certificateStatus: async () => "unrevoked",
        version: "fixture-expiry",
      },
    );
    signing.validTo = new Date(signingNow + 1_000).toISOString();
    await h.store
      .statement(
        "UPDATE connections SET kind='lotw',config=? WHERE id='destination'",
        JSON.stringify({ stations: [{ callsign: "W1AW", dxcc: 291 }] }),
      )
      .run();
    await h.store
      .statement(
        "DELETE FROM private_data WHERE connection='destination' AND kind='credential'",
      )
      .run();
    await (
      await h.store.putPrivate("a", "destination", "v1", "credential", {
        signingCredentials: [signing],
        query: { username: "synthetic", password: "synthetic" },
      })
    ).run();
    const item = await projectContact(
      {
        uuid: "q1",
        operation: "op1",
        startAtMillis: at,
        freq: 14074,
        band: "20m",
        mode: "FT8",
        their: { call: "K1ABC" },
        our: {
          stationCall: "W1AW",
          dxccCode: 291,
          grid: "FN31PR",
          state: "CT",
          county: "CT,Tolland",
          cqZone: 5,
          ituZone: 8,
        },
      },
      { uuid: "op1", stationCall: "W1AW" },
      [],
      { operationComplete: true },
    );
    await h.store.observe(
      key,
      item.generation,
      await sourceFingerprint(item, "lotw"),
      30,
      false,
      at,
    );
    await h.store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    let requests = 0;
    let uploads = 0;
    const fetcher: typeof fetch = async (input) => {
      requests++;
      const url = String(input);
      if (url.includes("/lotw/crl?"))
        return new Response("<Status>Unrevoked</Status>");
      if (url.includes("lotwreport.adi?"))
        return new Response(
          "<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH><APP_LOTW_EOF>",
        );
      assert.match(url, /lotw\/upload$/);
      uploads++;
      return new Response("<!-- .UPL. accepted -->");
    };
    const prepared = await prepareDue(h.store, key, item, gates, {
      fetcher,
      now: signingNow,
    });
    assert.equal(prepared.state, "prepared");
    assert(prepared.attemptId);
    const payload = await h.store.private<{ kind: string; tq8: string }>(
      "a",
      "destination",
      prepared.attemptId,
      "outbox",
    );
    assert.equal(payload?.kind, "lotw");
    assert.deepEqual(
      [...Buffer.from(payload!.tq8, "base64").subarray(0, 2)],
      [0x1f, 0x8b],
    );
    const requestsBeforeExpiry = requests;
    const rejected = await dispatchAttempt(
      h.store,
      "a",
      prepared.attemptId,
      gates,
      { fetcher, now: signingNow + 1_001 },
    );
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.reason, "lotw_certificate_not_currently_valid");
    assert.equal(uploads, 0);
    assert.equal(requests, requestsBeforeExpiry);
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT state FROM attempt_state WHERE attempt=?",
            prepared.attemptId,
          )
          .first<{ state: string }>()
      )?.state,
      "rejected",
    );
  } finally {
    await h.mf.dispose();
  }
});
