import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { getAdminOverview, sampleAdminBacklog } from "../src/admin-metrics.ts";
import { runScheduledTick } from "../src/scheduler-history.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

const now = Date.parse("2027-01-01T00:00:00Z");
const day = 86_400_000;

async function setup(beforeMandatoryProofMigration = false) {
  const h = await database();
  try {
    if (beforeMandatoryProofMigration) {
      // Historical attempts are seeded on their original schema, then upgraded
      // before the behavior under test. No current guard is removed or bypassed.
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
    return { ...h, env: fixtureEnvironment(h.db) };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("empty overview reports unknown scheduler health and all gates independently", async () => {
  const h = await setup();
  try {
    const view = await getAdminOverview(h.env, now);
    assert.equal(view.scheduler.stale, true);
    assert.equal(view.scheduler.lastCompletedAt, null);
    assert.equal(view.scheduler.totals24h.runs, 0);
    assert.deepEqual(view.backlog.deliveryCandidates, {
      due: 0,
      quiet: 0,
      oldestDueAt: null,
    });
    assert(view.backlog.source.every((row) => row.pending === 0));
    assert.deepEqual(view.gates, {
      exportsEnabled: false,
      rolloutChecksPassed: false,
      liveWriteAuthorized: false,
      sourceBoundaryVerified: false,
      qrzFreshInsertsEnabled: false,
      exportMode: null,
      rolloutScopeConfigured: false,
      rolloutScope: "none",
      destinationScopeConfigured: false,
      destinationScope: "none",
      effective: false,
      configurationValid: true,
    });
    h.env.EXPORTS_ENABLED = "true";
    h.env.ROLLOUT_CHECKS_PASSED = "true";
    h.env.LIVE_WRITE_AUTHORIZATION = "I_AUTHORIZE_LIVE_VENDOR_WRITES";
    h.env.SOURCE_BOUNDARY_VERIFIED = "true";
    h.env.ROLLOUT_QSO_IDS_JSON = '["private-qso-id"]';
    const noDestination = await getAdminOverview(h.env, now);
    assert.equal(noDestination.gates.effective, false);
    assert.equal(noDestination.gates.destinationScope, "none");
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["private-destination-id"]';
    const enabled = await getAdminOverview(h.env, now);
    assert.equal(enabled.gates.effective, true);
    assert.equal(enabled.gates.rolloutScope, "limited");
    assert.equal(enabled.gates.destinationScope, "limited");
    assert(!JSON.stringify(enabled).includes("private-destination-id"));
    assert(!JSON.stringify(enabled).includes("private-qso-id"));
    assert(!JSON.stringify(enabled).includes("I_AUTHORIZE_LIVE_VENDOR_WRITES"));
    h.env.SOURCE_BOUNDARY_VERIFIED = "false";
    h.env.QRZ_FRESH_INSERTS_ENABLED = "true";
    const firstInserts = await getAdminOverview(h.env, now);
    assert.equal(firstInserts.gates.effective, true);
    assert.equal(firstInserts.gates.exportMode, "qrz_fresh_insert");
    assert.equal(firstInserts.gates.sourceBoundaryVerified, false);
    h.env.ROLLOUT_QSO_IDS_JSON = "broken-json-secret";
    const invalid = await getAdminOverview(h.env, now);
    assert.equal(invalid.gates.configurationValid, false);
    assert.equal(invalid.gates.effective, false);
  } finally {
    await h.mf.dispose();
  }
});

test("admin connection labels use confirmed LoFi metadata independently of the Ferry account email", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  await seed(h.store);
  for (const [label, status, accountEmail, expected] of [
    ["iPad", "active", null, "Email unavailable"],
    ["old-device@example.test", "revoked", null, "Email unavailable"],
    [
      "old-device@example.test",
      "active",
      "confirmed-lofi@example.test",
      "confirmed-lofi@example.test",
    ],
    [
      "LoFi approval pending",
      "approval_pending",
      null,
      "LoFi approval pending",
    ],
  ]) {
    await h.store
      .statement(
        "UPDATE connections SET label=?,status=?,config=json_object('accountEmail',?) WHERE tenant='a' AND id='source'",
        label,
        status,
        accountEmail,
      )
      .run();
    const overview = await getAdminOverview(h.env, now);
    const source = overview.connections.items.find(
      (item) => item.id === "source",
    );
    assert.equal(source?.label, expected);
    assert.equal(source?.accountEmail, "a@example.test");
    assert.doesNotMatch(
      JSON.stringify(overview),
      /iPad|old-device@example|lofiAccountEmail/,
    );
    assert.equal(
      overview.connections.items.find((item) => item.kind === "qrz")?.label,
      "destination",
    );
  }
});

test("backlog separates retained contacts, quiet candidates, unresolved attempts and attention", async () => {
  const h = await setup(true);
  try {
    await seed(h.store);
    await seed(h.store, "paused");
    await h.store
      .statement(
        "UPDATE connections SET status='disabled' WHERE tenant='paused'",
      )
      .run();
    const source = async (
      id: string,
      priority: string,
      state: string,
      expires: number,
      tenant = "a",
      event = 0,
      deleted = 0,
    ) => {
      await h.db.batch([
        h.db
          .prepare(
            "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,state,expires_at,priority,synced_at,is_event,deleted,reason) VALUES(?,'source',?,'qso',?,'g1',?,?,?,1,?,?,'source-secret-reason')",
          )
          .bind(tenant, id, id, state, expires, priority, event, deleted),
        h.db
          .prepare(
            "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at) VALUES(?,'source',?,'source','private-payload-secret',?,?)",
          )
          .bind(tenant, id, now - 90_000, expires),
      ]);
    };
    await source("live-pending", "live", "pending", now + day * 2);
    await source("live-waiting", "live", "waiting", now + 300_000);
    await source("live-blocked", "live", "blocked", now + day * 2);
    await source("live-expired", "live", "expired", now - 1);
    await source("history", "background", "pending", now + day * 2);
    await source("context-event", "live", "pending", now + day, "a", 1);
    await source("tombstone", "live", "pending", now + day, "a", 0, 1);
    await source("archived", "live", "archived", 0);
    await source("disabled", "live", "pending", now + day, "paused");
    const attempt = async (
      id: string,
      priority: string,
      state: string,
      due: number,
    ) => {
      await h.store.observe(
        { tenant: "a", source: "source", qso: id, destination: "destination" },
        "g1",
        "hash",
        30,
        false,
        now - day,
      );
      await h.db.batch([
        h.db
          .prepare(
            "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a',?,'source',?,'destination','g1',?,'h1','v1',?,'h1')",
          )
          .bind(id, id, id, now - 3_600_000),
        h.db
          .prepare(
            "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at,priority,reason) VALUES('a',?,?,?, ?,?,'vendor-secret-error')",
          )
          .bind(id, state, due, now, priority),
      ]);
    };
    await attempt("prepared", "live", "prepared", now - 1000);
    await attempt("submitted", "background", "submitted", now + 1000);
    await attempt("uncertain", "background", "uncertain", now - 2000);
    await attempt("expired-outbox", "live", "reconciliation_required", 0);
    await attempt("rejected", "live", "rejected", 0);
    await attempt("delivered", "live", "delivered", 0);
    await h.store
      .statement(
        "UPDATE ledger SET state='changed',due_at=? WHERE qso='prepared'",
        now - 1000,
      )
      .run();
    await h.store
      .statement(
        "UPDATE ledger SET state='live_new',due_at=? WHERE qso='submitted'",
        now + 1000,
      )
      .run();
    await h.store
      .statement(
        "UPDATE ledger SET state='history_ambiguous' WHERE qso='uncertain'",
      )
      .run();

    for (const file of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((name) => name.endsWith(".sql") && name >= "0030")
      .sort())
      await applyMigration(h.db, file);
    const view = await getAdminOverview(h.env, now);
    assert.deepEqual(view.backlog.source, [
      {
        priority: "live",
        pending: 2,
        blocked: 1,
        expired: 1,
        expiring24h: 1,
        oldestRetainedAt: now - 90_000,
      },
      {
        priority: "background",
        pending: 1,
        blocked: 0,
        expired: 0,
        expiring24h: 0,
        oldestRetainedAt: now - 90_000,
      },
    ]);
    assert.equal(
      view.backlog.attempts.reduce((total, row) => total + row.count, 0),
      4,
    );
    assert.equal(
      view.backlog.attempts.reduce((total, row) => total + row.due, 0),
      2,
    );
    assert.equal(
      view.backlog.attempts.find((row) => row.state === "prepared")
        ?.oldestCreatedAt,
      now - 3_600_000,
    );
    assert.equal(
      view.backlog.attempts.find((row) => row.state === "uncertain")
        ?.oldestDueAt,
      now - 2000,
    );
    assert.deepEqual(view.backlog.deliveryCandidates, {
      due: 1,
      quiet: 1,
      oldestDueAt: now - 1000,
    });
    assert(
      view.attention.some(
        (row) =>
          row.area === "attempt" && row.state === "rejected" && row.count === 1,
      ),
    );
    assert(
      view.attention.some(
        (row) =>
          row.area === "history" &&
          row.state === "history_ambiguous" &&
          row.count === 1,
      ),
    );
    assert(!JSON.stringify(view).includes("secret"));
    assert.deepEqual(await sampleAdminBacklog(h.db, now), {
      sourceLive: 2,
      sourceBackground: 1,
      attemptsDueLive: 1,
      attemptsDueBackground: 1,
      workLive: null,
      workBackground: null,
    });
  } finally {
    await h.mf.dispose();
  }
});

test("freshness uses successful polling evidence and vendor windows preserve cooldowns", async () => {
  const h = await setup();
  try {
    await seed(h.store);
    await h.store
      .statement(
        "UPDATE connections SET last_poll_at=?,remote_identity='private-account-uuid',config=? WHERE id='source'",
        now,
        JSON.stringify({
          lastSuccessfulPollAt: now - day,
          lastSyncFailureAt: now,
          lastError: "credential-bearing-secret-url",
          credential: "private-secret",
        }),
      )
      .run();
    await h.store
      .statement(
        "INSERT INTO cursors(tenant,connection,stream,cursor,updated_at) VALUES('a','source','sync','{\"mode\":\"forward\",\"private\":\"source-cursor-secret\"}',?)",
        now,
      )
      .run();
    await h.store
      .statement(
        "INSERT INTO cursors(tenant,connection,stream,cursor,updated_at) VALUES('a','source','context','{\"complete\":true}',?)",
        now,
      )
      .run();
    await h.db.batch([
      h.db
        .prepare("INSERT INTO vendor_requests VALUES('lofi',?,24,4,?)")
        .bind(now - 300_000, now + 600_000),
      h.db
        .prepare("INSERT INTO vendor_requests VALUES('qrz',?,5,2,0)")
        .bind(now),
    ]);
    const view = await getAdminOverview(h.env, now);
    const source = view.connections.items.find((row) => row.kind === "lofi");
    assert.equal(source?.lastAttemptAt, now);
    assert.equal(source?.lastSuccessAt, now - day);
    assert.equal(source?.lastFailureAt, now);
    assert.equal(source?.hasError, true);
    assert.equal(source?.contextComplete, true);
    assert.equal(source?.syncMode, "forward");
    assert(!JSON.stringify(view).includes("secret"));
    assert(!JSON.stringify(view).includes("private-account-uuid"));
    assert.deepEqual(
      view.vendors.find((row) => row.vendor === "lofi"),
      {
        vendor: "lofi",
        requests: 0,
        backgroundRequests: 0,
        totalLimit: 24,
        backgroundLimit: 4,
        windowEndsAt: now + 300_000,
        cooldownUntil: now + 600_000,
      },
    );
    assert.equal(view.vendors.find((row) => row.vendor === "qrz")?.requests, 5);
    assert.equal(
      view.vendors.find((row) => row.vendor === "lotw")?.requests,
      0,
    );
    await h.store
      .statement(
        "UPDATE connections SET config=? WHERE id='source'",
        JSON.stringify({
          lastSuccessfulPollAt: "secret-invalid-timestamp",
          lastSyncSuccessAt: now - 50_000,
        }),
      )
      .run();
    const fallback = await getAdminOverview(h.env, now);
    assert.equal(
      fallback.connections.items.find((row) => row.kind === "lofi")
        ?.lastSuccessAt,
      now - 50_000,
    );
    assert(!JSON.stringify(fallback).includes("secret"));
  } finally {
    await h.mf.dispose();
  }
});

test("scheduler records starts, completed turns, safe failures and seven-day retention", async () => {
  const h = await setup();
  try {
    await h.store
      .statement(
        "INSERT INTO scheduler_runs(id,started_at,status) VALUES('old',?,'running')",
        now - 8 * day,
      )
      .run();
    let time = now;
    const result = await runScheduledTick(h.env, {
      now: () => time,
      run: async () => {
        const started = await getAdminOverview(h.env, time);
        assert.equal(started.scheduler.running, 1);
        assert.equal(started.scheduler.lastStartedAt, time);
        assert.equal(started.scheduler.recentRuns[0].status, "running");
        assert.equal(started.scheduler.recentRuns[0].rounds, null);
        assert.equal(started.scheduler.recentRuns[0].stopReason, null);
        time += 1234;
        return {
          sources: 2,
          contacts: 12,
          attempts: 6,
          errors: 1,
          deferred: 4,
          exportsEnabled: false,
          rounds: 3,
          elapsedMs: 1200,
          stopReason: "idle",
        };
      },
    });
    assert.equal(result.contacts, 12);
    const complete = await getAdminOverview(h.env, time);
    assert.equal(complete.scheduler.stale, false);
    assert.equal(complete.scheduler.running, 0);
    assert.equal(complete.scheduler.recentRuns[0].durationMs, 1234);
    assert.equal(complete.scheduler.recentRuns[0].rounds, 3);
    assert.equal(complete.scheduler.recentRuns[0].stopReason, "idle");
    assert.deepEqual(complete.scheduler.recentRuns[0].backlog, {
      sourceLive: 0,
      sourceBackground: 0,
      attemptsDueLive: 0,
      attemptsDueBackground: 0,
      workLive: { ready: 0, held: 0, blocked: 0 },
      workBackground: { ready: 0, held: 0, blocked: 0 },
    });
    assert.deepEqual(complete.scheduler.totals24h, {
      runs: 1,
      failed: 0,
      deadlineRuns: 0,
      sourcePages: 2,
      contactTurns: 12,
      attemptTurns: 6,
      errors: 1,
      deferred: 4,
    });
    assert.equal(
      await h.store
        .statement("SELECT id FROM scheduler_runs WHERE id='old'")
        .first(),
      null,
    );
    await assert.rejects(
      runScheduledTick(h.env, {
        now: () => time,
        run: async () => {
          time += 100;
          throw new Error("https://vendor.example/?password=secret");
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Scheduled processing failed",
    );
    const failed = await getAdminOverview(h.env, time);
    const failedRun = failed.scheduler.recentRuns.find(
      (row) => row.status === "failed",
    );
    assert.equal(failedRun?.durationMs, 100);
    assert.equal(failedRun?.failure, "scheduled_processing_failed");
    assert.equal(failedRun?.rounds, null);
    assert.equal(failedRun?.stopReason, null);
    assert.equal(failed.scheduler.totals24h.failed, 1);
    assert(!JSON.stringify(failed).includes("password"));
    assert.equal(
      (await getAdminOverview(h.env, now + day)).scheduler.stale,
      true,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("scheduled wrapper invokes the real idle scheduler without a test runner", async () => {
  const h = await setup();
  try {
    const result = await runScheduledTick(h.env);
    const { elapsedMs, throughput, ...counters } = result;
    assert(throughput && throughput.database.calls > 0);
    const saved = await h.store
      .statement(
        "SELECT throughput_json FROM scheduler_runs WHERE status='completed' ORDER BY started_at DESC LIMIT 1",
      )
      .first<{ throughput_json: string }>();
    // JSON preserves diagnostic entries, not the in-memory map's null prototype.
    assert.deepEqual(JSON.parse(saved!.throughput_json), {
      ...throughput,
      failures: { ...throughput.failures },
    });
    assert(elapsedMs >= 0);
    assert.deepEqual(counters, {
      sources: 0,
      contacts: 0,
      attempts: 0,
      errors: 0,
      deferred: 0,
      exportsEnabled: false,
      rounds: 1,
      stopReason: "idle",
    });
    const view = await getAdminOverview(h.env);
    assert.equal(view.scheduler.recentRuns[0].status, "completed");
    assert.equal(view.scheduler.stale, false);
  } finally {
    await h.mf.dispose();
  }
});

test("scheduler saturation counts deadline stops in the last day separately from idle and failure", async () => {
  const h = await setup();
  try {
    for (const [startedAt, stopReason] of [
      [now - 2 * day, "deadline"],
      [now - 600_000, "deadline"],
      [now - 300_000, "idle"],
    ] as const) {
      let time = startedAt;
      await runScheduledTick(h.env, {
        now: () => time,
        run: async () => {
          time += stopReason === "deadline" ? 90_000 : 1000;
          return {
            sources: 5,
            contacts: 12,
            attempts: 6,
            errors: 0,
            deferred: 2,
            exportsEnabled: false,
            rounds: 8,
            elapsedMs: time - startedAt,
            stopReason,
          };
        },
      });
    }
    await h.store
      .statement(
        "INSERT INTO scheduler_runs(id,started_at,status,failure) VALUES('failed',?,'failed','scheduled_processing_failed')",
        now,
      )
      .run();
    const view = await getAdminOverview(h.env, now);
    assert.equal(view.scheduler.totals24h.runs, 3);
    assert.equal(view.scheduler.totals24h.failed, 1);
    assert.equal(view.scheduler.totals24h.deadlineRuns, 1);
    assert.equal(view.scheduler.totals24h.sourcePages, 10);
    assert.equal(
      view.scheduler.recentRuns.filter((run) => run.stopReason === "deadline")
        .length,
      2,
    );
    assert(
      view.scheduler.recentRuns
        .filter((run) => run.status === "completed")
        .every((run) => run.rounds === 8 && run.sourcePages === 5),
    );
  } finally {
    await h.mf.dispose();
  }
});

test("admin account and connection lists stop at 100 and announce truncation", async () => {
  const h = await setup();
  try {
    for (let i = 0; i < 101; i++) {
      await h.db.batch([
        h.db
          .prepare(
            "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES(?,?,?,?)",
          )
          .bind(`account-${i}`, `${i}@example.test`, `handle-${i}`, i),
        h.db
          .prepare(
            "INSERT INTO connections(tenant,id,kind,remote_identity,label,created_at) VALUES(?,'source','lofi','remote','Source',?)",
          )
          .bind(`account-${i}`, i),
      ]);
    }
    const view = await getAdminOverview(h.env, now);
    assert.equal(view.accounts.total, 101);
    assert.equal(view.accounts.items.length, 100);
    assert.equal(view.accounts.truncated, true);
    assert.equal(view.connections.total, 101);
    assert.equal(view.connections.items.length, 100);
    assert.equal(view.connections.truncated, true);
    assert.equal(view.accounts.items[0].id, "account-100");
  } finally {
    await h.mf.dispose();
  }
});
