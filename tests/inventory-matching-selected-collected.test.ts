import assert from "node:assert/strict";
import test from "node:test";
import { matchingSelectedLeaseScope } from "../src/inventory-matching-selected.ts";
import { applyMigration } from "./helpers.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { selectedPagesFixture } from "./inventory-matching-selected-fixtures.ts";

async function fixture() {
  const f = await selectedPagesFixture({
    receipts: [],
    sources: [sourceContact("q0"), sourceContact("q1"), sourceContact("q2")],
  });
  try {
    await applyMigration(f.db, "0075_inventory_matching_selected_observed.sql");
    await applyMigration(f.db, "0076_inventory_matching_bucket_observed.sql");
    await applyMigration(
      f.db,
      "0077_inventory_matching_selected_collected.sql",
    );
    await f.matches.match("a", "destination", f.selected);
    await f.projections.project("a", f.generation, "source", ["q0"]);
    await f.matches.match("a", "destination", f.selected.slice(0, 1));
    return f;
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const key = (f: Fixture) => ({
  generation: f.generation,
  scope: "source",
  facet: "source" as const,
  record: "q0",
});
async function job(f: Fixture) {
  const row = await f.db
    .prepare(
      "SELECT * FROM inventory_matching_selected_jobs WHERE record_key='q0'",
    )
    .first<{ work_version: number; completed_version: number }>();
  assert.ok(row);
  return row;
}

test("replacing the last old siblings completes an unselected identity without an empty page", async () => {
  const f = await fixture();
  try {
    const before = await job(f);
    assert.ok(before.completed_version < before.work_version);
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_selected_jobs SET completed_version=work_version WHERE record_key='q0'",
        )
        .run(),
      /progress guard missing/,
    );
    await f.matches.match("a", "destination", f.selected.slice(1));
    assert.deepEqual(await job(f), {
      ...before,
      completed_version: before.work_version,
    });
    assert.equal((await f.selectedInputs.step("a")).kind, "idle");
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_matching_selected_pages")
        .first(),
      { n: 0 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("collected completion rejects an old page and preserves a later signal", async () => {
  const f = await fixture();
  try {
    const lease = await f.store.claim(
      "a",
      matchingSelectedLeaseScope(key(f)),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.selectedInputs.prepare("a", key(f), lease);
    assert.ok(page);
    await f.matches.match("a", "destination", f.selected.slice(1));
    await assert.rejects(f.selectedInputs.publish(page), /frontier changed/);
    await f.projections.project("a", f.generation, "source", ["q0"]);
    const newer = await job(f);
    assert.ok(newer.completed_version < newer.work_version);
    await assert.rejects(f.selectedInputs.publish(page), /authority changed/);
    await f.store.release(lease);
    const expanded = await f.selectedInputs.step("a");
    assert.ok("records" in expanded && expanded.records === 1);
  } finally {
    await f.mf.dispose();
  }
});

test("a late collected-job failure rolls back sibling replacement and dependency collection", async () => {
  const f = await fixture();
  try {
    const before = await f.db
      .prepare("SELECT * FROM match_results ORDER BY record_key")
      .all();
    const dependencies = await f.db
      .prepare(
        "SELECT * FROM inventory_matching_selected_dependents ORDER BY set_id,source_scope,record_key",
      )
      .all();
    const previousJob = await job(f);
    await f.db
      .prepare(
        "CREATE TRIGGER fail_selected_collected AFTER UPDATE ON inventory_matching_selected_jobs WHEN NEW.record_key='q0' AND NEW.completed_version>OLD.completed_version BEGIN SELECT RAISE(ABORT,'late collected failure'); END;",
      )
      .run();
    await assert.rejects(
      f.matches.match("a", "destination", f.selected.slice(1)),
      /late collected failure/,
    );
    assert.deepEqual(await job(f), previousJob);
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
            "SELECT * FROM inventory_matching_selected_dependents ORDER BY set_id,source_scope,record_key",
          )
          .all()
      ).results,
      dependencies.results,
    );
    await f.db.prepare("DROP TRIGGER fail_selected_collected").run();
    await f.matches.match("a", "destination", f.selected.slice(1));
    const after = await job(f);
    assert.equal(after.completed_version, after.work_version);
  } finally {
    await f.mf.dispose();
  }
});

test("collected completion stays bounded with unrelated completed selected-input jobs", async (t) => {
  const f = await fixture();
  try {
    const before = await f.matches.match(
      "a",
      "destination",
      f.selected.slice(1),
    );
    assert.ok("rowsRead" in before);
    await f.db
      .prepare(
        "WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4000) INSERT INTO inventory_matching_selected_jobs(tenant,generation_id,scope_id,facet,record_key,config_version) SELECT 'a',?,'source','source','history-'||i,1 FROM n",
      )
      .bind(f.generation)
      .run();
    await f.db
      .prepare(
        "UPDATE inventory_matching_selected_jobs SET completed_version=work_version WHERE record_key LIKE 'history-%'",
      )
      .run();
    await f.matches.match("a", "destination", f.selected);
    await f.projections.project("a", f.generation, "source", ["q0"]);
    await f.matches.match("a", "destination", f.selected.slice(0, 1));
    const after = await f.matches.match(
      "a",
      "destination",
      f.selected.slice(1),
    );
    assert.ok("rowsRead" in after);
    assert.ok(before.rowsRead <= 2500 && after.rowsRead <= 2500);
    t.diagnostic(
      `sibling replacement: ${before.rowsRead} reads before history, ${after.rowsRead} after 4,000 unrelated jobs`,
    );
    const completed = await job(f);
    assert.equal(completed.completed_version, completed.work_version);
  } finally {
    await f.mf.dispose();
  }
});
