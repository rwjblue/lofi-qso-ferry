import assert from "node:assert/strict";
import test from "node:test";
import {
  type AdifRecord,
  parseAdif,
  serializeAdifRecord,
} from "../src/adif.ts";
import { clublogRecord, clublogRemoteIdentity } from "../src/clublog.ts";
import {
  type DeliveryGates,
  dispatchAttempt,
  type PreparedPayload,
  prepareDue,
  reconcileAttempt,
} from "../src/delivery.ts";
import {
  type Contact,
  projectContact,
  sourceFingerprint,
} from "../src/projection.ts";
import { adoptHistory, classifyHistory } from "../src/reconcile.ts";
import { RETAINED_REMOTE_IDENTITY_NOTICE } from "../src/store.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const at = Date.parse("2026-10-22T12:00:01Z");
const now = at + 31 * 60000;
const gates: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: true,
};

async function setup() {
  const h = await database();
  await applyAdditionalMigrations(h.db);
  const sourceKey = await seed(h.store);
  const key = { ...sourceKey, destination: "clublog" };
  await h.store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','clublog','clublog','synthetic','Club Log','active','cl-v1',?,0)",
      JSON.stringify({ stationCallsign: "W1AW" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "clublog", "cl-v1", "credential", {
      email: "synthetic@example.test",
      password: "synthetic-app-password",
      callsign: "W1AW",
    })
  ).run();
  const item = await projectContact(
    {
      uuid: "q1",
      startAtMillis: at,
      stationCall: "W1AW",
      band: "20m",
      freq: 14060,
      mode: "CW",
      their: { call: "K1ABC" },
      rstSent: "599",
      rstReceived: "579",
    },
    null,
  );
  await h.store.observe(
    key,
    item.generation,
    await sourceFingerprint(item, "clublog"),
    30,
    false,
    at,
  );
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity' WHERE destination='clublog'",
    )
    .run();
  const records: AdifRecord[] = [];
  const mutations: AdifRecord[] = [];
  const flags = {
    readFail: false,
    readAuth: false,
    lostReceipt: false,
    revokeOnRead: false,
    budget: false,
    sourceDeleted: false,
    sourceEdited: false,
    uploadServerError: false,
  };
  const calls = { reads: 0, writes: 0, batch: 0 };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/getadif.php") {
      calls.reads++;
      if (flags.readAuth) return new Response("Forbidden", { status: 403 });
      if (flags.readFail) throw new Error("synthetic read failure");
      if (flags.revokeOnRead)
        await h.store
          .statement(
            "UPDATE connections SET credential_version='cl-v2' WHERE id='clublog'",
          )
          .run();
      if (flags.sourceDeleted)
        await h.store
          .statement(
            "UPDATE ledger SET state='source_deleted' WHERE destination='clublog'",
          )
          .run();
      if (flags.sourceEdited)
        await h.store
          .statement(
            "UPDATE ledger SET source_hash='new-source-revision' WHERE destination='clublog'",
          )
          .run();
      return new Response(
        `<ADIF_VER:5>3.1.6<EOH>${records.map(serializeAdifRecord).join("")}`,
      );
    }
    assert(["/realtime.php", "/putlogs.php"].includes(url.pathname));
    if (flags.budget) throw new VendorDeferredError(now + 60000, false);
    calls.writes++;
    let adif: string;
    if (url.pathname === "/putlogs.php") {
      calls.batch++;
      assert(init?.body instanceof FormData);
      assert.equal(init.body.get("clear"), null);
      const file = init.body.get("file");
      assert(file instanceof Blob);
      adif = await file.text();
    } else {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("api"), "synthetic-developer-key");
      assert.equal(form.get("callsign"), "W1AW");
      adif = form.get("adif")!;
    }
    const record = parseAdif(adif).records[0]!;
    mutations.push(record);
    records.push({ ...record, STATION_CALLSIGN: "W1AW" });
    if (flags.uploadServerError)
      return new Response("Internal error", { status: 500 });
    if (flags.lostReceipt)
      throw new Error("synthetic receipt lost after acceptance");
    return new Response(url.pathname === "/putlogs.php" ? "OK" : "QSO OK");
  };
  const deps = { now, fetcher, clublogApiKey: "synthetic-developer-key" };
  const stage = async (contact = item) => {
    const result = await prepareDue(h.store, key, contact, gates, deps);
    assert.equal(result.state, "prepared", result.reason);
    assert(result.attemptId);
    return result.attemptId;
  };
  const change = async (values: Partial<Contact>) => {
    const changed = { ...item, ...values };
    changed.generation = await sourceFingerprint(changed, "qrz");
    await h.store.observe(
      key,
      changed.generation,
      await sourceFingerprint(changed, "clublog"),
      30,
      false,
      now + 1,
    );
    deps.now = now + 31 * 60000;
    return changed;
  };
  return {
    ...h,
    key,
    item,
    records,
    mutations,
    flags,
    calls,
    deps,
    stage,
    change,
  };
}

