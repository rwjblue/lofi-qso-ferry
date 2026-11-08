import assert from "node:assert/strict";
import test from "node:test";
import { matchingSelectedLeaseScope } from "../src/inventory-matching-selected.ts";
import { applyMigration } from "./helpers.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { selectedPagesFixture } from "./inventory-matching-selected-fixtures.ts";

async function fixture(count = 20) {
  const f = await selectedPagesFixture({
    receipts: [],
    sources: Array.from({ length: count }, (_, i) => sourceContact(`q${i}`)),
  });
  try {
    await applyMigration(f.db, "0075_inventory_matching_selected_observed.sql");
    await f.matches.match("a", "destination", f.selected);
    return f;
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function signal(f: Fixture, keys = ["q0"]) {
  await f.projections.project("a", f.generation, "source", keys);
}
async function pending(f: Fixture) {
  return (
    await f.db
      .prepare(
        "SELECT count(*) AS n FROM inventory_matching_selected_jobs WHERE completed_version<work_version",
      )
      .first<{ n: number }>()
  )?.n;
}
const key = (f: Fixture) => ({
  generation: f.generation,
  scope: "source",
  facet: "source" as const,
  record: "q0",
});

test("a replacement cohort completes all observed signals without empty pages", async () => {
  const f = await fixture();
  try {
    await signal(
      f,
      f.selected.map((row) => row.key),
    );
    assert.equal(await pending(f), 20);
    const clocks = await f.db
      .prepare(
        "SELECT record_key,work_version,signal_clock,last_turn FROM inventory_matching_selected_jobs ORDER BY record_key",
      )
      .all();
    await f.matches.match("a", "destination", f.selected);
    assert.equal(await pending(f), 0);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT record_key,work_version,signal_clock,last_turn FROM inventory_matching_selected_jobs ORDER BY record_key",
          )
          .all()
      ).results,
      clocks.results,
    );
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

test("moving one result cannot complete a signal still used by its old siblings", async () => {
  const f = await fixture(3);
  try {
    await signal(f);
    await f.matches.match("a", "destination", f.selected.slice(0, 1));
    assert.equal(await pending(f), 1);
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_selected_jobs SET completed_version=work_version",
        )
        .run(),
      /progress guard missing/,
    );
    const result = await f.selectedInputs.step("a");
    assert.ok("records" in result && result.records === 2);
    assert.equal(await pending(f), 0);
  } finally {
    await f.mf.dispose();
  }
});

test("an older prepared page cannot overwrite completion or a later signal", async () => {
  const f = await fixture(3);
  try {
    await signal(f);
    const lease = await f.store.claim(
      "a",
      matchingSelectedLeaseScope(key(f)),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.selectedInputs.prepare("a", key(f), lease);
    assert.ok(page);
    await f.matches.match("a", "destination", f.selected);
    assert.equal(await pending(f), 0);
    await assert.rejects(f.selectedInputs.publish(page), /frontier changed/);
    await signal(f);
    assert.equal(await pending(f), 1);
    await assert.rejects(f.selectedInputs.publish(page), /authority changed/);
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_selected_jobs SET completed_version=work_version",
        )
        .run(),
      /progress guard missing/,
    );
    await f.store.release(lease);
    const result = await f.selectedInputs.step("a");
    assert.ok("records" in result && result.records === 3);
    assert.equal(await pending(f), 0);
  } finally {
    await f.mf.dispose();
  }
});

test("a late publication failure rolls back observed completion with the results", async () => {
  const f = await fixture(3);
  try {
    await signal(f);
    const before = await f.db
      .prepare("SELECT * FROM match_results ORDER BY record_key")
      .all();
    await f.db
      .prepare(
        "CREATE TRIGGER fail_observed AFTER UPDATE ON inventory_matching_selected_jobs WHEN NEW.completed_version>OLD.completed_version BEGIN SELECT RAISE(ABORT,'late observed failure'); END;",
      )
      .run();
    await assert.rejects(
      f.matches.match("a", "destination", f.selected),
      /late observed failure/,
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
    await f.db.prepare("DROP TRIGGER fail_observed").run();
    await f.matches.match("a", "destination", f.selected);
    assert.equal(await pending(f), 0);
  } finally {
    await f.mf.dispose();
  }
});

test("recovery of a committed match receipt leaves a newer signal pending", async () => {
  const f = await fixture(3);
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
    await f.matches.publish(page, lease, "observed-receipt");
    assert.equal(await pending(f), 0);
    await signal(f);
    const recovered = await f.matches.publish(page, lease, "observed-receipt");
    assert.ok(recovered.recovered);
    assert.equal(recovered.statements, 0);
    assert.equal(await pending(f), 1);
    await f.store.release(lease);
    const result = await f.selectedInputs.step("a");
    assert.ok("records" in result && result.records === 3);
  } finally {
    await f.mf.dispose();
  }
});

test("observed completion probes selected keys without scanning unrelated job history", async (t) => {
  const f = await fixture(3);
  try {
    const keys = f.selected.map((row) => row.key);
    await signal(f, keys);
    const before = await f.matches.match("a", "destination", f.selected);
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
    await signal(f, keys);
    const after = await f.matches.match("a", "destination", f.selected);
    assert.ok("rowsRead" in after);
    assert.ok(after.rowsRead <= before.rowsRead + 100);
    t.diagnostic(
      `publication: ${before.rowsRead} reads before history, ${after.rowsRead} after 4,000 unrelated completed jobs`,
    );
    assert.equal(await pending(f), 0);
  } finally {
    await f.mf.dispose();
  }
});
