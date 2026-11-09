import assert from "node:assert/strict";
import test from "node:test";
import { InventoryAdoptionWork } from "../src/inventory-adoption-work.ts";
import { InventoryAssociations } from "../src/inventory-associations.ts";
import { InventoryOwnership } from "../src/inventory-ownership.ts";
import { applyMigration } from "./helpers.ts";
import { installMatchingCoordinator } from "./inventory-matching-coordinator-fixtures.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

async function fixture(
  provider: "qrz" | "lotw" = "qrz",
  count = 3,
  empty = false,
) {
  const f = await matchingWorkFixture({
    provider,
    sources: Array.from({ length: count }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: empty
      ? []
      : Array.from({ length: count }, (_, i) =>
          receipt(String(i), "130000", `W${i}AW`),
        ),
  });
  try {
    await installMatchingCoordinator(f.db, 72);
    await applyMigration(f.db, "0078_inventory_adoption_work.sql");
    return {
      ...f,
      adoption: new InventoryAdoptionWork(f.store),
      match: () => f.matches.match("a", "destination", f.selected),
    };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function counts(f: Fixture) {
  return f.db
    .prepare(
      "SELECT (SELECT count(*) FROM inventory_adoption_work) AS jobs,(SELECT count(*) FROM inventory_historical_associations) AS associations,(SELECT count(*) FROM inventory_ownership_evidence) AS evidence,(SELECT count(*) FROM attempts) AS attempts",
    )
    .first();
}
async function jobs(f: Fixture) {
  return (
    await f.db
      .prepare(
        "SELECT result_version,due_at,hold_reason FROM inventory_adoption_work ORDER BY record_key",
      )
      .all<{
        result_version: number;
        due_at: number;
        hold_reason: string | null;
      }>()
  ).results;
}

for (const [provider, size] of [
  ["qrz", 20],
  ["lotw", 3],
] as const)
  test(`${provider} matching enqueues and retires a guarded historical cohort`, async () => {
    const f = await fixture(provider, size);
    try {
      const before = await f.inventory.snapshot("a", "source", "sync");
      const credential = await f.store.private(
        "a",
        "source",
        "v1",
        "credential",
      );
      await f.match();
      assert.deepEqual(await counts(f), {
        jobs: size,
        associations: 0,
        evidence: 0,
        attempts: 0,
      });
      assert.deepEqual(await f.adoption.step("a"), {
        kind: "processed",
        records: size,
        completed: size,
        held: 0,
      });
      assert.deepEqual(await counts(f), {
        jobs: 0,
        associations: size,
        evidence: size,
        attempts: 0,
      });
      const archived = await f.db
        .prepare(
          "SELECT * FROM inventory_historical_associations ORDER BY record_key",
        )
        .all();
      await f.match();
      assert.deepEqual(await f.adoption.step("a"), { kind: "idle" });
      assert.deepEqual(
        (
          await f.db
            .prepare(
              "SELECT * FROM inventory_historical_associations ORDER BY record_key",
            )
            .all()
        ).results,
        archived.results,
      );
      assert.equal(
        (await f.matches.current("a", "destination", f.selected)).results
          .length,
        size,
      );
      assert.deepEqual(
        await f.inventory.snapshot("a", "source", "sync"),
        before,
      );
      assert.deepEqual(
        await f.store.private("a", "source", "v1", "credential"),
        credential,
      );
    } finally {
      await f.mf.dispose();
    }
  });

test("absence does not enqueue adoption; an omitted matched job rolls back its entire result", async () => {
  const absent = await fixture("qrz", 1, true);
  try {
    await absent.match();
    assert.equal(
      (await absent.matches.current("a", "destination", absent.selected))
        .results[0]?.state,
      "absent_at_inventory",
    );
    assert.deepEqual(await counts(absent), {
      jobs: 0,
      associations: 0,
      evidence: 0,
      attempts: 0,
    });
  } finally {
    await absent.mf.dispose();
  }
  const f = await fixture();
  try {
    await f.db.prepare("DROP TRIGGER inventory_adoption_result_insert").run();
    await assert.rejects(
      f.match(),
      /inventory adoption work publication incomplete/,
    );
    assert.deepEqual(await counts(f), {
      jobs: 0,
      associations: 0,
      evidence: 0,
      attempts: 0,
    });
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("stale comparison work defers under its lease and a fresh result requeues it", async () => {
  const f = await fixture();
  try {
    await f.match();
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_adoption_work").run(),
      /pending inventory adoption work/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_adoption_work SET due_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+300000,hold_reason='ownership'",
        )
        .run(),
      /adoption deferral lease missing/,
    );
    await f.projections.project("a", f.generation, "source", ["q0"]);
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 0,
      completed: 0,
      held: 3,
    });
    assert.ok(
      (await jobs(f)).every(
        (row) =>
          row.due_at > Date.now() &&
          row.hold_reason === "comparison" &&
          row.result_version === 1,
      ),
    );
    assert.deepEqual(await f.adoption.step("a"), { kind: "idle" });
    await f.match();
    assert.ok(
      (await jobs(f)).every(
        (row) =>
          row.due_at <= Date.now() &&
          row.hold_reason === null &&
          row.result_version === 2,
      ),
    );
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 3,
      completed: 3,
      held: 0,
    });
  } finally {
    await f.mf.dispose();
  }
});

