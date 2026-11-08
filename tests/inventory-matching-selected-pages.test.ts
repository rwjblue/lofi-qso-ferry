import assert from "node:assert/strict";
import test from "node:test";
import {
  InventoryMatchingSelected,
  matchingSelectedLeaseScope,
  type MatchingSelectedKey,
} from "../src/inventory-matching-selected.ts";
import { Store } from "../src/store.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { selectedPagesFixture } from "./inventory-matching-selected-fixtures.ts";

type Fixture = Awaited<ReturnType<typeof selectedPagesFixture>>;
async function seeded(count = 3, shared = false) {
  const f = await selectedPagesFixture({
    receipts: [],
    sources: [
      ...(shared ? [sourceContact("shared")] : []),
      ...Array.from({ length: count }, (_, i) =>
        sourceContact(`q${String(i).padStart(4, "0")}`),
      ),
    ],
  });
  try {
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    try {
      const inputs = shared ? f.selected.slice(1) : f.selected;
      const size = shared ? 19 : 20;
      for (let i = 0; i < inputs.length; i += size)
        await f.matches.publish(
          await f.workspace.prepare("a", "destination", [
            ...(shared ? [f.selected[0]] : []),
            ...inputs.slice(i, i + size),
          ]),
          lease,
          `baseline-${String(i).padStart(6, "0")}`,
        );
    } finally {
      await f.store.release(lease);
    }
    return f;
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
async function signal(f: Fixture, record = "q0000") {
  await f.projections.project("a", f.generation, "source", [record]);
  return {
    generation: f.generation,
    scope: "source",
    facet: "source",
    record,
  } satisfies MatchingSelectedKey;
}
async function prepared(count = 3, limit = 10) {
  const f = await seeded(count);
  try {
    const key = await signal(f);
    const lease = await f.store.claim(
      "a",
      matchingSelectedLeaseScope(key),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.selectedInputs.prepare("a", key, lease, limit);
    assert.ok(page);
    return { ...f, key, selectedLease: lease, page };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
async function snapshot(f: Fixture) {
  const state: Record<string, unknown> = {};
  for (const table of [
    "inventory_matching_selected_jobs",
    "inventory_matching_selected_pages",
    "inventory_matching_selected_rows",
    "inventory_matching_selected_guards",
    "matching_work",
    "match_results",
    "inventory_record_facets",
    "inventory_streams",
  ])
    state[table] = (
      await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ).results;
  return state;
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

test("a source edit requeues every current sibling, including ready absence results", async (t) => {
  const f = await seeded(21);
  try {
    const edit = sourceContact("q0000", "14:00:00");
    edit.order = 2;
    edit.revision = "2";
    await f.full([observation("op", "operation"), edit, ...f.sources.slice(1)]);
    await f.projections.project("a", f.generation, "source", ["q0000"]);
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM match_results_current")
        .first(),
      { n: 1 },
    );
    const result = await f.selectedInputs.step("a");
    assert.ok("records" in result);
    assert.equal(result.records, 20);
    assert.equal(result.statements, 6);
    t.diagnostic(
      `twenty selected-input siblings: ${result.rowsRead} reads, ${result.rowsWritten} writes`,
    );
    assert.equal((await f.work.step("a")).kind, "matched");
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM match_results_current")
        .first(),
      { n: 21 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a selected input still wakes its old cohort after its own result moves elsewhere", async () => {
  const f = await seeded(20);
  try {
    await f.matches.match("a", "destination", f.selected.slice(0, 1));
    await signal(f);
    const result = await f.selectedInputs.step("a");
    assert.ok("records" in result);
    assert.equal(result.records, 20);
    assert.equal(result.sets, 2);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM matching_work WHERE record_key!='q0000' AND completed_version<work_version",
        )
        .first(),
      { n: 19 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("one selected identity expands at most ten cohorts and two hundred members per page", async (t) => {
  const f = await seeded(205, true);
  try {
    await signal(f, "shared");
    const first = await f.selectedInputs.step("a");
    assert.ok("records" in first);
    assert.equal(first.records, 190);
    assert.equal(first.sets, 10);
    assert.equal(first.complete, false);
    const second = await f.selectedInputs.step("a");
    assert.ok("records" in second);
    assert.equal(second.records, 16);
    assert.equal(second.sets, 1);
    assert.equal(second.complete, true);
    t.diagnostic(
      `190 selected references: ${first.rowsRead} reads, ${first.rowsWritten} writes`,
    );
    assert.equal((await f.selectedInputs.step("a")).kind, "idle");
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM matching_work WHERE completed_version<work_version",
        )
        .first(),
      { n: 206 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("newly published cohorts skip older selected-input signals", async () => {
  const f = await seeded(3);
  try {
    await signal(f);
    await f.matches.match("a", "destination", f.selected);
    const before = await snapshot(f);
    const result = await f.selectedInputs.step("a");
    assert.ok(
      "records" in result &&
        result.records === 0 &&
        result.sets === 0 &&
        result.complete,
    );
    assert.deepEqual((await snapshot(f)).matching_work, before.matching_work);
  } finally {
    await f.mf.dispose();
  }
});

test("missing selected input arrival and retirement both requeue siblings", async (t) => {
  for (const missing of [true, false])
    await t.test(missing ? "arrival" : "retirement", async () => {
      const f = await selectedPagesFixture({ receipts: [] });
      try {
        const selected = [...f.selected, { scope: "source", key: "missing" }];
        if (!missing) {
          await f.full([
            observation("op", "operation"),
            ...f.sources,
            sourceContact("missing"),
          ]);
          await f.projections.project("a", f.generation, "source", ["missing"]);
        }
        await f.matches.match("a", "destination", selected);
        const record = sourceContact("missing");
        record.order = 2;
        record.revision = "2";
        if (!missing) record.status = "deleted";
        await f.full([observation("op", "operation"), ...f.sources, record]);
        const result = await f.selectedInputs.step("a");
        assert.ok("records" in result && result.records === 2);
        assert.deepEqual(
          await f.db
            .prepare(
              "SELECT count(*) AS n FROM matching_work WHERE completed_version<work_version",
            )
            .first(),
          { n: 2 },
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("lost acknowledgement recovery cannot finish a newer selected-input signal", async () => {
  const f = await prepared();
  try {
    const publisher = new InventoryMatchingSelected(
      alteredStore(f, async (plan) => {
        await f.db.batch(plan);
        throw new Error("lost acknowledgement");
      }),
    );
    const result = await publisher.publish(f.page);
    assert.equal(result.recovered, true);
    await signal(f);
    const before = await snapshot(f);
    assert.equal((await publisher.publish(f.page)).recovered, true);
    assert.deepEqual(await snapshot(f), before);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_matching_selected_jobs WHERE completed_version<work_version",
        )
        .first(),
      { n: 1 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("late failures roll back contact work and selected-input frontier together", async (t) => {
  for (const [name, sql] of [
    ["sql", "SELECT * FROM deliberately_missing_selected_table"],
    ["account", "UPDATE accounts SET status='locked' WHERE id='a'"],
    [
      "configuration",
      "UPDATE inventory_scopes SET config_version=config_version+1 WHERE scope_id='source'",
    ],
    [
      "signal",
      "UPDATE inventory_matching_selected_jobs SET work_version=work_version+1,signal_clock=signal_clock+1,cursor_destination='',cursor_source='',cursor_clock=0,cursor_set=''",
    ],
    [
      "work",
      "UPDATE matching_work SET work_version=work_version+1,due_at=0,hold_reason=NULL",
    ],
  ])
    await t.test(name, async () => {
      const f = await prepared();
      try {
        const before = await snapshot(f);
        const publisher = new InventoryMatchingSelected(
          alteredStore(f, (plan) =>
            f.db.batch([...plan.slice(0, -1), f.db.prepare(sql), plan.at(-1)!]),
          ),
        );
        await assert.rejects(publisher.publish(f.page));
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("native manifests reject omitted members and omitted matching-work writes", async (t) => {
  for (const [name, sql] of [
    [
      "row",
      "CREATE TRIGGER omit_selected_row BEFORE INSERT ON inventory_matching_selected_rows BEGIN SELECT RAISE(IGNORE); END;",
    ],
    [
      "work",
      "CREATE TRIGGER omit_selected_work BEFORE INSERT ON matching_work BEGIN SELECT RAISE(IGNORE); END;",
    ],
  ])
    await t.test(name, async () => {
      const f = await prepared();
      try {
        await f.db.prepare(sql).run();
        const before = await snapshot(f);
        await assert.rejects(f.selectedInputs.publish(f.page), /incomplete/);
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("a replaced selected-input lease fences publication", async () => {
  const f = await prepared();
  try {
    await f.store.release(f.selectedLease);
    assert.ok(
      await f.store.claim(
        "a",
        matchingSelectedLeaseScope(f.key),
        Date.now(),
        60000,
      ),
    );
    const before = await snapshot(f);
    await assert.rejects(f.selectedInputs.publish(f.page), /authority changed/);
    assert.deepEqual(await snapshot(f), before);
  } finally {
    await f.mf.dispose();
  }
});

test("a forged complete prefix cannot skip remaining selected cohorts", async () => {
  const f = await seeded(21, true);
  try {
    const key = await signal(f, "shared");
    const lease = await f.store.claim(
      "a",
      matchingSelectedLeaseScope(key),
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const page = await f.selectedInputs.prepare("a", key, lease, 1);
    assert.ok(page);
    const store = new Store(f.db, f.store.keys),
      statement = store.statement.bind(store);
    store.statement = (sql, ...parameters) =>
      statement(
        sql.replace(
          "CASE WHEN (SELECT count(*) FROM selected)>?11 THEN 0 ELSE 1 END",
          "1",
        ),
        ...parameters,
      );
    const before = await snapshot(f);
    await assert.rejects(
      new InventoryMatchingSelected(store).publish(page),
      /range incomplete/,
    );
    assert.deepEqual(await snapshot(f), before);
  } finally {
    await f.mf.dispose();
  }
});

test("another selected-input job gets a turn before a large continuation", async () => {
  const f = await seeded(205, true);
  try {
    await signal(f, "shared");
    const first = await f.selectedInputs.step("a");
    assert.ok("complete" in first && !first.complete);
    await signal(f, "q0000");
    const second = await f.selectedInputs.step("a");
    assert.ok("records" in second && second.records === 19 && second.complete);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT record_key FROM inventory_matching_selected_jobs WHERE completed_version<work_version",
        )
        .first(),
      { record_key: "shared" },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("selected-input publication stays bounded across one hundred retained proofs and pages", async (t) => {
  const f = await seeded(1);
  try {
    const costs: number[] = [];
    const writes: number[] = [];
    for (let i = 0; i < 102; i++) {
      await signal(f);
      const result = await f.selectedInputs.step("a");
      assert.ok("records" in result && result.records === 1);
      assert.ok(result.rowsRead <= 400);
      assert.equal(result.rowsWritten, 12);
      costs.push(result.rowsRead);
      writes.push(result.rowsWritten);
      assert.equal((await f.work.step("a")).kind, "matched");
    }
    t.diagnostic(
      `102 selected publications: ${Math.min(...costs)}–${Math.max(...costs)} reads, ${Math.min(...writes)}–${Math.max(...writes)} writes`,
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_matching_selected_dependents",
        )
        .first(),
      { n: 1 },
    );
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_matching_selected_pages")
        .first(),
      { n: 102 },
    );
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_match_sets")
        .first(),
      { n: 103 },
    );
  } finally {
    await f.mf.dispose();
  }
});
