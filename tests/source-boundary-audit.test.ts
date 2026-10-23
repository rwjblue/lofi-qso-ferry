import assert from "node:assert/strict";
import test from "node:test";
import {
  sourceBoundaryAuditQuery,
  sourceBoundaryAuditReport,
} from "../scripts/source-boundary-audit.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const now = 1000;
async function setup() {
  const h = await database();
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await h.db.batch([
    h.db
      .prepare(
        "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','sync',?,7,100)",
      )
      .bind(
        JSON.stringify({
          mode: "forward",
          operations: { cursor: "private-cursor" },
          qsos: {},
        }),
      ),
    h.db
      .prepare(
        "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','context',?,9,100)",
      )
      .bind(JSON.stringify({ complete: true, syncComplete: true })),
  ]);
  async function row(
    id: string,
    options: {
      kind?: "operation" | "qso";
      operation?: string | null;
      state?: string;
      event?: boolean;
      deleted?: boolean;
      body?: boolean;
      expires?: number;
      payloadExpires?: number;
      revoked?: boolean;
      birth?: boolean;
      generation?: number;
      phase?: "history" | "forward_new";
    } = {},
  ) {
    const kind = options.kind ?? "qso";
    const payload = `private-${id}`;
    if (options.body !== false)
      await h.db
        .prepare(
          "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at,revoked_at) VALUES('a','source',?,'source','never-read-private-payload',0,?,?)",
        )
        .bind(
          payload,
          options.payloadExpires ?? 2000,
          options.revoked ? now : null,
        )
        .run();
    await h.db
      .prepare(
        "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at,synced_at,is_event,deleted) VALUES('a','source',?,?,?,?,?,?,?,100,?,?)",
      )
      .bind(
        id,
        kind,
        options.operation ?? (kind === "operation" ? id : null),
        payload,
        "private-revision",
        options.state ?? (kind === "operation" ? "context" : "waiting"),
        options.expires ?? 2000,
        Number(options.event ?? false),
        Number(options.deleted ?? false),
      )
      .run();
    if (kind === "qso" && options.birth !== false)
      await h.db
        .prepare(
          "INSERT INTO source_births(tenant,source,qso,phase,first_seen_at,first_cursor_generation,first_stream) VALUES('a','source',?,?,100,?,'sync')",
        )
        .bind(id, options.phase ?? "history", options.generation ?? 1)
        .run();
  }
  async function audit(tenant = "a", source = "source") {
    const query = sourceBoundaryAuditQuery(tenant, source, now);
    return sourceBoundaryAuditReport(
      await h.db
        .prepare(query.sql)
        .bind(...query.params)
        .first(),
    );
  }
  return { ...h, row, audit };
}

test("complete local metadata never verifies the boundary and deleted operations are not pending rereads", async () => {
  const h = await setup();
  try {
    await h.row("operation", { kind: "operation" });
    await h.row("contact", { operation: "operation" });
    await h.row("later-deleted", {
      deleted: true,
      body: false,
      phase: "forward_new",
    });
    await h.row("deleted-event", {
      operation: "operation",
      event: true,
      deleted: true,
      body: false,
    });
    await h.db
      .prepare(
        "WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<41) INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at,deleted) SELECT 'a','source','deleted-op-'||x,'operation','deleted-op-'||x,'missing','r','pending',2000,1 FROM n",
      )
      .run();
    const before = await h.db
      .prepare(
        "SELECT stream,cursor,generation,updated_at FROM cursors ORDER BY stream",
      )
      .all();
    const result = await h.audit();
    assert.equal(result.sourceBoundaryVerified, false);
    assert.equal(result.evidence, "local-metadata-only");
    const c = result.counts;
    assert.equal(c.source_active, 1);
    assert.equal(c.credential_available, 1);
    assert.equal(c.sync_forward, 1);
    assert.equal(c.context_complete, 1);
    assert.equal(c.context_sync_complete, 1);
    assert.equal(c.operation_cursor_present, 1);
    assert.equal(c.qso_cursor_present, 0);
    assert.equal(c.operation_rows, 42);
    assert.equal(c.deleted_operations, 41);
    assert.equal(c.context_operations, 1);
    assert.equal(c.pending_nondeleted_operations, 0);
    assert.equal(c.reread_eligible_metadata_operations, 0);
    assert.equal(
      c.forward_new_births,
      1,
      "a previously new contact can later be deleted",
    );
    assert.equal(c.missing_qso_births, 0);
    assert.equal(c.invalid_sync_birth_generations, 0);
    assert.equal(c.nondeleted_missing_payloads, 0);
    assert.equal(c.unavailable_contact_dependencies, 0);
    assert.equal(c.cutovers, 0);
    assert.equal(c.destinations_requiring_rescan, 0);
    assert.deepEqual(
      (
        await h.db
          .prepare(
            "SELECT stream,cursor,generation,updated_at FROM cursors ORDER BY stream",
          )
          .all()
      ).results,
      before.results,
    );
    const output = JSON.stringify(result);
    for (const privateValue of [
      "private-cursor",
      "private-revision",
      "never-read-private-payload",
      "later-deleted",
      "deleted-op-",
    ])
      assert.equal(output.includes(privateValue), false);
  } finally {
    await h.mf.dispose();
  }
});

