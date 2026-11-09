import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import {
  InventoryProjectionJobs,
  type PreparedProjectionJob,
} from "../src/inventory-projection-jobs.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import {
  matchingFixture,
  sourceContact,
} from "./inventory-matching-fixtures.ts";

async function fixture(count = 3) {
  const runtime = await database();
  try {
    const f = await matchingFixture(
      {
        sources: Array.from({ length: count }, (_, i) =>
          sourceContact(
            `q${String(i).padStart(4, "0")}`,
            "13:00:00",
            `W${i}AW`,
          ),
        ),
        receipts: [],
      },
      runtime,
    );
    await applyMigration(f.db, "0052_inventory_projection_jobs.sql");
    await applyMigration(f.db, "0056_inventory_current_work_selection.sql");
    await applyMigration(
      f.db,
      "0115_inventory_projection_childless_context.sql",
    );
    const jobs = new InventoryProjectionJobs(f.store);
    async function edit(order = 2) {
      const op = observation("op", "operation", order);
      op.body = {
        ...(op.body as object),
        stationCall: order % 2 ? "K1ABC" : "N2RWJ",
      };
      await f.full([op, ...f.sources]);
    }
    return { ...f, jobs, edit };
  } catch (error) {
    await runtime.mf.dispose();
    throw error;
  }
}
async function prepared(count = 3) {
  const f = await fixture(count);
  await f.edit();
  const lease = await f.store.claim(
    "a",
    canonical(["projection-fanout", f.generation, "source", "op"]),
    Date.now(),
    60000,
  );
  assert.ok(lease);
  const page = await f.jobs.prepare(
    "a",
    f.generation,
    "source",
    "op",
    lease,
    2,
  );
  assert.ok(page);
  return { ...f, lease, page };
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
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    domains: (
      await f.db
        .prepare(
          "SELECT * FROM projection_domains ORDER BY tenant,scope_id,operation_key",
        )
        .all()
    ).results,
    jobs: (
      await f.db
        .prepare(
          "SELECT * FROM inventory_projection_jobs ORDER BY tenant,generation_id,scope_id,operation_key",
        )
        .all()
    ).results,
    work: (
      await f.db
        .prepare(
          "SELECT * FROM comparison_work ORDER BY tenant,generation_id,scope_id,record_key,facet",
        )
        .all()
    ).results,
  };
}
async function resign(page: PreparedProjectionJob) {
  const { digest: _digest, ...manifest } = page;
  page.digest = await sha256(canonical(manifest));
}

test("childless context changes skip new fan-out and later children project the current topology", async () => {
  const f = await fixture(0);
  try {
    // The migration keeps legacy pending jobs publishable across a later edit.
    await f.edit();
    const legacy = await f.jobs.expandNext("a");
    assert.equal(legacy.kind, "expanded");
    assert.ok("records" in legacy && legacy.records === 0);

    const op = (order: number) => {
      const row = observation("new-op", "operation", order);
      row.body = {
        ...(row.body as object),
        stationCall: order % 2 ? "N1RWJ" : "K1ABC",
      };
      return row;
    };
    const child = sourceContact("new-qso");
    child.parentKey = "new-op";
    child.body = { ...(child.body as object), operation: "new-op" };
    await f.full([op(1)]);
    await f.full([op(2)]);
    assert.equal((await f.jobs.expandNext("a")).kind, "idle");
    assert.equal(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_projection_jobs WHERE operation_key='new-op'",
        )
        .first("n"),
      0,
    );

    const projection = () =>
      f.db
        .prepare(
          `SELECT p.state,p.topology_version,d.topology_version AS current_version
           FROM comparison_projections p JOIN projection_domains d
            ON (p.tenant,p.scope_id,p.parent_key)=(d.tenant,d.scope_id,d.operation_key)
           WHERE p.record_key='new-qso'`,
        )
        .first();
    await f.full([op(2), child]);
    assert.equal((await f.jobs.projectNext("a")).kind, "projected");
    const current = await projection();
    assert.equal(current?.state, "ready");
    assert.equal(current?.topology_version, current?.current_version);

    await f.full([op(3), child]);
    const edited = await f.jobs.expandNext("a");
    assert.equal(edited.kind, "expanded");
    assert.ok("records" in edited && edited.records === 1);
    assert.equal((await f.jobs.projectNext("a")).kind, "projected");
    const updated = await projection();
    assert.equal(updated?.state, "ready");
    assert.equal(updated?.topology_version, updated?.current_version);
    assert.notEqual(updated?.topology_version, current?.topology_version);
  } finally {
    await f.mf.dispose();
  }
});

