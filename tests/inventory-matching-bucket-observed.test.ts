import assert from "node:assert/strict";
import test from "node:test";
import {
  type MatchingBucketKey,
  matchingBucketLeaseScope,
} from "../src/inventory-matching-invalidations.ts";
import { applyMigration } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { invalidationFixture } from "./inventory-matching-invalidations-fixtures.ts";

async function fixture(count = 3) {
  const f = await invalidationFixture({
    sources: Array.from({ length: count }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: count }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    await applyMigration(f.db, "0076_inventory_matching_bucket_observed.sql");
    await f.matches.match("a", "destination", f.selected);
    return f;
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function pending(f: Fixture) {
  return (
    await f.db
      .prepare(
        "SELECT count(*) AS n FROM inventory_matching_bucket_jobs WHERE completed_version<work_version",
      )
      .first<{ n: number }>()
  )?.n;
}
async function signal(f: Fixture, keys = ["q0"]) {
  await f.projections.project("a", f.generation, "source", keys);
  const key = await f.db
    .prepare(
      "SELECT generation_id AS generation,scope_id AS scope,key_class AS keyClass,bucket_hash AS hash FROM inventory_matching_bucket_jobs WHERE completed_version<work_version ORDER BY bucket_hash LIMIT 1",
    )
    .first<MatchingBucketKey>();
  assert.ok(key);
  return key;
}

test("replacing a complete cohort finishes observed bucket jobs without empty pages", async () => {
  const f = await fixture(20);
  try {
    await signal(
      f,
      f.selected.map((row) => row.key),
    );
    assert.equal(await pending(f), 20);
    const before = await f.db
      .prepare(
        "SELECT scope_id,key_class,bucket_hash,work_version,cursor_version,cursor_set FROM inventory_matching_bucket_jobs ORDER BY bucket_hash",
      )
      .all();
    await f.matches.match("a", "destination", f.selected);
    assert.equal(await pending(f), 0);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT scope_id,key_class,bucket_hash,work_version,cursor_version,cursor_set FROM inventory_matching_bucket_jobs ORDER BY bucket_hash",
          )
          .all()
      ).results,
      before.results,
    );
    assert.equal((await f.invalidations.step("a")).kind, "idle");
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_matching_bucket_pages")
        .first(),
      { n: 0 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a surviving old cohort still requires guarded expansion", async () => {
  const f = await fixture();
  try {
    await signal(f);
    await f.matches.match("a", "destination", f.selected.slice(0, 1));
    assert.equal(await pending(f), 1);
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_bucket_jobs SET completed_version=work_version",
        )
        .run(),
      /progress guard missing/,
    );
    const result = await f.invalidations.step("a");
    assert.ok("records" in result && result.records === 2);
    assert.equal(await pending(f), 0);
  } finally {
    await f.mf.dispose();
  }
});

