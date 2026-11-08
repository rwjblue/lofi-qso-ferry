import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  activateInventoryRuntime,
  inventoryRuntime,
} from "../src/inventory-runtime.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

async function fixture(t: TestContext) {
  const f = await database();
  t.after(() => f.mf.dispose());
  await applyAdditionalMigrations(f.db);
  await seed(f.store);
  return f;
}

test("the runtime handoff is durable, idempotent and preserves account credentials", async (t) => {
  const f = await fixture(t);
  const before = (
    await f.db
      .prepare(
        "SELECT * FROM private_data WHERE kind='credential' ORDER BY connection",
      )
      .all()
  ).results;
  assert.equal((await inventoryRuntime(f.store)).mode, "legacy");
  const activated = await activateInventoryRuntime(f.store);
  assert.equal(activated.mode, "inventory_read_only");
  assert.equal(activated.version, 1);
  assert.ok(activated.activated_at);
  assert.deepEqual(await activateInventoryRuntime(f.store), activated);
  assert.deepEqual(
    (
      await f.db
        .prepare(
          "SELECT * FROM private_data WHERE kind='credential' ORDER BY connection",
        )
        .all()
    ).results,
    before,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT email FROM accounts WHERE id='a'")
        .first<{ email: string }>()
    )?.email,
    "a@example.test",
  );
  for (const sql of [
    "DELETE FROM inventory_runtime",
    "UPDATE inventory_runtime SET mode='legacy',version=0,activated_at=NULL",
    "INSERT OR REPLACE INTO inventory_runtime VALUES(1,'legacy',0,NULL)",
  ])
    await assert.rejects(f.db.prepare(sql).run(), /inventory runtime/);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM inventory_runtime_switch_guards")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("an active old-reader lease prevents handoff and cannot be reacquired afterward", async (t) => {
  const f = await fixture(t);
  const lease = await f.store.claim("a", "cycle:source");
  assert.ok(lease);
  await assert.rejects(
    activateInventoryRuntime(f.store),
    /legacy work still leased/,
  );
  assert.equal((await inventoryRuntime(f.store)).mode, "legacy");
  await f.store.release(lease);
  await activateInventoryRuntime(f.store);
  for (const scope of [
    "cycle:source",
    "poll:source:sync",
    "reread:source",
    "delivery:destination",
    "confirmation-refresh",
    "lotw-ownership",
  ])
    await assert.rejects(f.store.claim("a", scope), /legacy reader retired/);
  const inventoryLease = await f.store.claim("a", "inventory:scope");
  assert.ok(inventoryLease);
});

test("native activation rechecks preconditions after a separately staged switch guard", async (t) => {
  const f = await fixture(t);
  const lease = await f.store.claim("a", "inventory:runtime");
  assert.ok(lease);
  await f.store
    .statement(
      "INSERT INTO inventory_runtime_switch_guards VALUES('staged',0,?,?,?)",
      lease.tenant,
      lease.token,
      lease.fence,
    )
    .run();
  const racing = await f.store.claim("a", "cycle:source");
  assert.ok(racing);
  await assert.rejects(
    f.db
      .prepare(
        "UPDATE inventory_runtime SET mode='inventory_read_only',version=1,activated_at=1",
      )
      .run(),
    /legacy work still leased/,
  );
  await f.store.release(racing);
  await f.store.release(lease);
  await assert.rejects(
    f.db
      .prepare(
        "UPDATE inventory_runtime SET mode='inventory_read_only',version=1,activated_at=1",
      )
      .run(),
    /runtime transition refused/,
  );
  assert.equal((await inventoryRuntime(f.store)).mode, "legacy");
});

test("unresolved and missing-state old attempts block a fresh-state handoff", async (t) => {
  for (const state of [
    null,
    "prepared",
    "dispatching",
    "submitted",
    "uncertain",
  ])
    await t.test(String(state), async (t) => {
      const f = await fixture(t);
      await f.store
        .statement(
          "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at,state) VALUES('a','source','q','destination','g','h',0,0,'inventory_pending')",
        )
        .run();
      // Historical fixture insertion predates the proof guard. Native activation
      // must handle imported rows whose transport state is missing or unresolved.
      const guards = (
        await f.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='attempts'",
          )
          .all<{ name: string }>()
      ).results;
      for (const guard of guards)
        await f.db
          .prepare(`DROP TRIGGER "${guard.name.replaceAll('"', '""')}"`)
          .run();
      await f.store
        .statement(
          "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','old','source','q','destination','g','p','h','v1',0,'h')",
        )
        .run();
      if (state !== null) {
        const triggers = (
          await f.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='attempt_state' AND sql LIKE '%BEFORE INSERT%'",
            )
            .all<{ name: string }>()
        ).results;
        for (const guard of triggers)
          await f.db
            .prepare(`DROP TRIGGER "${guard.name.replaceAll('"', '""')}"`)
            .run();
        await f.store
          .statement(
            "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','old',?,0,0)",
            state,
          )
          .run();
      }
      await assert.rejects(
        activateInventoryRuntime(f.store),
        /legacy attempt needs reconciliation/,
      );
      assert.equal((await inventoryRuntime(f.store)).mode, "legacy");
    });
});

test("native legacy write boundaries remain closed after environment-independent handoff", async (t) => {
  const f = await fixture(t);
  await activateInventoryRuntime(f.store);
  for (const sql of [
    "INSERT INTO checkpoint_guards(id) VALUES('old')",
    "INSERT INTO source_write_guards(id) VALUES('old')",
    "INSERT INTO projection_guards(id) VALUES('old')",
    "INSERT INTO history_inventory_guards(id) VALUES('old')",
    "INSERT INTO stage_guards(id) VALUES('old')",
    "INSERT INTO cursors VALUES('a','source','sync','{}',1,0)",
    "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','old','source','q','destination','g','p','h','v1',0,'h')",
  ])
    await assert.rejects(
      f.db.prepare(sql).run(),
      /legacy (reader|sender) retired/,
    );
});
