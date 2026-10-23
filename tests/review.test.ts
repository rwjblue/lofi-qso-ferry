import assert from "node:assert/strict";
import test from "node:test";
import type { SourceRecord } from "../src/lofi.ts";
import { ReviewError, reviewRoute, reviewSource } from "../src/review.ts";
import { saveDefaultTemplate } from "../src/settings.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const qsoAt = Date.UTC(2026, 9, 22, 12);
const rawQso = (id = "q1", operation: string | null = "op1"): SourceRecord => ({
  uuid: id,
  operation,
  startAtMillis: qsoAt,
  band: "20m",
  freq: 14074,
  mode: "FT8",
  their: { call: "W1AW" },
  our: { dxccCode: 291 },
  refs: [{ type: "pota", ref: "US-0002" }],
  notes: "Good signal",
  privateField: "unreturned-source-field",
});
const rawOperation: SourceRecord = {
  uuid: "op1",
  title: "Portable afternoon",
  stationCall: "N0CALL",
  grid: "FN31AA",
  refs: [{ type: "potaActivation", ref: "US-0001" }],
};
async function setup() {
  const state = await database();
  await applyAdditionalMigrations(state.db);
  await seed(state.store);
  const current = await state.store.saveTemplate("a", "destination", {
    profile: TEMPLATE_PROFILE,
    fields: {
      COMMENT:
        "{{ op.stationCall }} {{ op.refs | refLabels | join: ', ' }} | {{ qso.notes }}",
    },
    fallbackNotes: false,
  });
  const now = Date.now();
  await state.store
    .statement(
      "INSERT INTO cursors VALUES('a','source','sync',?,1,?)",
      JSON.stringify({
        mode: "forward",
        operations: { complete: true },
        qsos: { complete: true },
      }),
      now,
    )
    .run();
  await state.store
    .statement(
      "INSERT INTO cursors VALUES('a','source','context',?,2,?)",
      JSON.stringify({ complete: true }),
      now,
    )
    .run();
  await state.store
    .statement(
      "UPDATE connections SET last_poll_at=?,config=? WHERE tenant='a' AND id='source'",
      now,
      JSON.stringify({
        accountId: "not-returned-vendor-id",
        lastSuccessfulPollAt: now - 1,
      }),
    )
    .run();
  return { ...state, now, current };
}
type State = Awaited<ReturnType<typeof setup>>;
async function put(
  h: State,
  raw: SourceRecord,
  kind: "qso" | "operation" = "qso",
  options: {
    tenant?: string;
    state?: string;
    expiresAt?: number;
    syncedAt?: number;
    missing?: boolean;
  } = {},
) {
  const tenant = options.tenant ?? "a";
  const id = String(raw.uuid);
  const privateId = `${kind}:${id}`;
  const event = raw.band === "event" || Boolean(raw.event);
  const expiry =
    options.expiresAt ??
    h.now + (kind === "operation" || event ? 30 : 7) * 86_400_000;
  if (!options.missing) {
    await (
      await h.store.putPrivate(
        tenant,
        "source",
        privateId,
        "source",
        raw,
        expiry,
      )
    ).run();
  }
  await h.store
    .statement(
      "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at,synced_at,is_event,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      tenant,
      "source",
      id,
      kind,
      kind === "operation"
        ? id
        : typeof raw.operation === "string"
          ? raw.operation
          : null,
      privateId,
      `revision:${id}`,
      options.state ?? (kind === "operation" ? "context" : "pending"),
      expiry,
      options.syncedAt ?? h.now,
      event ? 1 : 0,
      raw.deleted ? 1 : 0,
    )
    .run();
}
async function snapshot(h: State) {
  const tables = (
    await h.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results;
  const state: Record<string, string[]> = {};
  for (const { name } of tables) {
    assert.match(name, /^[A-Za-z0-9_]+$/);
    // Fixed test-database schema names only, never request input.
    const rows = (await h.db.prepare(`SELECT * FROM ${name}`).all()).results;
    state[name] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return state;
}

test("retained review uses effective segment context and current production renderer without changing any database row", async () => {
  const h = await setup();
  try {
    await put(h, rawOperation, "operation");
    await put(h, {
      uuid: "segment1",
      operation: "op1",
      band: "event",
      startAtMillis: qsoAt - 1,
      event: {
        event: "break",
        operation: {
          stationCall: "N0CALL/P",
          grid: "FN32BB",
          refs: [{ type: "potaActivation", ref: "US-0003" }],
        },
      },
    });
    await put(h, rawQso());
    const before = await snapshot(h);
    const result = await reviewSource(h.store, "a", {}, h.now);
    assert.deepEqual(await snapshot(h), before);
    assert.equal(result.readOnly, true);
    assert.equal(result.sources[0].lastSuccessAt, h.now - 1);
    assert.match(
      result.sources[0].message,
      /import is ready to review.*does not enable delivery/,
    );
    assert.deepEqual(result.sources[0].counts, {
      operations: 1,
      contacts: 1,
      events: 1,
      tombstones: 0,
      expired: 0,
      archived: 0,
      reviewable: 1,
      pendingOperations: 0,
      operationReadFailures: 0,
    });
    const contact = result.recentContacts[0];
    assert.equal(contact.stationCall, "N0CALL/P");
    assert.equal(contact.grid, "FN32BB");
    assert.equal(contact.operationName, "Portable afternoon");
    assert.deepEqual(contact.ownParks, ["US-0003"]);
    assert.deepEqual(contact.workedParks, ["US-0002"]);
    assert.match(
      contact.preview?.COMMENT ?? "",
      /N0CALL\/P.*US-0003.*Good signal/,
    );
    assert.equal(result.template.version, h.current);
    assert.equal(contact.templateStatus, "current_preview");
    assert.doesNotMatch(
      JSON.stringify(result),
      /fixture-secret|not-returned-vendor-id|unreturned-source-field|private_id|envelope|"credential"/,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("LoTW readiness explains saved verification evidence without vendor reads, private config exposure or paused and tenant regressions", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  await seed(h.store, "b");
  const certificate = {
    validFrom: new Date(h.now - 86_400_000).toISOString(),
    validTo: new Date(h.now + 86_400_000).toISOString(),
    trusted: true,
    status: "unrevoked",
    statusCheckedAt: new Date(h.now - 1).toISOString(),
  };
  const config = {
    readAccess: true,
    loginVerification: {
      status: "verified",
      checkedAt: new Date(h.now - 1).toISOString(),
    },
    certificates: [certificate],
    queryUsername: "private-account",
    error: "private-vendor-error",
  };
  for (const tenant of ["a", "b"])
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,config,created_at) VALUES(?,'lotw','lotw','lotw','LoTW','needs_verification',?,0)",
        tenant,
        JSON.stringify(config),
      )
      .run();
  const readiness = async (trustRootsJson = "[]") => {
    const before = await snapshot(h);
    const result = await reviewSource(h.store, "a", { trustRootsJson }, h.now);
    assert.deepEqual(await snapshot(h), before);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-account|private-vendor-error/,
    );
    const lotw = result.readiness.find((item) => item.kind === "lotw");
    assert(lotw);
    return lotw;
  };
  const missingTrust = await readiness();
  assert.equal(missingTrust.status, "attention");
  assert.match(missingTrust.message, /trust is not configured on the server/);

  await h.store
    .statement(
      "UPDATE connections SET status='active' WHERE tenant='a' AND id='lotw'",
    )
    .run();
  assert.equal((await readiness("bundled")).status, "ready");

  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='a' AND id='lotw'",
      JSON.stringify({
        ...config,
        loginVerification: {
          status: "rejected",
          checkedAt: new Date(h.now).toISOString(),
        },
        certificates: [
          {
            ...certificate,
            statusCheckedAt: new Date(h.now - 86_400_000).toISOString(),
          },
        ],
      }),
    )
    .run();
  const failed = await readiness("bundled");
  assert.equal(failed.status, "attention");
  assert.match(failed.message, /LoTW rejected/);
  assert.match(failed.message, /at least 24 hours old/);

  await h.store
    .statement(
      "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='lotw'",
    )
    .run();
  const paused = await readiness();
  assert.equal(paused.status, "paused");
  assert.match(paused.message, /connection is paused/);
  assert.doesNotMatch(paused.message, /rejected|trust is not configured/);

  await h.store
    .statement(
      "UPDATE connections SET status='revoked' WHERE tenant='a' AND id='lotw'",
    )
    .run();
  assert.equal((await readiness()).status, "not_connected");
});

test("an incomplete first import still explains counts and raw contacts but never guesses operation fields or comments", async () => {
  const h = await setup();
  try {
    await put(h, rawOperation, "operation", { state: "pending" });
    await put(
      h,
      { ...rawOperation, uuid: "deleted-op", deleted: true },
      "operation",
      { state: "pending" },
    );
    await put(h, rawQso());
    await h.store
      .statement(
        "UPDATE cursors SET cursor=? WHERE stream='sync'",
        JSON.stringify({ mode: "backfill", operations: {}, qsos: {} }),
      )
      .run();
    await h.store
      .statement(
        "UPDATE cursors SET cursor=? WHERE stream='context'",
        JSON.stringify({ complete: false }),
      )
      .run();
    await h.store
      .statement("UPDATE connections SET status='revoked' WHERE kind='qrz'")
      .run();
    const result = await reviewSource(h.store, "a", {}, h.now);
    assert.equal(result.sources[0].initialScanComplete, false);
    assert.equal(result.sources[0].counts.operations, 1);
    assert.equal(result.sources[0].counts.tombstones, 1);
    assert.equal(result.sources[0].counts.pendingOperations, 1);
    assert.equal(
      result.readiness.find((item) => item.kind === "qrz")?.status,
      "not_connected",
    );
    assert.equal(
      result.readiness.find((item) => item.kind === "lofi")?.status,
      "scanning",
    );
    const contact = result.recentContacts[0];
    assert.equal(contact.call, "W1AW");
    assert.equal(contact.at, new Date(qsoAt).toISOString());
    assert.equal(contact.band, "20m");
    assert.equal(contact.mode, "FT8");
    assert.equal(contact.stationCall, undefined);
    assert.equal(contact.grid, undefined);
    assert.equal(contact.preview, undefined);
    assert.equal(contact.reason, "source_context_pending");
    await h.store
      .statement("UPDATE connections SET status='revoked' WHERE kind='lofi'")
      .run();
    const removed = await reviewSource(h.store, "a", {}, h.now);
    assert.match(removed.sources[0].message, /^Credentials removed/);
    assert.equal(
      removed.readiness.find((item) => item.kind === "lofi")?.status,
      "not_connected",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("expired, archived, absent and corrupt ciphertext never extend source retention or disclose data", async () => {
  const h = await setup();
  try {
    await put(
      h,
      { ...rawQso("expired", null), our: { stationCall: "N0CALL" } },
      "qso",
      { expiresAt: h.now - 1 },
    );
    await put(h, rawQso("archived", null), "qso", {
      state: "archived",
      missing: true,
    });
    await put(h, rawQso("missing", null), "qso", { missing: true });
    await put(h, rawQso("corrupt", null));
    await h.store
      .statement(
        "UPDATE private_data SET envelope='not-json-private-value' WHERE kind='source' AND id='qso:corrupt'",
      )
      .run();
    const before = await snapshot(h);
    const result = await reviewSource(
      h.store,
      "a",
      { destination: "account_default" },
      h.now,
    );
    assert.deepEqual(await snapshot(h), before);
    const byId = new Map(result.recentContacts.map((row) => [row.id, row]));
    assert.equal(byId.get("expired")?.reason, "source_payload_expired");
    assert.equal(
      byId.get("archived")?.reason,
      "source_payload_no_longer_retained",
    );
    assert.equal(
      byId.get("missing")?.reason,
      "source_payload_no_longer_retained",
    );
    assert.equal(byId.get("corrupt")?.reason, "source_preview_unavailable");
    assert(result.recentContacts.every((row) => !row.preview && !row.call));
    assert.doesNotMatch(JSON.stringify(result), /not-json-private-value/);
  } finally {
    await h.mf.dispose();
  }
});

test("expired and failed operation contexts block previews and remain actionable while source summaries stay visible", async () => {
  const h = await setup();
  try {
    await put(h, rawOperation, "operation", { expiresAt: h.now - 1 });
    await put(h, rawQso());
    let result = await reviewSource(h.store, "a", {}, h.now);
    assert.equal(result.recentContacts[0].call, "W1AW");
    assert.equal(result.recentContacts[0].reason, "operation_context_expired");
    assert.equal(result.recentContacts[0].preview, undefined);
    await h.store
      .statement(
        "UPDATE source_work SET expires_at=?,state='pending',reason='operation_read_failed_retrying' WHERE kind='operation'",
        h.now + 86_400_000,
      )
      .run();
    result = await reviewSource(h.store, "a", {}, h.now);
    assert.equal(result.sources[0].counts.operationReadFailures, 1);
    assert.equal(
      result.readiness.find((item) => item.kind === "lofi")?.status,
      "attention",
    );
    assert.match(result.sources[0].message, /failed.*retried/);
  } finally {
    await h.mf.dispose();
  }
});

test("current-template predictions explicitly preserve pinned and adopted narrative policies", async () => {
  const h = await setup();
  try {
    await put(h, rawOperation, "operation");
    await put(h, rawQso());
    const key = {
      tenant: "a",
      source: "source",
      qso: "q1",
      destination: "destination",
    };
    await h.store.observe(key, "generation", "source-hash", 30, false, h.now);
    const current = await h.store.saveTemplate("a", "destination", {
      profile: TEMPLATE_PROFILE,
      fields: { COMMENT: "New forward-only text" },
      fallbackNotes: false,
    });
    await h.store
      .statement(
        "UPDATE ledger SET template_version=?,narrative='template_bound' WHERE tenant='a'",
        h.current,
      )
      .run();
    let result = await reviewSource(h.store, "a", {}, h.now);
    assert.equal(result.template.version, current);
    assert.equal(result.recentContacts[0].pinnedTemplateVersion, h.current);
    assert.equal(result.recentContacts[0].templateStatus, "pinned");
    assert.equal(
      result.recentContacts[0].preview?.COMMENT,
      "New forward-only text",
    );
    assert.match(
      result.template.notice,
      /Current saved template preview only.*does not prepare an export.*pinned version.*adopted QRZ narrative/,
    );
    await h.store
      .statement(
        "UPDATE ledger SET template_version=NULL,narrative='remote_preserved',provenance='adopted' WHERE tenant='a'",
      )
      .run();
    const before = await snapshot(h);
    result = await reviewSource(h.store, "a", {}, h.now);
    assert.equal(result.recentContacts[0].templateStatus, "remote_preserved");
    assert.equal(result.recentContacts[0].pinnedTemplateVersion, undefined);
    assert.deepEqual(await snapshot(h), before);
    assert.equal((await h.store.ledger(key))?.template_version, null);
    assert.equal((await h.store.ledger(key))?.narrative, "remote_preserved");
  } finally {
    await h.mf.dispose();
  }
});

test("review selections are tenant scoped, bounded and explicitly read only", async () => {
  const h = await setup();
  try {
    await seed(h.store, "b");
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('b','other-source','lofi','other-source','Other source','active',0)",
      )
      .run();
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('b','other-destination','qrz','other-destination','Other destination','active',0)",
      )
      .run();
    await put(
      h,
      {
        ...rawQso("same-id", null),
        their: { call: "K1ABC" },
        our: { stationCall: "K2XYZ" },
      },
      "qso",
      { tenant: "b" },
    );
    for (let index = 0; index < 22; index++) {
      await put(
        h,
        { ...rawQso(`q${index}`, null), our: { stationCall: "N0CALL" } },
        "qso",
        { syncedAt: h.now + index },
      );
    }
    await saveDefaultTemplate(h.store, "a", {
      id: "pending",
      profile: TEMPLATE_PROFILE,
      fields: { COMMENT: "Saved account default" },
      fallbackNotes: false,
    });
    const response = await reviewSource(h.store, "a", { limit: 20 }, h.now);
    assert.equal(response.recentContacts.length, 20);
    assert(!JSON.stringify(response).includes("K1ABC"));
    assert.equal(response.recentContacts[0].id, "q21");
    assert.equal(
      (
        await reviewSource(
          h.store,
          "a",
          { destination: "account_default" },
          h.now,
        )
      ).template.scope,
      "account_default",
    );
    for (const options of [
      { source: "other-source" },
      { destination: "other-destination" },
      { source: "destination" },
      { destination: "source" },
    ]) {
      await assert.rejects(
        reviewSource(h.store, "a", options, h.now),
        (error) => error instanceof ReviewError && error.status === 404,
      );
    }
    for (const limit of [0, 21, 1.5, Number.NaN]) {
      await assert.rejects(
        reviewSource(h.store, "a", { limit }, h.now),
        (error) => error instanceof ReviewError && error.status === 400,
      );
    }
    const foreign = await reviewRoute(
      new Request("https://example.test/api/review?source=other-source"),
      h.store,
      "a",
    );
    assert.equal(foreign?.status, 404);
    assert.equal(foreign?.headers.get("Cache-Control"), "no-store");
    assert.equal(
      (
        await reviewRoute(
          new Request("https://example.test/api/review", { method: "POST" }),
          h.store,
          "a",
        )
      )?.status,
      405,
    );
    assert.equal(
      await reviewRoute(
        new Request("https://example.test/api/other"),
        h.store,
        "a",
      ),
      null,
    );
    const empty = await reviewSource(h.store, "no-connections", {}, h.now);
    assert.deepEqual(empty.sources, []);
    assert.deepEqual(empty.recentContacts, []);
    assert(empty.readiness.every((item) => item.status === "not_connected"));
  } finally {
    await h.mf.dispose();
  }
});

test("review refuses oversized source bodies and too many operation dependencies without guessing or retaining more data", async () => {
  const h = await setup();
  try {
    await put(h, {
      ...rawQso("large", null),
      notes: "x".repeat(180_000),
      our: { stationCall: "N0CALL" },
    });
    let result = await reviewSource(h.store, "a", {}, h.now);
    assert.equal(result.recentContacts[0].reason, "source_review_size_limit");
    assert.equal(result.recentContacts[0].preview, undefined);
    await put(h, rawOperation, "operation");
    await put(h, rawQso("normal"), "qso", { syncedAt: h.now + 1 });
    for (let index = 0; index < 65; index++) {
      await put(
        h,
        { uuid: `event-${index}`, operation: "op1", band: "event" },
        "qso",
        { missing: true },
      );
    }
    const before = await snapshot(h);
    result = await reviewSource(h.store, "a", {}, h.now);
    const contact = result.recentContacts.find((row) => row.id === "normal");
    assert.equal(contact?.call, "W1AW");
    assert.equal(contact?.preview, undefined);
    assert.equal(contact?.reason, "operation_review_size_limit");
    assert.deepEqual(await snapshot(h), before);
  } finally {
    await h.mf.dispose();
  }
});