async function competingContact(h: Awaited<ReturnType<typeof setup>>) {
  const key = { ...h.key, qso: "q2" };
  const contact = {
    ...h.item,
    id: key.qso,
    context: {
      ...h.item.context,
      qso: { ...h.item.context.qso, uuid: key.qso },
    },
  };
  contact.generation = await sourceFingerprint(contact, "qrz");
  await h.store.observe(
    key,
    contact.generation,
    await sourceFingerprint(contact, "clublog"),
    30,
    false,
    at,
  );
  const classify = (records: AdifRecord[]) =>
    classifyHistory(clublogRecord(contact), records, {
      destination: "clublog",
      capturedGeneration: contact.generation,
      currentGeneration: contact.generation,
      readAccess: true,
      inventoryComplete: true,
      catchupComplete: true,
      freshCheckComplete: true,
    });
  assert.equal(
    (
      await adoptHistory(
        h.store,
        key,
        contact.generation,
        classify([]),
        h.deps.now,
      )
    ).applied,
    true,
  );
  return { key, contact, classify };
}

function delayedVisibility(h: Awaited<ReturnType<typeof setup>>) {
  const queued: AdifRecord[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    try {
      return await h.deps.fetcher(input, init);
    } finally {
      if (new URL(String(input)).pathname !== "/getadif.php")
        queued.push(...h.records.splice(0));
    }
  };
  return { fetcher, reveal: () => h.records.push(...queued.splice(0)) };
}

