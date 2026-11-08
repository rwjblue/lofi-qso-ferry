import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { observation } from "./inventory-context-fixtures.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { pairFixture } from "./inventory-matching-pair-metadata-fixtures.ts";

async function jobs(f: Awaited<ReturnType<typeof pairFixture>>) {
  return (
    await f.db
      .prepare(
        "SELECT generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version,work_version,completed_version,cursor_key FROM inventory_matching_pair_jobs ORDER BY generation_id,destination,source_scope",
      )
      .all<{
        generation_id: string;
        destination: string;
        source_scope: string;
        source_config_version: number;
        destination_config_version: number;
        source_set_version: number;
        work_version: number;
        completed_version: number;
        cursor_key: string;
      }>()
  ).results;
}

test("initial enrollment and scope changes queue metadata without enumerating retained contacts", async (t) => {
  const costs: { reads: number; writes: number }[] = [];
  for (const size of [1, 205]) {
    const f = await pairFixture({
      sources: Array.from({ length: size }, (_, i) => sourceContact(`q${i}`)),
    });
    try {
      const before = await f.inventory.snapshot("a", "source", "sync");
      const credential = await f.store.private(
        "a",
        "source",
        "v1",
        "credential",
      );
      const initial = await jobs(f);
      assert.equal(initial.length, 1);
      assert.equal(initial[0].work_version, 1);
      assert.equal(initial[0].completed_version, 0);
      const changed = await f.db
        .prepare(
          "UPDATE inventory_scopes SET config_version=config_version+1 WHERE tenant='a' AND scope_id='source'",
        )
        .run();
      const current = await jobs(f);
      assert.equal(current[0].source_config_version, 2);
      assert.equal(
        current[0].source_set_version,
        initial[0].source_set_version + 1,
      );
      assert.equal(current[0].work_version, 2);
      assert.equal(current[0].cursor_key, "");
      assert.equal(
        (
          await f.db
            .prepare("SELECT count(*) AS n FROM matching_work")
            .first<{ n: number }>()
        )?.n,
        0,
      );
      assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), {
        ...before,
        configVersion: 2,
      });
      assert.deepEqual(
        await f.store.private("a", "source", "v1", "credential"),
        credential,
      );
      await assert.rejects(
        f.db
          .prepare(
            "UPDATE inventory_matching_pair_jobs SET completed_version=work_version",
          )
          .run(),
        /page required/,
      );
      costs.push({
        reads: changed.meta.rows_read,
        writes: changed.meta.rows_written,
      });
    } finally {
      await f.mf.dispose();
    }
  }
  assert.deepEqual(costs[0], costs[1]);
  t.diagnostic(
    `1/205-contact source configuration change: ${JSON.stringify(costs)}; one metadata pair, zero matching work rows`,
  );
});

