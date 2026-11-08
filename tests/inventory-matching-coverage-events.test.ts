import assert from "node:assert/strict";
import test from "node:test";
import {
  InventoryMatchingCoverageEvents,
  matchingCoverageEventLeaseScope,
  type MatchingCoverageEventKey,
  type PreparedMatchingCoverageEvent,
} from "../src/inventory-matching-coverage-events.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

async function fixture(count = 1) {
  const f = await matchingWorkFixture({
    provider: "lotw",
    sources: Array.from({ length: count }, (_, i) => {
      const source = sourceContact(`q${i}`);
      source.body = {
        ...(source.body as object),
        startAtMillis: Date.parse("2026-10-01T13:00:00Z") + i * 86400000,
      };
      return source;
    }),
    receipts: [],
    range: ["2026-11-09", "2026-11-09"],
  });
  try {
    for (const migration of [
      "0059_inventory_live_bucket_dependencies.sql",
      "0060_inventory_matching_bucket_pages.sql",
      "0062_inventory_matching_pair_jobs.sql",
      "0063_inventory_matching_pair_pages.sql",
      "0067_inventory_matching_coverage_dispatch.sql",
    ])
      await applyMigration(f.db, migration);
    const matches = await f.matches.match("a", "destination", f.selected);
    assert.ok("records" in matches);
    assert.equal(matches.records, count);
    await f.fullReceipt(
      [],
      ["2026-10-01", `2026-10-${String(count).padStart(2, "0")}`],
    );
    return { ...f, events: new InventoryMatchingCoverageEvents(f.store) };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function prepared(count = 1) {
  const f = await fixture(count);
  try {
    const key = await f.db
      .prepare(
        "SELECT scope_id AS scope,stream_id AS stream,facet,partition_id AS partition FROM inventory_matching_coverage_events WHERE completed_version<work_version ORDER BY scope_id,stream_id,facet,partition_id LIMIT 1",
      )
      .first<MatchingCoverageEventKey>();
    assert.ok(key);
    const lease = await f.store.claim(
      "a",
      matchingCoverageEventLeaseScope(key),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.events.prepare("a", key, lease);
    assert.ok(page);
    return { ...f, key, eventLease: lease, page };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
async function snapshot(f: Fixture) {
  const state: Record<string, unknown> = {};
  for (const table of [
    "inventory_matching_coverage_events",
    "inventory_matching_coverage_jobs",
    "inventory_matching_coverage_dispatches",
    "matching_work",
    "inventory_record_facets",
    "inventory_streams",
  ])
    state[table] = (
      await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ).results;
  return state;
}
async function resign(page: PreparedMatchingCoverageEvent) {
  const { digest: _digest, ...input } = page;
  page.digest = await sha256(canonical(input));
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

test("a completed selection dispatches bounded calendar jobs without enumerating or changing contact work", async (t) => {
  const f = await prepared(20);
  try {
    assert.ok(f.page.nodes.length <= 44);
    assert.equal(canonical(f.page.nodes).includes("2026-"), false);
    const work = (
      await f.db
        .prepare("SELECT * FROM matching_work ORDER BY record_key")
        .all()
    ).results;
    const source = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const result = await f.events.publish(f.page);
    assert.equal(result.statements, 1);
    assert.equal(result.jobs, f.page.nodes.length);
    assert.equal((await f.events.publish(f.page)).recovered, true);
    const jobs = (
      await f.db.prepare("SELECT * FROM inventory_matching_coverage_jobs").all<{
        signal_clock: number;
        completed_version: number;
        work_version: number;
      }>()
    ).results;
    assert.equal(jobs.length, result.jobs);
    assert.ok(
      jobs.every(
        (row) =>
          row.signal_clock === f.page.event.scope_clock &&
          row.work_version === 1 &&
          row.completed_version === 0,
      ),
    );
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM matching_work ORDER BY record_key")
          .all()
      ).results,
      work,
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), source);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    assert.equal((await f.events.step("a")).kind, "idle");
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_coverage_jobs SET completed_version=work_version",
        )
        .run(),
      /publisher required/,
    );
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_matching_coverage_dispatches").run(),
      /retained/,
    );
    t.diagnostic(
      `twenty-day selection dispatch: ${result.jobs} prefix jobs, ${result.statements} statement, ${result.rowsRead} reads, ${result.rowsWritten} writes; zero contact work changes`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native coverage dispatch fences readiness, scope clocks, leases, accounts and newer runs", async (t) => {
  for (const change of [
    "coverage",
    "scope-clock",
    "lease",
    "account",
    "new-run",
  ] as const)
    await t.test(change, async () => {
      const f = await prepared();
      try {
        if (change === "coverage")
          await f.db
            .prepare(
              "UPDATE inventory_coverage SET state='collecting',version=version+1 WHERE scope_id='destination'",
            )
            .run();
        else if (change === "scope-clock")
          await f.db
            .prepare(
              "UPDATE inventory_matching_coverage_clocks SET version=version+1 WHERE scope_id='destination'",
            )
            .run();
        else if (change === "lease") await f.store.release(f.eventLease);
        else if (change === "account")
          await f.db.prepare("UPDATE accounts SET status='locked'").run();
        else await f.fullReceipt([], ["2026-10-01", "2026-10-01"]);
        const before = await snapshot(f);
        await assert.rejects(f.events.publish(f.page), /authority changed/);
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("malformed prefix declarations and unguarded event progress are rejected natively", async (t) => {
  for (const change of [
    "duplicate",
    "alphabet",
    "source-wildcard",
    "progress",
  ] as const)
    await t.test(change, async () => {
      const f = await prepared();
      try {
        const before = await snapshot(f);
        if (change === "progress")
          await assert.rejects(
            f.db
              .prepare(
                "UPDATE inventory_matching_coverage_events SET completed_version=work_version",
              )
              .run(),
            /progress guard/,
          );
        else {
          const page = structuredClone(f.page);
          if (change === "duplicate") page.nodes.push(page.nodes[0]);
          else if (change === "alphabet") page.nodes[0] = "!".repeat(43);
          else page.nodes = [""];
          await resign(page);
          await assert.rejects(f.events.publish(page), /nodes invalid/);
        }
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("late changes and suppressed prefix jobs roll back readiness completion and all jobs", async (t) => {
  for (const change of ["clock", "account", "job"] as const)
    await t.test(change, async () => {
      const f = await prepared(20);
      try {
        const sql =
          change === "job"
            ? "CREATE TRIGGER ignored_coverage_job BEFORE INSERT ON inventory_matching_coverage_jobs BEGIN SELECT RAISE(IGNORE); END;"
            : `CREATE TRIGGER late_coverage_dispatch BEFORE UPDATE ON inventory_matching_coverage_dispatches WHEN NEW.state='committed' BEGIN ${change === "clock" ? "UPDATE inventory_matching_coverage_clocks SET version=version+1 WHERE scope_id='destination'" : "UPDATE accounts SET status='locked'"}; END;`;
        await f.db.prepare(sql).run();
        const before = await snapshot(f);
        await assert.rejects(
          f.events.publish(f.page),
          /commit changed|publication incomplete/,
        );
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("lost acknowledgements recover the original dispatch without completing newer readiness", async () => {
  const f = await prepared();
  try {
    const publisher = new InventoryMatchingCoverageEvents(
      alteredStore(f, async (plan) => {
        await f.db.batch(plan);
        throw new Error("lost acknowledgement");
      }),
    );
    const result = await publisher.publish(f.page);
    assert.equal(result.recovered, true);
    assert.equal(result.jobs, 1);
    await f.fullReceipt([], ["2026-10-01", "2026-10-01"]);
    const before = await snapshot(f);
    assert.equal((await f.events.publish(f.page)).recovered, true);
    assert.deepEqual(await snapshot(f), before);
    const event = await f.db
      .prepare(
        "SELECT work_version,completed_version FROM inventory_matching_coverage_events",
      )
      .first<{ work_version: number; completed_version: number }>();
    assert.ok(event && event.work_version > event.completed_version);
    await f.store.release(f.eventLease);
    const newer = await f.events.step("a");
    assert.ok("jobs" in newer);
    assert.equal(newer.jobs, 1);
    const job = await f.db
      .prepare(
        "SELECT work_version,completed_version FROM inventory_matching_coverage_jobs",
      )
      .first();
    assert.deepEqual(job, { work_version: 2, completed_version: 0 });
  } finally {
    await f.mf.dispose();
  }
});

test("a later SQL failure rolls back the entire bounded dispatch", async () => {
  const f = await prepared();
  try {
    const before = await snapshot(f);
    const publisher = new InventoryMatchingCoverageEvents(
      alteredStore(f, (plan) =>
        f.db.batch([
          ...plan,
          f.db.prepare("SELECT * FROM intentionally_missing_dispatch_table"),
        ]),
      ),
    );
    await assert.rejects(publisher.publish(f.page));
    assert.deepEqual(await snapshot(f), before);
  } finally {
    await f.mf.dispose();
  }
});

test("readiness without remaining current interests completes without prefix jobs", async () => {
  const f = await prepared();
  try {
    await f.matches.match("a", "destination", f.selected);
    const result = await f.events.publish(f.page);
    assert.equal(result.jobs, 0);
    assert.equal((await f.events.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("disabled source routes are excluded before probing current prefix interests", async () => {
  const f = await fixture();
  try {
    await f.db
      .prepare("UPDATE connections SET status='disabled' WHERE id='source'")
      .run();
    const result = await f.events.step("a");
    assert.ok("jobs" in result);
    assert.equal(result.jobs, 0);
    assert.equal((await f.events.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("restoring unchanged source coverage dispatches its wildcard without another projection version", async () => {
  const f = await matchingWorkFixture({ receipts: [] });
  try {
    for (const migration of [
      "0059_inventory_live_bucket_dependencies.sql",
      "0060_inventory_matching_bucket_pages.sql",
      "0062_inventory_matching_pair_jobs.sql",
      "0063_inventory_matching_pair_pages.sql",
      "0067_inventory_matching_coverage_dispatch.sql",
    ])
      await applyMigration(f.db, migration);
    const projections = (
      await f.db
        .prepare("SELECT * FROM comparison_projections ORDER BY record_key")
        .all()
    ).results;
    const run = await f.begin();
    await f.matches.match("a", "destination", f.selected);
    const recovery = await f.db
      .prepare(
        "SELECT nodes FROM inventory_match_recovery WHERE facet='source'",
      )
      .first<{ nodes: string }>();
    assert.equal(recovery?.nodes, '[""]');
    await f.observed(run.id, [observation("op", "operation"), ...f.sources]);
    await f.observed(run.id, []);
    await f.finish(run.id);
    const result = await new InventoryMatchingCoverageEvents(f.store).step("a");
    assert.ok("jobs" in result);
    assert.equal(result.jobs, 1);
    assert.deepEqual(
      await f.db
        .prepare("SELECT facet,node_hash FROM inventory_matching_coverage_jobs")
        .first(),
      { facet: "source", node_hash: "" },
    );
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM comparison_projections ORDER BY record_key")
          .all()
      ).results,
      projections,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("coalesced dispatch stays bounded as retained receipts grow", async (t) => {
  const f = await fixture();
  try {
    const first = await f.events.step("a");
    assert.ok("jobs" in first);
    let turns = 0;
    async function next() {
      if (turns++ % 10 === 0) {
        await f.store.release(f.destinationLease);
        const lease = await f.store.claim(
          "a",
          "inventory:destination",
          Date.now(),
          90000,
        );
        assert.ok(lease);
        Object.assign(f.destinationLease, lease);
      }
      await f.fullReceipt([], ["2026-10-01", "2026-10-01"]);
      const result = await f.events.step("a");
      assert.ok("jobs" in result);
      assert.equal(result.jobs, 1);
      return result;
    }
    for (let i = 0; i < 10; i++) await next();
    const before = await next();
    for (let i = 0; i < 100; i++) await next();
    const after = await next();
    assert.equal(after.rowsRead, before.rowsRead);
    assert.equal(after.rowsWritten, before.rowsWritten);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_matching_coverage_jobs")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_coverage_dispatches",
          )
          .first<{ n: number }>()
      )?.n,
      113,
    );
    const plan = await f.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM inventory_matching_coverage_dispatch_needed WHERE tenant=? AND dispatch_id=?",
      )
      .bind("a", after.dispatchId)
      .all<{ detail: string }>();
    const lookups = plan.results.filter((row) =>
      /SEARCH dep /.test(row.detail),
    );
    assert.ok(lookups.length > 0);
    assert.ok(
      lookups.every((row) =>
        /destination=\? AND source_scope=\? AND seen_clock<\?/.test(row.detail),
      ),
      "reverse map probes must include the eligible route before the range",
    );
    t.diagnostic(
      `warm dispatch before/after 100 retained receipts: ${before.rowsRead}/${after.rowsRead} reads, ${before.rowsWritten}/${after.rowsWritten} writes; one current prefix job`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("QRZ dispatch hashes the full date selection after catch-up completes", async () => {
  const f = await matchingWorkFixture({
    receipts: [],
    range: ["2026-11-09", "2026-11-09"],
  });
  try {
    for (const migration of [
      "0059_inventory_live_bucket_dependencies.sql",
      "0060_inventory_matching_bucket_pages.sql",
      "0062_inventory_matching_pair_jobs.sql",
      "0063_inventory_matching_pair_pages.sql",
      "0067_inventory_matching_coverage_dispatch.sql",
    ])
      await applyMigration(f.db, migration);
    await f.matches.match("a", "destination", f.selected);
    await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
    const result = await new InventoryMatchingCoverageEvents(f.store).step("a");
    assert.ok("jobs" in result);
    assert.equal(result.jobs, 1);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_coverage_jobs WHERE facet='receipt'",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("overlapping readiness events coalesce a prefix at the same scope clock", async () => {
  const f = await fixture();
  try {
    await f.fullReceipt([], ["2026-10-01", "2026-10-01"], {
      stationCallsign: "N1RWJ",
    });
    const first = await f.events.step("a");
    const second = await f.events.step("a");
    assert.ok("jobs" in first && "jobs" in second);
    assert.equal(first.jobs, 1);
    assert.equal(second.jobs, 0);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM inventory_matching_coverage_jobs",
        )
        .first(),
      { work_version: 1, completed_version: 0 },
    );
    assert.equal((await f.events.step("a")).kind, "idle");
  } finally {
    await f.mf.dispose();
  }
});

test("delta restoration dispatches the retained full selection rather than its receive filter", async () => {
  const f = await fixture();
  try {
    const coverage = await f.db
      .prepare(
        "SELECT partition_id,partition_binding,published_run_id FROM inventory_coverage WHERE scope_id='destination' AND facet='receipt' AND partition_id IN(SELECT partition_id FROM inventory_matching_coverage_events WHERE completed_version<work_version)",
      )
      .first<{
        partition_id: string;
        partition_binding: string;
        published_run_id: string;
      }>();
    assert.ok(coverage);
    const stream = await f.inventory.snapshot("a", "destination", "receipt");
    assert.ok(stream);
    const run = await f.runs.begin({
      stream,
      lease: f.destinationLease,
      definition: {
        id: crypto.randomUUID(),
        mode: "delta",
        facet: "receipt",
        partition: coverage.partition_id,
        partitionBinding: coverage.partition_binding,
        collectionBinding: "delta-collect",
        requiredStreams: ["selection"],
        fixedQuery: {
          version: 1,
          provider: "lotw",
          query: {
            startDate: "2026-10-01",
            endDate: "2026-10-01",
            receivedSince: "2026-11-09 00:00:00",
          },
        },
        initialResume: {},
      },
    });
    await f.matches.match("a", "destination", f.selected);
    for (let i = 0; i < 8; i++) {
      const context = await f.runs.context("a", run.id);
      if (context.run.phase === "collecting")
        await f.inventory.publish(
          await f.runs.preparePage(context, f.destinationLease, {
            observations: [],
            requestStartedAt: Date.now(),
            requestBinding: "delta-collect",
            nextResume: {},
            observedComplete: true,
            completedStreams: ["selection"],
            proposedCheckpoint: { done: true },
            nextDueAt: Date.now(),
          }),
        );
      else if (context.run.phase === "quarantining")
        await f.inventory.publish(
          await f.runs.prepareQuarantine(context, f.destinationLease, {
            limit: 200,
          }),
        );
      else if (context.run.phase === "publishing") {
        await f.inventory.publish(
          await f.runs.prepareComplete(context, f.destinationLease),
        );
        break;
      } else throw new Error(`unexpected delta phase ${context.run.phase}`);
      assert.ok(i < 7);
    }
    const key = await f.db
      .prepare(
        "SELECT scope_id AS scope,stream_id AS stream,facet,partition_id AS partition FROM inventory_matching_coverage_events WHERE completed_version<work_version",
      )
      .first<MatchingCoverageEventKey>();
    assert.ok(key);
    const lease = await f.store.claim(
      "a",
      matchingCoverageEventLeaseScope(key),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.events.prepare("a", key, lease);
    assert.ok(page);
    assert.equal(page.event.published_run_id, coverage.published_run_id);
    assert.equal(JSON.parse(page.event.query).query.receivedSince, undefined);
    assert.equal((await f.events.publish(page)).jobs, 1);
  } finally {
    await f.mf.dispose();
  }
});