test("Club Log stages without QRZ templates, honors quiet period and gates, then observes the exact upload", async () => {
  const h = await setup();
  try {
    assert.equal(
      (
        await prepareDue(h.store, h.key, h.item, gates, {
          ...h.deps,
          now: at + 1000,
        })
      ).state,
      "skipped",
    );
    assert.equal(h.calls.reads, 0);
    const id = await h.stage();
    const payload = await h.store.private<PreparedPayload>(
      "a",
      "clublog",
      id,
      "outbox",
    );
    assert.equal(payload?.kind, "clublog");
    assert.equal((await h.store.ledger(h.key))!.template_version, null);
    assert.equal(
      (
        await dispatchAttempt(
          h.store,
          "a",
          id,
          { ...gates, exportsEnabled: false },
          h.deps,
        )
      ).state,
      "blocked",
    );
    assert.equal(h.calls.writes, 0);
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "submitted",
    );
    assert.equal((await h.store.ledger(h.key))!.state, "submitted");
    assert(await h.store.private("a", "clublog", id, "outbox"));
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "observed",
    );
    const row = (await h.store.ledger(h.key))!;
    assert.equal(
      row.remote_id,
      await clublogRemoteIdentity(clublogRecord(h.item)),
    );
    assert.equal(row.confirmed, 0);
    assert.equal(row.baseline_hash, row.source_hash);
    assert.equal(await h.store.private("a", "clublog", id, "outbox"), null);
    assert.equal(h.calls.writes, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("Club Log history uses merge-only queued uploads and waits for observation", async () => {
  const h = await setup();
  try {
    const ready = await prepareDue(h.store, h.key, h.item, gates, {
      ...h.deps,
      priority: "background",
    });
    assert(ready.attemptId);
    // Dispatch's scheduler priority cannot change the immutable transport choice.
    assert.equal(
      (await dispatchAttempt(h.store, "a", ready.attemptId, gates, h.deps))
        .state,
      "submitted",
    );
    assert.equal(h.calls.batch, 1);
    assert.equal(
      (await reconcileAttempt(h.store, "a", ready.attemptId, h.deps)).state,
      "observed",
    );
  } finally {
    await h.mf.dispose();
  }
});

for (const state of ["submitted", "uncertain"] as const) {
  test(`${state === "uncertain" ? "an" : "a"} ${state} Club Log identity cannot be adopted by a competing source UUID`, async () => {
    const h = await setup();
    try {
      const rival = await competingContact(h);
      const pending = delayedVisibility(h);
      const ready = await prepareDue(h.store, h.key, h.item, gates, {
        ...h.deps,
        priority: "background",
      });
      assert.ok(ready.attemptId);
      h.flags.lostReceipt = state === "uncertain";
      assert.equal(
        (
          await dispatchAttempt(h.store, "a", ready.attemptId, gates, {
            ...h.deps,
            fetcher: pending.fetcher,
          })
        ).state,
        state,
      );
      assert.equal(h.records.length, 0);
      assert.equal((await h.store.ledger(h.key))!.remote_id, null);
      assert.equal(pending.reveal(), 1);
      const remote = rival.classify(h.records);
      assert.equal(remote.state, "adopted_existing");
      // The rival has no attempt of its own: exclusion must come from the
      // first UUID's reserved identity, not the existing own-attempt guard.
      assert.equal(
        (
          await adoptHistory(
            h.store,
            rival.key,
            rival.contact.generation,
            remote,
            h.deps.now,
          )
        ).applied,
        false,
      );
      assert.equal((await h.store.ledger(rival.key))!.remote_id, null);
      assert.equal(
        (await reconcileAttempt(h.store, "a", ready.attemptId, h.deps)).state,
        "observed",
      );
      assert.equal(
        (await h.store.ledger(h.key))!.remote_id,
        await clublogRemoteIdentity(h.records[0]!),
      );
      assert.equal(h.calls.writes, 1);
    } finally {
      await h.mf.dispose();
    }
  });

  test(`${state === "uncertain" ? "an" : "a"} ${state} Club Log identity prevents competing dispatch before vendor readback`, async () => {
    const h = await setup();
    try {
      const rival = await competingContact(h);
      const first = await h.stage();
      const second = await prepareDue(
        h.store,
        rival.key,
        rival.contact,
        gates,
        h.deps,
      );
      assert.ok(second.attemptId);
      const pending = delayedVisibility(h);
      h.flags.lostReceipt = state === "uncertain";
      assert.equal(
        (
          await dispatchAttempt(h.store, "a", first, gates, {
            ...h.deps,
            fetcher: pending.fetcher,
          })
        ).state,
        state,
      );
      assert.equal(h.records.length, 0);
      const reads = h.calls.reads;
      const rejectedClaim = await dispatchAttempt(
        h.store,
        "a",
        second.attemptId,
        gates,
        h.deps,
      );
      assert.equal(rejectedClaim.state, "skipped");
      assert.equal(rejectedClaim.reason, "attempt_not_claimable");
      assert.equal(h.calls.reads, reads);
      assert.equal(h.calls.writes, 1);
      assert.equal(pending.reveal(), 1);
      assert.equal(
        (await reconcileAttempt(h.store, "a", first, h.deps)).state,
        "observed",
      );
      assert.equal((await h.store.ledger(rival.key))!.remote_id, null);
    } finally {
      await h.mf.dispose();
    }
  });
}

for (const terminal of ["rejected", "cancelled"] as const)
  test(`a definitely unsent ${terminal} Club Log attempt releases its competing identity claim`, async () => {
    const h = await setup();
    try {
      const rival = await competingContact(h);
      const first = await h.stage();
      const second = await prepareDue(
        h.store,
        rival.key,
        rival.contact,
        gates,
        h.deps,
      );
      assert.ok(second.attemptId);
      if (terminal === "rejected") h.flags.readAuth = true;
      else h.flags.readFail = true;
      assert.equal(
        (await dispatchAttempt(h.store, "a", first, gates, h.deps)).state,
        terminal === "rejected" ? "rejected" : "retry_scheduled",
      );
      assert.equal(h.calls.writes, 0);
      if (terminal === "rejected") {
        h.flags.readAuth = false;
        await h.store
          .statement(
            "UPDATE connections SET status='active' WHERE id='clublog'",
          )
          .run();
      } else {
        h.flags.readFail = false;
        const deleted = { ...h.item, deleted: true };
        await h.store.observe(
          h.key,
          await sourceFingerprint(deleted, "qrz"),
          await sourceFingerprint(deleted, "clublog"),
          30,
          true,
          h.deps.now,
        );
      }
      assert.equal(
        (await h.store
          .statement("SELECT state FROM attempt_state WHERE attempt=?", first)
          .first<{ state: string }>())!.state,
        terminal,
      );
      assert.equal(
        (await dispatchAttempt(h.store, "a", second.attemptId, gates, h.deps))
          .state,
        "submitted",
      );
      assert.equal(
        (await reconcileAttempt(h.store, "a", second.attemptId, h.deps)).state,
        "observed",
      );
      assert.equal((await h.store.ledger(h.key))!.remote_id, null);
      assert.ok((await h.store.ledger(rival.key))!.remote_id);
      assert.equal(h.calls.writes, 1);
    } finally {
      await h.mf.dispose();
    }
  });

for (const field of ["FREQ", "RST_SENT"] as const)
  test(`clearing previously sent ${field} requires review and retains the Club Log baseline`, async () => {
    const h = await setup();
    try {
      const original =
        field === "RST_SENT" ? await h.change({ rstSent: "599" }) : h.item;
      const id = await h.stage(original);
      await dispatchAttempt(h.store, "a", id, gates, h.deps);
      await reconcileAttempt(h.store, "a", id, h.deps);
      const before = await h.store.ledger(h.key);
      assert.ok(before);
      assert.equal(h.mutations[0]![field], field === "FREQ" ? "14.06" : "599");
      const changed = await h.change(
        field === "FREQ" ? { frequencyMHz: undefined } : { rstSent: undefined },
      );
      assert.equal(clublogRecord(changed)[field], undefined);
      const result = await prepareDue(h.store, h.key, changed, gates, h.deps);
      assert.equal(result.state, "blocked");
      assert.equal(
        result.reason,
        "clublog_same_identity_correction_requires_review",
      );
      const after = await h.store.ledger(h.key);
      assert.ok(after);
      assert.equal(after.state, "changed");
      assert.equal(after.baseline_hash, before.baseline_hash);
      assert.notEqual(after.baseline_hash, after.source_hash);
      assert.equal(h.records[0]![field], h.mutations[0]![field]);
      assert.equal(h.calls.writes, 1);
    } finally {
      await h.mf.dispose();
    }
  });

test("a lost Club Log response retains the exact attempt and never creates a second upload", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    h.flags.lostReceipt = true;
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "uncertain",
    );
    const changed = await h.change({ call: "K2XYZ" });
    assert.equal(
      (await prepareDue(h.store, h.key, changed, gates, h.deps)).reason,
      "unresolved_attempt",
    );
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "observed",
    );
    assert.equal((await h.store.ledger(h.key))!.state, "changed");
    assert.equal(h.calls.writes, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("Club Log rejects a stale revision observation and preserves its unresolved payload", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    await dispatchAttempt(h.store, "a", id, gates, h.deps);
    h.records[0]!.FREQ = "14.061";
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "unresolved",
    );
    assert(await h.store.private("a", "clublog", id, "outbox"));
    assert.equal((await h.store.ledger(h.key))!.state, "submitted");
  } finally {
    await h.mf.dispose();
  }
});

