import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { inventoryComparisonToken } from "../src/inventory-comparison-keys.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";

async function fixture() {
  const f = await database();
  await seed(f.store);
  await applyMigration(f.db, "0039_inventory_ingestion.sql");
  await applyMigration(f.db, "0044_inventory_comparison_generations.sql");
  const inventory = new InventoryIngestion(f.store);
  const scope = {
    tenant: "a",
    scope: "source",
    connection: "source",
    provider: "lofi" as const,
    logicalIdentity: "source",
    adapterBinding: "test-v1",
    ordering: "numeric" as const,
  };
  await inventory.initialize(scope, "sync", "all-clients-v1");
  return {
    ...f,
    inventory,
    scope,
    generations: new InventoryComparisonGenerations(f.store),
  };
}

test("concurrent key/build creation converges on one encrypted tenant key and one pending generation", async () => {
  const f = await fixture();
  try {
    const credentials = await f.store.private(
      "a",
      "source",
      "v1",
      "credential",
    );
    const domains = await Promise.all([
      f.generations.begin("a"),
      new InventoryComparisonGenerations(f.store).begin("a"),
    ]);
    assert.deepEqual(domains[0], domains[1]);
    assert.equal(domains[0].active_generation, null);
    const counts = await f.db
      .prepare(
        "SELECT (SELECT count(*) FROM inventory_comparison_keys) AS keys,(SELECT count(*) FROM index_generations) AS generations,(SELECT count(*) FROM comparison_builds) AS builds",
      )
      .first();
    assert.deepEqual(counts, { keys: 1, generations: 1, builds: 1 });
    const writers = await f.generations.writers("a");
    assert.ok(writers);
    assert.equal(writers.contexts.length, 1);
    const token = await inventoryComparisonToken(writers.contexts[0], {
      CALL: "W1AW",
    });
    const reloaded = await new InventoryComparisonGenerations(f.store).writers(
      "a",
    );
    assert.ok(reloaded);
    assert.deepEqual(
      await inventoryComparisonToken(reloaded.contexts[0], { CALL: "W1AW" }),
      token,
    );
    const row = await f.db
      .prepare("SELECT envelope FROM inventory_comparison_keys")
      .first<{ envelope: string }>();
    assert.ok(row);
    assert.equal(row.envelope.includes("secret"), false);
    assert.equal(row.envelope.includes("W1AW"), false);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credentials,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("KEK rotation preserves the tenant key ID and every generation hash", async () => {
  const f = await fixture();
  try {
    await f.generations.begin("a");
    const before = await f.generations.writers("a");
    assert.ok(before);
    const token = await inventoryComparisonToken(before.contexts[0], {
      CALL: "W1AW",
    });
    const rotated = new InventoryComparisonGenerations(
      new Store(f.db, { ...keys, active: "2" }),
    );
    assert.equal(await rotated.rewrapKey("a"), true);
    const after = await rotated.writers("a");
    assert.ok(after);
    assert.deepEqual(after.domain, before.domain);
    assert.equal(after.contexts[0].keyId, before.contexts[0].keyId);
    assert.deepEqual(
      await inventoryComparisonToken(after.contexts[0], { CALL: "W1AW" }),
      token,
    );
    const row = await f.db
      .prepare("SELECT envelope FROM inventory_comparison_keys")
      .first<{ envelope: string }>();
    assert.equal(JSON.parse(row?.envelope ?? "{}").kek, "2");
    const onlyNewKey = new InventoryComparisonGenerations(
      new Store(f.db, { active: "2", keys: { "2": keys.keys["2"] } }),
    );
    assert.equal((await onlyNewKey.key("a")).keyId, before.contexts[0].keyId);
  } finally {
    await f.mf.dispose();
  }
});

test("generation publication rejects an incomplete scope and retains key/version metadata", async () => {
  const f = await fixture();
  try {
    const domain = await f.generations.begin("a");
    await assert.rejects(
      f.db
        .prepare("UPDATE index_generations SET state='active' WHERE tenant='a'")
        .run(),
      /incomplete/,
    );
    assert.deepEqual(await f.generations.domain("a"), domain);
    for (const sql of [
      "UPDATE index_generations SET key_version=2 WHERE tenant='a'",
      "DELETE FROM inventory_comparison_keys WHERE tenant='a'",
      "DELETE FROM comparison_domains WHERE tenant='a'",
      "DELETE FROM index_generations WHERE tenant='a'",
      "DELETE FROM comparison_builds WHERE tenant='a'",
      "UPDATE comparison_domains SET source_set_version=source_set_version+1 WHERE tenant='a'",
    ])
      await assert.rejects(f.db.prepare(sql).run());
    assert.deepEqual(await f.generations.domain("a"), domain);
  } finally {
    await f.mf.dispose();
  }
});

test("source roster changes invalidate reverse census before a new source has a scope", async () => {
  const f = await fixture();
  try {
    let domain = await f.generations.begin("a");
    await f.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','new-source','lofi','new-account','new','active','v1',0)",
      )
      .run();
    let next = await f.generations.domain("a");
    assert.ok(next && next.source_set_version > domain.source_set_version);
    domain = next;
    await f.inventory.initialize(
      {
        ...f.scope,
        scope: "new-source",
        connection: "new-source",
        logicalIdentity: "new-account",
      },
      "sync",
      "all-clients-v1",
    );
    const builds = await f.db
      .prepare(
        "SELECT complete FROM comparison_builds WHERE scope_id='new-source'",
      )
      .first<{ complete: number }>();
    assert.equal(builds?.complete, 0);
    next = await f.generations.domain("a");
    assert.ok(next && next.source_set_version > domain.source_set_version);
    domain = next;
    await f.db
      .prepare(
        "UPDATE connections SET label='renamed',last_poll_at=10 WHERE tenant='a' AND id='source'",
      )
      .run();
    assert.deepEqual(await f.generations.domain("a"), domain);
    await f.db
      .prepare(
        "UPDATE connections SET status='paused' WHERE tenant='a' AND id='source'",
      )
      .run();
    next = await f.generations.domain("a");
    assert.ok(next && next.source_set_version > domain.source_set_version);
  } finally {
    await f.mf.dispose();
  }
});

test("a scope reconfiguration restarts only live generations and tenant keys cannot cross tenants", async () => {
  const f = await fixture();
  try {
    await f.generations.begin("a");
    await seed(f.store, "b");
    const a = await f.generations.key("a");
    const b = await f.generations.key("b");
    assert.notEqual(a.keyId, b.keyId);
    const rowA = await f.db
      .prepare(
        "SELECT envelope FROM inventory_comparison_keys WHERE tenant='a'",
      )
      .first<{ envelope: string }>();
    await f.db
      .prepare(
        "UPDATE inventory_comparison_keys SET envelope=? WHERE tenant='b'",
      )
      .bind(rowA?.envelope)
      .run();
    await assert.rejects(f.generations.key("b"));
    await f.db
      .prepare(
        "UPDATE inventory_scopes SET config_version=config_version+1 WHERE tenant='a'",
      )
      .run();
    const build = await f.db
      .prepare(
        "SELECT config_version,version,cursor_key,complete FROM comparison_builds WHERE tenant='a'",
      )
      .first();
    assert.deepEqual(build, {
      config_version: 2,
      version: 2,
      cursor_key: "",
      complete: 0,
    });
    await assert.rejects(
      f.db
        .prepare("UPDATE index_generations SET state='active' WHERE tenant='a'")
        .run(),
      /incomplete/,
    );
  } finally {
    await f.mf.dispose();
  }
});
