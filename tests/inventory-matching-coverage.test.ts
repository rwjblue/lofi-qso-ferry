import assert from "node:assert/strict";
import test from "node:test";
import {
  InventoryMatchingCoverage,
  matchingCoverageLeaseScope,
  type MatchingCoverageKey,
  type PreparedMatchingCoverage,
} from "../src/inventory-matching-coverage.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { coverageFixture } from "./inventory-matching-coverage-fixtures.ts";

type Fixture = Awaited<ReturnType<typeof coverageFixture>>;
async function prepared(count = 41, limit = 1) {
  const f = await coverageFixture(count);
  try {
    const key = await f.db
      .prepare(
        "SELECT generation_id AS generation,scope_id AS scope,facet,node_hash AS hash FROM inventory_matching_coverage_jobs WHERE completed_version<work_version",
      )
      .first<MatchingCoverageKey>();
    assert.ok(key);
    const lease = await f.store.claim(
      "a",
      matchingCoverageLeaseScope(key),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.coverage.prepare("a", key, lease, limit);
    assert.ok(page);
    return { ...f, key, coverageLease: lease, page };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
async function snapshot(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "inventory_matching_coverage_jobs",
    "inventory_matching_coverage_pages",
    "inventory_matching_coverage_rows",
    "inventory_matching_coverage_guards",
    "matching_work",
    "match_results",
    "inventory_record_facets",
    "inventory_streams",
  ])
    result[table] = (
      await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ).results;
  return result;
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
async function resign(page: PreparedMatchingCoverage) {
  const { digest: _digest, ...input } = page;
  page.digest = await sha256(canonical(input));
}

test("coverage prefix expansion queues two hundred incomplete references and resumes the final cohort", async (t) => {
  const f = await coverageFixture(205);
  try {
    const source = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const first = await f.coverage.step("a");
    assert.ok("records" in first);
    assert.equal(first.records, 200);
    assert.equal(first.sets, 10);
    assert.equal(first.complete, false);
    assert.equal(first.statements, 6);
    const second = await f.coverage.step("a");
    assert.ok("records" in second);
    assert.equal(second.records, 5);
    assert.equal(second.sets, 1);
    assert.equal(second.complete, true);
    assert.equal((await f.coverage.step("a")).kind, "idle");
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM matching_work WHERE completed_version<work_version",
          )
          .first<{ n: number }>()
      )?.n,
      205,
    );
    let completed = 0;
    for (let i = 0; i < 12; i++) {
      const turn = await f.work.step("a");
      if (turn.kind === "idle") break;
      assert.ok("records" in turn);
      assert.equal(typeof turn.records, "number");
      completed += turn.records!;
    }
    assert.equal(completed, 205);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM match_results_current WHERE state='absent_at_inventory'",
          )
          .first<{ n: number }>()
      )?.n,
      205,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_coverage_dependents",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), source);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    t.diagnostic(
      `coverage expansion of 200 references: ${first.statements} statements, ${first.rowsRead} reads, ${first.rowsWritten} writes`,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native prefix publication fences leases, account access, configuration, roster and newer signals", async (t) => {
  for (const change of [
    "lease",
    "account",
    "scope",
    "roster",
    "signal",
    "cursor",
  ] as const)
    await t.test(change, async () => {
      const f = await prepared();
      try {
        const page = structuredClone(f.page);
        if (change === "lease") await f.store.release(f.coverageLease);
        else if (change === "account")
          await f.db.prepare("UPDATE accounts SET status='locked'").run();
        else if (change === "scope")
          await f.db
            .prepare(
              "UPDATE inventory_scopes SET config_version=config_version+1 WHERE scope_id='destination'",
            )
            .run();
        else if (change === "roster")
          await f.db
            .prepare(
              "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1",
            )
            .run();
        else if (change === "signal") {
          await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
          await f.events.step("a");
        } else {
          page.job.cursor_set = "incorrect";
          await resign(page);
        }
        const before = await snapshot(f);
        await assert.rejects(
          f.coverage.publish(page),
          /authority changed|frontier changed/,
        );
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("native census and final guards roll back omitted rows, ignored work, late authority and cursor mutations", async (t) => {
  for (const failure of [
    "row",
    "work",
    "account",
    "scope",
    "census",
    "identity",
  ] as const)
    await t.test(failure, async () => {
      const f = await prepared();
      try {
        const sql =
          failure === "row"
            ? "CREATE TRIGGER ignored_coverage_row BEFORE INSERT ON inventory_matching_coverage_rows BEGIN SELECT RAISE(IGNORE); END;"
            : failure === "work"
              ? "CREATE TRIGGER ignored_coverage_work BEFORE INSERT ON matching_work BEGIN SELECT RAISE(IGNORE); END;"
              : `CREATE TRIGGER late_coverage_page BEFORE UPDATE ON inventory_matching_coverage_pages WHEN NEW.state='committed' BEGIN ${failure === "account" ? "UPDATE accounts SET status='locked'" : failure === "scope" ? "UPDATE inventory_scopes SET config_version=config_version+1 WHERE scope_id='source'" : failure === "census" ? "UPDATE inventory_matching_coverage_pages SET row_count=row_count+1 WHERE page_id=OLD.page_id" : "UPDATE inventory_matching_coverage_pages SET next_set='forged' WHERE page_id=OLD.page_id"}; END;`;
        await f.db.prepare(sql).run();
        const before = await snapshot(f);
        await assert.rejects(
          f.coverage.publish(f.page),
          /incomplete|changed|immutable/,
        );
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("lost acknowledgements recover the old frontier without consuming a newer coverage signal", async () => {
  const f = await prepared();
  try {
    const publisher = new InventoryMatchingCoverage(
      alteredStore(f, async (plan) => {
        await f.db.batch(plan);
        throw new Error("lost acknowledgement");
      }),
    );
    const first = await publisher.publish(f.page);
    assert.equal(first.recovered, true);
    assert.equal(first.records, 20);
    assert.equal(first.complete, false);
    await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
    await f.events.step("a");
    const before = await snapshot(f);
    assert.equal((await f.coverage.publish(f.page)).recovered, true);
    assert.deepEqual(await snapshot(f), before);
    const job = await f.db
      .prepare(
        "SELECT work_version,completed_version,cursor_destination,last_turn FROM inventory_matching_coverage_jobs",
      )
      .first();
    assert.deepEqual(job, {
      work_version: 2,
      completed_version: 0,
      cursor_destination: "",
      last_turn: 1,
    });
    await f.store.release(f.coverageLease);
    const newer = await f.coverage.step("a");
    assert.ok("records" in newer);
    assert.equal(newer.records, 41);
    assert.equal(newer.complete, true);
  } finally {
    await f.mf.dispose();
  }
});

test("a later SQL failure leaves zero queued work or partial prefix progress", async () => {
  const f = await prepared();
  try {
    const before = await snapshot(f);
    const publisher = new InventoryMatchingCoverage(
      alteredStore(f, (plan) =>
        f.db.batch([
          ...plan,
          f.db.prepare("SELECT * FROM intentional_missing_prefix_table"),
        ]),
      ),
    );
    await assert.rejects(publisher.publish(f.page));
    assert.deepEqual(await snapshot(f), before);
  } finally {
    await f.mf.dispose();
  }
});

test("fresh comparisons at the signal clock and disabled routes leave empty old prefix jobs", async (t) => {
  for (const change of ["fresh", "disabled"] as const)
    await t.test(change, async () => {
      const f = await coverageFixture(41);
      try {
        if (change === "fresh")
          for (let i = 0; i < f.selected.length; i += 20)
            await f.matches.match(
              "a",
              "destination",
              f.selected.slice(i, i + 20),
            );
        else
          await f.db
            .prepare(
              "UPDATE connections SET status='disabled' WHERE id='source'",
            )
            .run();
        const turn = await f.coverage.step("a");
        assert.ok("records" in turn);
        assert.equal(turn.records, 0);
        assert.equal(turn.sets, 0);
        assert.equal(turn.complete, true);
        assert.equal((await f.coverage.step("a")).kind, "idle");
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM matching_work")
              .first<{ n: number }>()
          )?.n,
          0,
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("native prefix progress and fairness counters require an admitted publication", async () => {
  const f = await coverageFixture();
  try {
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_coverage_jobs SET completed_version=work_version",
        )
        .run(),
      /progress guard/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_coverage_jobs SET last_turn=last_turn+1",
        )
        .run(),
      /progress guard/,
    );
    await f.coverage.step("a");
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_matching_coverage_pages").run(),
      /retained/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_coverage_pages SET input_digest='changed'",
        )
        .run(),
      /immutable|commit changed/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("prefix expansion gives another pending node a turn before continuing a large node", async () => {
  const f = await coverageFixture(205, undefined, { earlierDay: "2026-11-02" });
  try {
    const key = await f.db
      .prepare(
        `SELECT j.generation_id AS generation,j.scope_id AS scope,j.facet,j.node_hash AS hash FROM inventory_matching_coverage_jobs j ORDER BY (SELECT count(*) FROM inventory_matching_coverage_dependents d WHERE d.tenant=j.tenant AND d.generation_id=j.generation_id AND d.scope_id=j.scope_id AND d.facet=j.facet AND d.node_hash=j.node_hash) DESC LIMIT 1`,
      )
      .first<MatchingCoverageKey>();
    assert.ok(key);
    const lease = await f.store.claim(
      "a",
      matchingCoverageLeaseScope(key),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.coverage.prepare("a", key, lease);
    assert.ok(page);
    const first = await f.coverage.publish(page);
    assert.equal(first.records, 200);
    assert.equal(first.complete, false);
    await f.store.release(lease);
    const other = await f.coverage.step("a");
    assert.ok("records" in other);
    assert.equal(other.sets, 1);
    assert.equal(other.records, 5);
    assert.equal(other.complete, true);
    const continuation = await f.coverage.step("a");
    assert.ok("records" in continuation);
    assert.equal(continuation.records, 5);
    assert.equal(continuation.complete, true);
    assert.equal((await f.coverage.step("a")).kind, "idle");
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT last_turn FROM inventory_matching_coverage_jobs ORDER BY last_turn",
          )
          .all()
      ).results,
      [{ last_turn: 2 }, { last_turn: 3 }],
    );
  } finally {
    await f.mf.dispose();
  }
});

test("an old prefix skips large current cohorts that already observed its clock", async (t) => {
  const costs: number[] = [];
  for (const count of [1, 101]) {
    const f = await coverageFixture(count, undefined, {
      enroll: 1,
      stationCallsign: "N0CALL",
    });
    try {
      for (let i = 1; i < count; i++) {
        const matched = await f.matches.match("a", "destination", [
          f.selected[i],
        ]);
        assert.ok("records" in matched);
      }
      const turn = await f.coverage.step("a");
      assert.ok("records" in turn);
      assert.equal(turn.records, 1);
      assert.equal(turn.sets, 1);
      assert.equal(turn.complete, true);
      costs.push(turn.rowsRead);
      assert.equal(
        (
          await f.db
            .prepare("SELECT count(*) AS n FROM matching_work")
            .first<{ n: number }>()
        )?.n,
        1,
      );
    } finally {
      await f.mf.dispose();
    }
  }
  assert.ok(costs[1] <= costs[0] + 16, `old-clock reads ${costs.join("/")}`);
  t.diagnostic(
    `old prefix with one/101 current observed cohorts: ${costs.join("/")} reads`,
  );
});

test("forged queued members and route configurations cannot replace the native cohort census", async (t) => {
  for (const change of ["member", "configuration"] as const)
    await t.test(change, async () => {
      const f = await prepared();
      try {
        const before = await snapshot(f);
        const store = alteredStore(f, (plan) =>
          f.db.batch([
            plan[0],
            f.store.statement(
              `INSERT INTO inventory_matching_coverage_rows(tenant,page_id,destination,source_scope,record_key,source_config_version,destination_config_version,expected_work_version,expected_completed_version) SELECT c.tenant,c.page_id,c.destination,c.source_scope,${change === "member" ? "CASE c.record_key WHEN 'q0000' THEN 'q0020' ELSE c.record_key END" : "c.record_key"},c.source_config_version${change === "configuration" ? "+1" : ""},c.destination_config_version,0,0 FROM inventory_matching_coverage_page_candidates c WHERE c.tenant=? AND c.page_id=?`,
              "a",
              f.page.pageId,
            ),
            ...plan.slice(2),
          ]),
        );
        await assert.rejects(
          new InventoryMatchingCoverage(store).publish(f.page),
          /row changed|configuration changed/,
        );
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("prefix publication ignores retained committed page and selection history", async (t) => {
  const f = await coverageFixture(1);
  try {
    const first = await f.coverage.step("a");
    assert.ok("records" in first);
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
      await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
      await f.events.step("a");
      const result = await f.coverage.step("a");
      assert.ok("records" in result);
      assert.equal(result.records, 1);
      assert.equal(result.complete, true);
      return result;
    }
    for (let i = 0; i < 10; i++) await next();
    const before = await next();
    for (let i = 0; i < 100; i++) await next();
    const after = await next();
    assert.ok(
      after.rowsRead <= before.rowsRead + 8,
      `retained prefix reads ${before.rowsRead}/${after.rowsRead}`,
    );
    assert.equal(after.rowsWritten, before.rowsWritten);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_matching_coverage_pages WHERE state='committed'",
          )
          .first<{ n: number }>()
      )?.n,
      113,
    );
    const remaining = await f.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM inventory_matching_coverage_page_remaining WHERE tenant=? AND page_id=?",
      )
      .bind("a", after.pageId)
      .all<{ detail: string }>();
    const probes = remaining.results.filter((row) =>
      row.detail.includes("inventory_matching_coverage_dependents_cursor"),
    );
    assert.ok(probes.length > 0);
    assert.ok(
      probes.every((row) =>
        row.detail.includes("destination=? AND source_scope=?"),
      ),
    );
    const rows = await f.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM inventory_matching_coverage_invalid_rows WHERE tenant=? AND page_id=?",
      )
      .bind("a", after.pageId)
      .all<{ detail: string }>();
    const references = rows.results.filter((row) =>
      row.detail.startsWith("SEARCH d "),
    );
    assert.ok(references.length > 0);
    assert.ok(
      references.every((row) => row.detail.includes("set_id=?")),
      "row validation must probe the exact original current set",
    );
    t.diagnostic(
      `prefix publication before/after 100 old pages: ${before.rowsRead}/${after.rowsRead} reads, ${before.rowsWritten}/${after.rowsWritten} writes`,
    );
  } finally {
    await f.mf.dispose();
  }
});