test("Club Log defers unsent read failures and budget denials without changing immutable bytes", async () => {
  for (const failure of ["readFail", "budget"] as const) {
    const h = await setup();
    try {
      const id = await h.stage();
      const before = await h.store.private("a", "clublog", id, "outbox");
      h.flags[failure] = true;
      assert.equal(
        (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
        "retry_scheduled",
      );
      assert.deepEqual(
        await h.store.private("a", "clublog", id, "outbox"),
        before,
      );
      assert.equal(h.calls.writes, 0);
      assert.equal(
        (await h.store
          .statement("SELECT state FROM attempt_state WHERE attempt=?", id)
          .first<{ state: string }>())!.state,
        "prepared",
      );
    } finally {
      await h.mf.dispose();
    }
  }
});

test("credential renewal during Club Log readback prevents an upload using superseded secrets", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    h.flags.revokeOnRead = true;
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "rejected",
    );
    assert.equal(h.calls.writes, 0);
    assert.equal(
      (await h.store
        .statement("SELECT reason FROM attempt_state WHERE attempt=?", id)
        .first<{ reason: string }>())!.reason,
      "clublog_write_blocked",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("source edits and tombstones during preflight stop Club Log mutations", async () => {
  for (const flag of ["sourceDeleted", "sourceEdited"] as const) {
    const h = await setup();
    try {
      const id = await h.stage();
      h.flags[flag] = true;
      assert.equal(
        (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
        "rejected",
      );
      assert.equal(h.calls.writes, 0);
      if (flag === "sourceDeleted")
        assert.equal((await h.store.ledger(h.key))!.state, "source_deleted");
    } finally {
      await h.mf.dispose();
    }
  }
});

for (const state of ["source_deleted", "retained_old_route"] as const)
  test(`current-projection Club Log readback preserves a concurrent ${state} state`, async () => {
    const h = await setup();
    try {
      const id = await h.stage();
      await dispatchAttempt(h.store, "a", id, gates, h.deps);
      await reconcileAttempt(h.store, "a", id, h.deps);
      const before = await h.store.ledger(h.key);
      assert.ok(before);
      const changed = await h.change({ frequencyMHz: 14.061 });
      // The remote was corrected independently, so preparation can settle
      // without writing unless source invalidation occurred during its read.
      h.records[0]!.FREQ = "14.061";
      const fetcher: typeof fetch = async (input, init) => {
        const response = await h.deps.fetcher(input, init);
        if (new URL(String(input)).pathname === "/getadif.php")
          await h.store
            .statement(
              "UPDATE ledger SET state=?,reason='concurrent source invalidation' WHERE destination='clublog'",
              state,
            )
            .run();
        return response;
      };
      await prepareDue(h.store, h.key, changed, gates, {
        ...h.deps,
        fetcher,
      });
      const after = await h.store.ledger(h.key);
      assert.ok(after);
      assert.equal(after.state, state);
      assert.equal(after.reason, "concurrent source invalidation");
      assert.equal(after.baseline_hash, before.baseline_hash);
      assert.notEqual(after.baseline_hash, after.source_hash);
      assert.equal(h.calls.writes, 1);
    } finally {
      await h.mf.dispose();
    }
  });

test("non-200 Club Log writes suspend requests while preserving uncertain artifacts", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    h.flags.uploadServerError = true;
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "uncertain",
    );
    assert.equal(
      (await h.store.connection("a", "clublog"))!.status,
      "needs_verification",
    );
    assert(await h.store.private("a", "clublog", id, "outbox"));
    assert.equal(
      (await h.store
        .statement("SELECT reason FROM attempt_state WHERE attempt=?", id)
        .first<{ reason: string }>())!.reason,
      "clublog_suspended_with_unknown_delivery",
    );
    await h.store
      .statement("UPDATE connections SET status='active' WHERE id='clublog'")
      .run();
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "observed",
    );
    assert.equal((await h.store.ledger(h.key))!.reason, null);
  } finally {
    await h.mf.dispose();
  }
});

