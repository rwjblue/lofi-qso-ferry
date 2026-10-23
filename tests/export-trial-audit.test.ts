import assert from "node:assert/strict";
import test from "node:test";
import {
  type ExportTrialAuditScope,
  exportTrialAuditQuery,
  exportTrialAuditReport,
} from "../scripts/export-trial-audit.ts";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const now = 1000;
const record = {
  STATION_CALLSIGN: "W1AW",
  CALL: "K1ABC",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "FT8",
  MY_GRIDSQUARE: "FN31AA12",
};
async function setup() {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    await seed(h.store);
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','lotw','lotw','private-book','LoTW','active','v1',0)",
      )
      .run();
    await (
      await h.store.putPrivate("a", "lotw", "v1", "credential", {
        secret: "never-output-credential",
      })
    ).run();
    for (const [id, kind, event] of [
      ["private-operation", "operation", 0],
      ["private-contact", "qso", 0],
      ["private-event", "qso", 1],
    ] as const) {
      await h.store
        .statement(
          "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at) VALUES('a','source',?,'source','never-read-private-payload',0,2000)",
          id,
        )
        .run();
      await h.store
        .statement(
          "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at,is_event) VALUES('a','source',?,?,'private-operation',?,'private-revision',?,2000,?)",
          id,
          kind,
          id,
          kind === "operation" ? "context" : "waiting",
          event,
        )
        .run();
    }
    await h.store
      .statement(
        "INSERT INTO source_births(tenant,source,qso,phase,first_seen_at,first_cursor_generation,first_stream) VALUES('a','source','private-contact','forward_new',100,1,'sync')",
      )
      .run();
    await h.store
      .statement(
        "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','sync','{\"mode\":\"forward\",\"private\":\"private-token\"}',7,100),('a','source','context','{\"complete\":true,\"syncComplete\":true}',9,100)",
      )
      .run();
    for (const destination of ["destination", "lotw"]) {
      await h.store.observe(
        { tenant: "a", source: "source", qso: "private-contact", destination },
        "private-generation",
        "private-source-hash",
        30,
        false,
        100,
      );
      await h.store
        .statement(
          "UPDATE ledger SET context_generation=9,operation_id='private-operation',state='missing_current_identity',due_at=900 WHERE destination=?",
          destination,
        )
        .run();
    }
    const version = await h.store
      .statement(
        "SELECT version FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso='private-contact'",
      )
      .first<{ version: number }>();
    assert(version);
    const scope: ExportTrialAuditScope = {
      tenant: "a",
      source: "source",
      qso: "private-contact",
      generation: "private-generation",
      sourceRevision: "private-revision",
      reconciliationVersion: version.version,
      contextGeneration: 9,
      now,
      routes: [
        {
          destination: "destination",
          credentialVersion: "v1",
          identity: await destinationIdentityClaim("qrz", record),
        },
        {
          destination: "lotw",
          credentialVersion: "v1",
          identity: await destinationIdentityClaim("lotw", record),
        },
      ],
    };
    const raw = async (value = scope) => {
      const query = await exportTrialAuditQuery(value);
      return (await h.store.statement(query.sql, ...query.params).all())
        .results;
    };
    const audit = async (value = scope) =>
      exportTrialAuditReport(
        await raw(value),
        value.routes.map((route) => route.identity.vendor),
      );
    return { ...h, scope, raw, audit };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("exact trial metadata remains read-only and never authorizes writes or prints private scope", async () => {
  const h = await setup();
  try {
    const before = await h.store
      .statement(
        "SELECT (SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM destination_identity_claims) claims,(SELECT group_concat(stream||':'||generation||':'||updated_at) FROM cursors) cursors,(SELECT group_concat(qso||':'||version||':'||selected_at) FROM reconciliation_work) queue",
      )
      .first();
    const result = await h.audit();
    assert.deepEqual(
      result.routes.map((route) => route.metadataChecksPass),
      [true, true],
    );
    assert.equal(result.writesAuthorized, false);
    assert.equal(result.sourceBoundaryVerified, false);
    assert.equal(result.freshVendorChecksComplete, false);
    assert.deepEqual(
      await h.store
        .statement(
          "SELECT (SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM destination_identity_claims) claims,(SELECT group_concat(stream||':'||generation||':'||updated_at) FROM cursors) cursors,(SELECT group_concat(qso||':'||version||':'||selected_at) FROM reconciliation_work) queue",
        )
        .first(),
      before,
    );
    const output = JSON.stringify(result);
    for (const value of [
      "private-contact",
      "private-generation",
      "private-revision",
      "private-source-hash",
      "private-token",
      "never-read-private-payload",
      "never-output-credential",
      h.scope.routes[0].identity.hash,
    ])
      assert.equal(output.includes(value), false);
    const omitted = await h.audit({
      ...h.scope,
      routes: h.scope.routes.slice(0, 1),
    });
    assert.equal(omitted.routes[0].counts.other_active_ledger_routes, 1);
    assert.equal(omitted.routes[0].metadataChecksPass, false);
  } finally {
    await h.mf.dispose();
  }
});

