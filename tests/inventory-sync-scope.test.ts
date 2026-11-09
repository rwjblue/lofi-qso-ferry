import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import { inventoryDashboardSummary } from "../src/inventory-dashboard.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import { InventoryMatchingWorkspace } from "../src/inventory-matching-workspace.ts";
import { InventoryRunner } from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  registerSourceCalendarSelections,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { inventorySyncScopeRoute } from "../src/inventory-sync-scope.ts";
import { database } from "./helpers.ts";
import {
  matchingFixture,
  sourceContact,
} from "./inventory-matching-fixtures.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

async function setScope(
  db: D1Database,
  destination: string,
  mode: "all" | "since" | "forward",
  since?: string,
) {
  const response = await inventorySyncScopeRoute(
    new Request("https://test.invalid/api/sync-scope", {
      method: "POST",
      body: JSON.stringify({ destination, mode, since }),
    }),
    db,
    "a",
  );
  assert.equal(response?.status, 200);
}

test("native matching excludes QSO dates before the cutoff and invalidates an older snapshot", async (t) => {
  const base = await database();
  t.after(() => base.mf.dispose());
  await applyAdditionalMigrations(base.db);
  const older = sourceContact("older", "13:00:00", "K1ABC");
  older.body = {
    ...(older.body as object),
    startAtMillis: Date.parse("2026-11-07T13:00:00Z"),
  };
  const included = sourceContact("inclusive", "00:00:00", "K2ABC");
  const { store, db } = await matchingFixture(
    {
      sources: [older, included],
      receipts: [],
      range: ["2026-11-07", "2026-11-08"],
    },
    base,
    "current",
  );
  const workspace = new InventoryMatchingWorkspace(store);
  const matches = new InventoryMatchingResults(store);
  const keys = [older, included].map(({ key }) => ({ scope: "source", key }));
  const before = await workspace.prepare("a", "destination", keys);
  assert.ok(before.results.every((row) => row.state === "absent_at_inventory"));
  const pairVersion = await db
    .prepare(
      "SELECT work_version FROM inventory_matching_pair_jobs WHERE tenant='a'",
    )
    .first<number>("work_version");
  assert.ok(pairVersion);
  await setScope(db, "destination", "since", "2026-11-08");
  assert.equal(
    await db
      .prepare(
        "SELECT work_version FROM inventory_matching_pair_jobs WHERE tenant='a'",
      )
      .first("work_version"),
    pairVersion + 1,
  );
  const lease = await store.claim("a", "matching:destination");
  assert.ok(lease);
  await assert.rejects(
    matches.publish(before, lease),
    /sync scope changed|authority or dependencies changed/,
  );
  const after = await workspace.prepare("a", "destination", keys);
  assert.deepEqual(
    after.results.map(({ state, scopeExcluded }) => [state, scopeExcluded]),
    [
      ["excluded", true],
      ["absent_at_inventory", undefined],
    ],
  );
  await matches.publish(after, lease);
  const dashboard = (await inventoryDashboardSummary(db, "a")).find(
    (provider) => provider.provider === "qrz",
  );
  assert.deepEqual(
    dashboard?.matches.map(({ state, count }) => [state, count]),
    [
      ["absent_at_inventory", 1],
      ["out_of_scope", 1],
    ],
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT record_key FROM inventory_delivery_review WHERE tenant='a'",
        )
        .all()
    ).results,
    [{ record_key: "inclusive" }],
  );
  await setScope(db, "destination", "since", "2026-11-09");
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM inventory_delivery_preparation_review WHERE tenant='a' AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets stale WHERE stale.tenant=inventory_delivery_preparation_review.tenant AND stale.set_id=result_set)",
      )
      .first("count(*)"),
    0,
  );
});