test("payload and operation/event dependency gaps remain visible despite complete sync flags", async () => {
  const h = await setup();
  try {
    await h.row("base", { kind: "operation" });
    await h.row("affected", { operation: "base" });
    await h.row("expired-event", {
      operation: "base",
      event: true,
      payloadExpires: now,
    });
    await h.row("revoked-event", {
      operation: "base",
      event: true,
      revoked: true,
    });
    await h.row("missing-event", {
      operation: "base",
      event: true,
      body: false,
    });
    await h.row("missing-base-contact", { operation: "missing-base" });
    await h.row("pending-base", { kind: "operation", state: "pending" });
    await h.row("pending-base-contact", { operation: "pending-base" });
    await h.row("expired-base", {
      kind: "operation",
      state: "pending",
      expires: now,
    });
    await h.row("general", { revoked: true });
    await h.row("test-contact", {
      state: "test",
      body: false,
      operation: "missing-base",
    });
    const c = (await h.audit()).counts;
    assert.equal(c.context_complete, 1);
    assert.equal(c.pending_nondeleted_operations, 2);
    assert.equal(c.reread_eligible_metadata_operations, 1);
    assert.equal(c.nondeleted_missing_payloads, 2);
    assert.equal(c.nondeleted_revoked_payloads, 2);
    assert.equal(c.nondeleted_expired_payloads, 2);
    assert.equal(
      c.unavailable_contact_payloads,
      1,
      "known tests do not demand payload repair",
    );
    assert.equal(c.unavailable_contact_dependencies, 3);
    assert.equal(c.general_log_contacts, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("audit isolates tenant/source scope and reports unresolved scans, births and retained gaps", async () => {
  const h = await setup();
  try {
    await seed(h.store, "other-tenant");
    await h.db
      .prepare(
        "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,state,expires_at) VALUES('other-tenant','source','foreign-qso','qso','missing','foreign-private','pending',0)",
      )
      .run();
    await h.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','second-source','lofi','second-private','secret','active',0),('a','new-destination','lotw','new-private','secret','active',200)",
      )
      .run();
    await h.db
      .prepare(
        "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,state,expires_at) VALUES('a','second-source','foreign-source-qso','qso','missing','foreign-private','pending',0)",
      )
      .run();
    await h.row("missing-birth", { birth: false });
    await h.row("future-birth", { generation: 8 });
    await h.db.batch([
      h.db
        .prepare(
          "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','rescan:new-destination',?,1,200)",
        )
        .bind(JSON.stringify({ mode: "backfill", rescanComplete: false })),
      h.db
        .prepare(
          "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','gap:private-gap',?,1,200)",
        )
        .bind(JSON.stringify({ previous: { cursor: "private-old-cursor" } })),
    ]);
    const c = (await h.audit()).counts;
    assert.equal(c.contact_rows, 2);
    assert.equal(c.nondeleted_missing_payloads, 0);
    assert.equal(c.missing_qso_births, 1);
    assert.equal(c.invalid_sync_birth_generations, 1);
    assert.equal(c.active_destinations, 2);
    assert.equal(c.destinations_requiring_rescan, 1);
    assert.equal(c.rescan_streams, 1);
    assert.equal(c.completed_rescan_streams, 0);
    assert.equal(c.retained_gap_markers, 1);
    await h.db
      .prepare(
        "UPDATE cursors SET cursor=json_set(cursor,'$.rescanComplete',1) WHERE tenant='a' AND connection='source' AND stream='rescan:new-destination'",
      )
      .run();
    assert.equal((await h.audit()).counts.destinations_requiring_rescan, 0);
    const absent = await h.audit("missing-tenant");
    assert.equal(absent.counts.source_present, 0);
    assert.equal(absent.counts.contact_rows, 0);
    assert.equal(absent.sourceBoundaryVerified, false);
    await h.db
      .prepare(
        "UPDATE private_data SET revoked_at=? WHERE tenant='a' AND connection='source' AND kind='credential'",
      )
      .bind(now)
      .run();
    assert.equal((await h.audit()).counts.credential_available, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("report accepts only fixed numeric aggregates and never promotes its proof flag", async () => {
  const h = await setup();
  try {
    const result = await h.audit();
    const hostile = {
      ...result.counts,
      raw: "private-payload",
      sourceBoundaryVerified: true,
    };
    assert.deepEqual(sourceBoundaryAuditReport(hostile), result);
    for (const value of [
      null,
      [],
      { ...hostile, contact_rows: "private-payload" },
      { ...hostile, contact_rows: -1 },
      { ...hostile, contact_rows: Number.MAX_SAFE_INTEGER + 1 },
    ])
      assert.throws(
        () => sourceBoundaryAuditReport(value),
        /^Error: Invalid source audit result$/,
      );
    assert.throws(
      () => sourceBoundaryAuditQuery("", "source", now),
      /Invalid source audit scope/,
    );
    assert.throws(
      () => sourceBoundaryAuditQuery("a", "source", -1),
      /Invalid source audit scope/,
    );
    const scoped = sourceBoundaryAuditQuery("a' OR 1=1", "source", now);
    assert.equal(scoped.sql.includes("a' OR 1=1"), false);
    assert.deepEqual(scoped.params, ["a' OR 1=1", "source", now]);
  } finally {
    await h.mf.dispose();
  }
});