test("repeated nearby Club Log identity corrections exclude only verified retained identities", async () => {
  const h = await setup();
  try {
    const first = await h.stage();
    await dispatchAttempt(h.store, "a", first, gates, h.deps);
    await reconcileAttempt(h.store, "a", first, h.deps);
    for (const minutes of [1, 2]) {
      const changed = await h.change({ startAtMillis: at + minutes * 60000 });
      const id = await h.stage(changed);
      assert.equal(
        (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
        "submitted",
      );
      assert.equal(
        (await reconcileAttempt(h.store, "a", id, h.deps)).state,
        "observed",
      );
    }
    assert.equal(h.records.length, 3);
    assert.equal((await h.store.retainedRemoteIds(h.key)).length, 2);
    h.records.push({ ...h.records[0]!, TIME_ON: "120230" });
    const changed = await h.change({ startAtMillis: at + 3 * 60000 });
    assert.equal(
      (await prepareDue(h.store, h.key, changed, gates, h.deps)).reason,
      "clublog_fresh_absence_check_found_candidate",
    );
    assert.equal(h.calls.writes, 3);
  } finally {
    await h.mf.dispose();
  }
});

test("Club Log authentication rejection suspends its connection and retains a submitted artifact", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    await dispatchAttempt(h.store, "a", id, gates, h.deps);
    h.flags.readAuth = true;
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).reason,
      "clublog_credentials_require_verification",
    );
    assert.equal(
      (await h.store.connection("a", "clublog"))!.status,
      "needs_verification",
    );
    assert.equal(
      (await h.store.connection("a", "destination"))!.status,
      "active",
    );
    assert(await h.store.private("a", "clublog", id, "outbox"));
    const reads = h.calls.reads;
    await reconcileAttempt(h.store, "a", id, h.deps);
    assert.equal(h.calls.reads, reads);
  } finally {
    await h.mf.dispose();
  }
});

