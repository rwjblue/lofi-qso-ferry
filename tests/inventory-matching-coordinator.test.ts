import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { applyMigration } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import {
  installMatchingCoordinator,
  installSelectedCoordinator,
} from "./inventory-matching-coordinator-fixtures.ts";
import { coverageFixture } from "./inventory-matching-coverage-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

async function drain(coordinator: InventoryComparisonCoordinator, limit = 160) {
  const turns = [];
  for (let i = 0; i < limit; i++) {
    const turn = await coordinator.step("a");
    assert.notEqual(turn.kind, "deferred");
    turns.push(turn);
    if (!turn.more) return turns;
  }
  throw new Error("matching coordinator did not park");
}

test("the coordinator repairs every selected-source sibling after an edit", async () => {
  const sources = Array.from({ length: 21 }, (_, i) => sourceContact(`q${i}`));
  const f = await matchingWorkFixture({
    provider: "lotw",
    receipts: [],
    sources,
  });
  try {
    await installMatchingCoordinator(f.db);
    const coordinator = new InventoryComparisonCoordinator(f.store);
    await drain(coordinator);
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM match_results_current")
        .first(),
      { n: 21 },
    );
    const edited = sourceContact("q0", "14:00:00");
    edited.order = 2;
    edited.revision = "2";
    await f.full([observation("op", "operation"), edited, ...sources.slice(1)]);
    const source = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const turns = await drain(coordinator);
    assert.ok(
      turns.some(
        (turn) =>
          "phase" in turn && turn.phase === "selected" && turn.records > 0,
      ),
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT (SELECT count(*) FROM match_results_current) AS current,(SELECT count(*) FROM matching_work WHERE completed_version<work_version) AS pending,(SELECT count(*) FROM inventory_matching_selected_jobs WHERE completed_version<work_version) AS jobs,(SELECT count(*) FROM attempts) AS attempts",
        )
        .first(),
      { current: 21, pending: 0, jobs: 0, attempts: 0 },
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), source);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    for (const [order, status] of [
      [3, "deleted"],
      [4, "active"],
    ] as const) {
      const replacement = sourceContact("q0", "14:00:00");
      replacement.order = order;
      replacement.revision = String(order);
      replacement.status = status;
      await f.full([
        observation("op", "operation"),
        replacement,
        ...sources.slice(1),
      ]);
      await drain(coordinator);
      assert.deepEqual(
        await f.db
          .prepare(
            "SELECT (SELECT count(*) FROM match_results_current) AS current,(SELECT count(*) FROM matching_work WHERE completed_version<work_version) AS pending,(SELECT count(*) FROM inventory_matching_selected_jobs WHERE completed_version<work_version) AS jobs",
          )
          .first(),
        { current: 21, pending: 0, jobs: 0 },
      );
    }
  } finally {
    await f.mf.dispose();
  }
});

