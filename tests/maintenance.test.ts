import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { purgeResolvedSource, rotatePrivateData } from "../src/maintenance.ts";
import { Store } from "../src/store.ts";
import { database, keys, seed } from "./helpers.ts";
async function intakeSchema(db: D1Database) {
  const sql = await readFile(
    new URL("../migrations/0004_intake.sql", import.meta.url),
    "utf8",
  );
  let pending = "";
  for (const line of sql.split("\n")) {
    pending += line + "\n";
    const trigger = pending.trimStart().startsWith("CREATE TRIGGER");
    if (line.trim().endsWith(";") && (!trigger || line.trim() === "END;")) {
      await db.prepare(pending).run();
      pending = "";
    }
  }
}
test("bounded interrupted KEK rotation preserves revoked state and encrypted payload bytes", async () => {
  const { mf, store, db } = await database();
  try {
    await seed(store);
    await store
      .statement(
        "UPDATE private_data SET revoked_at=1 WHERE connection='source'",
      )
      .run();
    const before = (
      await store
        .statement("SELECT envelope FROM private_data ORDER BY connection")
        .all<{ envelope: string }>()
    ).results.map((r) => JSON.parse(r.envelope).ciphertext);
    const rotated = new Store(db, { ...keys, active: "2" });
    assert.deepEqual(await rotatePrivateData(rotated, 1), {
      rotated: 1,
      blocked: 0,
    });
    assert.deepEqual(await rotatePrivateData(rotated, 1), {
      rotated: 1,
      blocked: 0,
    });
    assert.deepEqual(await rotatePrivateData(rotated, 1), {
      rotated: 0,
      blocked: 0,
    });
    const after = (
      await store
        .statement("SELECT envelope FROM private_data ORDER BY connection")
        .all<{ envelope: string }>()
    ).results.map((r) => JSON.parse(r.envelope).ciphertext);
    assert.deepEqual(after, before);
    const restored = new Store(db, {
      active: "2",
      keys: { "2": keys.keys["2"] },
    });
    assert.equal(
      await restored.private("a", "source", "v1", "credential"),
      null,
    );
    assert.deepEqual(
      await restored.private("a", "destination", "v1", "credential"),
      { secret: "private" },
    );
  } finally {
    await mf.dispose();
  }
});
test("resolved source purge keeps server watermark and never purges another tenant by colliding ID", async () => {
  const { mf, store, db } = await database();
  try {
    await intakeSchema(db);
    const a = await seed(store);
    const b = await seed(store, "b");
    for (const key of [a, b]) {
      await store.observe(key, "g", "h", 30);
      await (
        await store.putPrivate(
          key.tenant,
          "source",
          "same-private-id",
          "source",
          { notes: "private fixture" },
        )
      ).run();
      await store
        .statement(
          "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at,synced_at) VALUES(?,?,'q1','qso','same-private-id','r1',?,123)",
          key.tenant,
          "source",
          Date.now() + 1000,
        )
        .run();
    }
    await store
      .statement(
        "UPDATE ledger SET state='adopted_existing',baseline_hash=source_hash WHERE tenant='a'",
      )
      .run();
    await purgeResolvedSource(store);
    assert.equal(
      await store.private("a", "source", "same-private-id", "source"),
      null,
    );
    assert.notEqual(
      await store.private("b", "source", "same-private-id", "source"),
      null,
    );
    const row = await store
      .statement("SELECT synced_at,state FROM source_work WHERE tenant='a'")
      .first<{ synced_at: number; state: string }>();
    assert.equal(row?.synced_at, 123);
    assert.equal(row?.state, "archived");
  } finally {
    await mf.dispose();
  }
});