test("connection reactivation and account recovery reset eligible pair work without query-unrelated churn", async () => {
  const f = await pairFixture();
  try {
    const initial = await jobs(f);
    await f.db
      .prepare(
        "UPDATE connections SET label='Renamed',config=json_set(config,'$.template','changed') WHERE id='destination'",
      )
      .run();
    assert.deepEqual(await jobs(f), initial);
    await f.db
      .prepare(
        "UPDATE connections SET status='disabled' WHERE id='destination'",
      )
      .run();
    assert.deepEqual(await jobs(f), initial);
    await f.db
      .prepare("UPDATE connections SET status='active' WHERE id='destination'")
      .run();
    assert.equal((await jobs(f))[0].work_version, 2);
    await f.db
      .prepare("UPDATE accounts SET status='locked' WHERE id='a'")
      .run();
    await f.db
      .prepare(
        "UPDATE comparison_domains SET source_set_version=source_set_version+1,version=version+1 WHERE tenant='a'",
      )
      .run();
    const locked = await jobs(f);
    assert.equal(locked[0].work_version, 2);
    await f.db
      .prepare("UPDATE accounts SET status='active' WHERE id='a'")
      .run();
    const recovered = await jobs(f);
    assert.equal(recovered[0].work_version, 3);
    assert.equal(
      recovered[0].source_set_version,
      initial[0].source_set_version + 1,
    );
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_matching_pair_jobs").run(),
      /retained/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a new generation enrolls its pairs without restarting the active generation census", async () => {
  const f = await pairFixture();
  try {
    const initial = (await jobs(f))[0];
    const next = await new InventoryComparisonGenerations(f.store).begin("a");
    assert.ok(next.pending_generation);
    const current = await jobs(f);
    assert.equal(current.length, 2);
    assert.deepEqual(
      current.find((row) => row.generation_id === f.generation),
      initial,
    );
    assert.equal(
      current.find((row) => row.generation_id === next.pending_generation)
        ?.work_version,
      1,
    );
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

test("new and reclassified sources invalidate every remaining reverse-source pair", async () => {
  const f = await pairFixture();
  try {
    await f.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','other','lofi','other','Other','active','v1','{}',1)",
      )
      .run();
    assert.equal((await jobs(f))[0].work_version, 2);
    await (
      await f.store.putPrivate("a", "other", "v1", "credential", {
        secret: "private",
      })
    ).run();
    await f.inventory.initialize(
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
    const linked = await jobs(f);
    assert.equal(linked.length, 2);
    assert.equal(
      linked.find((row) => row.source_scope === "source")?.work_version,
      3,
    );
    const other = linked.find((row) => row.source_scope === "other");
    assert.ok(other);
    await f.db
      .prepare(
        "UPDATE inventory_scopes SET provider='qrz',config_version=config_version+1 WHERE scope_id='source'",
      )
      .run();
    const remaining = (await jobs(f)).find(
      (row) => row.source_scope === "other",
    );
    assert.ok(remaining);
    assert.equal(remaining.work_version, other.work_version + 1);
    assert.equal(remaining.source_set_version, other.source_set_version + 1);
  } finally {
    await f.mf.dispose();
  }
});

test("only the first unresolved source and the final resolved source signal a global uncertainty transition", async () => {
  const sources = [
    sourceContact("q0"),
    sourceContact("ghost1"),
    sourceContact("ghost2"),
  ];
  const f = await pairFixture({ sources });
  try {
    const initial = (await jobs(f))[0];
    await f.full([observation("op", "operation"), sources[0]]);
    assert.equal((await jobs(f))[0].work_version, initial.work_version + 1);
    await f.full([observation("op", "operation"), sources[0]]);
    assert.equal((await jobs(f))[0].work_version, initial.work_version + 1);
    await f.full([observation("op", "operation"), sources[0], sources[1]]);
    assert.equal((await jobs(f))[0].work_version, initial.work_version + 1);
    await f.full([observation("op", "operation"), ...sources]);
    assert.equal((await jobs(f))[0].work_version, initial.work_version + 2);
  } finally {
    await f.mf.dispose();
  }
});

test("receipt uncertainty recovery signals only on its scope-wide boolean transition", async () => {
  const receipts = [receipt("1"), receipt("2")];
  const f = await pairFixture({ receipts });
  try {
    await f.fullReceipt([]);
    assert.equal((await jobs(f))[0].work_version, 2);
    await f.fullReceipt([receipts[0]]);
    assert.equal((await jobs(f))[0].work_version, 2);
    await f.fullReceipt(receipts);
    assert.equal((await jobs(f))[0].work_version, 3);
    await f.db
      .prepare(
        "INSERT INTO inventory_coverage(tenant,scope_id,stream_id,facet,partition_id,partition_binding) VALUES('a','destination','receipt','confirmation','confirmation','confirmation')",
      )
      .run();
    assert.equal((await jobs(f))[0].work_version, 3);
  } finally {
    await f.mf.dispose();
  }
});