test("ownership uncertainty is deferred without consuming current match facts", async () => {
  const f = await fixture();
  try {
    await f.match();
    await new InventoryOwnership(f.store).hold(
      "a",
      "qrz",
      "uncertain",
      "unresolved_delivery",
    );
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 0,
      completed: 0,
      held: 3,
    });
    assert.ok(
      (await jobs(f)).every(
        (row) => row.hold_reason === "ownership" && row.due_at > Date.now(),
      ),
    );
    assert.deepEqual(await counts(f), {
      jobs: 3,
      associations: 0,
      evidence: 0,
      attempts: 0,
    });
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      3,
    );
    assert.deepEqual(await f.adoption.step("a"), { kind: "idle" });
  } finally {
    await f.mf.dispose();
  }
});

test("a lost work acknowledgement recovers from the committed association", async () => {
  const f = await fixture();
  try {
    await f.match();
    await f.db
      .prepare(
        "CREATE TRIGGER fail_adoption_ack BEFORE DELETE ON inventory_adoption_work BEGIN SELECT RAISE(ABORT,'late adoption acknowledgement'); END;",
      )
      .run();
    await assert.rejects(f.adoption.step("a"), /late adoption acknowledgement/);
    assert.deepEqual(await counts(f), {
      jobs: 3,
      associations: 3,
      evidence: 3,
      attempts: 0,
    });
    await f.db.prepare("DROP TRIGGER fail_adoption_ack").run();
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 0,
      completed: 3,
      held: 0,
    });
    assert.deepEqual(await counts(f), {
      jobs: 0,
      associations: 3,
      evidence: 3,
      attempts: 0,
    });
    assert.deepEqual(await f.adoption.step("a"), { kind: "idle" });
  } finally {
    await f.mf.dispose();
  }
});

test("new result versions cannot be consumed under an earlier adoption claim", async (t) => {
  const f = await fixture();
  try {
    await f.match();
    const prepare = InventoryAssociations.prototype.prepare;
    const race = t.mock.method(
      InventoryAssociations.prototype,
      "prepare",
      async function (
        this: InventoryAssociations,
        ...args: Parameters<typeof prepare>
      ) {
        await f.match();
        return prepare.apply(this, args);
      },
    );
    assert.deepEqual(await f.adoption.step("a"), { kind: "deferred" });
    race.mock.restore();
    assert.deepEqual(await counts(f), {
      jobs: 3,
      associations: 0,
      evidence: 0,
      attempts: 0,
    });
    assert.ok(
      (await jobs(f)).every(
        (row) => row.result_version === 2 && row.due_at <= Date.now(),
      ),
    );
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 3,
      completed: 3,
      held: 0,
    });
  } finally {
    await f.mf.dispose();
  }
});

test("the oldest ready cohort shares one proof instead of mixing newer sets", async () => {
  const f = await fixture();
  try {
    await f.matches.match("a", "destination", f.selected.slice(1));
    await f.matches.match("a", "destination", f.selected.slice(0, 1));
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 2,
      completed: 2,
      held: 0,
    });
    assert.deepEqual(
      await f.db
        .prepare("SELECT record_key FROM inventory_adoption_work")
        .first(),
      { record_key: "q0" },
    );
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 1,
      completed: 1,
      held: 0,
    });
  } finally {
    await f.mf.dispose();
  }
});

test("capacity splits the cohort and defers only a singleton that still cannot fit", async (t) => {
  const f = await fixture();
  try {
    await f.match();
    const prepare = InventoryAssociations.prototype.prepare;
    let holdSingleton = false;
    const limit = t.mock.method(
      InventoryAssociations.prototype,
      "prepare",
      async function (
        this: InventoryAssociations,
        ...args: Parameters<typeof prepare>
      ) {
        if (args[2].length > 1 || holdSingleton)
          throw new Error("inventory_projection_read_byte_bound");
        return prepare.apply(this, args);
      },
    );
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 1,
      completed: 1,
      held: 0,
    });
    assert.ok(
      (await jobs(f)).every(
        (row) => row.due_at <= Date.now() && row.hold_reason === null,
      ),
    );
    holdSingleton = true;
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 0,
      completed: 0,
      held: 1,
    });
    limit.mock.restore();
    assert.equal(
      (await jobs(f)).filter((row) => row.hold_reason === "capacity").length,
      1,
    );
    assert.deepEqual(await f.adoption.step("a"), {
      kind: "processed",
      records: 1,
      completed: 1,
      held: 0,
    });
    assert.deepEqual(await f.adoption.step("a"), { kind: "idle" });
    assert.deepEqual(await counts(f), {
      jobs: 1,
      associations: 2,
      evidence: 2,
      attempts: 0,
    });
  } finally {
    await f.mf.dispose();
  }
});
