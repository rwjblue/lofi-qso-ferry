import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonLookup } from "../src/inventory-comparison-lookup.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import {
  fixture,
  membership,
  observation,
  scratchEmpty,
  topology,
} from "./inventory-context-fixtures.ts";

test("semantic and membership edits coalesce once per operation; unchanged full scans retain work and versions", async () => {
  const f = await fixture();
  try {
    const rows = [
      observation("op", "operation"),
      observation("event1", "event"),
      observation("event2", "event"),
      observation("q"),
    ];
    await f.full(rows);
    assert.equal(await topology(f), 1);
    assert.deepEqual(await membership(f, "event1"), {
      state: "present",
      version: 1,
    });
    const work = await f.db
      .prepare(
        "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q'",
      )
      .first();
    assert.deepEqual(work, { work_version: 1, completed_version: 0 });
    await f.full(rows);
    assert.equal(await topology(f), 1);
    assert.deepEqual(await membership(f, "event1"), {
      state: "present",
      version: 1,
    });
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q'",
        )
        .first(),
      work,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM bucket_versions")
          .first<{ version: number }>()
      )?.version,
      1,
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("unseen events dirty only their operation without child fanout; unchanged reappearance restores a new version", async (t) => {
  const f = await fixture();
  try {
    const rows = [
      observation("op", "operation"),
      observation("event1", "event"),
      observation("event2", "event"),
      observation("q"),
    ];
    await f.full(rows);
    const work = await f.db
      .prepare("SELECT * FROM comparison_work WHERE record_key='q'")
      .first();
    const receipts = await f.full([rows[0], rows[3]]);
    assert.equal(await topology(f), 2);
    assert.deepEqual(await membership(f, "event1"), {
      state: "unresolved",
      version: 2,
    });
    assert.deepEqual(await membership(f, "event2"), {
      state: "unresolved",
      version: 2,
    });
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM comparison_work WHERE record_key='q'")
        .first(),
      work,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT semantic_version FROM inventory_record_facets WHERE record_key='event1'",
          )
          .first<{ semantic_version: number }>()
      )?.semantic_version,
      1,
    );
    t.diagnostic(
      `quarantine: ${receipts.reduce((sum, r) => sum + r.statements, 0)} statements, ${receipts.reduce((sum, r) => sum + r.rowsRead, 0)} rows read`,
    );
    await f.full(rows);
    assert.equal(await topology(f), 3);
    assert.deepEqual(await membership(f, "event1"), {
      state: "present",
      version: 3,
    });
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("unseen ordinary contacts invalidate their own work and membership without dirtying every sibling", async () => {
  const f = await fixture();
  try {
    const rows = [
      observation("op", "operation"),
      observation("event", "event"),
      observation("q0"),
      observation("q1"),
    ];
    await f.full(rows);
    await f.db
      .prepare(
        "UPDATE comparison_index SET state='ready' WHERE record_key IN ('q0','q1')",
      )
      .run();
    await f.db
      .prepare(
        "UPDATE comparison_work SET completed_version=work_version WHERE record_key IN ('q0','q1')",
      )
      .run();
    await f.full(rows.filter((row) => row.key !== "q0"));
    assert.equal(await topology(f), 1);
    assert.deepEqual(await membership(f, "q0"), {
      state: "unresolved",
      version: 2,
    });
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT record_key,state FROM comparison_index WHERE record_key IN ('q0','q1') ORDER BY record_key",
          )
          .all()
      ).results,
      [
        { record_key: "q0", state: "pending" },
        { record_key: "q1", state: "ready" },
      ],
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q0'",
        )
        .first(),
      { work_version: 2, completed_version: 1 },
    );
    const probes = await new InventoryComparisonLookup(f.store).probe(
      "a",
      [
        {
          id: "selected",
          scope: "source",
          record: { CALL: "W1AW", QSO_DATE: "20261108", TIME_ON: "123000" },
        },
      ],
      { generation: f.generation },
    );
    assert.equal(
      probes.observations[0].candidates.find((row) => row.key === "q0")
        ?.membershipVersion,
      2,
    );
    assert.equal(
      probes.observations[0].candidates.find((row) => row.key === "q1")
        ?.membershipVersion,
      1,
    );
    await f.full(rows);
    assert.deepEqual(await membership(f, "q0"), {
      state: "present",
      version: 3,
    });
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q0'",
        )
        .first(),
      { work_version: 3, completed_version: 1 },
    );
    assert.equal(await topology(f), 1);
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM bucket_versions")
          .first<{ version: number }>()
      )?.version,
      1,
      "candidate keys did not change",
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("native guards reject missing context publication and roll back quarantine; receipt replay never increments twice", async () => {
  const f = await fixture();
  try {
    await f.full([
      observation("op", "operation"),
      observation("event", "event"),
      observation("q"),
    ]);
    const run = await f.begin();
    await f.observed(run.id, [
      observation("op", "operation"),
      observation("q"),
    ]);
    await f.observed(run.id, []);
    const page = await f.runs.prepareQuarantine(
      await f.runs.context("a", run.id),
      f.lease,
      { limit: 200 },
    );
    await assert.rejects(
      new InventoryIngestion(f.store).publish(page),
      /context membership changed/,
    );
    const incomplete = new InventoryComparisonPages(f.store);
    const context = incomplete.context.bind(incomplete);
    incomplete.context = (...args) => {
      const effects = context(...args);
      if (effects) effects.domainEffects = () => [];
      return effects;
    };
    await assert.rejects(
      new InventoryIngestion(f.store, incomplete).publish(page),
      /context publication incomplete/,
    );
    assert.equal(await topology(f), 1);
    assert.deepEqual(await membership(f, "event"), {
      state: "present",
      version: 1,
    });
    await scratchEmpty(f);
    await f.inventory.publish(page);
    assert.equal(await topology(f), 2);
    assert.equal((await f.inventory.publish(page)).recovered, true);
    assert.equal(await topology(f), 2);
    await f.finish(run.id);
    await scratchEmpty(f);
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_membership_versions").run(),
      /retained/,
    );
  } finally {
    await f.mf.dispose();
  }
});
