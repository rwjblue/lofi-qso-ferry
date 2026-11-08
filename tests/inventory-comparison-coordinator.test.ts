import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { Store } from "../src/store.ts";
import { seed } from "./helpers.ts";
import {
  activationFixture,
  coordinatorFixture,
} from "./inventory-coordinator-fixtures.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";

test("durable turns rotate builds and drain projections before managed activation", async () => {
  const f = await coordinatorFixture(205);
  try {
    await f.inventory.initialize(
      {
        tenant: "a",
        scope: "zz-destination",
        connection: "destination",
        provider: "qrz",
        logicalIdentity: "destination",
        adapterBinding: "test-v1",
        ordering: "serialized",
      },
      "receipt",
      "all-v1",
    );
    const checkpoint = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const built: number[] = [];
    let activations = 0;
    let finished = false;
    for (let turn = 0; turn < 100; turn++) {
      const result = await new InventoryComparisonCoordinator(f.store).step(
        "a",
      );
      assert.notEqual(result.kind, "deferred");
      if (
        "phase" in result &&
        result.phase === "build" &&
        result.kind === "advanced"
      )
        built.push(result.records);
      if (
        "phase" in result &&
        result.phase === "activate" &&
        result.kind === "advanced"
      )
        activations++;
      if (!result.more) {
        finished = true;
        break;
      }
    }
    assert.equal(finished, true);
    assert.deepEqual(
      built,
      [200, 0, 5],
      "a large scope cannot starve another scope's census",
    );
    assert.equal(activations, 1);
    assert.equal(
      (await f.generations.domain("a"))?.active_generation,
      f.generation,
    );
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
    assert.equal(
      (
        await f.db
          .prepare("SELECT state FROM inventory_comparison_activations")
          .first<{ state: string }>()
      )?.state,
      "committed",
    );
    assert.deepEqual(
      await f.inventory.snapshot("a", "source", "sync"),
      checkpoint,
    );
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM leases WHERE scope='inventory-comparison' AND expires_at>0",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
    for (const table of ["match_results", "ledger", "attempts"])
      assert.equal(
        (
          await f.db
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
      );
  } finally {
    await f.mf.dispose();
  }
});

test("a tenant without a comparison domain gets one first generation automatically", async () => {
  const f = await coordinatorFixture(1);
  try {
    await seed(f.store, "b");
    await f.inventory.initialize(
      {
        tenant: "b",
        scope: "source",
        connection: "source",
        provider: "lofi",
        logicalIdentity: "source",
        adapterBinding: "test-v1",
        ordering: "numeric",
      },
      "sync",
      "all-v1",
    );
    assert.equal((await f.coordinator.step("b")).kind, "initialized");
    for (let i = 0; i < 15; i++) {
      const result = await f.coordinator.step("b");
      if (!result.more) break;
    }
    const domain = await f.generations.domain("b");
    assert.ok(domain?.active_generation);
    assert.equal(domain.pending_generation, null);
    assert.equal(
      (await f.generations.domain("a"))?.pending_generation,
      f.generation,
    );
    assert.equal((await f.coordinator.step("missing")).more, false);
  } finally {
    await f.mf.dispose();
  }
});

test("atomic ingestion wakeups restart an idle coordinator and stable turns preserve observations", async () => {
  const f = await coordinatorFixture(1);
  try {
    for (let i = 0; i < 30; i++)
      if (!(await f.coordinator.step("a")).more) break;
    const old = await f.db
      .prepare("SELECT * FROM inventory_comparison_coordinators")
      .first<{
        work_version: number;
        observed_version: number;
        idle_turns: number;
      }>();
    assert.equal(old?.idle_turns, 5);
    const edited = sourceContact(f.sources[0].key, "14:00:00", "K1ABC");
    edited.order = 2;
    edited.revision = "2";
    await f.full([f.operation, edited]);
    const wake = await f.db
      .prepare("SELECT * FROM inventory_comparison_coordinators")
      .first<{ work_version: number; observed_version: number }>();
    assert.ok(wake && wake.work_version > wake.observed_version);
    const before = await f.inventory.snapshot("a", "source", "sync");
    for (let i = 0; i < 30; i++)
      if (!(await f.coordinator.step("a")).more) break;
    const body = await f.projections.body(
      "a",
      f.generation,
      "source",
      edited.key,
      "source",
    );
    assert.equal(body?.body.record.CALL, "K1ABC");
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.equal(
      (
        await f.db
          .prepare("SELECT idle_turns FROM inventory_comparison_coordinators")
          .first<{ idle_turns: number }>()
      )?.idle_turns,
      5,
    );
  } finally {
    await f.mf.dispose();
  }
});

function alteredStore(
  f: Awaited<ReturnType<typeof activationFixture>>,
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
test("managed activation rolls back retired pointers after late work, authority and SQL failures", async (t) => {
  for (const failure of ["work", "account", "source", "sql"] as const)
    await t.test(failure, async () => {
      const f = await activationFixture();
      try {
        const domain = await f.generations.domain("a");
        const store = alteredStore(f, async (plan) => {
          const changed = [...plan];
          const late =
            failure === "work"
              ? f.db
                  .prepare(
                    "UPDATE comparison_work SET work_version=work_version+1 WHERE generation_id=?",
                  )
                  .bind(f.pending)
              : f.db.prepare(
                  failure === "account"
                    ? "UPDATE accounts SET status='locked' WHERE id='a'"
                    : failure === "source"
                      ? "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','new-source','lofi','another-account','new','active','v1',0)"
                      : "SELECT * FROM intentional_missing_activation_table",
                );
          changed.splice(changed.length - 1, 0, late);
          return f.db.batch(changed);
        });
        await assert.rejects(
          new InventoryComparisonCoordinator(store).activate(
            "a",
            f.pending,
            f.lease,
            "race",
          ),
        );
        assert.deepEqual(await f.generations.domain("a"), domain);
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT state FROM index_generations WHERE generation_id=?",
              )
              .bind(f.generation)
              .first<{ state: string }>()
          )?.state,
          "active",
        );
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT count(*) AS n FROM inventory_comparison_activations",
              )
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

test("activation receipts survive lost acknowledgements and do not clear newer operation debt", async () => {
  const f = await activationFixture();
  try {
    const store = alteredStore(f, async (plan) => {
      await f.db.batch(plan);
      throw new Error("lost acknowledgement");
    });
    assert.equal(
      (
        await new InventoryComparisonCoordinator(store).activate(
          "a",
          f.pending,
          f.lease,
          "lost",
        )
      ).kind,
      "activated",
    );
    const op = observation("op", "operation", 2);
    op.body = { ...(op.body as object), stationCall: "K1ABC" };
    await f.full([op, ...f.sources]);
    const debt = (
      await f.db
        .prepare(
          "SELECT * FROM inventory_projection_jobs ORDER BY generation_id",
        )
        .all()
    ).results;
    const result = await f.coordinator.activate(
      "a",
      f.pending,
      f.lease,
      "lost",
    );
    assert.ok("recovered" in result && result.recovered);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT * FROM inventory_projection_jobs ORDER BY generation_id",
          )
          .all()
      ).results,
      debt,
    );
    assert.equal(
      (await f.generations.domain("a"))?.active_generation,
      f.pending,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("coordinator contention defers and activation requires both drained work and a live lease", async () => {
  const f = await activationFixture();
  try {
    assert.equal((await f.coordinator.step("a")).kind, "deferred");
    const domain = await f.generations.domain("a");
    await f.db
      .prepare(
        "UPDATE comparison_work SET work_version=work_version+1 WHERE generation_id=?",
      )
      .bind(f.pending)
      .run();
    assert.equal(
      (await f.coordinator.activate("a", f.pending, f.lease)).kind,
      "waiting",
    );
    assert.deepEqual(await f.generations.domain("a"), domain);
    await f.projections.project(
      "a",
      f.pending,
      "source",
      f.sources.map((row) => row.key),
    );
    await f.db
      .prepare(
        "UPDATE leases SET expires_at=0 WHERE scope='inventory-comparison'",
      )
      .run();
    await assert.rejects(
      f.coordinator.activate("a", f.pending, f.lease),
      /changed/,
    );
    assert.deepEqual(await f.generations.domain("a"), domain);
  } finally {
    await f.mf.dispose();
  }
});

test("a contended child keeps the coordinator durably pending instead of completing its idle cycle", async () => {
  const f = await coordinatorFixture(1);
  try {
    const leader = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    assert.ok(leader);
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,idle_turns=4 WHERE tenant='a'",
      )
      .run();
    await f.store.release(leader);
    const child = await f.store.claim(
      "a",
      `comparison:${f.generation}:source`,
      Date.now(),
      60000,
    );
    assert.ok(child);
    const beforeIndex = (
      await f.db
        .prepare("SELECT * FROM comparison_index ORDER BY scope_id,record_key")
        .all()
    ).results;
    const result = await f.coordinator.step("a");
    assert.equal(result.kind, "deferred");
    assert.equal(result.more, true);
    const control = await f.db
      .prepare(
        "SELECT idle_turns FROM inventory_comparison_coordinators INDEXED BY inventory_comparison_coordinator_due WHERE tenant='a' AND (idle_turns<5 OR observed_version<work_version)",
      )
      .first<{ idle_turns: number }>();
    assert.equal(control?.idle_turns, 0);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT * FROM comparison_index ORDER BY scope_id,record_key",
          )
          .all()
      ).results,
      beforeIndex,
    );
    await f.store.release(child);
  } finally {
    await f.mf.dispose();
  }
});