test("forward scope skips remote history and distinguishes an old edit from a newly seen backdated contact", async (t) => {
  const { db, mf, store } = await database();
  t.after(() => mf.dispose());
  await applyAdditionalMigrations(db);
  const book = {
    bookId: "7",
    stationCallsign: "W1AW",
    startDate: "1980-01-01",
    endDate: "2027-01-01",
  };
  await db.batch([
    db.prepare(
      "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('a','a@example.test','a',1)",
    ),
    db
      .prepare(`INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at)
      VALUES('a','source','lofi','a','Source','active','v1',?,1),('a','qrz','qrz','7','QRZ','active','v1',?,1)`)
      .bind(JSON.stringify({ accountId: "a" }), JSON.stringify(book)),
    await store.putPrivate("a", "source", "v1", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    }),
    await store.putPrivate("a", "qrz", "v1", "credential", {
      apiKey: "fixture",
    }),
  ]);
  await setScope(db, "qrz", "forward");
  const runtime = await activateInventoryRuntime(store);
  const source = await store.connection("a", "source");
  assert.ok(source);
  const sourceScope = (
    await registerInventorySelection(store, runtime, source, {
      provider: "lofi",
    })
  ).scope;
  assert.equal(
    (await registerSourceCalendarSelections(store, runtime)).registered,
    1,
  );
  const destination = await db
    .prepare("SELECT scope_id FROM inventory_scopes WHERE provider='qrz'")
    .first<string>("scope_id");
  assert.ok(destination);
  assert.equal((await startInventorySelections(store)).started, 1);
  const operation = {
    uuid: "op",
    stationCall: "W1AW",
    syncedAtMillis: Date.now() - 60_000,
  };
  const original = {
    uuid: "original",
    operation: operation.uuid,
    syncedAtMillis: operation.syncedAtMillis + 1,
    startAtMillis: Date.parse("2026-10-31T12:00:00Z"),
    their: { call: "K1ABC" },
    our: { grid: "FN31" },
    band: "20m",
    mode: "CW",
  };
  let calls = 0;
  let deltaStamp: number | null = null;
  let pendingBirth = false;
  const runs = new InventoryRuns(
    new InventoryIngestion(store, new InventoryComparisonPages(store)),
  );
  const runner = new InventoryRunner(
    runs,
    async (input, init) => {
      assert.equal(
        new URL(new Request(input, init).url).hostname,
        "lofi.ham2k.net",
      );
      const first = calls++ === 0;
      return Response.json({
        account: { uuid: "a" },
        operations: first ? [operation] : [],
        qsos: first
          ? [original]
          : deltaStamp !== null
            ? [
                { ...original, syncedAtMillis: deltaStamp, notes: "old edit" },
                {
                  ...original,
                  uuid: "new-backdated",
                  syncedAtMillis: deltaStamp + 1,
                  startAtMillis: Date.parse("2026-01-01T12:00:00Z"),
                  their: { call: "K2ABC" },
                },
              ]
            : [],
        meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
      });
    },
    { scheduled: true },
  );
  async function finish() {
    for (let step = 0; step < 12; step++) {
      const job = await store
        .statement(
          `SELECT j.stream_id AS stream,coalesce(j.active_run_id,w.run_id) AS run,j.work_version AS workVersion
           FROM inventory_stream_jobs j JOIN inventory_wakeups w
             ON (w.tenant,w.scope_id,w.stream_id,w.work_version)=(j.tenant,j.scope_id,j.stream_id,j.work_version)
           WHERE j.tenant='a' AND j.scope_id=?`,
          sourceScope,
        )
        .first<{ stream: string; run: string; workVersion: number }>();
      assert.ok(job);
      await db.prepare("DELETE FROM inventory_read_pacing").run();
      const outcome = await runner.step({
        version: 1,
        tenant: "a",
        scope: sourceScope,
        ...job,
      });
      if (outcome.kind === "complete") return;
      if (deltaStamp !== null && outcome.kind === "advanced") {
        const phase = await db
          .prepare(
            "SELECT phase FROM inventory_forward_births WHERE tenant='a' AND record_key='new-backdated'",
          )
          .first<string>("phase");
        if (phase) {
          assert.equal(phase, "publishing");
          pendingBirth = true;
        }
      }
      if (outcome.kind === "skipped" && outcome.reason === "not_due") {
        const at = Date.now();
        await db.batch([
          store.statement(
            "UPDATE inventory_stream_jobs SET work_version=work_version+1,next_due_at=? WHERE tenant='a' AND scope_id=?",
            at,
            sourceScope,
          ),
          store.statement(
            "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) VALUES('a',?,?,?,?,?,?)",
            crypto.randomUUID(),
            sourceScope,
            job.stream,
            job.run,
            job.workVersion + 1,
            at,
          ),
        ]);
      } else
        assert.ok(
          outcome.kind === "started" || outcome.kind === "advanced",
          JSON.stringify(outcome),
        );
    }
    assert.fail("reader did not settle");
  }
  await finish();
  assert.equal(
    (await registerSourceCalendarSelections(store, runtime)).registered,
    0,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM inventory_scheduled_selections WHERE scope_id=?",
      )
      .bind(destination)
      .first("count(*)"),
    0,
  );
  deltaStamp = Date.now() - 100;
  await finish();
  assert.equal(pendingBirth, true);
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT record_key,origin FROM inventory_births WHERE entity_family='qso' AND facet='source' ORDER BY record_key",
        )
        .all()
    ).results,
    [
      { record_key: "new-backdated", origin: "forward" },
      { record_key: "original", origin: "historical" },
    ],
  );
  const coordinator = new InventoryComparisonCoordinator(store);
  for (let step = 0; step < 100; step++) {
    const outcome = await coordinator.step("a");
    if (outcome.kind === "idle") break;
    assert.ok(step < 99, JSON.stringify(outcome));
  }
  const current = await new InventoryMatchingResults(store).current(
    "a",
    destination,
    [
      { scope: sourceScope, key: "original" },
      { scope: sourceScope, key: "new-backdated" },
    ],
  );
  assert.deepEqual(
    current.results
      .map(({ record_key, state }) => ({ record_key, state }))
      .sort((a, b) => a.record_key.localeCompare(b.record_key)),
    [
      { record_key: "new-backdated", state: "absent_at_inventory" },
      { record_key: "original", state: "excluded" },
    ],
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT record_key FROM inventory_delivery_preparation_review WHERE tenant='a' AND destination=? ORDER BY record_key",
        )
        .bind(destination)
        .all()
    ).results,
    [{ record_key: "new-backdated" }],
  );

  // Month hints remain coarse, but the dated plan is clipped and a later
  // widening only schedules the newly eligible gap.
  async function plans() {
    return (
      await db
        .prepare(
          "SELECT from_date,through_date FROM inventory_scoped_schedule WHERE tenant='a' AND scope_id=? ORDER BY from_date",
        )
        .bind(destination)
        .all()
    ).results;
  }
  await setScope(db, "qrz", "since", "2026-10-20");
  assert.equal(
    (await registerSourceCalendarSelections(store, runtime)).registered,
    1,
  );
  assert.deepEqual(await plans(), [
    { from_date: "2026-10-19", through_date: "2026-10-31" },
  ]);
  await setScope(db, "qrz", "since", "2026-10-10");
  assert.equal(
    (await registerSourceCalendarSelections(store, runtime)).registered,
    1,
  );
  assert.deepEqual(await plans(), [
    { from_date: "2026-10-09", through_date: "2026-10-18" },
    { from_date: "2026-10-19", through_date: "2026-10-31" },
  ]);
  assert.equal((await startInventorySelections(store)).started, 2);
  const queued = await db
    .prepare(
      "SELECT stream_id AS stream,active_run_id AS run,work_version AS workVersion FROM inventory_stream_jobs WHERE tenant='a' AND scope_id=? LIMIT 1",
    )
    .bind(destination)
    .first<{ stream: string; run: string; workVersion: number }>();
  assert.ok(queued);
  await setScope(db, "qrz", "forward");
  assert.deepEqual(await plans(), []);
  assert.deepEqual(
    await runner.step({
      version: 1,
      tenant: "a",
      scope: destination,
      ...queued,
    }),
    {
      kind: "skipped",
      reason: "stale",
    },
  );
});
