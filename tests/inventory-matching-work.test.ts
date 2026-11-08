import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import {
  InventoryMatchingResults,
  type InventoryMatchingWorkClaim,
} from "../src/inventory-matching-results.ts";
import { Store } from "../src/store.ts";
import { InventoryMatchingWork } from "../src/inventory-matching-work.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

async function captured(count = 1) {
  const f = await matchingWorkFixture({
    sources: Array.from({ length: count }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: count }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    assert.equal(
      (await f.work.enqueue("a", f.generation, "destination", f.selected))
        .records,
      count,
    );
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const claims = (
      await f.db
        .prepare(
          "SELECT source_scope AS scope,record_key AS key,work_version AS workVersion,completed_version AS completedVersion,source_config_version AS sourceConfigVersion,destination_config_version AS destinationConfigVersion,due_at AS dueAt FROM matching_work WHERE tenant='a' ORDER BY record_key",
        )
        .all<InventoryMatchingWorkClaim>()
    ).results;
    const page = await f.workspace.prepare("a", "destination", f.selected);
    return { ...f, lease, claims, page };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
async function counts(f: Awaited<ReturnType<typeof matchingWorkFixture>>) {
  return f.db
    .prepare(
      "SELECT count(*) AS total,sum(completed_version=work_version) AS done,coalesce(sum(hold_reason='capacity'),0) AS held FROM matching_work WHERE tenant='a'",
    )
    .first<{ total: number; done: number; held: number | null }>();
}
async function retainedWork(
  f: Awaited<ReturnType<typeof matchingWorkFixture>>,
) {
  await f.db
    .prepare(
      "INSERT INTO matching_work(tenant,generation_id,destination,source_scope,record_key,source_config_version,destination_config_version) SELECT r.tenant,r.generation_id,r.destination,r.source_scope,j.value,r.source_config_version,r.destination_config_version FROM inventory_matching_source_routes r CROSS JOIN json_each(?) j WHERE r.tenant='a' AND r.generation_id=? AND r.destination='destination' AND r.source_scope='source'",
    )
    .bind(
      JSON.stringify(Array.from({ length: 5000 }, (_, i) => `retained${i}`)),
      f.generation,
    )
    .run();
}

test("one native twenty-result publication completes exactly its claimed work and replays safely", async (t) => {
  const f = await captured(20);
  try {
    const result = await f.matches.publish(
      f.page,
      f.lease,
      "twenty-work",
      f.claims,
    );
    assert.equal(result.records, 20);
    assert.equal(result.statements, 14);
    t.diagnostic(
      `20 work completions: ${result.statements} statements, ${result.rowsRead} rows read, ${result.rowsWritten} rows written`,
    );
    assert.equal((await counts(f))?.done, 20);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      20,
    );
    assert.equal(
      (await f.matches.publish(f.page, f.lease, "twenty-work", f.claims))
        .recovered,
      true,
    );
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    assert.equal((await counts(f))?.done, 0);
    assert.equal(
      (await f.matches.publish(f.page, f.lease, "twenty-work", f.claims))
        .recovered,
      true,
    );
    assert.equal(
      (await counts(f))?.done,
      0,
      "old receipt must not complete newer work",
    );
    await assert.rejects(
      f.matches.publish(
        f.page,
        f.lease,
        "twenty-work",
        f.claims.map((row) => ({
          ...row,
          workVersion: 2,
          completedVersion: 1,
        })),
      ),
      /receipt_conflict/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("durable turns process twenty keys then resume the remainder without changing source evidence", async () => {
  const f = await matchingWorkFixture({
    sources: Array.from({ length: 21 }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: 21 }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    const before = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    const first = await f.work.step("a");
    assert.equal(first.kind, "matched");
    assert.ok("records" in first && first.records === 20);
    assert.equal((await counts(f))?.done, 20);
    const second = await f.work.step("a");
    assert.ok("records" in second && second.records === 1);
    assert.equal((await counts(f))?.done, 21);
    assert.equal((await f.work.step("a")).kind, "idle");
    assert.equal(
      (await f.matches.current("a", "destination", f.selected.slice(0, 20)))
        .results.length,
      20,
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    for (const table of ["ledger", "attempts"])
      assert.equal(
        (
          await f.db
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
      );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM leases WHERE scope='matching:destination' AND expires_at>unixepoch('subsec')*1000",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("new invalidation rejects a captured completion and bare result publication cannot clear queued work", async () => {
  const f = await captured();
  try {
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    await assert.rejects(
      f.matches.publish(f.page, f.lease, "old-work", f.claims),
      /claimed work changed/,
    );
    assert.equal((await counts(f))?.done, 0);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_match_sets")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await f.matches.publish(f.page, f.lease, "bare-result");
    assert.equal((await counts(f))?.done, 0);
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE matching_work SET completed_version=work_version,last_completed_set='bare-result'",
        )
        .run(),
      /completion guard missing/,
    );
    assert.equal((await counts(f))?.done, 0);
  } finally {
    await f.mf.dispose();
  }
});

test("native admission rejects missing claimed rows even after application validation", async () => {
  const f = await captured(2);
  try {
    const statement = f.store.statement.bind(f.store);
    f.store.statement = (sql, ...parameters) => {
      if (sql.startsWith("INSERT INTO inventory_match_work_rows"))
        parameters[2] = JSON.stringify(
          JSON.parse(parameters[2] as string).slice(1),
        );
      return statement(sql, ...parameters);
    };
    await assert.rejects(
      f.matches.publish(f.page, f.lease, "omitted-work", f.claims),
      /claim incomplete/,
    );
    assert.equal((await counts(f))?.done, 0);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_match_sets")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("lost acknowledgement recovery does not finish a newer work version", async () => {
  const f = await captured();
  try {
    let lost = false;
    const db = new Proxy(f.db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!lost) {
              lost = true;
              throw new Error("lost matching work acknowledgement");
            }
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const matches = new InventoryMatchingResults(new Store(db, f.store.keys));
    assert.equal(
      (await matches.publish(f.page, f.lease, "lost-work", f.claims)).recovered,
      true,
    );
    assert.equal((await counts(f))?.done, 1);
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    assert.equal(
      (await matches.publish(f.page, f.lease, "lost-work", f.claims)).recovered,
      true,
    );
    assert.equal((await counts(f))?.done, 0);
  } finally {
    await f.mf.dispose();
  }
});

test("one over-capacity comparison stays pending with a durable paced hold", async () => {
  const f = await matchingWorkFixture({
    receipts: Array.from({ length: 129 }, (_, i) => receipt(String(i))),
  });
  try {
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    assert.deepEqual(await f.work.step("a"), {
      kind: "held",
      records: 1,
      reason: "capacity",
    });
    assert.equal((await counts(f))?.done, 0);
    assert.equal((await counts(f))?.held, 1);
    assert.equal((await f.work.step("a")).kind, "idle");
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM match_results")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    assert.equal(
      (await counts(f))?.held,
      0,
      "new work clears the capacity delay",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("real candidate-union overflow splits a cohort without completing its unprocessed keys", async () => {
  const f = await matchingWorkFixture({
    sources: Array.from({ length: 20 }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: 120 }, (_, i) =>
      receipt(String(i), "130000", `W${Math.floor(i / 6)}AW`),
    ),
  });
  try {
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    const first = await f.work.step("a");
    assert.ok("records" in first && first.records === 10);
    assert.equal((await counts(f))?.done, 10);
    const second = await f.work.step("a");
    assert.ok("records" in second && second.records === 10);
    assert.equal((await counts(f))?.done, 20);
    assert.equal((await f.work.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("source reprojection atomically reopens its completed comparison work", async () => {
  const f = await matchingWorkFixture();
  try {
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    await f.work.step("a");
    assert.equal((await counts(f))?.done, 1);
    const changed = sourceContact("q0");
    changed.order = 2;
    changed.revision = "2";
    changed.body = {
      ...(changed.body as object),
      notes: "Changed private source note",
    };
    await f.full([observation("op", "operation"), changed]);
    await f.project("source");
    assert.equal((await counts(f))?.done, 0);
    assert.equal(
      (
        await f.db
          .prepare("SELECT work_version FROM matching_work")
          .first<{ work_version: number }>()
      )?.work_version,
      2,
    );
    assert.equal((await f.work.step("a")).kind, "matched");
    assert.equal((await counts(f))?.done, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("future work, configuration changes and expired leases reject captured publication", async (t) => {
  for (const sql of [
    "UPDATE matching_work SET due_at=unixepoch('subsec')*1000+300000",
    "UPDATE inventory_scopes SET config_version=config_version+1 WHERE scope_id='source'",
    "UPDATE inventory_scopes SET config_version=config_version+1 WHERE scope_id='destination'",
    "UPDATE leases SET expires_at=0 WHERE scope='matching:destination'",
  ])
    await t.test(sql, async () => {
      const f = await captured();
      try {
        await f.db.prepare(sql).run();
        await assert.rejects(
          f.matches.publish(f.page, f.lease, "stale-work", f.claims),
          /changed|missing/,
        );
        assert.equal((await counts(f))?.done, 0);
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM inventory_match_sets")
              .first<{ n: number }>()
          )?.n,
          0,
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("late failures roll back both result pointers and work completion", async (t) => {
  for (const [kind, sql] of [
    ["sql", "SELECT * FROM deliberately_missing_matching_work_table"],
    ["authority", "UPDATE accounts SET status='locked' WHERE id='a'"],
    [
      "invalidation",
      "UPDATE matching_work SET work_version=work_version+1,due_at=0,hold_reason=NULL",
    ],
  ])
    await t.test(kind, async () => {
      const f = await captured();
      try {
        const db = new Proxy(f.db, {
          get(target, property) {
            if (property === "batch")
              return (statements: D1PreparedStatement[]) =>
                target.batch([
                  ...statements.slice(0, -1),
                  target.prepare(sql),
                  statements.at(-1)!,
                ]);
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const matches = new InventoryMatchingResults(
          new Store(db, f.store.keys),
        );
        await assert.rejects(
          matches.publish(f.page, f.lease, "late-work", f.claims),
        );
        assert.equal((await counts(f))?.done, 0);
        assert.equal(
          (
            await f.db
              .prepare("SELECT work_version FROM matching_work")
              .first<{ work_version: number }>()
          )?.work_version,
          1,
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM match_results")
              .first<{ n: number }>()
          )?.n,
          0,
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM inventory_match_sets")
              .first<{ n: number }>()
          )?.n,
          0,
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT status FROM accounts WHERE id='a'")
              .first<{ status: string }>()
          )?.status,
          "active",
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("completing twenty claimed keys does not traverse thousands of unrelated pending jobs", async (t) => {
  const f = await captured(20);
  try {
    const publications: number[][] = [];
    const db = new Proxy(f.db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            publications.push(results.map((result) => result.meta.rows_read));
            return results;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const matches = new InventoryMatchingResults(new Store(db, f.store.keys));
    await f.matches.publish(f.page, f.lease, "warm-work", f.claims);
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    const baseline = await matches.publish(
      f.page,
      f.lease,
      "baseline-work",
      f.claims.map((row) => ({ ...row, workVersion: 2, completedVersion: 1 })),
    );
    await retainedWork(f);
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    const result = await matches.publish(
      f.page,
      f.lease,
      "retained-work",
      f.claims.map((row) => ({ ...row, workVersion: 3, completedVersion: 2 })),
    );
    t.diagnostic(
      `20 work completions before/after 5000 unrelated jobs: reads=${baseline.rowsRead}/${result.rowsRead}, writes=${baseline.rowsWritten}/${result.rowsWritten}`,
    );
    t.diagnostic(
      `final commit reads before/after unrelated growth: ${publications[0].at(-1)}/${publications[1].at(-1)}`,
    );
    assert.ok(publications[1].at(-1)! <= publications[0].at(-1)! + 8);
    assert.ok(result.rowsRead <= baseline.rowsRead + 128);
    assert.equal(result.rowsWritten, baseline.rowsWritten);
    assert.equal((await counts(f))?.done, 20);
    assert.equal((await counts(f))?.total, 5020);
  } finally {
    await f.mf.dispose();
  }
});

test("idle matching selection skips retained pending jobs in retired generations", async (t) => {
  const f = await matchingWorkFixture();
  try {
    await retainedWork(f);
    const generations = new InventoryComparisonGenerations(f.store);
    const next = (await generations.begin("a")).pending_generation;
    assert.ok(next);
    const builds = new InventoryComparisonBuilds(f.store);
    for (const scope of ["source", "destination"]) {
      const built = await builds.step("a", next, scope);
      assert.ok("complete" in built && built.complete);
      await f.projections.project(
        "a",
        next,
        scope,
        scope === "source" ? ["q0"] : ["1"],
      );
    }
    await builds.activate("a", next);
    assert.equal((await f.work.step("a")).kind, "matched");
    let read = 0;
    const store = new Store(f.db, f.store.keys);
    const statement = store.statement.bind(store);
    store.statement = (sql, ...parameters) =>
      new Proxy(statement(sql, ...parameters), {
        get(target, property) {
          if (property === "first")
            return async () => {
              const result = await target.all();
              read += result.meta.rows_read;
              return result.results[0] ?? null;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const work = new InventoryMatchingWork(store);
    assert.equal((await work.step("a")).kind, "idle");
    const retained = read;
    await f.db
      .prepare("DELETE FROM matching_work WHERE tenant='a' AND generation_id=?")
      .bind(f.generation)
      .run();
    read = 0;
    assert.equal((await work.step("a")).kind, "idle");
    t.diagnostic(
      `idle matching selector with/without 5000 retired jobs: ${retained}/${read} rows read`,
    );
    assert.ok(Math.abs(read - retained) <= 8);
  } finally {
    await f.mf.dispose();
  }
});
