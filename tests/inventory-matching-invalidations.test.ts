import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import {
  InventoryMatchingInvalidations,
  matchingBucketLeaseScope,
  type MatchingBucketKey,
} from "../src/inventory-matching-invalidations.ts";
import { Store } from "../src/store.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { invalidationFixture } from "./inventory-matching-invalidations-fixtures.ts";

async function seedMatches(f: Awaited<ReturnType<typeof invalidationFixture>>) {
  await f.work.enqueue("a", f.generation, "destination", f.selected);
  const result = await f.work.step("a");
  assert.ok(result.kind === "matched");
  return result;
}
test("only current cohorts register complete forward/reverse bucket dependencies", async (t) => {
  const f = await invalidationFixture({
    sources: Array.from({ length: 20 }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: 20 }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    const initial = await seedMatches(f);
    t.diagnostic(
      `20 first results with live dependencies: ${initial.statements} statements, ${initial.rowsRead} reads, ${initial.rowsWritten} writes`,
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS sets,sum(ref_count) AS refs FROM inventory_match_live_sets",
        )
        .first(),
      { sets: 1, refs: 20 },
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_bucket_dependents",
          )
          .first<{ n: number }>()
      )?.n,
      168,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_matching_bucket_jobs")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    const result = await f.work.step("a");
    assert.equal(result.kind, "matched");
    assert.ok("rowsRead" in result);
    t.diagnostic(
      `20 replacements with live dependencies: ${result.rowsRead} reads, ${result.rowsWritten} writes`,
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS sets,sum(ref_count) AS refs FROM inventory_match_live_sets",
        )
        .first(),
      { sets: 1, refs: 20 },
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_bucket_dependents",
          )
          .first<{ n: number }>()
      )?.n,
      168,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_match_sets")
          .first<{ n: number }>()
      )?.n,
      2,
      "retained proofs remain separate from current scheduling entries",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a destination time move queues its old bucket and recomputes the current comparison", async (t) => {
  const f = await invalidationFixture();
  try {
    await seedMatches(f);
    await f.fullReceipt([receipt("1", "140000")]);
    await f.project("destination");
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      0,
    );
    const result = await f.invalidations.step("a");
    assert.equal(result.kind, "expanded");
    assert.ok("records" in result && result.records === 1);
    assert.ok("statements" in result);
    t.diagnostic(
      `one bucket invalidation: ${result.statements} statements, ${result.rowsRead} reads, ${result.rowsWritten} writes`,
    );
    assert.equal((await f.work.step("a")).kind, "matched");
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        ?.state,
      "absent_at_inventory",
    );
    assert.equal((await f.invalidations.step("a")).kind, "idle");
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a comparison recomputed after a bucket signal is not requeued by its older pending invalidation", async () => {
  const f = await invalidationFixture();
  try {
    await seedMatches(f);
    await f.projections.project("a", f.generation, "source", ["q0"]);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_bucket_jobs WHERE completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal((await f.work.step("a")).kind, "matched");
    const before = await f.db
      .prepare("SELECT work_version,completed_version FROM matching_work")
      .first();
    const result = await f.invalidations.step("a");
    assert.ok(
      "records" in result &&
        result.records === 0 &&
        result.sets === 0 &&
        result.complete,
    );
    assert.deepEqual(
      await f.db
        .prepare("SELECT work_version,completed_version FROM matching_work")
        .first(),
      before,
    );
    assert.equal((await f.invalidations.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

async function signal(f: Awaited<ReturnType<typeof invalidationFixture>>) {
  await f.fullReceipt([receipt("1")]);
  await f.project("destination");
  const key = await f.db
    .prepare(
      "SELECT generation_id AS generation,scope_id AS scope,key_class AS keyClass,bucket_hash AS hash FROM inventory_matching_bucket_jobs WHERE tenant='a' AND completed_version<work_version ORDER BY scope_id,key_class,bucket_hash LIMIT 1",
    )
    .first<MatchingBucketKey>();
  assert.ok(key);
  return key;
}
async function cohorts(count: number, size = 20) {
  const f = await invalidationFixture({
    sources: Array.from({ length: count }, (_, i) =>
      sourceContact(`q${String(i).padStart(4, "0")}`),
    ),
    receipts: [],
  });
  try {
    for (let start = 0; start < f.selected.length; start += size)
      assert.ok(
        "records" in
          (await f.matches.match(
            "a",
            "destination",
            f.selected.slice(start, start + size),
          )),
      );
    return f;
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}

test("the first record in an expected-empty bucket wakes absence results", async () => {
  const f = await invalidationFixture({ receipts: [] });
  try {
    await seedMatches(f);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        ?.state,
      "absent_at_inventory",
    );
    await signal(f);
    const result = await f.invalidations.step("a");
    assert.ok("records" in result && result.records === 1);
    await f.work.step("a");
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        ?.state,
      "matched_existing",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("reverse dependencies requeue a different selected source when a competitor crosses the tolerance boundary", async () => {
  const first = sourceContact("qA", "13:00:00"),
    second = sourceContact("qB", "14:01:00");
  const f = await invalidationFixture({
    sources: [first, second],
    receipts: [receipt("1", "133000")],
  });
  const chosen = [{ scope: "source", key: "qA" }];
  try {
    await f.matches.match("a", "destination", chosen);
    assert.equal(
      (await f.matches.current("a", "destination", chosen)).results[0]?.state,
      "matched_existing",
    );
    const changed = sourceContact("qB", "14:00:00");
    changed.order = 2;
    changed.revision = "2";
    await f.full([observation("op", "operation"), first, changed]);
    await f.projections.project("a", f.generation, "source", ["qB"]);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM matching_work WHERE record_key='qA'",
          )
          .first<{ n: number }>()
      )?.n,
      0,
      "reprojecting qB must not directly enqueue qA",
    );
    const result = await f.invalidations.step("a");
    assert.ok("records" in result && result.records === 1);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM matching_work WHERE record_key='qA' AND completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    await f.work.step("a");
    assert.equal(
      (await f.matches.current("a", "destination", chosen)).results[0]?.state,
      "ambiguous",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("one bucket expands ten cohorts and at most two hundred current results per durable page", async (t) => {
  const f = await cohorts(220);
  try {
    await signal(f);
    const first = await f.invalidations.step("a");
    assert.ok(
      "records" in first &&
        first.records === 200 &&
        first.sets === 10 &&
        !first.complete,
    );
    t.diagnostic(
      `200 matching invalidations: ${first.statements} statements, ${first.rowsRead} reads, ${first.rowsWritten} writes`,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM matching_work")
          .first<{ n: number }>()
      )?.n,
      200,
    );
    const second = await new InventoryMatchingInvalidations(f.store).step("a");
    assert.ok(
      "records" in second &&
        second.records === 20 &&
        second.sets === 1 &&
        second.complete,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM matching_work")
          .first<{ n: number }>()
      )?.n,
      220,
    );
    assert.equal((await f.invalidations.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("partial result replacement retains old cohort dependencies until its last current reference leaves", async () => {
  const f = await invalidationFixture({
    sources: Array.from({ length: 4 }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: 4 }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    await seedMatches(f);
    const old = await f.db
      .prepare("SELECT set_id FROM inventory_match_live_sets")
      .first<{ set_id: string }>();
    assert.ok(old);
    await f.matches.match("a", "destination", f.selected.slice(0, 1));
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT ref_count FROM inventory_match_live_sets WHERE set_id=?",
          )
          .bind(old.set_id)
          .first<{ ref_count: number }>()
      )?.ref_count,
      3,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_bucket_dependents WHERE set_id=?",
          )
          .bind(old.set_id)
          .first<{ n: number }>()
      )?.n,
      40,
    );
    await f.matches.match("a", "destination", f.selected.slice(1));
    assert.equal(
      await f.db
        .prepare(
          "SELECT ref_count FROM inventory_match_live_sets WHERE set_id=?",
        )
        .bind(old.set_id)
        .first(),
      null,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_bucket_dependents WHERE set_id=?",
          )
          .bind(old.set_id)
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
      3,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("missing fallback dependencies roll back result publication and leave matching work pending", async () => {
  const f = await invalidationFixture();
  try {
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    await f.db
      .prepare(
        "CREATE TRIGGER omit_unknown_matching_dependency BEFORE INSERT ON inventory_matching_bucket_dependents WHEN NEW.key_class='unknown' BEGIN SELECT RAISE(IGNORE); END;",
      )
      .run();
    await assert.rejects(f.work.step("a"), /bucket dependencies incomplete/);
    for (const table of [
      "match_results",
      "inventory_match_live_sets",
      "inventory_matching_bucket_dependents",
    ])
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
          .prepare("SELECT completed_version FROM matching_work")
          .first<{ completed_version: number }>()
      )?.completed_version,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("lost invalidation acknowledgements cannot complete or enqueue a newer signal twice", async () => {
  const f = await cohorts(1, 1);
  try {
    const key = await signal(f);
    const lease = await f.store.claim(
      "a",
      matchingBucketLeaseScope(key),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.invalidations.prepare("a", key, lease);
    assert.ok(page);
    let lost = false;
    const db = new Proxy(f.db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!lost) {
              lost = true;
              throw new Error("lost invalidation acknowledgement");
            }
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const jobs = new InventoryMatchingInvalidations(
      new Store(db, f.store.keys),
    );
    assert.equal((await jobs.publish(page)).recovered, true);
    const before = await f.db
      .prepare("SELECT work_version FROM matching_work")
      .first();
    await f.db
      .prepare(
        "UPDATE bucket_versions SET version=version+1 WHERE tenant='a' AND generation_id=? AND scope_id=? AND key_class=? AND bucket_hash=?",
      )
      .bind(key.generation, key.scope, key.keyClass, key.hash)
      .run();
    assert.equal((await jobs.publish(page)).recovered, true);
    assert.deepEqual(
      await f.db.prepare("SELECT work_version FROM matching_work").first(),
      before,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_bucket_jobs WHERE completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    await f.store.release(lease);
    assert.equal((await f.invalidations.step("a")).kind, "expanded");
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_matching_bucket_jobs").run(),
      /retained.*clock/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("new signals and expired leases reject an older prepared invalidation", async (t) => {
  for (const mutation of ["signal", "lease", "account", "config"])
    await t.test(mutation, async () => {
      const f = await cohorts(1, 1);
      try {
        const key = await signal(f),
          lease = await f.store.claim(
            "a",
            matchingBucketLeaseScope(key),
            Date.now(),
            60000,
          );
        assert.ok(lease);
        const page = await f.invalidations.prepare("a", key, lease);
        assert.ok(page);
        if (mutation === "signal")
          await f.db
            .prepare(
              "UPDATE bucket_versions SET version=version+1 WHERE tenant='a' AND generation_id=? AND scope_id=? AND key_class=? AND bucket_hash=?",
            )
            .bind(key.generation, key.scope, key.keyClass, key.hash)
            .run();
        if (mutation === "lease")
          await f.db
            .prepare("UPDATE leases SET expires_at=0 WHERE scope=?")
            .bind(lease.scope)
            .run();
        if (mutation === "account")
          await f.db
            .prepare("UPDATE accounts SET status='locked' WHERE id='a'")
            .run();
        if (mutation === "config")
          await f.db
            .prepare(
              "UPDATE inventory_scopes SET config_version=config_version+1 WHERE scope_id=?",
            )
            .bind(key.scope)
            .run();
        await assert.rejects(f.invalidations.publish(page), /changed/);
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM matching_work")
              .first<{ n: number }>()
          )?.n,
          0,
        );
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT count(*) AS n FROM inventory_matching_bucket_pages",
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

test("late native failures roll back queued references and the bucket frontier together", async (t) => {
  for (const [name, sql] of [
    ["sql", "SELECT * FROM deliberately_missing_invalidation_table"],
    ["authority", "UPDATE accounts SET status='locked' WHERE id='a'"],
    [
      "signal",
      "UPDATE inventory_matching_bucket_jobs SET work_version=work_version+1,cursor_version=0,cursor_set=''",
    ],
    [
      "work",
      "UPDATE matching_work SET work_version=work_version+1,due_at=0,hold_reason=NULL",
    ],
  ])
    await t.test(name, async () => {
      const f = await cohorts(1, 1);
      try {
        const key = await signal(f),
          lease = await f.store.claim(
            "a",
            matchingBucketLeaseScope(key),
            Date.now(),
            60000,
          );
        assert.ok(lease);
        const page = await f.invalidations.prepare("a", key, lease);
        assert.ok(page);
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
        await assert.rejects(
          new InventoryMatchingInvalidations(
            new Store(db, f.store.keys),
          ).publish(page),
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM matching_work")
              .first<{ n: number }>()
          )?.n,
          0,
        );
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT count(*) AS n FROM inventory_matching_bucket_pages",
              )
              .first<{ n: number }>()
          )?.n,
          0,
        );
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT completed_version FROM inventory_matching_bucket_jobs",
              )
              .first<{ completed_version: number }>()
          )?.completed_version,
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

test("retiring a source queues its own comparison even when it will not publish another projection", async () => {
  const f = await invalidationFixture();
  try {
    await seedMatches(f);
    const removed = sourceContact("q0");
    removed.status = "deleted";
    removed.order = 2;
    removed.revision = "2";
    await f.full([observation("op", "operation"), removed]);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM matching_work WHERE record_key='q0' AND completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      0,
    );
    await f.work.step("a");
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        ?.state,
      "incomplete",
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native admission rejects a complete prefix that omits the rest of a bucket", async () => {
  const f = await cohorts(3, 1);
  try {
    const key = await signal(f),
      lease = await f.store.claim(
        "a",
        matchingBucketLeaseScope(key),
        Date.now(),
        60000,
      );
    assert.ok(lease);
    const page = await f.invalidations.prepare("a", key, lease);
    assert.ok(page);
    const dep = await f.db
      .prepare(
        "SELECT seen_version,set_id FROM inventory_matching_bucket_dependents WHERE tenant='a' AND generation_id=? AND scope_id=? AND key_class=? AND bucket_hash=? ORDER BY seen_version,set_id LIMIT 1",
      )
      .bind(key.generation, key.scope, key.keyClass, key.hash)
      .first<{ seen_version: number; set_id: string }>();
    assert.ok(dep);
    const j = page.job;
    const values = [
      j.tenant,
      page.pageId,
      j.generation_id,
      j.scope_id,
      j.key_class,
      j.bucket_hash,
      j.config_version,
      j.work_version,
      j.completed_version,
      j.cursor_version,
      j.cursor_set,
      dep.seen_version,
      dep.set_id,
      1,
      1,
      1,
      lease.token,
      lease.fence,
      page.digest,
      page.preparedAt,
    ];
    await assert.rejects(
      f.db
        .prepare(
          `INSERT INTO inventory_matching_bucket_pages(tenant,page_id,generation_id,scope_id,key_class,bucket_hash,config_version,work_version,completed_version,previous_version,previous_set,next_version,next_set,set_count,row_count,complete,lease_token,lease_fence,input_digest,prepared_at) VALUES(${values.map(() => "?").join(",")})`,
        )
        .bind(...values)
        .run(),
      /range incomplete/,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_matching_bucket_pages")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("silently omitted queued rows cannot advance an invalidation", async () => {
  const f = await cohorts(1, 1);
  try {
    await signal(f);
    await f.db
      .prepare(
        "CREATE TRIGGER omit_matching_bucket_row BEFORE INSERT ON inventory_matching_bucket_rows BEGIN SELECT RAISE(IGNORE); END;",
      )
      .run();
    await assert.rejects(f.invalidations.step("a"), /manifest incomplete/);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM matching_work")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT completed_version FROM inventory_matching_bucket_jobs",
          )
          .first<{ completed_version: number }>()
      )?.completed_version,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("live dependencies and reference counts cannot be erased or forged", async () => {
  const f = await invalidationFixture();
  try {
    await seedMatches(f);
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_match_live_sets").run(),
      /referenced/,
    );
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_matching_bucket_dependents").run(),
      /referenced/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_bucket_dependents SET seen_version=seen_version+1",
        )
        .run(),
      /immutable/,
    );
    await assert.rejects(
      f.db.prepare("UPDATE inventory_match_live_sets SET ref_count=2").run(),
      /references changed/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("retired pending bucket history cannot turn idle selection into a full scan", async (t) => {
  const f = await invalidationFixture();
  try {
    await seedMatches(f);
    await f.db
      .prepare(
        "INSERT INTO inventory_matching_bucket_jobs(tenant,generation_id,scope_id,key_class,bucket_hash,config_version) SELECT 'a',?,'destination','call_only',value,1 FROM json_each(?)",
      )
      .bind(
        f.generation,
        JSON.stringify(
          Array.from({ length: 5000 }, (_, i) => String(i).padStart(43, "A")),
        ),
      )
      .run();
    const next = (await new InventoryComparisonGenerations(f.store).begin("a"))
      .pending_generation;
    assert.ok(next);
    const builds = new InventoryComparisonBuilds(f.store);
    for (const scope of ["source", "destination"]) {
      const result = await builds.step("a", next, scope);
      assert.ok("complete" in result && result.complete);
      await f.projections.project(
        "a",
        next,
        scope,
        scope === "source" ? ["q0"] : ["1"],
      );
    }
    await builds.activate("a", next);
    await f.work.step("a");
    let read = 0;
    const store = new Store(f.db, f.store.keys),
      statement = store.statement.bind(store);
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
    const jobs = new InventoryMatchingInvalidations(store);
    assert.equal((await jobs.step("a")).kind, "idle");
    const retained = read;
    await f.db
      .prepare(
        "DELETE FROM inventory_matching_bucket_jobs WHERE generation_id=?",
      )
      .bind(f.generation)
      .run();
    read = 0;
    assert.equal((await jobs.step("a")).kind, "idle");
    t.diagnostic(
      `idle invalidation selector with/without 5000 retired jobs: ${retained}/${read} reads`,
    );
    assert.ok(Math.abs(retained - read) <= 8);
  } finally {
    await f.mf.dispose();
  }
});

test("bucket enqueue cost stays bounded as retained superseded proofs grow", async (t) => {
  const f = await cohorts(1, 1);
  try {
    const key = await signal(f);
    await f.matches.match("a", "destination", f.selected);
    await f.invalidations.step("a");
    const change = () =>
      f.db
        .prepare(
          "UPDATE bucket_versions SET version=version+1 WHERE tenant='a' AND generation_id=? AND scope_id=? AND key_class=? AND bucket_hash=?",
        )
        .bind(key.generation, key.scope, key.keyClass, key.hash)
        .run();
    const baseline = await change();
    for (let i = 0; i < 100; i++)
      await f.matches.match("a", "destination", f.selected);
    await f.invalidations.step("a");
    const after = await change();
    t.diagnostic(
      `bucket signal before/after 100 superseded proofs: reads=${baseline.meta.rows_read}/${after.meta.rows_read}, writes=${baseline.meta.rows_written}/${after.meta.rows_written}`,
    );
    assert.ok(after.meta.rows_read <= baseline.meta.rows_read + 8);
    assert.equal(after.meta.rows_written, baseline.meta.rows_written);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_match_live_sets")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_match_sets")
          .first<{ n: number }>()
      )?.n,
      102,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("old pending invalidations skip large current cohorts that already observed their clock", async (t) => {
  const costs = [];
  for (const count of [1, 100]) {
    const f = await cohorts(count, 1);
    try {
      const token = await f.db
        .prepare(
          "SELECT scope_id AS scope,key_class AS keyClass,bucket_hash AS hash FROM inventory_matching_bucket_dependents WHERE scope_id='destination' AND key_class='call_and_time' ORDER BY bucket_hash LIMIT 1",
        )
        .first<{
          scope: string;
          keyClass: MatchingBucketKey["keyClass"];
          hash: string;
        }>();
      assert.ok(token);
      await f.db
        .prepare(
          "INSERT INTO bucket_versions(tenant,generation_id,scope_id,key_class,bucket_hash,version) VALUES('a',?,?,?,?,1)",
        )
        .bind(f.generation, token.scope, token.keyClass, token.hash)
        .run();
      for (const chosen of f.selected)
        await f.matches.match("a", "destination", [chosen]);
      const result = await f.invalidations.step("a");
      assert.ok(
        "records" in result &&
          result.records === 0 &&
          result.sets === 0 &&
          result.complete,
      );
      costs.push(result.rowsRead);
      assert.equal(
        (
          await f.db
            .prepare("SELECT count(*) AS n FROM matching_work")
            .first<{ n: number }>()
        )?.n,
        0,
      );
    } finally {
      await f.mf.dispose();
    }
  }
  t.diagnostic(
    `empty old-clock expansion with 1/100 current observed cohorts: ${costs[0]}/${costs[1]} reads`,
  );
  assert.ok(costs[1] <= costs[0] + 8);
});
