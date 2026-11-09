import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import {
  InventoryMatchingPairs,
  matchingPairLeaseScope,
} from "../src/inventory-matching-pairs.ts";
import { Store } from "../src/store.ts";
import { applyMigration } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { pairPagesFixture } from "./inventory-matching-pairs-fixtures.ts";

type Fixture = Awaited<ReturnType<typeof pairPagesFixture>>;
async function captured(f: Fixture, limit = 200) {
  const key = {
    generation: f.generation,
    destination: "destination",
    source: "source",
  };
  const lease = await f.store.claim(
    "a",
    matchingPairLeaseScope(key),
    Date.now(),
    60000,
  );
  assert.ok(lease);
  const page = await f.pairs.prepare("a", key, lease, limit);
  assert.ok(page);
  return page;
}
async function signal(f: Fixture) {
  return f.db
    .prepare(
      "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant='a'",
    )
    .run();
}
function alteredStore(
  f: Fixture,
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
async function noPublication(f: Fixture) {
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_matching_pair_pages")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM matching_work")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.deepEqual(
    await f.db
      .prepare(
        "SELECT work_version,completed_version,cursor_key FROM inventory_matching_pair_jobs",
      )
      .first(),
    { work_version: 1, completed_version: 0, cursor_key: "" },
  );
}

