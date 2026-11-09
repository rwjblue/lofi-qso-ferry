import assert from "node:assert/strict";
import test from "node:test";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import {
  InventoryMatchingWorkspace,
  type PreparedInventoryMatchingSnapshot,
} from "../src/inventory-matching-workspace.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { database } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import {
  matchingFixture,
  receipt,
  sourceContact,
} from "./inventory-matching-fixtures.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

async function prepared(options: Parameters<typeof matchingFixture>[0] = {}) {
  const runtime = await database();
  try {
    await applyAdditionalMigrations(runtime.db);
    const f = await matchingFixture(options, runtime, "current");
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60_000,
    );
    assert.ok(lease);
    const selected = f.sources.map((row) => ({
      scope: "source",
      key: row.key,
    }));
    const page = await f.workspace.prepare("a", "destination", selected);
    return {
      ...f,
      lease,
      selected,
      page,
      matches: new InventoryMatchingResults(f.store),
    };
  } catch (error) {
    await runtime.mf.dispose();
    throw error;
  }
}
async function resign(page: PreparedInventoryMatchingSnapshot) {
  const { digest: _digest, ...input } = page;
  page.digest = await sha256(canonical(input));
}
async function empty(f: Awaited<ReturnType<typeof prepared>>) {
  for (const table of [
    "inventory_match_sets",
    "inventory_match_records",
    "inventory_match_tokens",
    "match_results",
  ])
    assert.equal(
      (
        await f.db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
      table,
    );
}

test("native publication stores a twenty-pair comparison cohort and receipt replay cannot increment versions", async (t) => {
  const f = await prepared({
    sources: Array.from({ length: 20 }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: 20 }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    assert.ok(f.page.results.every((row) => row.state === "matched_existing"));
    const before = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const result = await f.matches.publish(f.page, f.lease, "twenty");
    assert.equal(result.records, 20);
    const current = await f.matches.current("a", "destination", f.selected);
    assert.equal(current.results.length, 20);
    assert.ok(
      current.results.every(
        (row) => row.state === "matched_existing" && row.version === 1,
      ),
    );
    assert.equal(
      (await f.matches.publish(f.page, f.lease, "twenty")).recovered,
      true,
    );
    assert.deepEqual(
      (await f.matches.current("a", "destination", f.selected)).results,
      current.results,
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM ledger")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    t.diagnostic(
      `20 match results: ${result.statements} publication statements, ${result.rowsRead} rows read, ${result.rowsWritten} rows written; bounded current lookup ${current.rowsRead} rows read`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("empty candidate sets publish inventory absence and a first zero-hit bucket mutation invalidates it", async () => {
  const f = await prepared({ receipts: [] });
  try {
    assert.equal(f.page.results[0].state, "absent_at_inventory");
    assert.ok(f.page.lookups[0].probe.buckets.some((row) => row.version === 0));
    await f.matches.publish(f.page, f.lease);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        .state,
      "absent_at_inventory",
    );
    await f.fullReceipt([receipt()]);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("indexed native match checks reject an altered token shape and malformed coverage keys", async () => {
  const f = await prepared({ receipts: [] });
  try {
    const wrongShape = structuredClone(f.page);
    const token = wrongShape.lookups[0].probe.buckets.find(
      (row) => row.keyClass === "call_and_time",
    );
    assert.ok(token && token.version === 0);
    token.keyClass = "time_only";
    await resign(wrongShape);
    await assert.rejects(
      f.matches.publish(wrongShape, f.lease),
      /inventory match probe incomplete/,
    );
    await empty(f);

    const badKey = structuredClone(f.page);
    badKey.results[0].coverage = ["invalid coverage key"];
    await resign(badKey);
    await assert.rejects(
      f.matches.publish(badKey, f.lease),
      /inventory match result requirements incomplete/,
    );
    await empty(f);
    assert.equal((await f.matches.publish(f.page, f.lease)).records, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("collecting coverage hides results and unchanged full verification restores the same stored version", async () => {
  const f = await prepared();
  try {
    await f.matches.publish(f.page, f.lease);
    const before = (await f.matches.current("a", "destination", f.selected))
      .results;
    const run = await f.begin();
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      0,
    );
    await f.observed(run.id, [
      observation("op", "operation"),
      sourceContact("q0"),
    ]);
    await f.observed(run.id, []);
    await f.finish(run.id);
    assert.deepEqual(
      (await f.matches.current("a", "destination", f.selected)).results,
      before,
    );
    await assert.rejects(
      f.matches.publish(f.page, f.lease),
      /coverage set changed/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a newly completed date partition fences a comparison that never observed that partition", async () => {
  const f = await prepared({
    provider: "lotw",
    receipts: [],
    range: ["2026-11-09", "2026-11-09"],
  });
  try {
    assert.equal(f.page.results[0].state, "incomplete");
    await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
    await assert.rejects(
      f.matches.publish(f.page, f.lease),
      /coverage set changed/,
    );
    await empty(f);
    const fresh = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(fresh.results[0].state, "absent_at_inventory");
    await f.matches.publish(fresh, f.lease);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        .state,
      "absent_at_inventory",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a coverage partition added after admission rolls back with the whole comparison cohort", async () => {
  const f = await prepared();
  try {
    const before = await f.db
      .prepare(
        "SELECT * FROM inventory_matching_coverage_clocks ORDER BY scope_id,facet",
      )
      .all();
    const store = alteredStore(f, async (plan) => {
      const changed = [...plan];
      changed.splice(
        changed.length - 1,
        0,
        f.db.prepare(
          "INSERT INTO inventory_coverage(tenant,scope_id,stream_id,facet,partition_id,partition_binding) VALUES('a','destination','receipt','receipt','late','late')",
        ),
      );
      return f.db.batch(changed);
    });
    await assert.rejects(
      new InventoryMatchingResults(store).publish(f.page, f.lease),
      /coverage set changed/,
    );
    await empty(f);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT * FROM inventory_matching_coverage_clocks ORDER BY scope_id,facet",
          )
          .all()
      ).results,
      before.results,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_coverage WHERE partition_id='late'",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("coverage clocks track readiness changes while ignoring page bookkeeping and confirmations", async () => {
  const f = await prepared({ provider: "lotw" });
  try {
    const clocks = async () =>
      (
        await f.db
          .prepare(
            "SELECT scope_id,facet,version FROM inventory_matching_coverage_clocks ORDER BY scope_id,facet",
          )
          .all()
      ).results;
    const before = await clocks();
    await f.db
      .prepare(
        "UPDATE inventory_coverage SET version=version+1,completed_at=completed_at+1 WHERE scope_id='destination'",
      )
      .run();
    assert.deepEqual(await clocks(), before);
    await f.db
      .prepare(
        "INSERT INTO inventory_coverage(tenant,scope_id,stream_id,facet,partition_id,partition_binding) VALUES('a','destination','receipt','confirmation','confirmation','confirmation')",
      )
      .run();
    await f.db
      .prepare(
        "UPDATE inventory_coverage SET version=version+1,state='held' WHERE facet='confirmation'",
      )
      .run();
    assert.deepEqual(await clocks(), before);
    // Prepare again because per-row publication dependencies still see the
    // bookkeeping change, even though no coverage-set clock was necessary.
    const page = await f.workspace.prepare("a", "destination", f.selected);
    await f.matches.publish(page, f.lease);
    const current = (await f.matches.current("a", "destination", f.selected))
      .results;
    await f.fullReceipt([receipt()]);
    assert.notDeepEqual(await clocks(), before);
    assert.deepEqual(
      (await f.matches.current("a", "destination", f.selected)).results,
      current,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_coverage SET version=version+1,partition_id='moved' WHERE facet='receipt'",
        )
        .run(),
      /immutable inventory coverage identity/,
    );
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_matching_coverage_clocks").run(),
      /retained/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_coverage_clocks SET version=version+2",
        )
        .run(),
      /regressed/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("legacy read-only snapshots cannot bypass coverage-set publication fences", async () => {
  const f = await prepared();
  try {
    const legacy = await new InventoryMatchingWorkspace(f.store, {
      trackCoverageClocks: false,
    }).prepare("a", "destination", f.selected);
    assert.equal(legacy.coverageClocks, undefined);
    assert.ok(legacy.scopes.every((row) => row.coverageClock === undefined));
    await assert.rejects(
      f.matches.publish(legacy, f.lease),
      /coverage (set changed|recovery missing)/,
    );
    await empty(f);
    const forged = structuredClone(f.page);
    const target = forged.scopes.find((row) => row.scope === "destination");
    assert.ok(target);
    target.coverageClock = 0;
    await resign(forged);
    await assert.rejects(
      f.matches.publish(forged, f.lease),
      /coverage set changed/,
    );
    await empty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("operating-detail differences and missing location remain distinct from a historical match", async () => {
  const remote = receipt();
  remote.body = { ...(remote.body as object), MY_GRIDSQUARE: "EM00" };
  const f = await prepared({ receipts: [remote] });
  try {
    assert.equal(f.page.graph.results[0].state, "unique");
    assert.equal(f.page.results[0].state, "projection_mismatch");
    await f.matches.publish(f.page, f.lease);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        .reason,
      "operating_details_differ",
    );
  } finally {
    await f.mf.dispose();
  }
  const source = sourceContact("q0");
  source.body = { ...(source.body as object), our: {} };
  const missing = await prepared({ sources: [source] });
  try {
    assert.equal(
      missing.page.results[0].reason,
      "operating_details_unavailable",
    );
    await missing.matches.publish(missing.page, missing.lease);
    assert.equal(
      (await missing.matches.current("a", "destination", missing.selected))
        .results[0].state,
      "incomplete",
    );
  } finally {
    await missing.mf.dispose();
  }
});

test("native guards reject omitted reverse candidates and missing coverage after manifest recomputation", async (t) => {
  for (const omitted of ["candidate", "coverage", "token"] as const)
    await t.test(omitted, async () => {
      const f = await prepared({
        sources: [sourceContact("q0"), sourceContact("q1", "14:00:00")],
        receipts: [receipt("1", "133000")],
      });
      try {
        // Select only q0 while retaining q1 solely through the remote's reverse window.
        const page = await f.workspace.prepare("a", "destination", [
          { scope: "source", key: "q0" },
        ]);
        if (omitted === "candidate") {
          page.records = page.records.filter(
            (row) => row.reference.key !== "q1",
          );
          for (const lookup of page.lookups)
            lookup.probe.candidates = lookup.probe.candidates.filter(
              (row) => row.key !== "q1",
            );
        } else if (omitted === "coverage")
          page.coverage = page.coverage.filter(
            (row) => row.facet !== "receipt",
          );
        else page.lookups[0].probe.buckets.pop();
        await resign(page);
        await assert.rejects(f.matches.publish(page, f.lease));
        await empty(f);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("lease, source visibility, projection and membership races reject the entire cohort", async (t) => {
  for (const sql of [
    "UPDATE leases SET expires_at=0 WHERE scope='matching:destination'",
    "UPDATE accounts SET status='locked' WHERE id='a'",
    "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant='a'",
    "UPDATE comparison_index SET projection_version=projection_version+1 WHERE scope_id='source'",
    "UPDATE inventory_membership_versions SET version=version+1 WHERE scope_id='source' AND record_key='q0'",
  ])
    await t.test(sql, async () => {
      const f = await prepared();
      try {
        await f.db.prepare(sql).run();
        await assert.rejects(
          f.matches.publish(f.page, f.lease),
          /dependencies changed/,
        );
        await empty(f);
      } finally {
        await f.mf.dispose();
      }
    });
});

function alteredStore(
  f: Awaited<ReturnType<typeof prepared>>,
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

test("late SQL and post-admission authority failures roll all publication state back", async (t) => {
  for (const failure of ["sql", "authority"] as const)
    await t.test(failure, async () => {
      const f = await prepared();
      try {
        const store = alteredStore(f, async (plan) => {
          const changed = [...plan];
          changed.splice(
            changed.length - 1,
            0,
            f.db.prepare(
              failure === "sql"
                ? "SELECT * FROM intentional_missing_match_table"
                : "UPDATE accounts SET status='locked' WHERE id='a'",
            ),
          );
          return f.db.batch(changed);
        });
        await assert.rejects(
          new InventoryMatchingResults(store).publish(f.page, f.lease),
        );
        await empty(f);
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

test("lost acknowledgement recovery preserves a newer invalidation instead of refreshing old results", async () => {
  const f = await prepared();
  try {
    const store = alteredStore(f, async (plan) => {
      await f.db.batch(plan);
      throw new Error("lost acknowledgement");
    });
    assert.equal(
      (
        await new InventoryMatchingResults(store).publish(
          f.page,
          f.lease,
          "lost",
        )
      ).recovered,
      true,
    );
    const op = observation("op", "operation", 2);
    op.body = { uuid: "op", stationCall: "K1ABC" };
    await f.full([op, sourceContact("q0")]);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      0,
    );
    assert.equal(
      (await f.matches.publish(f.page, f.lease, "lost")).recovered,
      true,
    );
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      0,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM match_results")
          .first<{ version: number }>()
      )?.version,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("dependency rows close at admission and current lookup stays bounded as unrelated sets grow", async () => {
  const f = await prepared();
  try {
    await f.matches.publish(f.page, f.lease, "current");
    const before = await f.matches.current("a", "destination", f.selected);
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_match_records SET membership_version=membership_version+1 WHERE set_id='current'",
        )
        .run(),
      /immutable/,
    );
    await assert.rejects(
      f.db
        .prepare("DELETE FROM inventory_match_tokens WHERE set_id='current'")
        .run(),
      /retained/,
    );
    await f.db
      .prepare(`INSERT INTO inventory_match_sets(tenant,set_id,destination,generation_id,domain_version,source_set_version,policy_version,result_version,input_digest,lease_token,lease_fence,prepared_at,scope_count,coverage_count,record_count,probe_count,token_count,candidate_count,row_count)
      SELECT h.tenant,j.value,h.destination,h.generation_id,h.domain_version,h.source_set_version,h.policy_version,h.result_version,h.input_digest,h.lease_token,h.lease_fence,h.prepared_at,h.scope_count,h.coverage_count,h.record_count,h.probe_count,h.token_count,h.candidate_count,h.row_count FROM json_each(?) j CROSS JOIN inventory_match_sets h WHERE h.set_id='current'`)
      .bind(
        JSON.stringify(Array.from({ length: 5000 }, (_, i) => `unrelated${i}`)),
      )
      .run();
    const after = await f.matches.current("a", "destination", f.selected);
    assert.deepEqual(after, before);
  } finally {
    await f.mf.dispose();
  }
});

test("native LoTW matching uses the same group-mode and operating-detail rules", async () => {
  const source = sourceContact("q0");
  source.body = { ...(source.body as object), mode: "FT4" };
  const remote = receipt();
  remote.body = {
    ...(remote.body as object),
    MODE: "DATA",
    APP_LOTW_MODE: "FT8",
    APP_LOTW_MODEGROUP: "DATA",
  };
  const f = await prepared({
    provider: "lotw",
    sources: [source],
    receipts: [remote],
  });
  try {
    assert.equal(f.page.results[0].state, "matched_existing");
    await f.matches.publish(f.page, f.lease);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        .state,
      "matched_existing",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a date-union dependency cannot be dropped from an otherwise recomputed absence preparation", async () => {
  const f = await prepared({
    provider: "lotw",
    sources: [sourceContact("q0", "00:05:00")],
    receipts: [],
  });
  try {
    await f.fullReceipt([], ["2026-11-07", "2026-11-07"]);
    const page = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(page.results[0].state, "absent_at_inventory");
    assert.equal(page.results[0].coverage.length, 2);
    const removed = page.coverage.find((row) => row.facet === "receipt");
    assert.ok(removed);
    page.coverage = page.coverage.filter((row) => row !== removed);
    await resign(page);
    await assert.rejects(
      f.matches.publish(page, f.lease),
      /requirements incomplete/,
    );
    await empty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("context-dependent exclusions publish without losing their future invalidation dependency", async () => {
  const f = await prepared();
  try {
    const op = observation("op", "operation", 2);
    op.body = { uuid: "op", stationCall: "T/N1RWJ" };
    await f.full([op, sourceContact("q0")]);
    await f.project("source");
    const page = await f.workspace.prepare("a", "destination", f.selected);
    assert.equal(page.results[0].state, "excluded");
    await f.matches.publish(page, f.lease);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results[0]
        .state,
      "excluded",
    );
    await f.full([observation("op", "operation", 3), sourceContact("q0")]);
    assert.equal(
      (await f.matches.current("a", "destination", f.selected)).results.length,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a prepared result cannot borrow a different selected contact's remote candidate", async () => {
  const f = await prepared({
    sources: [sourceContact("q0"), sourceContact("q1", "13:00:00", "K1ABC")],
    receipts: [receipt("1"), receipt("2", "130000", "K1ABC")],
  });
  try {
    f.page.results[0].remote = f.page.results[1].remote;
    await resign(f.page);
    await assert.rejects(
      f.matches.publish(f.page, f.lease),
      /requirements incomplete/,
    );
    await empty(f);
  } finally {
    await f.mf.dispose();
  }
});