test("Club Log identity corrections retain prior records; same-identity edits require review", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    await dispatchAttempt(h.store, "a", id, gates, h.deps);
    await reconcileAttempt(h.store, "a", id, h.deps);
    const changed = await h.change({ call: "K2XYZ" });
    const correction = await h.stage(changed);
    await dispatchAttempt(h.store, "a", correction, gates, h.deps);
    await reconcileAttempt(h.store, "a", correction, h.deps);
    assert.equal(h.records.length, 2);
    assert.equal(
      (await h.store.ledger(h.key))!.reason,
      RETAINED_REMOTE_IDENTITY_NOTICE,
    );
    assert.equal(
      (await h.store
        .statement(
          "SELECT COUNT(*) n FROM private_data WHERE kind='identity_history' AND connection='clublog'",
        )
        .first<{ n: number }>())!.n,
      1,
    );
    const fieldEdit = { ...changed, frequencyMHz: 14.061 };
    fieldEdit.generation = await sourceFingerprint(fieldEdit, "qrz");
    await h.store.observe(
      h.key,
      fieldEdit.generation,
      await sourceFingerprint(fieldEdit, "clublog"),
      30,
      false,
      h.deps.now + 1,
    );
    h.deps.now += 31 * 60000;
    const blocked = await prepareDue(h.store, h.key, fieldEdit, gates, h.deps);
    assert.equal(
      blocked.reason,
      "clublog_same_identity_correction_requires_review",
    );
    assert.equal(h.calls.writes, 2);
  } finally {
    await h.mf.dispose();
  }
});
