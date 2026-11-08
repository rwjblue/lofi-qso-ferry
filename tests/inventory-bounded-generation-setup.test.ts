import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { InventoryProjectionJobs } from "../src/inventory-projection-jobs.ts";
import { InventoryProjections } from "../src/inventory-projections.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database } from "./helpers.ts";
import {
  fixture as contextFixture,
  observation,
} from "./inventory-context-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";

async function fixture(count: number) {
  const runtime = await database();
  try {
    const f = await contextFixture(runtime);
    for (const name of [
      "0049_inventory_matching_read_indexes.sql",
      "0050_inventory_match_results.sql",
      "0051_inventory_historical_ownership.sql",
      "0052_inventory_projection_jobs.sql",
      "0053_inventory_projection_coverage_jobs.sql",
      "0054_inventory_bounded_generation_setup.sql",
    ])
      await applyMigration(f.db, name);
    const operations = Array.from({ length: count }, (_, i) =>
      observation(`op${String(i).padStart(4, "0")}`, "operation"),
    );
    const sources = operations.map((operation, i) => {
      const qso = sourceContact(
        `q${String(i).padStart(4, "0")}`,
        "13:00:00",
        `W${i}AW`,
      );
      qso.parentKey = operation.key;
      qso.body = { ...(qso.body as object), operation: operation.key };
      return qso;
    });
    await f.full([...operations, ...sources]);
    const builds = new InventoryComparisonBuilds(f.store);
    async function build(generation: string) {
      for (let pass = 0; pass < 1000; pass++) {
        const result = await builds.step("a", generation, "source");
        assert.ok(!("deferred" in result));
        if (result.complete) return;
      }
      throw new Error("bounded setup fixture build limit");
    }
    await build(f.generation);
    await builds.activate("a", f.generation);
    return {
      ...f,
      builds,
      build,
      operations,
      sources,
      jobs: new InventoryProjectionJobs(f.store),
      projections: new InventoryProjections(f.store),
    };
  } catch (error) {
    await runtime.mf.dispose();
    throw error;
  }
}

test("generation setup stays constant as retained operation count grows", async (t) => {
  const costs = [];
  for (const count of [2, 250]) {
    const f = await fixture(count);
    try {
      const beforeJobs = (
        await f.db
          .prepare(
            "SELECT * FROM inventory_projection_jobs ORDER BY operation_key",
          )
          .all()
      ).results;
      let cost = { read: 0, written: 0, statements: 0 };
      const store = new Store(
        new Proxy(f.db, {
          get(target, property) {
            if (property === "batch")
              return async (plan: D1PreparedStatement[]) => {
                const result = await target.batch(plan);
                cost = {
                  read: result.reduce((n, row) => n + row.meta.rows_read, 0),
                  written: result.reduce(
                    (n, row) => n + row.meta.rows_written,
                    0,
                  ),
                  statements: plan.length,
                };
                return result;
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
        f.store.keys,
      );
      const domain = await new InventoryComparisonGenerations(store).begin("a");
      assert.ok(domain.pending_generation);
      assert.equal(cost.statements, 2);
      assert.ok(
        cost.read < 100 && cost.written < 30,
        "setup must not visit or enqueue every operation",
      );
      assert.deepEqual(
        (
          await f.db
            .prepare(
              "SELECT * FROM inventory_projection_jobs ORDER BY operation_key",
            )
            .all()
        ).results,
        beforeJobs,
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT count(*) AS n FROM comparison_builds WHERE generation_id=?",
            )
            .bind(domain.pending_generation)
            .first<{ n: number }>()
        )?.n,
        1,
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT count(*) AS n FROM inventory_projection_coverage_jobs WHERE generation_id=?",
            )
            .bind(domain.pending_generation)
            .first<{ n: number }>()
        )?.n,
        1,
      );
      costs.push(cost);
    } finally {
      await f.mf.dispose();
    }
  }
  assert.deepEqual(costs[1], costs[0]);
  t.diagnostic(
    `generation setup with 250 retained operations: ${costs[1].statements} statements, ${costs[1].read} rows read, ${costs[1].written} rows written`,
  );
});

test("bounded backfill queues all new-generation projections and retains edits arriving mid-build", async () => {
  const f = await fixture(205);
  try {
    const domain = await new InventoryComparisonGenerations(f.store).begin("a");
    assert.ok(domain.pending_generation);
    const generation = domain.pending_generation;
    const first = await f.builds.step("a", generation, "source");
    assert.ok("records" in first);
    assert.equal(first.records, 200);
    assert.equal(first.complete, false);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_projection_jobs WHERE generation_id=?",
          )
          .bind(generation)
          .first<{ n: number }>()
      )?.n,
      0,
    );
    const changed = observation(f.operations[0].key, "operation", 2);
    changed.body = { ...(changed.body as object), stationCall: "K1ABC" };
    await f.full([changed, ...f.operations.slice(1), ...f.sources]);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_projection_jobs WHERE generation_id=?",
          )
          .bind(generation)
          .first<{ n: number }>()
      )?.n,
      1,
      "only the changed operation needs fan-out",
    );
    await f.build(generation);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_work WHERE generation_id=? AND completed_version<work_version",
          )
          .bind(generation)
          .first<{ n: number }>()
      )?.n,
      205,
    );
    for (let offset = 0; offset < f.sources.length; offset += 20) {
      const result = await f.projections.project(
        "a",
        generation,
        "source",
        f.sources.slice(offset, offset + 20).map((row) => row.key),
      );
      assert.ok("ready" in result);
      assert.equal(result.ready, Math.min(20, f.sources.length - offset));
    }
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_projections_current WHERE generation_id=? AND state='ready'",
          )
          .bind(generation)
          .first<{ n: number }>()
      )?.n,
      205,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_work WHERE generation_id=? AND completed_version<work_version",
          )
          .bind(generation)
          .first<{ n: number }>()
      )?.n,
      0,
    );
    const body = await f.projections.body(
      "a",
      generation,
      "source",
      f.sources[0].key,
      "source",
    );
    assert.equal(body?.body.record.STATION_CALLSIGN, "K1ABC");
  } finally {
    await f.mf.dispose();
  }
});

test("source configuration changes reset bounded builds without enumerating operation jobs", async () => {
  const f = await fixture(3);
  try {
    const before = (
      await f.db
        .prepare(
          "SELECT * FROM inventory_projection_jobs ORDER BY operation_key",
        )
        .all()
    ).results;
    await f.db
      .prepare(
        "UPDATE inventory_scopes SET config_version=config_version+1 WHERE scope_id='source'",
      )
      .run();
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT * FROM inventory_projection_jobs ORDER BY operation_key",
          )
          .all()
      ).results,
      before,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT complete FROM comparison_builds WHERE generation_id=?",
          )
          .bind(f.generation)
          .first<{ complete: number }>()
      )?.complete,
      0,
    );
    await f.build(f.generation);
    const work = (
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE generation_id=? ORDER BY record_key",
        )
        .bind(f.generation)
        .all<{ work_version: number; completed_version: number }>()
    ).results;
    assert.equal(work.length, 3);
    assert.ok(work.every((row) => row.completed_version < row.work_version));
    const result = await f.jobs.projectNext("a");
    assert.ok("held" in result);
    assert.equal(
      result.held,
      3,
      "new configuration still requires full source coverage",
    );
  } finally {
    await f.mf.dispose();
  }
});
