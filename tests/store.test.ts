import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration, database, seed } from "./helpers.ts";

test("D1 tenants, atomic checkpoints and lease fencing survive overlap", async () => {
  const { mf, store } = await database();
  try {
    const key = await seed(store);
    await seed(store, "b");
    assert.equal(await store.connection("other", "source"), null);
    assert.equal(
      await store.private("other", "source", "v1", "credential"),
      null,
    );
    const lease = await store.claim("a", "poll", 1000, 100);
    assert(lease);
    assert.equal(await store.claim("a", "poll", 1050, 100), null);
    await store.checkpoint(
      lease,
      "source",
      "sync",
      0,
      { cursor: "page2" },
      [],
      1050,
    );
    await assert.rejects(
      store.checkpoint(
        lease,
        "source",
        "sync",
        0,
        { cursor: "skipped" },
        [],
        1051,
      ),
    );
    const next = await store.claim("a", "poll", 1100, 100);
    assert(next);
    assert.equal(next.fence, lease.fence + 1);
    await assert.rejects(
      store.checkpoint(lease, "source", "sync", 1, { cursor: "bad" }, [], 1101),
    );
    assert.equal(
      (
        await store
          .statement("SELECT cursor FROM cursors WHERE tenant='a'")
          .first<{ cursor: string }>()
      )?.cursor,
      '{"cursor":"page2"}',
    );
    await store.observe(key, "g1", "h1", 30, false, 1000);
    await store.observe({ ...key, qso: "q2" }, "g2", "h2", 30, false, 2000);
    await store.observe(key, "g1", "h1", 30, false, 3000);
    assert.equal((await store.ledger(key))?.due_at, 1801000);
  } finally {
    await mf.dispose();
  }
});
test("outbox pins versions, forbids mutation/overlap and parks crashes", async () => {
  const { mf, store } = await database();
  try {
    // Keep this legacy staging fixture independent of mandatory source proofs,
    // while installing the original-row metadata and current recovery schema.
    await store
      .statement(
        "ALTER TABLE private_data ADD COLUMN source_proof_version TEXT NOT NULL DEFAULT ''",
      )
      .run();
    await applyMigration(store.db, "0038_attempt_artifacts.sql");
    const key = await seed(store);
    const version = await store.saveTemplate("a", "destination", {
      comment: "v1",
    });
    await store.observe(key, "g1", "h1", 30, false, 0);
    await store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    const attempt = await store.stage(
      key,
      "g1",
      { adif: "frozen" },
      "v1",
      version,
      1800001,
    );
    assert.equal((await store.ledger(key))?.template_version, version);
    await store.saveTemplate("a", "destination", { comment: "v2" });
    assert.equal((await store.ledger(key))?.template_version, version);
    await assert.rejects(
      store.statement("UPDATE attempts SET payload_hash='bad'").run(),
    );
    await assert.rejects(
      store.stage(key, "g1", { adif: "second" }, "v1", version, 1800002),
    );
    const lease = await store.claim("a", "delivery", 1800001, 100);
    assert(lease);
    assert(await store.claimAttempt("a", attempt, lease, 1800002));
    assert(!(await store.claimAttempt("a", attempt, lease, 1800003)));
    await store.recover(1800102);
    assert.equal(
      (
        await store
          .statement("SELECT state FROM attempt_state")
          .first<{ state: string }>()
      )?.state,
      "uncertain",
    );
    await assert.rejects(
      store.resolve("a", attempt, lease, "delivered", "123", 1800103),
    );
    await store.recover(Date.now() + 8 * 86400000);
    assert.equal(
      (
        await store
          .statement("SELECT state FROM attempt_state")
          .first<{ state: string }>()
      )?.state,
      "reconciliation_required",
    );
    assert.equal(
      (
        await store
          .statement("SELECT COUNT(*) n FROM private_data WHERE kind='outbox'")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
test("a successful older generation preserves receipt and routes the newer correction", async () => {
  const { mf, store } = await database();
  try {
    const key = await seed(store);
    const version = await store.saveTemplate("a", "destination", {});
    await store.observe(key, "g1", "h1", 30, false, 0);
    await store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    await assert.rejects(store.stage(key, "g1", {}, "v1", null, 1800001));
    const attempt = await store.stage(key, "g1", {}, "v1", version, 1800001);
    const lease = await store.claim("a", "delivery", 1800001);
    assert(lease);
    assert(await store.claimAttempt("a", attempt, lease, 1800002));
    await store.observe(key, "g2", "h2", 30, false, 1800003);
    await store.resolve("a", attempt, lease, "delivered", "123", 1800004);
    const row = await store.ledger(key);
    assert.equal(row?.remote_id, "123");
    assert.equal(row?.baseline_hash, "h1");
    assert.equal(row?.state, "changed");
    assert.equal(row?.source_hash, "h2");
    assert.equal(row?.template_version, version);
  } finally {
    await mf.dispose();
  }
});