test("stale source, ledger and context generations fail independently with closed proof flags", async () => {
  const h = await setup();
  try {
    for (const [change, metric] of [
      [{ sourceRevision: "different" }, "source_revision_current"],
      [{ generation: "different" }, "ledger_current"],
      [{ contextGeneration: 10 }, "context_current"],
      [
        { reconciliationVersion: h.scope.reconciliationVersion + 1 },
        "source_version_current",
      ],
    ] as const) {
      const report = await h.audit({ ...h.scope, ...change });
      assert.equal(report.routes[0].counts[metric], 0);
      assert.equal(report.routes[0].metadataChecksPass, false);
    }
    await h.store
      .statement(
        "UPDATE ledger SET operation_id='different-operation' WHERE destination='destination'",
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.ledger_current, 0);
    await h.store
      .statement(
        "UPDATE ledger SET operation_id='private-operation' WHERE destination='destination'",
      )
      .run();
    await h.store
      .statement(
        "UPDATE source_work SET revision='new-revision' WHERE id='private-contact'",
      )
      .run();
    const changed = await h.audit();
    assert.equal(changed.routes[0].counts.source_revision_current, 0);
    assert.equal(changed.routes[0].counts.source_version_current, 0);
    await h.store
      .statement(
        "UPDATE cursors SET cursor='{\"complete\":false,\"syncComplete\":true}' WHERE stream='context'",
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.context_current, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("missing, revoked and expired dependencies and credentials cannot pass metadata checks", async () => {
  const h = await setup();
  try {
    await h.store
      .statement(
        "UPDATE private_data SET revoked_at=? WHERE id='private-event'",
        now,
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.dependencies_available, 0);
    await h.store
      .statement(
        "UPDATE private_data SET revoked_at=NULL WHERE id='private-event'",
      )
      .run();
    await h.store
      .statement(
        "UPDATE source_work SET expires_at=? WHERE id='private-operation'",
        now,
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.dependencies_available, 0);
    await h.store
      .statement(
        "UPDATE source_work SET expires_at=2000 WHERE id='private-operation'",
      )
      .run();
    await h.store
      .statement("DELETE FROM private_data WHERE id='private-event'")
      .run();
    assert.equal((await h.audit()).routes[0].counts.dependencies_available, 0);
    await h.store
      .statement(
        "UPDATE private_data SET expires_at=? WHERE id='private-contact'",
        now,
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.source_body_available, 0);
    await h.store
      .statement(
        "UPDATE private_data SET revoked_at=? WHERE connection='source' AND kind='credential'",
        now,
      )
      .run();
    assert.equal(
      (await h.audit()).routes[0].counts.source_credential_available,
      0,
    );
    await h.store
      .statement(
        "UPDATE connections SET credential_version='changed' WHERE id='destination'",
      )
      .run();
    assert.equal(
      (await h.audit()).routes[0].counts.destination_credential_current,
      0,
    );
    const absent = await h.audit({ ...h.scope, qso: "missing" });
    assert.equal(absent.routes[0].counts.ledger_present, 0);
    assert.equal(absent.routes[0].metadataChecksPass, false);
  } finally {
    await h.mf.dispose();
  }
});

test("identity ownership and unresolved attempts stay scoped to the exact tenant, destination and source UUID", async () => {
  const h = await setup();
  try {
    await seed(h.store, "foreign");
    await h.store.observe(
      {
        tenant: "foreign",
        source: "source",
        qso: "foreign-qso",
        destination: "destination",
      },
      "g",
      "h",
      30,
      false,
      0,
    );
    const hash = h.scope.routes[0].identity.hash;
    await h.store
      .statement(
        "INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES('foreign','destination','qrz',?,'source','foreign-qso',0)",
        hash,
      )
      .run();
    await h.store.observe(
      {
        tenant: "a",
        source: "source",
        qso: "other-owner",
        destination: "lotw",
      },
      "g",
      "h",
      30,
      false,
      0,
    );
    await h.store
      .statement(
        "INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES('a','lotw','lotw',?,'source','other-owner',0)",
        hash,
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.competing_claims, 0);
    await h.store.observe(
      {
        tenant: "a",
        source: "source",
        qso: "other-owner",
        destination: "destination",
      },
      "g",
      "h",
      30,
      false,
      0,
    );
    await h.store
      .statement(
        "INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES('a','destination','qrz',?,'source','other-owner',0)",
        hash,
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.competing_claims, 1);
    assert.equal((await h.audit()).routes[1].counts.competing_claims, 0);
    await h.store
      .statement(
        "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','attempt','source','private-contact','destination','private-generation','missing','h','v1',0,'h')",
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.attempt_states_missing, 1);
    await h.store
      .statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','attempt','unknown-state',0,0)",
      )
      .run();
    assert.equal((await h.audit()).routes[0].counts.unresolved_attempts, 1);
    await h.store.statement("UPDATE attempt_state SET state='cancelled'").run();
    assert.equal((await h.audit()).routes[0].counts.unresolved_attempts, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("legacy holds and adopted history stay ineligible for a first insert", async () => {
  const h = await setup();
  try {
    await h.store
      .statement(
        "UPDATE ledger SET remote_id='91',state='adopted_existing',provenance='adoption_conflict' WHERE destination='destination'",
      )
      .run();
    const report = await h.audit();
    const counts = report.routes[0].counts;
    assert.equal(counts.first_insert_candidate, 0);
    assert.equal(counts.adoption_conflict, 1);
    assert.equal(counts.existing_mapping, 1);
    assert.equal(counts.legacy_qrz_reservations, 1);
    assert.equal(report.routes[0].metadataChecksPass, false);
    await h.store
      .statement("UPDATE ledger SET due_at=2000 WHERE destination='lotw'")
      .run();
    assert.equal((await h.audit()).routes[1].counts.quiet_period_complete, 0);
    await h.store
      .statement(
        "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) VALUES('a','lotw',?,'lotw_identity','never-read',0)",
        `identity:other:${h.scope.routes[1].identity.hash}`,
      )
      .run();
    assert.equal((await h.audit()).routes[1].counts.legacy_lotw_claims, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("scope and report validation fail closed without reflecting arbitrary returned values", async () => {
  const h = await setup();
  try {
    for (const change of [
      { tenant: "" },
      { now: -1 },
      { routes: [] },
      { routes: [h.scope.routes[0], h.scope.routes[0]] },
      {
        routes: [
          {
            ...h.scope.routes[0],
            identity: { vendor: "qrz", hash: "private-invalid" },
          },
        ],
      },
    ])
      await assert.rejects(
        exportTrialAuditQuery({
          ...h.scope,
          ...change,
        } as ExportTrialAuditScope),
        /^Error: Invalid export trial audit scope$/,
      );
    const query = await exportTrialAuditQuery({
      ...h.scope,
      tenant: "' OR 1=1",
    });
    assert.equal(query.sql.includes("' OR 1=1"), false);
    assert.equal(query.params[0], "' OR 1=1");
    const rows = await h.raw();
    const report = await h.audit();
    assert.deepEqual(
      exportTrialAuditReport(
        rows.map((row) => ({
          ...row,
          secret: "never-output",
          writesAuthorized: true,
        })),
        ["qrz", "lotw"],
      ),
      report,
    );
    for (const invalid of [
      [],
      [rows[0]],
      [{ ...rows[0], vendor: "private-value" }, rows[1]],
      [{ ...rows[0], source_active: 2 }, rows[1]],
      [{ ...rows[0], competing_claims: -1 }, rows[1]],
      [{ ...rows[0], source_active: "secret" }, rows[1]],
    ])
      assert.throws(
        () => exportTrialAuditReport(invalid, ["qrz", "lotw"]),
        /^Error: Invalid export trial audit result$/,
      );
  } finally {
    await h.mf.dispose();
  }
});