test("a source census durably queues two hundred keys then resumes the final five without reading bodies", async (t) => {
  const f = await pairPagesFixture({
    sources: Array.from({ length: 205 }, (_, i) =>
      sourceContact(`q${String(i).padStart(3, "0")}`),
    ),
  });
  try {
    const before = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const first = await f.pairs.step("a");
    assert.ok(first.kind === "enrolled");
    assert.equal(first.records, 200);
    assert.equal(first.complete, false);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version,cursor_key FROM inventory_matching_pair_jobs",
        )
        .first(),
      { work_version: 1, completed_version: 0, cursor_key: "q199" },
    );
    const second = await new InventoryMatchingPairs(f.store).step("a");
    assert.ok(second.kind === "enrolled");
    assert.equal(second.records, 5);
    assert.equal(second.complete, true);
    assert.equal((await f.pairs.step("a")).kind, "idle");
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM matching_work WHERE work_version=1 AND completed_version=0",
          )
          .first<{ n: number }>()
      )?.n,
      205,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_match_sets")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    t.diagnostic(
      `200-key pair expansion: ${first.statements} statements, ${first.rowsRead} reads, ${first.rowsWritten} writes`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("an empty source census finishes without inventing matching or delivery records", async () => {
  const f = await pairPagesFixture({ sources: [] });
  try {
    const result = await f.pairs.step("a");
    assert.ok(
      result.kind === "enrolled" && result.records === 0 && result.complete,
    );
    assert.equal((await f.pairs.step("a")).kind, "idle");
    for (const table of [
      "matching_work",
      "match_results",
      "ledger",
      "attempts",
    ])
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

test("a historical policy migration resumes bounded census without rewriting published results", async () => {
  const f = await pairPagesFixture();
  try {
    assert.equal((await f.pairs.step("a")).kind, "enrolled");
    assert.equal((await f.work.step("a")).kind, "matched");
    assert.equal((await f.pairs.step("a")).kind, "idle");
    const result = () => f.db.prepare("SELECT * FROM match_results").first();
    const published = await result();
    assert.ok(published);

    await applyMigration(
      f.db,
      "0126_inventory_historical_frequency_recheck.sql",
    );
    assert.deepEqual(await result(), published);
    assert.equal((await f.work.step("a")).kind, "idle");
    const page = await f.pairs.step("a");
    assert.ok(page.kind === "enrolled");
    assert.equal(page.records, 1);
    assert.equal(page.complete, true);
    assert.equal((await f.work.step("a")).kind, "matched");
    assert.equal((await f.work.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("current results from a retired generation enroll even when their source keys have retired", async () => {
  const f = await pairPagesFixture();
  try {
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    assert.equal((await f.work.step("a")).kind, "matched");
    await f.full([
      observation("op", "operation"),
      observation("q0", "event", 2),
    ]);
    const next = (await new InventoryComparisonGenerations(f.store).begin("a"))
      .pending_generation;
    assert.ok(next);
    const builds = new InventoryComparisonBuilds(f.store);
    for (const scope of ["source", "destination"]) {
      const built = await builds.step("a", next, scope);
      assert.ok("complete" in built && built.complete);
    }
    await builds.activate("a", next);
    const result = await f.pairs.step("a");
    assert.ok(result.kind === "enrolled" && result.records === 1);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM matching_work WHERE generation_id=? AND record_key='q0'",
          )
          .bind(next)
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal((await f.work.step("a")).kind, "matched");
    const current = await f.matches.current("a", "destination", f.selected);
    assert.equal(current.results[0].state, "incomplete");
    assert.equal(current.results[0].reason, "source_unavailable");
  } finally {
    await f.mf.dispose();
  }
});

test("new metadata signals reject captured work and restart an already advanced pair cursor", async () => {
  const f = await pairPagesFixture({
    sources: [sourceContact("q0"), sourceContact("q1")],
  });
  try {
    const page = await captured(f, 1);
    const first = await f.pairs.publish(page);
    assert.equal(first.complete, false);
    const stale = await f.pairs.prepare(
      "a",
      {
        generation: f.generation,
        destination: "destination",
        source: "source",
      },
      page.lease,
      1,
    );
    assert.ok(stale);
    await signal(f);
    await assert.rejects(f.pairs.publish(stale), /authority changed/);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version,cursor_key FROM inventory_matching_pair_jobs",
        )
        .first(),
      { work_version: 2, completed_version: 0, cursor_key: "" },
    );
    await f.store.release(page.lease);
    const restarted = await f.pairs.step("a");
    assert.ok(
      restarted.kind === "enrolled" &&
        restarted.records === 2 &&
        restarted.complete,
    );
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT record_key,work_version FROM matching_work ORDER BY record_key",
          )
          .all()
      ).results,
      [
        { record_key: "q0", work_version: 2 },
        { record_key: "q1", work_version: 1 },
      ],
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native pair guards reject omitted queued keys and a forged prematurely complete frontier", async (t) => {
  for (const failure of ["row", "suffix"] as const)
    await t.test(failure, async () => {
      const f = await pairPagesFixture({
        sources: [sourceContact("q0"), sourceContact("q1")],
      });
      try {
        const page = await captured(f, 1);
        const store = alteredStore(f, async (plan) => {
          const changed = [...plan];
          if (failure === "row") changed[1] = f.db.prepare("SELECT 1");
          else {
            const j = page.job;
            changed[0] = f.db
              .prepare(
                `INSERT INTO inventory_matching_pair_pages(tenant,page_id,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version,work_version,completed_version,previous_key,next_key,previous_turn,next_turn,page_limit,row_count,complete,lease_token,lease_fence,input_digest,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING row_count,complete`,
              )
              .bind(
                j.tenant,
                page.pageId,
                j.generation_id,
                j.destination,
                j.source_scope,
                j.source_config_version,
                j.destination_config_version,
                j.source_set_version,
                j.work_version,
                j.completed_version,
                j.cursor_key,
                "q0",
                j.last_turn,
                j.last_turn + 1,
                page.limit,
                1,
                1,
                page.lease.token,
                page.lease.fence,
                page.digest,
                page.preparedAt,
              );
          }
          return f.db.batch(changed);
        });
        await assert.rejects(
          new InventoryMatchingPairs(store).publish(page),
          failure === "suffix" ? /range incomplete/ : /manifest incomplete/,
        );
        await noPublication(f);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("large initial censuses take fair turns across destinations", async () => {
  const f = await pairPagesFixture({
    sources: Array.from({ length: 205 }, (_, i) =>
      sourceContact(`q${String(i).padStart(3, "0")}`),
    ),
  });
  try {
    await f.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','second','qrz','second','Second','active','v1','{}',1)",
      )
      .run();
    await (
      await f.store.putPrivate("a", "second", "v1", "credential", {
        secret: "private",
      })
    ).run();
    await f.inventory.initialize(
      {
        tenant: "a",
        scope: "second",
        connection: "second",
        provider: "qrz",
        logicalIdentity: "second",
        adapterBinding: "test-v1",
        ordering: "serialized",
      },
      "receipt",
      "selection-v1",
    );
    const build = await new InventoryComparisonBuilds(f.store).step(
      "a",
      f.generation,
      "second",
    );
    assert.ok("complete" in build && build.complete);
    const turns = [];
    for (let i = 0; i < 4; i++) {
      const result = await f.pairs.step("a");
      assert.ok(result.kind === "enrolled");
      const page = await f.db
        .prepare(
          "SELECT destination FROM inventory_matching_pair_pages WHERE page_id=?",
        )
        .bind(result.pageId)
        .first<{ destination: string }>();
      turns.push({ destination: page?.destination, records: result.records });
    }
    assert.deepEqual(turns, [
      { destination: "destination", records: 200 },
      { destination: "second", records: 200 },
      { destination: "destination", records: 5 },
      { destination: "second", records: 5 },
    ]);
    assert.equal((await f.pairs.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("late native failures roll back work, metadata clocks and pair frontiers together", async (t) => {
  for (const failure of ["sql", "account", "signal", "work", "lease"] as const)
    await t.test(failure, async () => {
      const f = await pairPagesFixture();
      try {
        const page = await captured(f);
        const store = alteredStore(f, async (plan) => {
          const changed = [...plan];
          const sql = {
            sql: "SELECT * FROM intentionally_missing_pair_table",
            account: "UPDATE accounts SET status='locked' WHERE id='a'",
            signal:
              "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant='a'",
            work: "UPDATE matching_work SET work_version=work_version+1",
            lease: "UPDATE leases SET expires_at=0",
          }[failure];
          changed.splice(changed.length - 1, 0, f.db.prepare(sql));
          return f.db.batch(changed);
        });
        await assert.rejects(new InventoryMatchingPairs(store).publish(page));
        await noPublication(f);
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

test("lost pair acknowledgements preserve newer metadata work and never enqueue the same page twice", async () => {
  const f = await pairPagesFixture();
  try {
    const page = await captured(f);
    const store = alteredStore(f, async (plan) => {
      await f.db.batch(plan);
      await signal(f);
      throw new Error("lost acknowledgement");
    });
    assert.equal(
      (await new InventoryMatchingPairs(store).publish(page)).recovered,
      true,
    );
    assert.equal((await f.pairs.publish(page)).recovered, true);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version,cursor_key FROM inventory_matching_pair_jobs",
        )
        .first(),
      { work_version: 2, completed_version: 1, cursor_key: "" },
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT work_version FROM matching_work")
          .first<{ work_version: number }>()
      )?.work_version,
      1,
    );
    await f.store.release(page.lease);
    assert.equal((await f.pairs.step("a")).kind, "enrolled");
    assert.equal(
      (
        await f.db
          .prepare("SELECT work_version FROM matching_work")
          .first<{ work_version: number }>()
      )?.work_version,
      2,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("pair publication cost does not scan retained retired keys or completed page history", async (t) => {
  const f = await pairPagesFixture();
  try {
    await f.pairs.step("a");
    await signal(f);
    const before = await f.pairs.step("a");
    assert.ok(before.kind === "enrolled");
    await f.db
      .prepare(
        `INSERT INTO comparison_index(tenant,generation_id,scope_id,record_key,facet,key_class,bucket_hash,semantic_version,config_version,state,parent_key,topology_version,projection_version,last_page_id) SELECT i.tenant,i.generation_id,i.scope_id,j.value,i.facet,NULL,NULL,i.semantic_version,i.config_version,'retired',i.parent_key,i.topology_version,i.projection_version,i.last_page_id FROM json_each(?1) j CROSS JOIN comparison_index i WHERE i.tenant='a' AND i.generation_id=?2 AND i.scope_id='source' AND i.record_key='q0'`,
      )
      .bind(
        JSON.stringify(Array.from({ length: 5000 }, (_, i) => `old${i}`)),
        f.generation,
      )
      .run();
    for (let i = 0; i < 100; i++) {
      await signal(f);
      await f.pairs.step("a");
    }
    await signal(f);
    const after = await f.pairs.step("a");
    assert.ok(after.kind === "enrolled");
    assert.equal(after.records, 1);
    t.diagnostic(
      `pair history costs: reads=${before.rowsRead}/${after.rowsRead}, writes=${before.rowsWritten}/${after.rowsWritten}`,
    );
    assert.ok(after.rowsRead <= before.rowsRead + 8);
    assert.equal(after.rowsWritten, before.rowsWritten);
    t.diagnostic(
      `pair publication before/after 5000 retired keys and 100 old pages: reads=${before.rowsRead}/${after.rowsRead}, writes=${before.rowsWritten}/${after.rowsWritten}`,
    );
  } finally {
    await f.mf.dispose();
  }
});
