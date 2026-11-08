import assert from "node:assert/strict";
import test from "node:test";
import { inventoryRunFixture } from "./inventory-run-fixtures.ts";

test("full source run checkpoints only after vector catch-up and bounded quarantine", async () => {
  const f = await inventoryRunFixture();
  try {
    const run = await f.begin();
    assert.equal(run.phase, "collecting");
    await f.observed(run.id, [f.qso("a")], { watermark: 10 });
    assert.equal((await f.runs.load("a", run.id))?.phase, "catchup");
    assert.deepEqual(
      (await f.inventory.snapshot("a", f.scope, "sync"))?.checkpoint,
      {},
    );
    await f.observed(run.id, [f.qso("b")], { watermark: 20 });
    assert.equal((await f.runs.load("a", run.id))?.phase, "quarantining");
    const witness = (
      await f.db
        .prepare(
          "SELECT record_key,last_observed_at FROM inventory_record_facets ORDER BY record_key",
        )
        .all()
    ).results;
    await f.finish(run.id);
    assert.equal((await f.runs.load("a", run.id))?.phase, "complete");
    assert.deepEqual(
      (await f.inventory.snapshot("a", f.scope, "sync"))?.checkpoint,
      { watermark: 20 },
    );
    const coverage = await f.runs.coverage(
      "a",
      f.scope,
      "sync",
      "source",
      "all",
    );
    assert.equal(coverage?.state, "ready");
    assert.equal(coverage?.epoch, 1);
    assert.equal(coverage?.published_run_id, run.id);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT record_key,last_observed_at FROM inventory_record_facets ORDER BY record_key",
          )
          .all()
      ).results,
      witness,
      "control pages do not renew witnesses",
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_run_membership")
          .first<{ n: number }>()
      )?.n,
      2,
    );
    const wakeups = await f.runs.pendingWakeups();
    assert.equal(wakeups.length, 1);
    assert.equal(
      await f.runs.markWakeupPublished(
        "a",
        wakeups[0].wakeup_id,
        wakeups[0].work_version,
      ),
      true,
    );
    assert.equal(
      await f.runs.markWakeupPublished(
        "a",
        wakeups[0].wakeup_id,
        wakeups[0].work_version,
      ),
      false,
    );
    assert.equal((await f.runs.pendingWakeups()).length, 0);
  } finally {
    await f.mf.dispose();
  }
});

test("a delta without a full baseline stays positive-only and an empty delta never quarantines history", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const first = await f.begin({ mode: "delta" });
    await f.observed(first.id, [f.qso("q")]);
    assert.equal((await f.runs.load("a", first.id))?.phase, "publishing");
    await f.finish(first.id);
    const partial = await f.runs.coverage(
      "a",
      f.scope,
      "sync",
      "receipt",
      "all",
    );
    assert.equal(partial?.state, "partial");
    assert.equal(partial?.epoch, 0);
    const full = await f.begin();
    await f.observed(full.id, [f.qso("q")]);
    await f.finish(full.id);
    const next = await f.begin({ mode: "delta" });
    await f.observed(next.id);
    await f.finish(next.id);
    assert.equal(
      (
        await f.db
          .prepare("SELECT state FROM inventory_partition_membership")
          .first<{ state: string }>()
      )?.state,
      "present",
    );
    const coverage = await f.runs.coverage(
      "a",
      f.scope,
      "sync",
      "receipt",
      "all",
    );
    assert.equal(coverage?.state, "ready");
    assert.equal(coverage?.epoch, 1);
    assert.equal(coverage?.published_run_id, full.id);
  } finally {
    await f.mf.dispose();
  }
});

test("full verification marks missing membership unresolved without changing canonical deletion status", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const first = await f.begin();
    await f.observed(first.id, [f.qso("a"), f.qso("b")]);
    await f.finish(first.id);
    const next = await f.begin();
    await f.observed(next.id, [f.qso("a")]);
    await f.finish(next.id);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT record_key,state FROM inventory_partition_membership ORDER BY record_key",
          )
          .all()
      ).results,
      [
        { record_key: "a", state: "present" },
        { record_key: "b", state: "unresolved" },
      ],
    );
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT record_key,status FROM inventory_records ORDER BY record_key",
          )
          .all()
      ).results,
      [
        { record_key: "a", status: "active" },
        { record_key: "b", status: "active" },
      ],
    );
    assert.ok(await f.inventory.body("a", f.scope, "qso", "b", "receipt"));
  } finally {
    await f.mf.dispose();
  }
});