test("the selected-input phase upgrade retains deadlines, wake counters and account links", async () => {
  const f = await coverageFixture(1);
  try {
    await applyMigration(f.db, "0069_inventory_matching_coordinator.sql");
    const lease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const deadline = Date.now() + 300000;
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,phase=9,idle_turns=10,next_due_at=?,build_generation=?,build_scope='source' WHERE tenant='a'",
      )
      .bind(deadline, f.generation)
      .run();
    await f.store.release(lease);
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET work_version=work_version+1 WHERE tenant='a'",
      )
      .run();
    const before = await f.db
      .prepare("SELECT * FROM inventory_comparison_coordinators")
      .first();
    const credential = await f.store.private("a", "source", "v1", "credential");
    await installSelectedCoordinator(f.db);
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM inventory_comparison_coordinators")
        .first(),
      { ...before, phase_count: 11, idle_turns: 0 },
    );
    const version = async () =>
      (await f.db
        .prepare(
          "SELECT work_version AS n FROM inventory_comparison_coordinators",
        )
        .first<{ n: number }>())!.n;
    const previous = await version();
    const { InventoryMatchingSelected } = await import(
      "../src/inventory-matching-selected.ts"
    );
    const result = await new InventoryMatchingSelected(f.store).step("a");
    assert.ok("records" in result && result.records === 1);
    assert.equal(await version(), previous + 1);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    await assert.rejects(
      f.db
        .prepare("UPDATE inventory_comparison_coordinators SET phase_count=12")
        .run(),
      /regressed/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("the coordinator enrolls an inventory and automatically recovers coverage-held comparisons", async () => {
  const f = await matchingWorkFixture({
    provider: "lotw",
    receipts: [],
    range: ["2026-11-09", "2026-11-09"],
    sources: Array.from({ length: 41 }, (_, i) => sourceContact(`q${i}`)),
  });
  try {
    await installMatchingCoordinator(f.db);
    const coordinator = new InventoryComparisonCoordinator(f.store);
    const source = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const first = await drain(coordinator);
    assert.ok(
      first.some(
        (row) => "phase" in row && row.phase === "pair" && row.records === 41,
      ),
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM match_results WHERE state='incomplete'",
          )
          .first<{ n: number }>()
      )?.n,
      41,
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT phase_count,idle_turns,next_due_at FROM inventory_comparison_coordinators",
        )
        .first(),
      { phase_count: 11, idle_turns: 11, next_due_at: 0 },
    );
    const projections = (
      await f.db
        .prepare(
          "SELECT * FROM comparison_projections ORDER BY scope_id,record_key",
        )
        .all()
    ).results;
    await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
    const wake = await f.db
      .prepare(
        "SELECT work_version,observed_version FROM inventory_comparison_coordinators",
      )
      .first<{ work_version: number; observed_version: number }>();
    assert.ok(wake && wake.work_version > wake.observed_version);
    const recovered = await drain(coordinator);
    for (const phase of ["coverage-events", "coverage-match", "match"])
      assert.ok(
        recovered.some(
          (row) =>
            "phase" in row && row.phase === phase && row.kind === "advanced",
        ),
      );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT (SELECT count(*) FROM match_results_current WHERE state='absent_at_inventory') AS absent,(SELECT count(*) FROM matching_work WHERE completed_version<work_version) AS pending,(SELECT count(*) FROM inventory_matching_coverage_dependents) AS nodes,(SELECT count(*) FROM attempts) AS attempts",
        )
        .first(),
      { absent: 41, pending: 0, nodes: 0, attempts: 0 },
    );
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT * FROM comparison_projections ORDER BY scope_id,record_key",
          )
          .all()
      ).results,
      projections,
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), source);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("widening coordinator metadata preserves pending wakeups, cursors and linked credentials", async () => {
  const f = await coverageFixture(1);
  try {
    const lease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,phase=4,idle_turns=5,build_generation=?,build_scope='source' WHERE tenant='a'",
      )
      .bind(f.generation)
      .run();
    await f.store.release(lease);
    const before = await f.db
      .prepare("SELECT * FROM inventory_comparison_coordinators")
      .first<Record<string, unknown>>();
    assert.ok(before);
    const credential = await f.store.private("a", "source", "v1", "credential");
    await applyMigration(f.db, "0069_inventory_matching_coordinator.sql");
    const after = await f.db
      .prepare("SELECT * FROM inventory_comparison_coordinators")
      .first<Record<string, unknown>>();
    assert.ok(after);
    assert.deepEqual(after, {
      ...before,
      phase_count: 10,
      idle_turns: 0,
      next_due_at: 0,
    });
    await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
    const wake = await f.db
      .prepare(
        "SELECT work_version,observed_version FROM inventory_comparison_coordinators",
      )
      .first<{ work_version: number; observed_version: number }>();
    assert.ok(wake && wake.work_version > wake.observed_version);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    await assert.rejects(
      f.db
        .prepare("UPDATE inventory_comparison_coordinators SET phase_count=11")
        .run(),
      /regressed/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("bulk enqueue and a two-hundred-reference prefix publication wake the coordinator once each", async (t) => {
  const f = await coverageFixture(205);
  try {
    await applyMigration(f.db, "0069_inventory_matching_coordinator.sql");
    async function version() {
      const row = await f.db
        .prepare("SELECT work_version FROM inventory_comparison_coordinators")
        .first<{ work_version: number }>();
      assert.ok(row);
      return row.work_version;
    }
    const before = await version();
    const expansion = await f.coverage.step("a");
    assert.ok("records" in expansion);
    assert.equal(expansion.records, 200);
    assert.equal(await version(), before + 1);
    t.diagnostic(
      `200-reference prefix publication with coordinator wake: ${expansion.statements} statements, ${expansion.rowsRead} reads, ${expansion.rowsWritten} writes`,
    );
    const next = await f.work.enqueue(
      "a",
      f.generation,
      "destination",
      f.selected.slice(0, 200),
    );
    assert.equal(next.records, 200);
    assert.equal(await version(), before + 2);
  } finally {
    await f.mf.dispose();
  }
});

test("capacity deferrals survive parking and a due deadline resumes the full coordinator cycle", async () => {
  const f = await coverageFixture(1);
  try {
    await applyMigration(f.db, "0069_inventory_matching_coordinator.sql");
    await installSelectedCoordinator(f.db);
    const coordinator = new InventoryComparisonCoordinator(f.store);
    await drain(coordinator);
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    const matchingLease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60000,
    );
    assert.ok(matchingLease);
    const due = Date.now() + 300000;
    await f.db
      .prepare(
        "UPDATE matching_work SET due_at=?,hold_reason='capacity' WHERE tenant='a'",
      )
      .bind(due)
      .run();
    await f.store.release(matchingLease);
    const parked = await drain(coordinator);
    const last = parked.at(-1);
    assert.ok(last && "nextDueAt" in last);
    assert.equal(last.nextDueAt, due);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM matching_work WHERE completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    // Model the deadline becoming due without changing upstream observations or
    // sleeping through the production five-minute deferral.
    const retryLease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60000,
    );
    assert.ok(retryLease);
    await f.db
      .prepare("UPDATE matching_work SET due_at=? WHERE tenant='a'")
      .bind(Date.now() - 1)
      .run();
    await f.store.release(retryLease);
    const controlLease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    assert.ok(controlLease);
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,next_due_at=? WHERE tenant='a'",
      )
      .bind(Date.now() - 1)
      .run();
    await f.store.release(controlLease);
    const resumed = await drain(coordinator);
    assert.ok(
      resumed.some(
        (row) =>
          "phase" in row && row.phase === "match" && row.kind === "advanced",
      ),
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM matching_work WHERE completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT idle_turns,next_due_at FROM inventory_comparison_coordinators",
        )
        .first(),
      { idle_turns: 11, next_due_at: 0 },
    );
  } finally {
    await f.mf.dispose();
  }
});
