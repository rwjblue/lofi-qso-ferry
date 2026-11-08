import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { inventoryCoverageRange } from "../src/inventory-coverage-keys.ts";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import type { PreparedInventoryMatchingSnapshot } from "../src/inventory-matching-workspace.ts";
import { canonical, sha256 } from "../src/security.ts";
import type { Lease } from "../src/store.ts";
import { Store } from "../src/store.ts";
import { observation } from "./inventory-context-fixtures.ts";
import {
  matchingFixture,
  sourceContact,
} from "./inventory-matching-fixtures.ts";

async function fixture(options: Parameters<typeof matchingFixture>[0] = {}) {
  const f = await matchingFixture(options);
  const lease = await f.store.claim(
    "a",
    "matching:destination",
    Date.now(),
    60000,
  );
  assert.ok(lease);
  return {
    ...f,
    lease,
    matches: new InventoryMatchingResults(f.store),
    selected: f.sources.map((row) => ({ scope: "source", key: row.key })),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function count(f: Fixture, table: string) {
  return (
    await f.db
      .prepare(`SELECT count(*) AS n FROM ${table}`)
      .first<{ n: number }>()
  )?.n;
}
async function resign(page: PreparedInventoryMatchingSnapshot) {
  const { digest: _digest, ...manifest } = page;
  page.digest = await sha256(canonical(manifest));
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

async function finishEmpty(f: Fixture, id: string, lease: Lease) {
  for (let pass = 0; pass < 8; pass++) {
    const context = await f.runs.context("a", id);
    if (context.run.phase === "collecting" || context.run.phase === "catchup")
      await f.inventory.publish(
        await f.runs.preparePage(context, lease, {
          observations: [],
          requestStartedAt: Date.now(),
          requestBinding:
            context.run.phase === "catchup"
              ? (context.run.catchupBinding ?? context.run.collectionBinding)
              : context.run.collectionBinding,
          nextResume: {},
          observedComplete: true,
          completedStreams: context.run.requiredStreams,
          proposedCheckpoint: { done: true },
          nextDueAt: Date.now(),
        }),
      );
    else if (context.run.phase === "quarantining")
      await f.inventory.publish(
        await f.runs.prepareQuarantine(context, lease, { limit: 200 }),
      );
    else if (context.run.phase === "publishing") {
      await f.inventory.publish(await f.runs.prepareComplete(context, lease));
      return;
    } else
      throw new Error(`unexpected empty coverage phase ${context.run.phase}`);
  }
  throw new Error("empty coverage run limit");
}

test("missing receipt coverage registers an opaque current wait point and ready replacement collects it", async (t) => {
  const f = await fixture({
    provider: "lotw",
    receipts: [],
    range: ["2026-11-09", "2026-11-09"],
  });
  try {
    const page = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(page.results[0].reason, "forward_incomplete");
    assert.equal(page.recovery?.length, 1);
    assert.equal(page.recovery?.[0].facet, "receipt");
    assert.equal(page.recovery?.[0].nodes.length, 23);
    assert.equal(canonical(page.recovery).includes("2026-11"), false);
    const result = await f.matches.publish(page, f.lease);
    assert.equal(await count(f, "inventory_matching_coverage_dependents"), 23);
    await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
    assert.equal(await count(f, "inventory_matching_coverage_events"), 1);
    const fresh = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(fresh.results[0].state, "absent_at_inventory");
    assert.deepEqual(fresh.recovery, []);
    await f.matches.publish(fresh, f.lease);
    assert.equal(await count(f, "inventory_matching_coverage_dependents"), 0);
    assert.equal(
      await count(f, "inventory_match_recovery"),
      1,
      "original declaration remains in retained proof",
    );
    t.diagnostic(
      `one blocked receipt comparison: ${result.statements} statements, ${result.rowsRead} reads, ${result.rowsWritten} writes; 23 current opaque prefix entries`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("one missing day is a sufficient cross-midnight wait point, whichever day completes first", async () => {
  for (const earlyFirst of [false, true]) {
    const f = await fixture({
      provider: "lotw",
      sources: [sourceContact("q0", "00:05:00")],
      receipts: [],
      range: ["2026-11-09", "2026-11-09"],
    });
    try {
      const key = await new InventoryComparisonGenerations(f.store).key("a");
      const page = await f.workspace.prepare("a", "destination", f.selected);
      assert.equal(page.recovery?.length, 1);
      const early = await inventoryCoverageRange(
        key,
        "destination",
        "2026-11-07",
        "2026-11-07",
      );
      const late = await inventoryCoverageRange(
        key,
        "destination",
        "2026-11-08",
        "2026-11-08",
      );
      assert.ok(early.every((tag) => page.recovery?.[0].nodes.includes(tag)));
      assert.ok(late.every((tag) => !page.recovery?.[0].nodes.includes(tag)));
      await f.matches.publish(page, f.lease);
      const first = earlyFirst ? "2026-11-07" : "2026-11-08";
      const second = earlyFirst ? "2026-11-08" : "2026-11-07";
      await f.fullReceipt([], [first, first]);
      const middle = await f.workspace.prepare("a", "destination", f.selected);
      assert.equal(middle.results[0].state, "incomplete");
      assert.ok(
        (earlyFirst ? late : early).every((tag) =>
          middle.recovery?.[0].nodes.includes(tag),
        ),
      );
      await f.matches.publish(middle, f.lease);
      assert.equal(
        await count(f, "inventory_matching_coverage_dependents"),
        23,
      );
      await f.fullReceipt([], [second, second]);
      const ready = await f.workspace.prepare("a", "destination", f.selected);
      assert.equal(ready.results[0].state, "absent_at_inventory");
      assert.deepEqual(ready.recovery, []);
      await f.matches.publish(ready, f.lease);
      assert.equal(await count(f, "inventory_matching_coverage_dependents"), 0);
    } finally {
      await f.mf.dispose();
    }
  }
});

test("unchanged source verification journals recovery for a temporarily invisible ready projection", async () => {
  const f = await fixture();
  try {
    const before = await f.db
      .prepare(
        "SELECT version FROM comparison_projections WHERE scope_id='source' AND record_key='q0'",
      )
      .first();
    const run = await f.begin();
    const page = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(page.results[0].reason, "source_unavailable");
    assert.deepEqual(
      page.recovery?.map((row) => ({
        scope: row.scope,
        facet: row.facet,
        nodes: row.nodes,
      })),
      [{ scope: "source", facet: "source", nodes: [""] }],
    );
    await f.matches.publish(page, f.lease);
    await f.observed(run.id, [
      observation("op", "operation"),
      sourceContact("q0"),
    ]);
    await f.observed(run.id, []);
    await f.finish(run.id);
    assert.equal(await count(f, "inventory_matching_coverage_events"), 1);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT version FROM comparison_projections WHERE scope_id='source' AND record_key='q0'",
        )
        .first(),
      before,
    );
    const fresh = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(fresh.results[0].state, "matched_existing");
    await f.matches.publish(fresh, f.lease);
    assert.equal(await count(f, "inventory_matching_coverage_dependents"), 0);
  } finally {
    await f.mf.dispose();
  }
});

test("permanently held source shapes do not subscribe to every unchanged coverage poll", async () => {
  const source = sourceContact("q0");
  source.body = { ...(source.body as object), band: "unsupported-band" };
  const f = await fixture({ sources: [source] });
  try {
    const page = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(page.results[0].reason, "source_unavailable");
    assert.deepEqual(page.recovery, []);
    await f.matches.publish(page, f.lease);
    await f.full([observation("op", "operation"), source]);
    assert.equal(await count(f, "inventory_matching_coverage_events"), 0);
    assert.equal(await count(f, "inventory_matching_coverage_dependents"), 0);
  } finally {
    await f.mf.dispose();
  }
});

test("an empty second source completes reverse census without any projection publication", async () => {
  const f = await fixture();
  try {
    await f.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','other','lofi','other','Other','active','v1','{}',1)",
      )
      .run();
    await (
      await f.store.putPrivate("a", "other", "v1", "credential", {
        secret: "private",
      })
    ).run();
    const stream = await f.inventory.initialize(
      {
        tenant: "a",
        scope: "other",
        connection: "other",
        provider: "lofi",
        logicalIdentity: "other",
        adapterBinding: "test-v1",
        ordering: "numeric",
      },
      "sync",
      "all-clients-v1",
    );
    await f.project("other");
    const page = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(page.results[0].reason, "reverse_incomplete");
    assert.deepEqual(
      page.recovery?.map((row) => ({
        scope: row.scope,
        facet: row.facet,
        nodes: row.nodes,
      })),
      [{ scope: "other", facet: "source", nodes: [""] }],
    );
    await f.matches.publish(page, f.lease);
    const lease = await f.store.claim(
      "a",
      "inventory:other",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const run = await f.runs.begin({
      stream,
      lease,
      definition: {
        id: crypto.randomUUID(),
        mode: "full",
        facet: "source",
        partition: "all",
        partitionBinding: "all-v1",
        collectionBinding: "collect-v1",
        catchupBinding: "catchup-v1",
        requiredStreams: ["operations", "qsos"],
        fixedQuery: { upper: Date.now() },
        initialResume: {},
      },
    });
    await finishEmpty(f, run.id, lease);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT scope_id,facet FROM inventory_matching_coverage_events",
        )
        .first(),
      { scope_id: "other", facet: "source" },
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_projections WHERE scope_id='other'",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
    const ready = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(ready.results[0].state, "matched_existing");
    assert.deepEqual(ready.recovery, []);
  } finally {
    await f.mf.dispose();
  }
});

test("delta readiness recovery retains the original full selection instead of the receive filter", async () => {
  const f = await fixture({ provider: "lotw" });
  try {
    const coverage = await f.db
      .prepare(
        "SELECT partition_id,partition_binding,published_run_id FROM inventory_coverage WHERE scope_id='destination' AND facet='receipt'",
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
          provider: "lotw",
          query: {
            startDate: "2026-11-08",
            endDate: "2026-11-08",
            receivedSince: "2026-11-09T00:00:00Z",
          },
        },
        initialResume: {},
      },
    });
    const page = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(page.recovery?.[0].facet, "receipt");
    await f.matches.publish(page, f.lease);
    await finishEmpty(f, run.id, f.destinationLease);
    const event = await f.db
      .prepare(
        "SELECT e.published_run_id,r.mode,r.fixed_query FROM inventory_matching_coverage_events e JOIN inventory_runs r ON r.tenant=e.tenant AND r.run_id=e.published_run_id",
      )
      .first<{ published_run_id: string; mode: string; fixed_query: string }>();
    assert.equal(event?.published_run_id, coverage.published_run_id);
    assert.equal(event?.mode, "full");
    assert.equal(
      JSON.parse(event?.fixed_query ?? "{}").query.receivedSince,
      undefined,
    );
    const fresh = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(fresh.results[0].state, "matched_existing");
  } finally {
    await f.mf.dispose();
  }
});

test("twenty date wait points share prefix entries in one native comparison cohort", async (t) => {
  const sources = Array.from({ length: 20 }, (_, i) => {
    const source = sourceContact(`q${i}`);
    source.body = {
      ...(source.body as object),
      startAtMillis: Date.parse("2026-10-01T13:00:00Z") + i * 86400000,
    };
    return source;
  });
  const f = await fixture({
    provider: "lotw",
    sources,
    receipts: [],
    range: ["2026-11-09", "2026-11-09"],
  });
  try {
    const page = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(page.recovery?.length, 20);
    assert.ok(page.results.every((row) => row.reason === "forward_incomplete"));
    const unique = new Set(page.recovery.flatMap((row) => row.nodes)).size;
    const result = await f.matches.publish(page, f.lease);
    assert.equal(
      await count(f, "inventory_matching_coverage_dependents"),
      unique,
    );
    assert.ok(unique < 20 * 23);
    t.diagnostic(
      `20 blocked days: ${result.statements} statements, ${result.rowsRead} reads, ${result.rowsWritten} writes; 460 declared prefixes deduplicate to ${unique} current entries`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("recovery publication and readiness signals ignore retained superseded proofs", async (t) => {
  const f = await fixture({
    provider: "lotw",
    receipts: [],
    range: ["2026-11-09", "2026-11-09"],
  });
  try {
    const reads: number[] = [];
    let lastSet = "";
    for (let i = 0; i <= 500; i++) {
      if (i > 0 && i % 25 === 0) {
        await f.store.release(f.lease);
        const lease = await f.store.claim(
          "a",
          "matching:destination",
          Date.now(),
          60000,
        );
        assert.ok(lease);
        Object.assign(f.lease, lease);
      }
      const result = await f.matches.publish(
        await f.workspace.prepare("a", "destination", f.selected),
        f.lease,
      );
      lastSet = result.setId;
      if (i === 0) continue;
      reads.push(result.rowsRead);
      // Native successful-path costs vary even after warming. Enforce a fixed
      // per-publication budget across history sizes instead of two samples.
      assert.ok(
        result.rowsRead <= 700,
        `publication ${i}: ${result.rowsRead} reads`,
      );
      assert.equal(result.rowsWritten, 155);
    }
    t.diagnostic(
      `one wait point across 500 old proofs: ${Math.min(...reads)}–${Math.max(...reads)} reads per publication, 155 writes`,
    );
    const queryPlan = await f.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM inventory_match_recovery_source_requirements WHERE tenant=? AND set_id=?",
      )
      .bind("a", lastSet)
      .all<{ detail: string }>();
    assert.ok(
      queryPlan.results
        .filter((row) => row.detail.startsWith("SCAN"))
        .every((row) => row.detail.includes("VIRTUAL TABLE")),
      "retained dependency tables use indexed searches",
    );
    assert.equal(await count(f, "inventory_matching_coverage_dependents"), 23);
    assert.equal(await count(f, "inventory_match_recovery"), 501);
    await f.store.release(f.destinationLease);
    const destinationLease = await f.store.claim(
      "a",
      "inventory:destination",
      Date.now(),
      90000,
    );
    assert.ok(destinationLease);
    Object.assign(f.destinationLease, destinationLease);
    await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
    assert.equal(await count(f, "inventory_matching_coverage_events"), 1);
  } finally {
    await f.mf.dispose();
  }
});

test("re-signed missing or malformed wait points reject the whole comparison publication", async (t) => {
  for (const failure of [
    "receipt",
    "source",
    "path",
    "alphabet",
    "extra_source",
  ] as const)
    await t.test(failure, async () => {
      const f = await fixture(
        failure === "source"
          ? {}
          : {
              provider: "lotw",
              receipts: [],
              range: ["2026-11-09", "2026-11-09"],
            },
      );
      try {
        if (failure === "source") await f.begin();
        const page = await f.workspace.prepare("a", "destination", f.selected);
        assert.ok(page.recovery?.length);
        if (failure === "receipt" || failure === "source") page.recovery = [];
        else if (failure === "path") page.recovery[0].nodes.pop();
        else if (failure === "alphabet")
          page.recovery[0].nodes[0] = "!".repeat(43);
        else
          page.recovery.push({
            scope: "source",
            facet: "source",
            subject: page.selected[0],
            nodes: [""],
          });
        await resign(page);
        await assert.rejects(f.matches.publish(page, f.lease));
        assert.equal(await count(f, "inventory_match_sets"), 0);
        assert.equal(await count(f, "match_results"), 0);
        assert.equal(
          await count(f, "inventory_matching_coverage_dependents"),
          0,
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("late coverage mutations and suppressed dependency inserts roll every result and subscription back", async (t) => {
  for (const failure of ["coverage", "dependency", "header"] as const)
    await t.test(failure, async () => {
      const f = await fixture({
        provider: "lotw",
        receipts: [],
        range: ["2026-11-09", "2026-11-09"],
      });
      try {
        const page = await f.workspace.prepare("a", "destination", f.selected);
        if (failure === "dependency")
          await f.db
            .prepare(
              "CREATE TRIGGER suppress_coverage_dependency BEFORE INSERT ON inventory_matching_coverage_dependents WHEN NEW.node_index=7 BEGIN SELECT RAISE(IGNORE); END;",
            )
            .run();
        const store = alteredStore(f, async (plan) => {
          const changed = [...plan];
          if (failure !== "dependency")
            changed.splice(
              changed.length - 1,
              0,
              f.db.prepare(
                failure === "coverage"
                  ? "INSERT INTO inventory_coverage(tenant,scope_id,stream_id,facet,partition_id,partition_binding) VALUES('a','destination','receipt','receipt','late','late')"
                  : "UPDATE inventory_match_sets SET recovery_count=0,state='committed'",
              ),
            );
          return f.db.batch(changed);
        });
        await assert.rejects(
          new InventoryMatchingResults(store).publish(page, f.lease),
        );
        assert.equal(await count(f, "inventory_match_sets"), 0);
        assert.equal(await count(f, "match_results"), 0);
        assert.equal(
          await count(f, "inventory_matching_coverage_dependents"),
          0,
        );
        assert.equal(await count(f, "inventory_matching_coverage_events"), 0);
      } finally {
        await f.mf.dispose();
      }
    });
});
