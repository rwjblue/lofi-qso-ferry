import assert from "node:assert/strict";
import test from "node:test";
import { rotatePrivateData } from "../src/maintenance.ts";
import { canonical, seal } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";

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