test("an operation edit queues one job and keyset pages dirty children before bounded projection", async (t) => {
  const f = await fixture(205);
  try {
    const before = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    await f.edit();
    const afterEdit = await f.inventory.snapshot("a", "source", "sync");
    assert.notDeepEqual(afterEdit, before);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_projection_jobs")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_work WHERE completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      0,
      "intake must not update every operation child",
    );
    const first = await f.jobs.expandNext("a");
    assert.equal(first.kind, "expanded");
    assert.ok("records" in first);
    assert.equal(first.records, 200);
    assert.equal(first.complete, false);
    assert.equal(first.statements, 4);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_work WHERE completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      200,
    );
    const second = await f.jobs.expandNext("a");
    assert.ok("records" in second);
    assert.equal(second.records, 5);
    assert.equal(second.complete, true);
    assert.equal((await f.jobs.expandNext("a")).kind, "idle");
    let projected = 0;
    for (let i = 0; i < 12; i++) {
      const result = await f.jobs.projectNext("a");
      if (result.kind === "idle") break;
      assert.equal(result.kind, "projected");
      assert.ok("records" in result);
      assert.ok(result.records <= 20);
      projected += result.records;
    }
    assert.equal(projected, 205);
    assert.equal((await f.jobs.projectNext("a")).kind, "idle");
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_projections_current WHERE scope_id='source' AND state='ready'",
          )
          .first<{ n: number }>()
      )?.n,
      205,
    );
    assert.deepEqual(
      await f.inventory.snapshot("a", "source", "sync"),
      afterEdit,
    );
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    t.diagnostic(
      `200-child fan-out: ${first.statements} statements, ${first.rowsRead} rows read, ${first.rowsWritten} rows written`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("unchanged contexts do not re-enqueue completed fan-out or rewrite current children", async () => {
  const f = await fixture();
  try {
    const result = await f.jobs.expandNext("a");
    assert.ok("complete" in result && result.complete);
    const before = await snapshot(f);
    await f.full([observation("op", "operation"), ...f.sources]);
    assert.deepEqual(await snapshot(f), before);
    assert.equal((await f.jobs.expandNext("a")).kind, "idle");
    assert.equal((await f.jobs.projectNext("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("newer operation work resets its cursor and rejects the older prepared completion", async () => {
  const f = await prepared();
  try {
    await f.jobs.publish(f.page);
    const next = await f.jobs.prepare(
      "a",
      f.generation,
      "source",
      "op",
      f.lease,
      2,
    );
    assert.ok(next?.complete);
    await f.edit(3);
    const before = await snapshot(f);
    await assert.rejects(f.jobs.publish(next), /changed/);
    assert.deepEqual(await snapshot(f), before);
    const job = before.jobs[0] as {
      cursor_key: string;
      work_version: number;
      completed_version: number;
    };
    assert.equal(job.cursor_key, "");
    assert.ok(job.work_version > job.completed_version);
    assert.equal(
      (await f.jobs.publish(f.page)).recovered,
      true,
      "old receipt cannot advance newer work",
    );
    assert.deepEqual(await snapshot(f), before);
  } finally {
    await f.mf.dispose();
  }
});

test("native projection fan-out rejects omitted children, lease races and early completion", async (t) => {
  for (const failure of ["omission", "completion", "lease"] as const)
    await t.test(failure, async () => {
      const f = await prepared();
      try {
        const page = structuredClone(f.page);
        if (failure === "omission") page.records--;
        else if (failure === "completion") page.complete = true;
        else
          await f.db
            .prepare(
              "UPDATE leases SET expires_at=0 WHERE scope LIKE '%projection-fanout%'",
            )
            .run();
        await resign(page);
        const before = await snapshot(f);
        await assert.rejects(f.jobs.publish(page), /changed/);
        assert.deepEqual(await snapshot(f), before);
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT count(*) AS n FROM inventory_projection_job_pages",
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

test("fan-out rollback and lost acknowledgements preserve exactly the claimed continuation", async (t) => {
  for (const failure of ["sql", "authority", "context", "ack"] as const)
    await t.test(failure, async () => {
      const f = await prepared();
      try {
        const before = await snapshot(f);
        const store = alteredStore(f, async (plan) => {
          if (failure === "ack") {
            await f.db.batch(plan);
            throw new Error("lost acknowledgement");
          }
          const changed = [...plan];
          changed.splice(
            changed.length - 1,
            0,
            f.db.prepare(
              failure === "sql"
                ? "SELECT * FROM intentional_missing_projection_job_table"
                : failure === "authority"
                  ? "UPDATE accounts SET status='locked' WHERE id='a'"
                  : "UPDATE projection_domains SET topology_version=topology_version+1 WHERE scope_id='source'",
            ),
          );
          return f.db.batch(changed);
        });
        const jobs = new InventoryProjectionJobs(store);
        if (failure === "ack") {
          assert.equal((await jobs.publish(f.page)).recovered, true);
          const after = await snapshot(f);
          assert.equal((await f.jobs.publish(f.page)).recovered, true);
          assert.deepEqual(await snapshot(f), after);
          await assert.rejects(
            f.db
              .prepare(
                "UPDATE inventory_projection_jobs SET completed_version=work_version",
              )
              .run(),
            /publication guard/,
          );
          await assert.rejects(
            f.db.prepare("DELETE FROM inventory_projection_jobs").run(),
            /pending inventory projection job/,
          );
          await assert.rejects(
            f.db.prepare("DELETE FROM inventory_projection_job_pages").run(),
            /retained inventory projection job receipt/,
          );
        } else {
          await assert.rejects(jobs.publish(f.page));
          assert.deepEqual(await snapshot(f), before);
          assert.equal(
            (
              await f.db
                .prepare(
                  "SELECT count(*) AS n FROM inventory_projection_job_pages",
                )
                .first<{ n: number }>()
            )?.n,
            0,
          );
        }
      } finally {
        await f.mf.dispose();
      }
    });
});

test("new generations enroll context jobs and already pending children do not receive repeated versions", async () => {
  const f = await fixture();
  try {
    await f.jobs.expandNext("a");
    const generation = await new InventoryComparisonGenerations(f.store).begin(
      "a",
    );
    assert.ok(generation.pending_generation);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_projection_jobs")
          .first<{ n: number }>()
      )?.n,
      2,
    );
    assert.equal(
      (await f.jobs.expandNext("a")).kind,
      "idle",
      "unfinished indexes must not advance fan-out",
    );
    const builds = new InventoryComparisonBuilds(f.store);
    await builds.step("a", generation.pending_generation, "source");
    const before = (
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE generation_id=? ORDER BY record_key",
        )
        .bind(generation.pending_generation)
        .all()
    ).results;
    const result = await f.jobs.expandNext("a");
    assert.ok("complete" in result && result.complete);
    const after = (
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE generation_id=? ORDER BY record_key",
        )
        .bind(generation.pending_generation)
        .all()
    ).results;
    assert.deepEqual(after, before, "fan-out must coalesce already dirty work");
    const projected = await f.jobs.projectNext("a");
    assert.ok("records" in projected);
    assert.equal(projected.records, 3);
  } finally {
    await f.mf.dispose();
  }
});
