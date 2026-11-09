import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import {
  InventoryProjectionCoverageJobs,
  type PreparedCoverageRecovery,
} from "../src/inventory-projection-coverage-jobs.ts";
import { InventoryProjectionJobs } from "../src/inventory-projection-jobs.ts";
import { InventoryProjections } from "../src/inventory-projections.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database } from "./helpers.ts";
import {
  fixture as contextFixture,
  observation,
} from "./inventory-context-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";

async function fixture(
  count = 3,
  options: {
    missingOperation?: boolean;
    complete?: boolean;
    projectBeforeCoverage?: boolean;
  } = {},
) {
  const runtime = await database();
  try {
    const f = await contextFixture(runtime);
    for (const name of [
      "0049_inventory_matching_read_indexes.sql",
      "0050_inventory_match_results.sql",
      "0127_inventory_sync_scopes.sql",
      "0132_inventory_match_scope_binding.sql",
      "0051_inventory_historical_ownership.sql",
      "0052_inventory_projection_jobs.sql",
      "0053_inventory_projection_coverage_jobs.sql",
      "0056_inventory_current_work_selection.sql",
      "0066_inventory_projection_coverage_holds.sql",
    ])
      await applyMigration(f.db, name);
    const operation = observation("op", "operation");
    const sources = Array.from({ length: count }, (_, i) =>
      sourceContact(`q${String(i).padStart(4, "0")}`, "13:00:00", `W${i}AW`),
    );
    const run = await f.begin();
    await f.observed(run.id, [
      ...(options.missingOperation ? [] : [operation]),
      ...sources,
    ]);
    const builds = new InventoryComparisonBuilds(f.store);
    for (let i = 0; i < 1000; i++) {
      const result = await builds.step("a", f.generation, "source");
      assert.ok(!("deferred" in result));
      if (result.complete) break;
      assert.ok(i < 999);
    }
    const projections = new InventoryProjections(f.store);
    for (
      let i = 0;
      options.projectBeforeCoverage !== false && i < sources.length;
      i += 20
    ) {
      const result = await projections.project(
        "a",
        f.generation,
        "source",
        sources.slice(i, i + 20).map((row) => row.key),
      );
      assert.ok("held" in result);
      assert.equal(result.held, Math.min(20, sources.length - i));
    }
    async function finish() {
      await f.observed(run.id, []);
      await f.finish(run.id);
    }
    if (options.complete) await finish();
    return {
      ...f,
      sources,
      operation,
      finish,
      recovery: new InventoryProjectionCoverageJobs(f.store),
      jobs: new InventoryProjectionJobs(f.store),
    };
  } catch (error) {
    await runtime.mf.dispose();
    throw error;
  }
}
async function prepared() {
  const f = await fixture(3, { complete: true });
  try {
    const lease = await f.store.claim(
      "a",
      canonical(["projection-coverage", f.generation, "source"]),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.recovery.prepare(
      "a",
      f.generation,
      "source",
      lease,
      2,
    );
    assert.ok(page);
    return { ...f, lease, page };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  const state: Record<string, unknown> = {};
  for (const table of [
    "inventory_projection_coverage_jobs",
    "comparison_work",
    "inventory_coverage",
    "inventory_streams",
    "inventory_record_facets",
  ])
    state[table] = (
      await f.db.prepare(`SELECT * FROM ${table} ORDER BY tenant`).all()
    ).results;
  return state;
}
function alteredStore(
  f: Awaited<ReturnType<typeof prepared>>,
  alter: (plan: D1PreparedStatement[]) => Promise<D1Result[]>,
) {
  return new Store(
    new Proxy(f.db, {
      get(target, property) {
        if (property === "batch") return alter;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    f.store.keys,
  );
}
async function resign(page: PreparedCoverageRecovery) {
  const { digest: _digest, ...manifest } = page;
  page.digest = await sha256(canonical(manifest));
}

test("automatic source projection waits for first full coverage and leaves queued work intact", async (t) => {
  const f = await fixture(3, { projectBeforeCoverage: false });
  t.after(() => f.mf.dispose());
  const queued = () =>
    f.db
      .prepare(
        "SELECT count(*) AS n FROM comparison_work WHERE scope_id='source' AND completed_version<work_version",
      )
      .first("n");
  const queuedOperations = () =>
    f.db
      .prepare(
        "SELECT count(*) AS n FROM inventory_projection_jobs WHERE scope_id='source' AND completed_version<work_version",
      )
      .first("n");
  assert.equal(await queued(), 3);
  assert.equal(await queuedOperations(), 1);
  assert.deepEqual(await f.jobs.expandNext("a"), { kind: "idle" });
  assert.deepEqual(await f.jobs.projectNext("a"), { kind: "idle" });
  assert.equal(await queued(), 3);
  assert.equal(await queuedOperations(), 1);
  await f.finish();
  assert.equal((await f.jobs.expandNext("a")).kind, "expanded");
  const projected = await f.jobs.projectNext("a");
  assert.ok("ready" in projected);
  assert.equal(projected.ready, 3);
  assert.equal(await queued(), 0);
});

test("full source completion recovers coverage-held contacts in bounded pages without contact fan-out during ingestion", async (t) => {
  const f = await fixture(205);
  try {
    assert.equal((await f.recovery.step("a")).kind, "idle");
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_projection_coverage_jobs",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
    const workBefore = (
      await f.db
        .prepare("SELECT * FROM comparison_work ORDER BY record_key")
        .all()
    ).results;
    await f.finish();
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM comparison_work ORDER BY record_key")
          .all()
      ).results,
      workBefore,
      "completion only queues one scope control",
    );
    const checkpoint = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const first = await f.recovery.step("a");
    assert.ok("records" in first);
    assert.equal(first.records, 200);
    assert.equal(first.complete, false);
    assert.equal(first.statements, 1);
    const second = await f.recovery.step("a");
    assert.ok("records" in second);
    assert.equal(second.records, 5);
    assert.equal(second.complete, true);
    assert.equal((await f.recovery.step("a")).kind, "idle");
    let projected = 0;
    for (let i = 0; i < 12; i++) {
      const result = await f.jobs.projectNext("a");
      if (result.kind === "idle") break;
      assert.ok("ready" in result);
      projected += result.ready;
    }
    assert.equal(projected, 205);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_projections_current WHERE state='ready'",
          )
          .first<{ n: number }>()
      )?.n,
      205,
    );
    assert.deepEqual(
      await f.inventory.snapshot("a", "source", "sync"),
      checkpoint,
    );
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    await f.full([f.operation, ...f.sources]);
    const empty = await f.recovery.step("a");
    assert.ok("records" in empty);
    assert.equal(empty.records, 0);
    assert.ok(
      empty.rowsRead < 200,
      "ready projection growth must not become a recovery scan",
    );
    t.diagnostic(
      `200-contact coverage recovery: ${first.statements} explicit statement, ${first.rowsRead} rows read, ${first.rowsWritten} rows written`,
    );
    t.diagnostic(
      `empty recovery with 205 ready projections: ${empty.rowsRead} rows read`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("unchanged verification preserves ready payloads and work versions", async () => {
  const f = await fixture(3, { complete: true });
  try {
    await f.recovery.step("a");
    await f.jobs.projectNext("a");
    const projections = (
      await f.db
        .prepare("SELECT * FROM comparison_projections ORDER BY record_key")
        .all()
    ).results;
    const work = (
      await f.db
        .prepare("SELECT * FROM comparison_work ORDER BY record_key")
        .all()
    ).results;
    await f.full([f.operation, ...f.sources]);
    const result = await f.recovery.step("a");
    assert.ok("records" in result);
    assert.equal(result.records, 0);
    assert.equal(result.complete, true);
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM comparison_projections ORDER BY record_key")
          .all()
      ).results,
      projections,
    );
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM comparison_work ORDER BY record_key")
          .all()
      ).results,
      work,
    );
    assert.equal((await f.jobs.projectNext("a")).kind, "idle");
    assert.equal((await f.recovery.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("missing operation context stays held without spinning and later operation work repairs it", async () => {
  const f = await fixture(1, { missingOperation: true, complete: true });
  try {
    await f.recovery.step("a");
    const held = await f.jobs.projectNext("a");
    assert.ok("held" in held);
    assert.equal(held.held, 1);
    assert.equal((await f.recovery.step("a")).kind, "idle");
    assert.equal((await f.jobs.projectNext("a")).kind, "idle");
    const heldProjection = await f.db
      .prepare("SELECT * FROM comparison_projections WHERE record_key='q0000'")
      .first<{ reason: string }>();
    assert.equal(heldProjection?.reason, "operation_context_incomplete");
    const work = (
      await f.db
        .prepare("SELECT * FROM comparison_work ORDER BY record_key")
        .all()
    ).results;
    await f.full(f.sources);
    const unchanged = await f.recovery.step("a");
    assert.ok("records" in unchanged);
    assert.equal(unchanged.records, 0);
    assert.equal(unchanged.complete, true);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT * FROM comparison_projections WHERE record_key='q0000'",
        )
        .first(),
      heldProjection,
      "an unchanged scan does not rewrite a persistent context hold",
    );
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM comparison_work ORDER BY record_key")
          .all()
      ).results,
      work,
      "a context change, rather than another full scan, must wake this contact",
    );
    assert.equal((await f.jobs.projectNext("a")).kind, "idle");
    await f.full([f.operation, ...f.sources]);
    const expanded = await f.jobs.expandNext("a");
    assert.ok("records" in expanded);
    const ready = await f.jobs.projectNext("a");
    assert.ok("ready" in ready);
    assert.equal(ready.ready, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("native recovery fences stale coverage, leases, accounts and superseding full scans", async (t) => {
  for (const change of [
    "coverage",
    "lease",
    "account",
    "new-run",
    "cursor",
  ] as const)
    await t.test(change, async () => {
      const f = await prepared();
      try {
        const page = structuredClone(f.page);
        if (change === "coverage")
          await f.db
            .prepare(
              "UPDATE inventory_coverage SET state='collecting',version=version+1",
            )
            .run();
        else if (change === "lease")
          await f.db
            .prepare(
              "UPDATE leases SET expires_at=0 WHERE scope LIKE '%projection-coverage%'",
            )
            .run();
        else if (change === "account")
          await f.db.prepare("UPDATE accounts SET status='locked'").run();
        else if (change === "new-run")
          await f.full([f.operation, ...f.sources]);
        else {
          page.job.cursor_key = "q0001";
          await resign(page);
        }
        const before = await snapshot(f);
        await assert.rejects(f.recovery.publish(page), /changed/);
        assert.deepEqual(await snapshot(f), before);
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT count(*) AS n FROM inventory_projection_coverage_pages",
              )
              .first<{ n: number }>()
          )?.n,
          0,
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("native final recovery guards roll back late authority changes and ignored work", async (t) => {
  for (const failure of ["account", "coverage", "work"] as const)
    await t.test(failure, async () => {
      const f = await prepared();
      try {
        const sql =
          failure === "account"
            ? "UPDATE accounts SET status='locked'"
            : failure === "coverage"
              ? "UPDATE inventory_coverage SET state='collecting',version=version+1"
              : "UPDATE comparison_work SET completed_version=work_version";
        await f.db
          .prepare(
            `CREATE TRIGGER late_recovery_change BEFORE UPDATE ON inventory_projection_coverage_pages WHEN NEW.state='committed' BEGIN ${sql}; END;`,
          )
          .run();
        const before = await snapshot(f);
        await assert.rejects(f.recovery.publish(f.page), /incomplete/);
        assert.deepEqual(await snapshot(f), before);
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT count(*) AS n FROM inventory_projection_coverage_pages",
              )
              .first<{ n: number }>()
          )?.n,
          0,
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("SQL rollback and lost acknowledgements preserve recovery receipts without refreshing new work", async (t) => {
  for (const failure of ["sql", "ack"] as const)
    await t.test(failure, async () => {
      const f = await prepared();
      try {
        const before = await snapshot(f);
        const store = alteredStore(f, async (plan) => {
          if (failure === "sql")
            return f.db.batch([
              ...plan,
              f.db.prepare("SELECT * FROM intentional_missing_coverage_table"),
            ]);
          await f.db.batch(plan);
          throw new Error("lost acknowledgement");
        });
        const recovery = new InventoryProjectionCoverageJobs(store);
        if (failure === "sql") {
          await assert.rejects(recovery.publish(f.page));
          assert.deepEqual(await snapshot(f), before);
        } else {
          const result = await recovery.publish(f.page);
          assert.equal(result.recovered, true);
          assert.equal(result.records, 2);
          assert.equal(result.complete, false);
          await f.full([f.operation, ...f.sources]);
          const newer = await snapshot(f);
          assert.equal((await f.recovery.publish(f.page)).recovered, true);
          assert.deepEqual(await snapshot(f), newer);
          await assert.rejects(
            f.db
              .prepare("DELETE FROM inventory_projection_coverage_pages")
              .run(),
            /retained/,
          );
        }
      } finally {
        await f.mf.dispose();
      }
    });
});

test("new comparison generations enroll recovery and defer until their source census completes", async () => {
  const f = await fixture(1, { complete: true });
  try {
    await f.recovery.step("a");
    const builds = new InventoryComparisonBuilds(f.store);
    await builds.activate("a", f.generation);
    const generation = await new InventoryComparisonGenerations(f.store).begin(
      "a",
    );
    assert.ok(generation.pending_generation);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_projection_coverage_jobs",
          )
          .first<{ n: number }>()
      )?.n,
      2,
    );
    assert.equal((await f.recovery.step("a")).kind, "idle");
    await builds.step("a", generation.pending_generation, "source");
    const result = await f.recovery.step("a");
    assert.ok("records" in result);
    assert.equal(
      result.records,
      0,
      "new generation has no held projections yet",
    );
    assert.equal(result.complete, true);
  } finally {
    await f.mf.dispose();
  }
});
