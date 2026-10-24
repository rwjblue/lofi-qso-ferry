import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { getAdminWorkload } from "../src/admin-workload.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

const now = Date.parse("2027-01-01T00:00:00Z");
const hour = 3_600_000;
const day = 24 * hour;

async function setup(beforeMandatoryProofMigration = false) {
  const h = await database();
  try {
    if (beforeMandatoryProofMigration) {
      // Retained artifacts originate on the old schema; assertions run only after
      // the current mandatory-proof migration is applied, without disabling it.
      for (const file of (
        await readdir(new URL("../migrations/", import.meta.url))
      )
        .filter(
          (name) =>
            name.endsWith(".sql") &&
            name !== "0001_foundation.sql" &&
            name < "0030",
        )
        .sort())
        await applyMigration(h.db, file);
    } else await applyAdditionalMigrations(h.db);
    await seed(h.store);
    await h.db
      .prepare(
        "INSERT INTO cursors(tenant,connection,stream,cursor,updated_at) VALUES('a','source','context','{\"complete\":true}',?)",
      )
      .bind(now)
      .run();
    const env = fixtureEnvironment(h.db);
    const addSource = async (
      id: string,
      state = "pending",
      reason: string | null = null,
      priority = "background",
    ) => {
      await h.db.batch([
        h.db
          .prepare(
            "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,state,reason,expires_at,priority) VALUES('a','source',?,'qso',?,'g1',?,?,?,?)",
          )
          .bind(id, id, state, reason, now + day, priority),
        h.db
          .prepare(
            "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at) VALUES('a','source',?,'source','never-decrypt-this-secret',?,?)",
          )
          .bind(id, now - hour, now + day),
      ]);
    };
    const ledger = async (
      id: string,
      state: string,
      dueAt = now - 1,
      reason: string | null = null,
      destination = "destination",
    ) => {
      await h.db
        .prepare(
          "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at,state,reason) VALUES('a','source',?,?,'g1','h1',?,?,?,?)",
        )
        .bind(id, destination, dueAt, now, state, reason)
        .run();
    };
    const attempt = async (
      id: string,
      qso: string,
      state = "submitted",
      destination = "destination",
    ) => {
      await h.db.batch([
        h.db
          .prepare(
            "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a',?,'source',?,?,'g1','outbox','h1','v1',?,'h1')",
          )
          .bind(id, qso, destination, now - day),
        h.db
          .prepare(
            "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,?,?,?)",
          )
          .bind(id, state, now, now),
      ]);
    };
    return { ...h, env, addSource, ledger, attempt };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("workload distinguishes actionable inventory, gate/quiet/in-flight holds and recoverable context from invalid source", async () => {
  const h = await setup(true);
  try {
    await h.addSource("new");
    await h.addSource("inventory", "waiting");
    await h.ledger(
      "inventory",
      "inventory_pending",
      now - 1,
      "Destination readback unavailable; retry automatically",
    );
    await h.addSource("context", "blocked", "operation_context_unavailable");
    await h.addSource("bad", "blocked", "missing_or_ambiguous_station_call");
    await h.addSource("unknown", "blocked", "private-secret-error");
    await h.addSource("send", "waiting");
    await h.ledger("send", "live_new");
    await h.addSource("quiet", "waiting");
    await h.ledger("quiet", "missing_current_identity", now + hour);
    await h.addSource("flight", "waiting");
    await h.ledger("flight", "live_new");
    await h.attempt("flight-a", "flight");
    await h.addSource(
      "routing",
      "waiting",
      "No QRZ route matches station and date",
    );
    await h.addSource("review", "waiting");
    await h.ledger(
      "review",
      "history_ambiguous",
      now - 1,
      "qso_outside_rollout_scope",
    );
    await h.addSource("operation");
    await h.db
      .prepare(
        "UPDATE source_work SET operation_id='missing-op' WHERE id='operation'",
      )
      .run();
    await h.addSource("changed", "waiting");
    await h.ledger("changed", "changed");
    await h.addSource("expired");
    await h.db
      .prepare("UPDATE source_work SET expires_at=? WHERE id='expired'")
      .bind(now)
      .run();
    await applyMigration(h.db, "0030_source_export_guards.sql");
    const closed = await getAdminWorkload(h.env, now);
    assert.deepEqual(
      closed.source.map(({ oldestRetainedAt: _age, ...row }) => row),
      [
        { priority: "live", ready: 0, held: 1, blocked: 0, expired: 0 },
        { priority: "background", ready: 2, held: 7, blocked: 2, expired: 1 },
      ],
    );
    assert.equal(
      closed.heldReasons.find(
        (row) => row.reason === "operation_context_unavailable",
      )?.count,
      2,
    );
    assert.equal(
      closed.heldReasons.find((row) => row.reason === "history_review")?.count,
      1,
    );
    assert.equal(
      closed.heldReasons.find((row) => row.reason === "in_flight")?.count,
      1,
    );
    assert.equal(
      closed.blockedReasons.find(
        (row) => row.reason === "source_projection_requires_review",
      )?.count,
      1,
    );
    assert(!JSON.stringify(closed).includes("secret"));
    Object.assign(h.env, {
      EXPORTS_ENABLED: "true",
      ROLLOUT_CHECKS_PASSED: "true",
      LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
      SOURCE_BOUNDARY_VERIFIED: "true",
      ROLLOUT_QSO_IDS_JSON: '["*"]',
      ROLLOUT_DESTINATION_IDS_JSON: '["*"]',
    });
    const open = await getAdminWorkload(h.env, now);
    assert.equal(open.source[0]?.ready, 1);
    assert.equal(open.source[1]?.ready, 3);
    assert.equal(
      open.heldReasons.find((row) => row.reason === "quiet")?.count,
      1,
    );
    assert(!open.heldReasons.some((row) => row.reason === "exports_disabled"));
    h.env.ROLLOUT_QSO_IDS_JSON = '["new"]';
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["*"]';
    const scoped = await getAdminWorkload(h.env, now);
    assert.equal(
      scoped.heldReasons
        .filter((row) => row.reason === "rollout_scope")
        .reduce((n, row) => n + row.count, 0),
      3,
    );
    h.env.ROLLOUT_QSO_IDS_JSON = '["*"]';
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["another-destination"]';
    const destinationScoped = await getAdminWorkload(h.env, now);
    assert.equal(
      destinationScoped.heldReasons
        .filter((row) => row.reason === "rollout_scope")
        .reduce((n, row) => n + row.count, 0),
      3,
    );
    assert.equal(destinationScoped.source[0]?.ready, 0);
    await h.db
      .prepare(
        "UPDATE cursors SET cursor='{\"complete\":false}' WHERE stream='context'",
      )
      .run();
    assert.equal(
      (await getAdminWorkload(h.env, now)).source.reduce(
        (n, row) => n + row.ready,
        0,
      ),
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("current source verification holds remain distinct from ready work and preserve earlier hold precedence", async () => {
  const h = await setup(true);
  try {
    const proofReasons = [
      "source_export_proof_unavailable",
      "source_export_proof_request_budget",
      "source_export_proof_dependencies_changed",
    ];
    const actionableStates = [
      "missing_current_identity",
      "changed",
      "live_new",
    ];
    for (const [index, reason] of proofReasons.entries()) {
      await h.addSource(reason, "waiting");
      await h.ledger(reason, actionableStates[index]!, now - 1, reason);
    }
    for (const [id, state, reason, dueAt] of [
      ["eligible", "live_new", null, now - 1],
      ["lookalike", "live_new", "sourceXexportXproof_unavailable", now - 1],
      ["inventory", "inventory_pending", proofReasons[0], now - 1],
      ["quiet", "live_new", proofReasons[0], now + hour],
      ["history", "history_mismatch", proofReasons[0], now - 1],
      ["flight", "live_new", proofReasons[0], now - 1],
    ] as const) {
      await h.addSource(id, "waiting");
      await h.ledger(id, state, dueAt, reason);
    }
    await h.attempt("flight-proof", "flight");
    await applyMigration(h.db, "0030_source_export_guards.sql");
    const count = (
      view: Awaited<ReturnType<typeof getAdminWorkload>>,
      reason: string,
    ) =>
      view.heldReasons
        .filter((row) => row.reason === reason)
        .reduce((total, row) => total + row.count, 0);
    const closed = await getAdminWorkload(h.env, now);
    assert.equal(count(closed, "exports_disabled"), 6);
    assert.equal(count(closed, "source_validation"), 0);

    Object.assign(h.env, {
      EXPORTS_ENABLED: "true",
      ROLLOUT_CHECKS_PASSED: "true",
      LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
      SOURCE_BOUNDARY_VERIFIED: "true",
      ROLLOUT_QSO_IDS_JSON: '["*"]',
      ROLLOUT_DESTINATION_IDS_JSON: '["*"]',
    });
    const open = await getAdminWorkload(h.env, now);
    assert.equal(count(open, "source_validation"), proofReasons.length);
    assert.equal(count(open, "delivery_review"), 0);
    assert.equal(count(open, "quiet"), 1);
    assert.equal(count(open, "history_review"), 1);
    assert.equal(count(open, "in_flight"), 1);
    assert.equal(
      open.source.reduce((total, row) => total + row.ready, 0),
      3,
    );
    assert.equal(
      open.source.reduce((total, row) => total + row.blocked, 0),
      0,
    );
    assert.ok(
      open.heldReasons
        .filter((row) => row.reason === "source_validation")
        .every(
          (row) => row.label === "Waiting for current source verification",
        ),
    );
    assert.ok(!JSON.stringify(open).includes("source_export_proof_"));

    h.env.ROLLOUT_QSO_IDS_JSON = '["another-contact"]';
    const qsoScoped = await getAdminWorkload(h.env, now);
    assert.equal(count(qsoScoped, "rollout_scope"), 6);
    assert.equal(count(qsoScoped, "source_validation"), 0);
    h.env.ROLLOUT_QSO_IDS_JSON = '["*"]';
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["another-destination"]';
    const destinationScoped = await getAdminWorkload(h.env, now);
    assert.equal(count(destinationScoped, "rollout_scope"), 6);
    assert.equal(count(destinationScoped, "source_validation"), 0);
  } finally {
    await h.mf.dispose();
  }
});

test("identity review holds remain visible with open gates and after route or retention state changes", async () => {
  const h = await setup();
  try {
    Object.assign(h.env, {
      EXPORTS_ENABLED: "true",
      ROLLOUT_CHECKS_PASSED: "true",
      LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
      SOURCE_BOUNDARY_VERIFIED: "true",
      ROLLOUT_QSO_IDS_JSON: '["*"]',
      ROLLOUT_DESTINATION_IDS_JSON: '["*"]',
    });
    for (const reason of [
      "subsecond_export_requires_identity_claim",
      "remote_identity_claim_conflict",
    ]) {
      await h.addSource(reason, "waiting");
      await h.ledger(reason, "missing_current_identity", now - 1, reason);
    }
    const states = [
      "history_ambiguous",
      "inventory_pending",
      "changed",
      "retained_old_route",
      "adopted_existing",
      "observed",
    ];
    for (const state of states) {
      const id = `conflict-${state}`;
      await h.addSource(id, "waiting");
      await h.ledger(id, state);
      await h.db
        .prepare(
          "UPDATE ledger SET provenance='adoption_conflict',baseline_hash=source_hash WHERE qso=?",
        )
        .bind(id)
        .run();
    }
    const workload = await getAdminWorkload(h.env, now);
    assert.equal(
      workload.source.reduce((sum, row) => sum + row.ready, 0),
      0,
    );
    assert.equal(
      workload.source.reduce((sum, row) => sum + row.held, 0),
      states.length + 2,
    );
    for (const [reason, count] of [
      ["history_review", states.length],
      ["delivery_review", 2],
    ] as const)
      assert.equal(
        workload.heldReasons
          .filter((row) => row.reason === reason)
          .reduce((sum, row) => sum + row.count, 0),
        count,
      );
  } finally {
    await h.mf.dispose();
  }
});

test("new source revisions and additional destinations stay actionable without ignoring credential and routing holds", async () => {
  const h = await setup();
  try {
    await h.addSource("edited", "pending");
    await h.ledger("edited", "delivered");
    await h.db
      .prepare("UPDATE ledger SET baseline_hash=source_hash WHERE qso='edited'")
      .run();
    assert.equal((await getAdminWorkload(h.env, now)).source[1]?.ready, 1);
    await h.db
      .prepare("UPDATE source_work SET state='waiting' WHERE id='edited'")
      .run();
    assert.equal(
      (await getAdminWorkload(h.env, now)).heldReasons[0]?.reason,
      "resolved",
    );
    await h.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','lotw','lotw','lotw','LoTW','active','v1',?)",
      )
      .bind(now)
      .run();
    await (
      await h.store.putPrivate("a", "lotw", "v1", "credential", {
        secret: "not-read",
      })
    ).run();
    // The newly connected destination has not yet been inventoried.
    assert.equal((await getAdminWorkload(h.env, now)).source[1]?.ready, 1);
    await h.db
      .prepare(
        "UPDATE source_work SET reason='No QRZ route matches station and date',processed_at=? WHERE id='edited'",
      )
      .bind(now - 1000)
      .run();
    assert.equal((await getAdminWorkload(h.env, now)).source[1]?.ready, 1);
    await h.addSource(
      "partial",
      "waiting",
      "No QRZ route matches station and date",
    );
    await h.ledger("partial", "inventory_pending", now, null, "lotw");
    assert.equal((await getAdminWorkload(h.env, now)).source[1]?.ready, 2);
    await h.addSource("new");
    await h.db
      .prepare("UPDATE private_data SET revoked_at=? WHERE kind='credential'")
      .bind(now)
      .run();
    const revoked = await getAdminWorkload(h.env, now);
    assert.equal(revoked.source[1]?.ready, 0);
    assert.equal(
      revoked.heldReasons.find(
        (row) => row.reason === "destination_unavailable",
      )?.count,
      3,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("successful destination-contact versions deduplicate terminal events, exclude submissions/adoptions and keep exact window boundaries", async () => {
  const h = await setup(true);
  try {
    await h.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,created_at) VALUES('a','lotw','lotw','lotw','LoTW',0)",
      )
      .run();
    for (const [id, vendor] of [
      ["qrz", "destination"],
      ["lotw", "lotw"],
      ["submitted", "lotw"],
      ["old", "destination"],
      ["adopted", "destination"],
    ] as const) {
      await h.ledger(
        id,
        id === "adopted" ? "adopted_existing" : "live_new",
        now,
        null,
        vendor,
      );
      if (id !== "adopted")
        await h.attempt(
          id,
          id,
          id === "submitted" ? "submitted" : "observed",
          vendor,
        );
    }
    await h.db
      .prepare("UPDATE ledger SET provenance='adopted' WHERE qso='adopted'")
      .run();
    // A real correction of the same QSO is another delivered contact version.
    await h.attempt("correction", "qrz", "delivered");
    for (const [id, state, at] of [
      ["qrz", "delivered", now - hour],
      ["qrz", "observed", now],
      ["qrz", "observed", now],
      ["lotw", "submitted", now - hour],
      ["lotw", "observed", now],
      ["submitted", "submitted", now],
      ["old", "delivered", now - day],
      ["old", "observed", now],
      ["correction", "delivered", now - day + 1],
    ] as const)
      await h.db
        .prepare(
          "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES('a',?,?,?)",
        )
        .bind(id, state, at)
        .run();
    await applyMigration(h.db, "0030_source_export_guards.sql");
    const view = await getAdminWorkload(h.env, now);
    assert.equal(view.deliveries.total, 3);
    assert.equal(view.deliveries.qrz, 2);
    assert.equal(view.deliveries.lotw, 1);
    assert.equal(view.deliveries.submittedOutstanding, 1);
    assert.equal(view.deliveries.adoptedExisting, 1);
    assert.equal(view.deliveries.lastCompletedAt, now);
    assert.equal(view.deliveries.buckets[0]?.total, 1);
    assert.equal(view.deliveries.buckets[22]?.total, 1);
    assert.equal(view.deliveries.buckets[23]?.total, 1);
    assert.equal(
      view.deliveries.buckets.reduce((n, row) => n + row.total, 0),
      3,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("trend keeps missing and legacy samples unknown and reports stale partial coverage", async () => {
  const h = await setup();
  try {
    await h.db
      .prepare(
        "INSERT INTO scheduler_runs(id,started_at,finished_at,status,source_live,source_background) VALUES('legacy',?,?,'completed',0,100)",
      )
      .bind(now - 3 * hour, now - 3 * hour)
      .run();
    for (const [id, at, ready, held] of [
      ["first", now - 2 * hour, 100, 500],
      ["second", now - 2 * hour + 300_000, 70, 500],
    ] as const) {
      await h.db
        .prepare(
          "INSERT INTO scheduler_runs(id,started_at,finished_at,status,work_live_ready,work_live_held,work_live_blocked,work_background_ready,work_background_held,work_background_blocked) VALUES(?,?,?,'completed',0,0,0,?,?,1)",
        )
        .bind(id, at, at, ready, held)
        .run();
    }
    const view = await getAdminWorkload(h.env, now);
    assert.equal(view.trend.sampleCount, 2);
    assert.equal(view.trend.expectedSamples, 288);
    assert.equal(view.trend.firstAt, now - 2 * hour);
    assert.equal(view.trend.lastAt, now - 2 * hour + 300_000);
    assert.equal(view.trend.stale, true);
    assert.equal(view.trend.maxGapMs, 22 * hour);
    assert.equal(view.trend.points.length, 24);
    assert.equal(
      view.trend.points.filter((point) => point.background !== null).length,
      2,
    );
    assert(
      view.trend.points
        .filter((point) => point.at <= now - 3 * hour)
        .every((point) => point.background === null),
    );
    assert.equal(view.trend.points.at(-1)?.background, null);
  } finally {
    await h.mf.dispose();
  }
});
