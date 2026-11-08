import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { installMatchingCoordinator } from "./inventory-matching-coordinator-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { selectedFixture } from "./inventory-matching-selected-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

test("selected dependencies outlive individual members and collect with the final current reference", async () => {
  const f = await selectedFixture({
    sources: Array.from({ length: 20 }, (_, i) => sourceContact(`q${i}`)),
    receipts: [],
  });
  try {
    const initial = await f.matches.match("a", "destination", f.selected);
    assert.ok("setId" in initial);
    const count = () =>
      f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_matching_selected_dependents",
        )
        .first();
    assert.deepEqual(await count(), { n: 20 });
    await f.matches.match("a", "destination", f.selected.slice(0, 1));
    assert.deepEqual(await count(), { n: 21 });
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT record_key FROM inventory_matching_selected_dependents WHERE set_id=? AND record_key='q0'",
        )
        .bind(initial.setId)
        .first(),
      { record_key: "q0" },
    );
    await f.matches.match("a", "destination", f.selected.slice(1));
    assert.deepEqual(await count(), { n: 20 });
    assert.equal(
      await f.db
        .prepare(
          "SELECT 1 FROM inventory_matching_selected_dependents WHERE set_id=?",
        )
        .bind(initial.setId)
        .first(),
      null,
    );
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_match_sets")
        .first(),
      { n: 3 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("source edits and retirement signal metadata while siblings remain outside direct matching work", async () => {
  const sources = Array.from({ length: 3 }, (_, i) => sourceContact(`q${i}`));
  const f = await selectedFixture({ sources, receipts: [] });
  try {
    await f.matches.match("a", "destination", f.selected);
    const edit = sourceContact("q0", "14:00:00");
    edit.order = 2;
    edit.revision = "2";
    await f.full([observation("op", "operation"), edit, ...sources.slice(1)]);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT scope_id,record_key,completed_version FROM inventory_matching_selected_jobs",
        )
        .first(),
      { scope_id: "source", record_key: "q0", completed_version: 0 },
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM matching_work WHERE record_key!='q0'",
        )
        .first(),
      { n: 0 },
    );
    const removed = sourceContact("q0");
    removed.status = "deleted";
    removed.order = 3;
    removed.revision = "3";
    await f.full([
      observation("op", "operation"),
      removed,
      ...sources.slice(1),
    ]);
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_matching_selected_jobs")
        .first(),
      { n: 1 },
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT signal_clock=work_version AND work_version>1 AS valid FROM inventory_matching_selected_jobs",
          )
          .first<{ valid: number }>()
      )?.valid,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("missing selected identities are watched before a source index entry exists", async () => {
  const f = await selectedFixture({ receipts: [] });
  try {
    await f.matches.match("a", "destination", [
      ...f.selected,
      { scope: "source", key: "missing" },
    ]);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_matching_selected_dependents WHERE record_key='missing'",
        )
        .first(),
      { n: 1 },
    );
    await f.full([
      observation("op", "operation"),
      ...f.sources,
      sourceContact("missing"),
    ]);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_matching_selected_jobs WHERE record_key='missing' AND completed_version<work_version",
        )
        .first(),
      { n: 1 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native publication rejects omitted selected declarations and immutable maps cannot be forged", async () => {
  const f = await selectedFixture({ receipts: [] });
  try {
    await f.db
      .prepare(
        "CREATE TRIGGER omit_selected BEFORE INSERT ON inventory_matching_selected_dependents BEGIN SELECT RAISE(IGNORE); END;",
      )
      .run();
    await assert.rejects(
      f.matches.match("a", "destination", f.selected),
      /selected dependencies incomplete/,
    );
    assert.deepEqual(
      await f.db.prepare("SELECT count(*) AS n FROM match_results").first(),
      { n: 0 },
    );
    await f.db.prepare("DROP TRIGGER omit_selected").run();
    await f.matches.match("a", "destination", f.selected);
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_matching_selected_dependents").run(),
      /referenced/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_matching_selected_dependents SET seen_clock=seen_clock+1",
        )
        .run(),
      /immutable/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "INSERT INTO inventory_matching_selected_dependents SELECT tenant,set_id,generation_id,destination,source_scope,scope_id,facet,'invented',seen_clock FROM inventory_matching_selected_dependents",
        )
        .run(),
      /dependent invalid/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("installing the current selected map schedules existing proofs for revalidation", async () => {
  const f = await matchingWorkFixture({ receipts: [] });
  try {
    await installMatchingCoordinator(f.db, 69);
    await f.matches.match("a", "destination", f.selected);
    await applyMigration(f.db, "0070_inventory_matching_selected_inputs.sql");
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
        .prepare(
          "SELECT work_version,completed_version FROM inventory_matching_selected_jobs",
        )
        .first(),
      { work_version: 1, completed_version: 0 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("mixed source cohorts retain each selected input for every remaining owner route", async () => {
  const f = await selectedFixture({ receipts: [] });
  try {
    await f.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','source-b','lofi','source-b','Second source','active','v1',1)",
      )
      .run();
    await (
      await f.store.putPrivate("a", "source-b", "v1", "credential", {
        key: "browser:fixture",
        secret: "fixture-secret",
        token: "fixture-token",
      })
    ).run();
    await f.inventory.initialize(
      {
        tenant: "a",
        scope: "source-b",
        connection: "source-b",
        provider: "lofi",
        logicalIdentity: "source-b",
        adapterBinding: "test-v1",
        ordering: "numeric",
      },
      "sync",
      "all-clients-v1",
    );
    const selected = [...f.selected, { scope: "source-b", key: "missing" }];
    const initial = await f.matches.match("a", "destination", selected);
    assert.ok("setId" in initial);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT source_scope,count(*) AS n FROM inventory_matching_selected_dependents GROUP BY source_scope ORDER BY source_scope",
        )
        .all()
        .then((result) => result.results),
      [
        { source_scope: "source", n: 2 },
        { source_scope: "source-b", n: 2 },
      ],
    );
    await f.matches.match("a", "destination", f.selected);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT source_scope,scope_id,record_key FROM inventory_matching_selected_dependents WHERE set_id=? ORDER BY scope_id",
        )
        .bind(initial.setId)
        .all()
        .then((result) => result.results),
      [
        { source_scope: "source-b", scope_id: "source", record_key: "q0" },
        {
          source_scope: "source-b",
          scope_id: "source-b",
          record_key: "missing",
        },
      ],
    );
    await f.matches.match("a", "destination", selected.slice(1));
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_matching_selected_dependents WHERE set_id=?",
        )
        .bind(initial.setId)
        .first(),
      { n: 0 },
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_matching_selected_dependents",
        )
        .first(),
      { n: 2 },
    );
  } finally {
    await f.mf.dispose();
  }
});
