import assert from "node:assert/strict";
import test from "node:test";
import { InventoryProjectionCoverageJobs } from "../src/inventory-projection-coverage-jobs.ts";
import { InventoryProjectionJobs } from "../src/inventory-projection-jobs.ts";
import { Store } from "../src/store.ts";
import { activationFixture } from "./inventory-coordinator-fixtures.ts";

function meteredStore(f: Awaited<ReturnType<typeof activationFixture>>) {
  let read = 0;
  const store = new Store(f.db, f.store.keys);
  const statement = store.statement.bind(store);
  store.statement = (sql, ...parameters) =>
    new Proxy(statement(sql, ...parameters), {
      get(target, property) {
        if (property === "first" || property === "all")
          return async () => {
            const result = await target.all();
            read += result.meta.rows_read;
            return property === "first" ? (result.results[0] ?? null) : result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    store,
    generation: f.pending,
    reset() {
      read = 0;
    },
    get read() {
      return read;
    },
  };
}

async function measured(meter: ReturnType<typeof meteredStore>) {
  const costs: Record<string, number> = {};
  for (const [kind, run] of [
    [
      "operation",
      () => new InventoryProjectionJobs(meter.store).expandNext("a"),
    ],
    [
      "projection",
      () => new InventoryProjectionJobs(meter.store).projectNext("a"),
    ],
    [
      "coverage",
      () => new InventoryProjectionCoverageJobs(meter.store).step("a"),
    ],
  ] as const) {
    meter.reset();
    assert.equal((await run()).kind, "idle");
    costs[kind] = meter.read;
  }
  meter.reset();
  assert.equal(
    await meter.store
      .statement(
        "SELECT 1 FROM inventory_comparison_generation_debt WHERE tenant=? AND generation_id=? LIMIT 1",
        "a",
        meter.generation,
      )
      .first(),
    null,
  );
  costs.activation = meter.read;
  return costs;
}

test("work selection ignores retained pending rows from retired generations", async (t) => {
  const keys = Array.from(
    { length: 5000 },
    (_, i) => `old${String(i).padStart(5, "0")}`,
  );
  const f = await activationFixture(1, async (f) => {
    await f.db
      .prepare(
        "INSERT INTO projection_domains(tenant,scope_id,operation_key,topology_version) SELECT 'a','source',value,1 FROM json_each(?)",
      )
      .bind(JSON.stringify(keys))
      .run();
  });
  try {
    await f.coordinator.activate("a", f.pending, f.lease);
    await f.store.release(f.lease);
    // Retired derived rows may be collected/restored independently of source
    // observations. Keep their valid parent domains, then vary retained work.
    await f.db
      .prepare(
        "DELETE FROM inventory_projection_jobs WHERE generation_id=? AND operation_key LIKE 'old%'",
      )
      .bind(f.generation)
      .run();
    const meter = meteredStore(f);
    const before = await measured(meter);
    await f.db.batch([
      f.db
        .prepare(
          `INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at) SELECT p.tenant,?,p.scope_id,p.operation_key,s.config_version,p.topology_version,1,0 FROM projection_domains p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id WHERE p.tenant='a' AND p.operation_key LIKE 'old%'`,
        )
        .bind(f.generation),
      f.db
        .prepare(
          `INSERT INTO comparison_index(tenant,generation_id,scope_id,record_key,facet,key_class,bucket_hash,semantic_version,config_version,state,parent_key,topology_version,projection_version,last_page_id) SELECT i.tenant,i.generation_id,i.scope_id,j.value,i.facet,i.key_class,i.bucket_hash,i.semantic_version,i.config_version,'pending',i.parent_key,0,0,i.last_page_id FROM json_each(?) j CROSS JOIN comparison_index i WHERE i.tenant='a' AND i.generation_id=? AND i.record_key='q0000'`,
        )
        .bind(JSON.stringify(keys), f.generation),
      f.db
        .prepare(
          `INSERT INTO comparison_work(tenant,generation_id,scope_id,record_key,facet,work_version,completed_version,due_at) SELECT i.tenant,i.generation_id,i.scope_id,i.record_key,i.facet,1,0,0 FROM comparison_index i WHERE i.tenant='a' AND i.generation_id=? AND i.record_key LIKE 'old%'`,
        )
        .bind(f.generation),
      f.db
        .prepare(
          "UPDATE inventory_projection_coverage_jobs SET work_version=work_version+1,cursor_key='' WHERE generation_id=?",
        )
        .bind(f.generation),
    ]);
    const after = await measured(meter);
    t.diagnostic(
      `idle selector rows read before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
    assert.deepEqual(after, before);
    await f.db
      .prepare(
        "UPDATE projection_domains SET topology_version=topology_version+1 WHERE scope_id='source' AND operation_key='op'",
      )
      .run();
    const operation = await new InventoryProjectionJobs(f.store).expandNext(
      "a",
    );
    assert.ok("records" in operation);
    assert.equal(operation.records, 1);
    const projection = await new InventoryProjectionJobs(f.store).projectNext(
      "a",
    );
    assert.ok("ready" in projection);
    assert.equal(projection.ready, 1);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_work WHERE generation_id=? AND completed_version<work_version",
          )
          .bind(f.generation)
          .first<{ n: number }>()
      )?.n,
      5000,
      "current work selection must not consume retired work",
    );
    await f.db
      .prepare(
        "UPDATE comparison_work SET work_version=work_version+1,due_at=? WHERE generation_id=?",
      )
      .bind(Date.now() + 60000, f.pending)
      .run();
    assert.equal(
      (await new InventoryProjectionJobs(f.store).projectNext("a")).kind,
      "idle",
    );
    await f.db
      .prepare("UPDATE comparison_work SET due_at=0 WHERE generation_id=?")
      .bind(f.pending)
      .run();
    assert.equal(
      (await new InventoryProjectionJobs(f.store).projectNext("a")).kind,
      "projected",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("disabled pending history keeps work selection and native activation bounded", async (t) => {
  const f = await activationFixture(1);
  try {
    await f.store.release(f.lease);
    await f.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','disabled','lofi','other-account','disabled','disabled','v1',0)",
      )
      .run();
    await f.inventory.initialize(
      {
        tenant: "a",
        scope: "disabled",
        connection: "disabled",
        provider: "lofi",
        logicalIdentity: "other-account",
        adapterBinding: "test-v1",
        ordering: "numeric",
      },
      "sync",
      "all-v1",
    );
    await f.builds.step("a", f.pending, "disabled");
    const meter = meteredStore(f);
    const before = await measured(meter);
    const costs: Record<string, number>[] = [];
    let count = 0;
    for (const size of [100, 5000]) {
      const keys = JSON.stringify(
        Array.from({ length: size - count }, (_, i) => `disabled${i + count}`),
      );
      await f.db.batch([
        f.db
          .prepare(
            "INSERT INTO projection_domains(tenant,scope_id,operation_key,topology_version) SELECT 'a','disabled',value,1 FROM json_each(?)",
          )
          .bind(keys),
        f.db
          .prepare(
            `INSERT INTO comparison_index(tenant,generation_id,scope_id,record_key,facet,key_class,bucket_hash,semantic_version,config_version,state,parent_key,topology_version,projection_version,last_page_id) SELECT i.tenant,i.generation_id,'disabled',j.value,i.facet,i.key_class,i.bucket_hash,i.semantic_version,1,'pending',NULL,0,0,i.last_page_id FROM json_each(?) j CROSS JOIN comparison_index i WHERE i.tenant='a' AND i.generation_id=? AND i.scope_id='source' AND i.record_key='q0000'`,
          )
          .bind(keys, f.pending),
        f.db
          .prepare(
            "INSERT INTO comparison_work(tenant,generation_id,scope_id,record_key,facet,work_version,completed_version,due_at) SELECT i.tenant,i.generation_id,i.scope_id,i.record_key,i.facet,1,0,0 FROM comparison_index i JOIN json_each(?) j ON j.value=i.record_key WHERE i.tenant='a' AND i.generation_id=? AND i.scope_id='disabled'",
          )
          .bind(keys, f.pending),
      ]);
      costs.push(await measured(meter));
      count = size;
    }
    t.diagnostic(
      `disabled scope selector rows read empty=${JSON.stringify(before)} at100=${JSON.stringify(costs[0])} at5000=${JSON.stringify(costs[1])}`,
    );
    // Populating an empty pending index adds a fixed failed-probe cost. Growth
    // within that nonempty index must not turn back into a per-row scan.
    for (const [kind, cost] of Object.entries(costs[0]))
      assert.ok(cost <= before[kind] + 8, `${kind} must stay bounded`);
    assert.deepEqual(costs[1], costs[0]);
    const lease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    assert.equal(
      (await f.coordinator.activate("a", f.pending, lease)).kind,
      "activated",
      "native activation fences must also ignore disabled pending history",
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_work WHERE generation_id=? AND scope_id='disabled' AND completed_version<work_version",
          )
          .bind(f.pending)
          .first<{ n: number }>()
      )?.n,
      5000,
    );
    await f.store.release(lease);
  } finally {
    await f.mf.dispose();
  }
});

test("obsolete operation configurations do not become a pending-history scan", async (t) => {
  const keys = JSON.stringify(
    Array.from({ length: 5000 }, (_, i) => `obsolete${i}`),
  );
  const f = await activationFixture(1, async (f) => {
    await f.db
      .prepare(
        "INSERT INTO projection_domains(tenant,scope_id,operation_key,topology_version) SELECT 'a','source',value,1 FROM json_each(?)",
      )
      .bind(keys)
      .run();
  });
  try {
    await f.coordinator.activate("a", f.pending, f.lease);
    await f.store.release(f.lease);
    await f.db
      .prepare(
        "UPDATE inventory_scopes SET config_version=config_version+1 WHERE scope_id='source'",
      )
      .run();
    await f.builds.step("a", f.pending, "source");
    const projected = await new InventoryProjectionJobs(f.store).projectNext(
      "a",
    );
    assert.ok("held" in projected && projected.held === 1);
    const meter = meteredStore(f);
    const before = await measured(meter);
    await f.db
      .prepare(
        "INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at) SELECT tenant,?,scope_id,operation_key,1,topology_version,1,0 FROM projection_domains WHERE tenant='a' AND scope_id='source' AND operation_key LIKE 'obsolete%'",
      )
      .bind(f.pending)
      .run();
    const after = await measured(meter);
    assert.deepEqual(after, before);
    t.diagnostic(
      `obsolete configuration selector rows read before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  } finally {
    await f.mf.dispose();
  }
});
