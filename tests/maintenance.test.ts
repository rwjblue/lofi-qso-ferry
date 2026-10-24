import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { purgeResolvedSource, rotatePrivateData } from "../src/maintenance.ts";
import { canonical, seal } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";

async function intakeSchema(db: D1Database) {
  const sql = await readFile(
    new URL("../migrations/0004_intake.sql", import.meta.url),
    "utf8",
  );
  let pending = "";
  for (const line of sql.split("\n")) {
    pending += `${line}\n`;
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
test("source proof token rotation counts one private row and envelope races count zero", async (t) => {
  const { mf, store, db } = await database();
  t.after(() => mf.dispose());
  await applyMigration(db, "0028_source_export_proofs.sql");
  const rotating = new Store(db, { ...keys, active: "2" });
  await seed(rotating);
  await (
    await store.putPrivate("a", "source", "body", "source", {
      notes: "original fixture",
    })
  ).run();
  const savedBody = () =>
    store
      .statement(
        "SELECT envelope,source_proof_version FROM private_data WHERE tenant='a' AND connection='source' AND id='body' AND kind='source'",
      )
      .first<{ envelope: string; source_proof_version: string }>();
  const before = (await savedBody())!;
  assert.deepEqual(await rotatePrivateData(rotating, 1), {
    rotated: 1,
    blocked: 0,
  });
  const after = (await savedBody())!;
  assert.notEqual(after.source_proof_version, before.source_proof_version);
  assert.equal(
    JSON.parse(after.envelope).ciphertext,
    JSON.parse(before.envelope).ciphertext,
  );
  assert.equal(JSON.parse(after.envelope).kek, "2");
  assert.deepEqual(await rotatePrivateData(rotating, 1), {
    rotated: 0,
    blocked: 0,
  });

  for (const race of ["replace", "delete"] as const) {
    await store
      .statement(
        "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND id='body' AND kind='source'",
      )
      .run();
    await (
      await store.putPrivate("a", "source", "body", "source", {
        notes: "original fixture",
      })
    ).run();
    const replacement = canonical(
      await seal(
        { notes: "replacement fixture" },
        {
          tenant: "a",
          connection: "source",
          id: "body",
          kind: "source",
          purpose: "storage",
        },
        rotating.keys,
      ),
    );
    let raced = false;
    const racing = new Proxy(rotating, {
      get(target, property, receiver) {
        if (property === "statement")
          return (sql: string, ...params: (string | number | null)[]) => {
            const statement = target.statement(sql, ...params);
            if (!sql.startsWith("SELECT tenant,connection,id,kind,envelope"))
              return statement;
            return {
              async all() {
                const selected = await statement.all();
                if (race === "replace")
                  await store
                    .statement(
                      "UPDATE private_data SET envelope=? WHERE tenant='a' AND connection='source' AND id='body' AND kind='source'",
                      replacement,
                    )
                    .run();
                else
                  await store
                    .statement(
                      "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND id='body' AND kind='source'",
                    )
                    .run();
                raced = true;
                return selected;
              },
            };
          };
        return Reflect.get(target, property, receiver);
      },
    });
    assert.deepEqual(await rotatePrivateData(racing, 1), {
      rotated: 0,
      blocked: 0,
    });
    assert.equal(raced, true);
    if (race === "replace") {
      assert.equal((await savedBody())?.envelope, replacement);
      assert.deepEqual(
        await rotating.private("a", "source", "body", "source"),
        { notes: "replacement fixture" },
      );
    } else assert.equal(await savedBody(), null);
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

test("expired unresolved source metadata stays available for background repair", async () => {
  const { mf, store, db } = await database();
  try {
    await intakeSchema(db);
    const key = await seed(store);
    await store.observe(key, "g", "h", 30);
    await store
      .statement(
        "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,state,reason,expires_at) VALUES('a','source','q1','qso','expired-body','r1','expired','source payload expired; current reread required',0)",
      )
      .run();
    await purgeResolvedSource(store);
    assert.deepEqual(
      await store
        .statement("SELECT state,reason FROM source_work WHERE id='q1'")
        .first(),
      {
        state: "expired",
        reason: "source payload expired; current reread required",
      },
    );
  } finally {
    await mf.dispose();
  }
});

test("source cleanup requires every destination and attempt to be resolved", async () => {
  const { mf, store, db } = await database();
  try {
    await intakeSchema(db);
    await seed(store);
    await store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,created_at) VALUES('a','other-destination','qrz','other','other',0),('a','other-source','lofi','other','other',0)",
      )
      .run();
    const cases = [
      { id: "adopted", state: "adopted_existing", purge: true },
      { id: "delivered", state: "delivered", purge: true },
      { id: "observed", state: "observed", purge: true },
      { id: "deleted", state: "source_deleted", purge: true },
      { id: "pending", state: "inventory_pending", purge: false },
      { id: "mixed", state: "adopted_existing", purge: false },
      { id: "edited", state: "delivered", purge: false },
      { id: "missing-baseline", state: "observed", purge: false },
      { id: "no-ledger", purge: false },
      { id: "operation", state: "adopted_existing", purge: false },
      { id: "event", state: "adopted_existing", purge: false },
      ...[
        "prepared",
        "dispatching",
        "uncertain",
        "submitted",
        "reconciliation_required",
        "cancelled",
      ].map((attempt) => ({
        id: `attempt-${attempt}`,
        state: "adopted_existing",
        attempt,
        purge: attempt === "cancelled",
      })),
    ];
    for (const item of cases) {
      await db.batch([
        store.statement(
          "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) VALUES('a','source',?,'source','{}',0)",
          item.id,
        ),
        store.statement(
          "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at,is_event) VALUES('a','source',?,?,?,'g',?,?)",
          item.id,
          item.id === "operation" ? "operation" : "qso",
          item.id,
          Date.now() + 60_000,
          Number(item.id === "event"),
        ),
      ]);
      if (item.state)
        await store
          .statement(
            "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,baseline_hash,state,due_at,updated_at) VALUES('a','source',?,'destination','g','current',?,?,0,0)",
            item.id,
            item.id === "edited"
              ? "old"
              : item.id === "missing-baseline"
                ? null
                : "current",
            item.state,
          )
          .run();
      if ("attempt" in item)
        await db.batch([
          store.statement(
            "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a',?,'source',?,'destination','g','payload','hash','v1',0,'current')",
            item.id,
            item.id,
          ),
          store.statement(
            "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,?,0,0)",
            item.id,
            item.attempt,
          ),
        ]);
    }
    await db.batch([
      store.statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,due_at,updated_at) VALUES('a','source','mixed','other-destination','g','current','history_mismatch',0,0)",
      ),
      // Matching IDs in another source or private-data kind are independent.
      store.statement(
        "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) VALUES('a','other-source','adopted','source','{}',0),('a','source','adopted','credential','{}',0)",
      ),
    ]);
    await purgeResolvedSource(store);
    for (const item of cases) {
      const payload = await store
        .statement(
          "SELECT 1 found FROM private_data WHERE tenant='a' AND connection='source' AND id=? AND kind='source'",
          item.id,
        )
        .first();
      assert.equal(payload === null, item.purge, item.id);
      const work = await store
        .statement("SELECT state FROM source_work WHERE id=?", item.id)
        .first<{ state: string }>();
      assert.equal(work?.state, item.purge ? "archived" : "pending", item.id);
    }
    assert.equal(
      (
        await store
          .statement(
            "SELECT COUNT(*) n FROM private_data WHERE id='adopted' AND (connection='other-source' OR kind='credential')",
          )
          .first<{ n: number }>()
      )?.n,
      2,
    );
  } finally {
    await mf.dispose();
  }
});

test("unresolved backlog cleanup reads a bounded multiple of its rows", async () => {
  const { mf, store, db } = await database();
  try {
    await intakeSchema(db);
    await seed(store);
    const contacts = 4_000;
    await db.batch([
      store.statement(
        "WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<?) INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at) SELECT 'a','source','q'||n,'qso','p'||n,'g',1 FROM sequence",
        contacts,
      ),
      store.statement(
        "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) SELECT tenant,source,private_id,'source','{}',0 FROM source_work",
      ),
      store.statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) SELECT tenant,source,id,'destination','g','h',0,0 FROM source_work",
      ),
    ]);
    let results: D1Result[] | undefined;
    const measured = new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            results = await target.batch(statements);
            return results;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await purgeResolvedSource(new Store(measured, keys));
    assert(results);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.meta.changes, 0);
      // A correlated scan once per retained body makes this quadratic. Row
      // counts catch that regression without a machine-dependent time limit.
      assert(
        result.meta.rows_read < contacts * 20,
        JSON.stringify(result.meta),
      );
    }
    assert.equal(
      (
        await store
          .statement("SELECT COUNT(*) n FROM source_work")
          .first<{ n: number }>()
      )?.n,
      contacts,
    );
  } finally {
    await mf.dispose();
  }
});