test("native completion detects ignored coverage and membership writes", async (t) => {
  for (const table of [
    "inventory_run_membership",
    "inventory_partition_membership",
  ])
    await t.test(table, async () => {
      const f = await inventoryRunFixture("qrz");
      try {
        const run = await f.begin();
        const page = await f.page(run.id, [f.qso("q")]);
        await f.db
          .prepare(
            `CREATE TRIGGER ignore_membership BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
          )
          .run();
        await assert.rejects(
          f.inventory.publish(page),
          /inventory (run|partition) membership incomplete/,
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM inventory_records")
              .first<{ n: number }>()
          )?.n,
          0,
        );
        assert.equal((await f.runs.load("a", run.id))?.version, 1);
      } finally {
        await f.mf.dispose();
      }
    });
  await t.test("coverage", async () => {
    const f = await inventoryRunFixture("qrz");
    try {
      const run = await f.begin({ mode: "delta" });
      await f.observed(run.id);
      const context = await f.runs.context("a", run.id);
      const page = await f.runs.prepareComplete(context, f.lease);
      await f.db
        .prepare(
          "CREATE TRIGGER ignore_coverage BEFORE UPDATE ON inventory_coverage BEGIN SELECT RAISE(IGNORE); END",
        )
        .run();
      await assert.rejects(
        f.inventory.publish(page),
        /inventory run publication incomplete/,
      );
      assert.equal((await f.runs.load("a", run.id))?.phase, "publishing");
      assert.deepEqual(
        (await f.inventory.snapshot("a", f.scope, "sync"))?.checkpoint,
        {},
      );
    } finally {
      await f.mf.dispose();
    }
  });
});

test("a changed source client holds its run and requires a full same-account restart", async () => {
  const f = await inventoryRunFixture();
  try {
    const run = await f.begin();
    await f.inventory.publish(await f.page(run.id, [f.qso("q")]));
    await (
      await f.store.putPrivate("a", "source", "v2", "credential", {
        secret: "private replacement",
      })
    ).run();
    await f.store
      .statement(
        "UPDATE connections SET credential_version='v2' WHERE tenant='a' AND id='source'",
      )
      .run();
    assert.equal((await f.runs.load("a", run.id))?.phase, "held");
    assert.equal(
      (await f.runs.coverage("a", f.scope, "sync", "source", "all"))?.state,
      "held",
    );
    await assert.rejects(
      f.runs.context("a", run.id),
      /inventory_run_not_active/,
    );
    assert.ok(await f.inventory.body("a", f.scope, "qso", "q", "source"));
    assert.equal(
      await f.runs.resumeHeldScope("a", f.scope, "wrong-account"),
      false,
    );
    assert.equal(await f.runs.resumeHeldScope("a", f.scope, "source"), true);
    await assert.rejects(f.begin(), /inventory run changed/);
    const next = await f.begin({}, true);
    assert.equal(next.phase, "collecting");
    assert.equal((await f.runs.load("a", run.id))?.phase, "held");
    assert.deepEqual(await f.store.private("a", "source", "v2", "credential"), {
      secret: "private replacement",
    });
  } finally {
    await f.mf.dispose();
  }
});

test("display and verification metadata preserve an active query, but book filters invalidate it", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const run = await f.begin();
    await f.store
      .statement(
        "UPDATE connections SET config=? WHERE tenant='a' AND id='destination'",
        JSON.stringify({
          label: "Display only",
          replacementContractVerified: true,
        }),
      )
      .run();
    const context = await f.runs.context("a", run.id);
    assert.equal(context.run.configVersion, run.configVersion);
    await f.inventory.publish(await f.page(run.id, [f.qso("q")]));
    await f.store
      .statement(
        "UPDATE connections SET config=json_set(config,'$.startDate','2024-01-01') WHERE tenant='a' AND id='destination'",
      )
      .run();
    assert.equal((await f.runs.load("a", run.id))?.phase, "held");
    assert.equal(
      (await f.runs.coverage("a", f.scope, "sync", "receipt", "all"))?.state,
      "held",
    );
    assert.ok(await f.inventory.body("a", f.scope, "qso", "q", "receipt"));
  } finally {
    await f.mf.dispose();
  }
});

test("historical membership cannot be inserted behind an active quarantine cursor", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const first = await f.begin();
    await f.observed(first.id, [f.qso("a"), f.qso("z")]);
    await f.finish(first.id);
    const side = await f.inventory.initialize(
      f.initial,
      "side",
      "run-query-v1",
    );
    await f.inventory.publish(
      await f.inventory.prepare({
        pageId: crypto.randomUUID(),
        stream: side,
        lease: f.lease,
        facet: "receipt",
        requestStartedAt: Date.now(),
        origin: "historical",
        observations: [f.qso("0-behind")],
        nextResume: {},
      }),
    );
    const next = await f.begin();
    await f.observed(next.id);
    await f.inventory.publish(
      await f.runs.prepareQuarantine(
        await f.runs.context("a", next.id),
        f.lease,
        { limit: 1 },
      ),
    );
    await assert.rejects(
      f.store
        .statement(
          "INSERT INTO inventory_partition_membership SELECT 'a',?,'sync','receipt','all',f.entity_family,f.record_key,'present',1,f.row_version,f.last_accepted_sequence,f.last_observed_at,? FROM inventory_record_facets f WHERE f.scope_id=? AND f.record_key='0-behind'",
          f.scope,
          first.id,
          f.scope,
        )
        .run(),
      /historical inventory member behind cursor/,
    );
    assert.ok(
      await f.inventory.body("a", f.scope, "qso", "0-behind", "receipt"),
    );
  } finally {
    await f.mf.dispose();
  }
});