test("removing the last old dependency finishes a bucket absent from the replacement probes", async () => {
  const f = await fixture(1);
  try {
    const edit = sourceContact("q0", "13:00:00", "N0NEW");
    edit.order = 2;
    edit.revision = "2";
    await f.full([observation("op", "operation"), edit]);
    await f.projections.project("a", f.generation, "source", ["q0"]);
    const pendingCount = await pending(f);
    assert.ok(pendingCount && pendingCount > 0);
    const keys = await f.db
      .prepare(
        "SELECT scope_id,key_class,bucket_hash FROM inventory_matching_bucket_jobs WHERE completed_version<work_version",
      )
      .all();
    await f.matches.match("a", "destination", f.selected);
    assert.equal(await pending(f), 0);
    for (const key of keys.results) {
      assert.equal(
        await f.db
          .prepare(
            "SELECT 1 FROM inventory_matching_bucket_dependents WHERE scope_id=? AND key_class=? AND bucket_hash=? LIMIT 1",
          )
          .bind(key.scope_id, key.key_class, key.bucket_hash)
          .first(),
        null,
      );
    }
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        ?.state,
      "absent_at_inventory",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("old prepared pages cannot overwrite observed completion or a newer signal", async () => {
  const f = await fixture();
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
    await f.matches.match("a", "destination", f.selected);
    assert.equal(await pending(f), 0);
    await assert.rejects(f.invalidations.publish(page), /authority changed/);
    await signal(f);
    assert.equal(await pending(f), 1);
    await assert.rejects(f.invalidations.publish(page), /authority changed/);
    await f.store.release(lease);
    const result = await f.invalidations.step("a");
    assert.ok("records" in result && result.records === 3);
  } finally {
    await f.mf.dispose();
  }
});

test("a late completion failure rolls back result replacement and dependency collection", async () => {
  const f = await fixture();
  try {
    await signal(f);
    const before = await f.db
      .prepare("SELECT * FROM match_results ORDER BY record_key")
      .all();
    const dependencies = await f.db
      .prepare(
        "SELECT * FROM inventory_matching_bucket_dependents ORDER BY scope_id,key_class,bucket_hash",
      )
      .all();
    await f.db
      .prepare(
        "CREATE TRIGGER fail_bucket_observed AFTER UPDATE ON inventory_matching_bucket_jobs WHEN NEW.completed_version>OLD.completed_version BEGIN SELECT RAISE(ABORT,'late bucket failure'); END;",
      )
      .run();
    await assert.rejects(
      f.matches.match("a", "destination", f.selected),
      /late bucket failure/,
    );
    assert.equal(await pending(f), 1);
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM match_results ORDER BY record_key")
          .all()
      ).results,
      before.results,
    );
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT * FROM inventory_matching_bucket_dependents ORDER BY scope_id,key_class,bucket_hash",
          )
          .all()
      ).results,
      dependencies.results,
    );
    await f.db.prepare("DROP TRIGGER fail_bucket_observed").run();
    await f.matches.match("a", "destination", f.selected);
    assert.equal(await pending(f), 0);
  } finally {
    await f.mf.dispose();
  }
});

test("recovering a committed result cannot finish a later bucket signal", async () => {
  const f = await fixture();
  try {
    await signal(f);
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.workspace.prepare("a", "destination", f.selected);
    await f.matches.publish(page, lease, "observed-bucket-receipt");
    assert.equal(await pending(f), 0);
    await signal(f);
    const recovered = await f.matches.publish(
      page,
      lease,
      "observed-bucket-receipt",
    );
    assert.ok(recovered.recovered);
    assert.equal(recovered.statements, 0);
    assert.equal(await pending(f), 1);
  } finally {
    await f.mf.dispose();
  }
});

test("replacement cost stays bounded with unrelated completed bucket jobs", async (t) => {
  const f = await fixture();
  try {
    await signal(f);
    const before = await f.matches.match("a", "destination", f.selected);
    assert.ok("rowsRead" in before);
    await f.db
      .prepare(
        "WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4000) INSERT INTO inventory_matching_bucket_jobs(tenant,generation_id,scope_id,key_class,bucket_hash,config_version) SELECT 'a',?,'source','unknown',printf('%043d',i),1 FROM n",
      )
      .bind(f.generation)
      .run();
    await f.db
      .prepare(
        "UPDATE inventory_matching_bucket_jobs SET completed_version=work_version WHERE key_class='unknown'",
      )
      .run();
    await signal(f);
    const after = await f.matches.match("a", "destination", f.selected);
    assert.ok("rowsRead" in after);
    assert.ok(before.rowsRead <= 2000 && after.rowsRead <= 2000);
    t.diagnostic(
      `publication: ${before.rowsRead} reads before history, ${after.rowsRead} after 4,000 unrelated completed jobs`,
    );
    assert.equal(await pending(f), 0);
  } finally {
    await f.mf.dispose();
  }
});