test("a requested rebuild wakes an idle coordinator without retiring the old active generation early", async () => {
  const f = await coordinatorFixture(1);
  try {
    for (let turn = 0; turn < 30; turn++)
      if (!(await f.coordinator.step("a")).more) break;
    const old = await f.generations.domain("a");
    assert.ok(old?.active_generation);
    const domain = await f.generations.begin("a");
    assert.ok(domain.pending_generation);
    const control = await f.db
      .prepare(
        "SELECT work_version,observed_version FROM inventory_comparison_coordinators WHERE tenant='a'",
      )
      .first<{ work_version: number; observed_version: number }>();
    assert.ok(control && control.work_version > control.observed_version);
    assert.equal(domain.active_generation, old.active_generation);
    for (let turn = 0; turn < 35; turn++)
      if (!(await f.coordinator.step("a")).more) break;
    assert.equal(
      (await f.generations.domain("a"))?.active_generation,
      domain.pending_generation,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT state FROM index_generations WHERE generation_id=?")
          .bind(old.active_generation)
          .first<{ state: string }>()
      )?.state,
      "retired",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("managed activation validates pending work without scanning completed contact history", async (t) => {
  const costs = [];
  for (const count of [3, 205, 405]) {
    const f = await activationFixture(count);
    try {
      const result = await f.coordinator.activate("a", f.pending, f.lease);
      assert.ok("statements" in result);
      assert.equal(result.statements, 3);
      // Indexed probe counts can vary with generation ordering and populated
      // indexes. Keep a fixed budget across larger completed histories rather
      // than requiring identical counts for every index layout.
      assert.ok(result.rowsRead <= 100);
      costs.push({ count, read: result.rowsRead, written: result.rowsWritten });
    } finally {
      await f.mf.dispose();
    }
  }
  assert.equal(costs[1].written, costs[0].written);
  assert.equal(costs[2].written, costs[0].written);
  t.diagnostic(
    `managed activation: 3 statements; contacts/read/written=${JSON.stringify(costs)}`,
  );
});
