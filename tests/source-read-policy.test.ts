import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  ensureSourceReadPolicy,
  resetSourceReadPolicy,
  SOURCE_READER_POLICY,
  sourceReadPolicy,
} from "../src/source-read-policy.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const NOW = 1_800_000_000_000;
const legacy = {
  mode: "forward",
  operations: { watermark: 400, cursor: "old-operations" },
  qsos: { watermark: 500, cursor: "old-qsos" },
  accountId: "source",
};
async function setup(t: TestContext, prior = true) {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter(
      (name) =>
        /^\d{4}_.*\.sql$/.test(name) && name > "0001_" && name < "0026_",
    )
    .filter((name) => !name.startsWith("0001_"))
    .sort())
    await applyMigration(h.db, name);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  if (prior)
    await h.db.batch([
      h.store.statement(
        "INSERT INTO cursors VALUES('a','source','sync',?,7,?)",
        JSON.stringify(legacy),
        NOW - 10,
      ),
      h.store.statement(
        "INSERT INTO cursors VALUES('a','source','context',?,3,?)",
        JSON.stringify({
          complete: true,
          syncComplete: true,
          retained: "metadata",
        }),
        NOW - 10,
      ),
    ]);
  const source = (await h.store.connection("a", "source"))!;
  const lease = (await h.store.claim("a", "poll:source:sync", NOW, 90_000))!;
  async function cursors() {
    return (
      await h.store
        .statement(
          "SELECT stream,cursor,generation,updated_at FROM cursors WHERE tenant='a' AND connection='source' ORDER BY stream",
        )
        .all()
    ).results;
  }
  async function noGuards() {
    assert.equal(
      await h.store
        .statement("SELECT count(*) FROM checkpoint_guards")
        .first("count(*)"),
      0,
    );
  }
  return { ...h, source, lease, cursors, noGuards };
}

test("policy migration is dormant and activation preserves immutable history and claims", async (t) => {
  const h = await setup(t);
  assert.equal(await sourceReadPolicy(h.store, "a", "source"), null);
  await h.db.batch([
    h.store.statement(
      "INSERT INTO source_births VALUES('a','source','qso','forward_new',1,2,'sync')",
    ),
    h.store.statement(
      "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at,seen_epoch) VALUES('a','source','qso','qso','body','revision',?,'operation-reread')",
      NOW + 100_000,
    ),
    h.store.statement(
      "INSERT INTO source_cutovers SELECT 'a','source','destination','cutover',epoch,3,'{}','initial_inventory',3,NULL,1 FROM source_inventory_epochs WHERE tenant='a' AND source='source'",
    ),
    h.store.statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('a','source','qso','destination','generation','hash',0,0)",
    ),
    h.store.statement(
      "INSERT INTO destination_identity_claims VALUES('a','destination','qrz',?,'source','qso',0)",
      "a".repeat(43),
    ),
  ]);
  const retained = async () =>
    Promise.all(
      [
        "source_births",
        "source_inventory_epochs",
        "source_cutovers",
        "destination_identity_claims",
        "source_work",
      ].map(
        async (table) =>
          (await h.store.statement(`SELECT * FROM ${table}`).all()).results,
      ),
    );
  const before = await retained();
  const result = await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  assert.equal(result.activated, true);
  assert.equal(result.cursor.generation, 8);
  assert.equal(result.policy.phase, "backfill");
  assert.equal(result.policy.completed_sync_generation, null);
  assert.equal(result.policy.completed_at, null);
  assert.deepEqual(result.cursor.cursor, {
    mode: "backfill",
    operations: {},
    qsos: {},
    accountId: "source",
    readerPolicy: SOURCE_READER_POLICY,
    policyEpoch: result.policy.epoch,
  });
  assert.deepEqual(await retained(), before);
  const rows = await h.cursors();
  const archived = rows.find((row) => String(row.stream).startsWith("gap:"))!;
  assert.deepEqual(JSON.parse(archived.cursor as string), {
    stream: "sync",
    code: "reader_policy_changed",
    previous: legacy,
    observedAt: NOW,
  });
  const context = rows.find((row) => row.stream === "context")!;
  assert.equal(context.generation, 4);
  assert.deepEqual(JSON.parse(context.cursor as string), {
    complete: false,
    syncComplete: false,
    retained: "metadata",
  });
  await h.noGuards();
});

test("activation from no cursor starts one baseline and repeated calls preserve progress", async (t) => {
  const h = await setup(t, false);
  const first = await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  assert.equal(first.cursor.generation, 1);
  assert.equal((await h.cursors()).length, 2);
  const next = {
    ...first.cursor.cursor,
    operations: { cursor: "all-clients-page", watermark: 200 },
  };
  await h.store.checkpoint(h.lease, "source", "sync", 1, next, [], NOW + 1);
  const before = await h.cursors();
  const again = await ensureSourceReadPolicy(
    h.store,
    h.source,
    h.lease,
    NOW + 2,
  );
  assert.equal(again.activated, false);
  assert.deepEqual(again.policy, first.policy);
  assert.deepEqual(again.cursor, { cursor: next, generation: 2 });
  assert.deepEqual(await h.cursors(), before);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_inventory_epochs")
      .first("count(*)"),
    1,
  );
});

test("old worker starting after activation cannot commit page writes without policy tags", async (t) => {
  const h = await setup(t);
  const current = await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  const before = await h.cursors();
  await assert.rejects(
    h.store.checkpoint(
      h.lease,
      "source",
      "sync",
      current.cursor.generation,
      legacy,
      [
        h.store.statement(
          "INSERT INTO source_births VALUES('a','source','wrong-birth','forward_new',1,9,'sync')",
        ),
        h.store.statement(
          "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at) VALUES('a','source','wrong-page','qso','body','r',?)",
          NOW + 100_000,
        ),
        h.store.statement(
          "UPDATE cursors SET cursor='{" +
            '"complete":true,"syncComplete":true' +
            "}',generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='context'",
        ),
      ],
      NOW + 1,
    ),
    /source policy cursor changed/,
  );
  assert.deepEqual(await h.cursors(), before);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_births")
      .first("count(*)"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_work")
      .first("count(*)"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM reconciliation_work")
      .first("count(*)"),
    0,
  );
  await h.noGuards();
});

test("old in-flight worker loses its lease and cursor when the replacement activates", async (t) => {
  const h = await setup(t);
  const later = NOW + 90_001;
  const replacement = (await h.store.claim(
    "a",
    "poll:source:sync",
    later,
    90_000,
  ))!;
  await ensureSourceReadPolicy(h.store, h.source, replacement, later);
  const before = await h.cursors();
  await assert.rejects(
    h.store.checkpoint(
      h.lease,
      "source",
      "sync",
      7,
      legacy,
      [
        h.store.statement(
          "INSERT INTO source_births VALUES('a','source','stale','forward_new',1,8,'sync')",
        ),
      ],
      later,
    ),
    /lease lost/,
  );
  assert.deepEqual(await h.cursors(), before);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_births")
      .first("count(*)"),
    0,
  );
  await h.noGuards();
});

test("direct old resets and invalid cursor insert/update tags fail closed", async (t) => {
  const h = await setup(t);
  const current = await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  const before = await h.cursors();
  for (const cursor of [
    JSON.stringify(legacy),
    "not-json",
    "null",
    "[]",
    JSON.stringify({ ...current.cursor.cursor, readerPolicy: "old" }),
    JSON.stringify({ ...current.cursor.cursor, policyEpoch: "other" }),
    JSON.stringify({ ...current.cursor.cursor, accountId: "other" }),
  ]) {
    await assert.rejects(
      h.store
        .statement(
          "UPDATE cursors SET cursor=?,generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='sync'",
          cursor,
        )
        .run(),
      /source policy cursor/,
    );
    await assert.rejects(
      h.store
        .statement(
          "INSERT INTO cursors VALUES('a','source','sync',?,1,?) ON CONFLICT(tenant,connection,stream) DO UPDATE SET cursor=excluded.cursor",
          cursor,
          NOW,
        )
        .run(),
      /source policy cursor/,
    );
  }
  assert.deepEqual(await h.cursors(), before);
  await h.noGuards();
});

test("activation races roll back policy, archive and context invalidation", async (t) => {
  for (const [name, change, pattern] of [
    [
      "logical account",
      "UPDATE connections SET config='{\"accountId\":\"other\"}' WHERE tenant='a' AND id='source'",
      /source policy identity changed/,
    ],
    [
      "source disabled",
      "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source'",
      /source policy identity changed/,
    ],
    [
      "account disabled",
      "UPDATE accounts SET status='disabled' WHERE id='a'",
      /source policy identity changed/,
    ],
    [
      "lease takeover",
      "UPDATE leases SET token='replacement',fence=fence+1 WHERE tenant='a' AND scope='poll:source:sync'",
      /lease lost/,
    ],
    [
      "cursor advanced",
      "UPDATE cursors SET generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='sync'",
      /cursor changed/,
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const h = await setup(t);
      const checkpoint = h.store.checkpoint.bind(h.store);
      let afterRace: Awaited<ReturnType<typeof h.cursors>>;
      h.store.checkpoint = async (...args) => {
        await h.store.statement(change).run();
        afterRace = await h.cursors();
        return checkpoint(...args);
      };
      await assert.rejects(
        ensureSourceReadPolicy(h.store, h.source, h.lease, NOW),
        pattern,
      );
      assert.deepEqual(await h.cursors(), afterRace!);
      assert.equal(await sourceReadPolicy(h.store, "a", "source"), null);
      await h.noGuards();
    });
  }
});

test("a failure after policy insertion rolls back all activation statements", async (t) => {
  const h = await setup(t);
  const before = await h.cursors();
  await h.store
    .statement(
      "CREATE TRIGGER fail_context BEFORE UPDATE ON cursors WHEN NEW.stream='context' BEGIN SELECT RAISE(ABORT,'synthetic context failure'); END;",
    )
    .run();
  await assert.rejects(
    ensureSourceReadPolicy(h.store, h.source, h.lease, NOW),
    /synthetic context failure/,
  );
  assert.equal(await sourceReadPolicy(h.store, "a", "source"), null);
  assert.deepEqual(await h.cursors(), before);
  await h.noGuards();
});

test("existing policy validates lease and logical identity but survives bearer renewal", async (t) => {
  const h = await setup(t);
  const first = await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  await h.store
    .statement(
      "UPDATE connections SET credential_version='renewed',config=json_set(config,'$.lastSuccessfulPollAt',?) WHERE tenant='a' AND id='source'",
      NOW + 1,
    )
    .run();
  const renewed = (await h.store.connection("a", "source"))!;
  assert.deepEqual(
    (await ensureSourceReadPolicy(h.store, renewed, h.lease, NOW + 1)).policy,
    first.policy,
  );
  await assert.rejects(
    ensureSourceReadPolicy(h.store, renewed, h.lease, NOW + 90_000),
    /identity or lease changed/,
  );
  await assert.rejects(
    ensureSourceReadPolicy(
      h.store,
      renewed,
      { ...h.lease, scope: "reread:source" },
      NOW + 2,
    ),
    /lease invalid/,
  );
  await h.store
    .statement(
      "UPDATE connections SET remote_identity='other',config='{\"accountId\":\"other\"}' WHERE tenant='a' AND id='source'",
    )
    .run();
  await assert.rejects(
    ensureSourceReadPolicy(h.store, renewed, h.lease, NOW + 2),
    /identity or lease changed/,
  );
  await assert.rejects(
    ensureSourceReadPolicy(
      h.store,
      (await h.store.connection("a", "source"))!,
      h.lease,
      NOW + 2,
    ),
    /scope changed/,
  );
  await assert.rejects(
    h.store.checkpoint(
      h.lease,
      "source",
      "sync",
      first.cursor.generation,
      first.cursor.cursor,
      [],
      NOW + 2,
    ),
    /source policy cursor changed/,
  );
});

test("policy phase evidence is durable, constrained and never implicitly ready", async (t) => {
  const h = await setup(t);
  await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  await assert.rejects(
    h.store.statement("UPDATE source_read_policies SET phase='ready'").run(),
    /CHECK constraint/,
  );
  for (const phase of ["drain", "quarantine"]) {
    await h.store
      .statement("UPDATE source_read_policies SET phase=?", phase)
      .run();
    assert.equal(
      (await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW + 1)).policy
        .phase,
      phase,
    );
  }
  await assert.rejects(
    h.store
      .statement("UPDATE source_read_policies SET completed_sync_generation=8")
      .run(),
    /CHECK constraint/,
  );
  assert.equal(
    (await sourceReadPolicy(h.store, "a", "source"))!.phase,
    "quarantine",
  );
});

test("policy fences are tenant/source scoped and reject activation outside its checkpoint", async (t) => {
  const h = await setup(t);
  await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  await seed(h.store, "b");
  await h.store
    .statement(
      "UPDATE connections SET config='{\"accountId\":\"source\"}' WHERE tenant='b' AND id='source'",
    )
    .run();
  await h.store
    .statement(
      "INSERT INTO cursors VALUES('b','source','sync',?,1,?)",
      JSON.stringify(legacy),
      NOW,
    )
    .run();
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO source_read_policies(tenant,source,reader_policy,epoch,source_remote,account_id,phase,started_at) VALUES('b','source','all-clients-v1','unleased','source','source','backfill',?)",
        NOW,
      )
      .run(),
    /activation lease lost/,
  );
  const second = (await h.store.connection("b", "source"))!;
  await assert.rejects(
    ensureSourceReadPolicy(h.store, second, h.lease, NOW),
    /lease invalid/,
  );
  assert.equal(await sourceReadPolicy(h.store, "b", "source"), null);
});

test("active canonical cursor cannot be deleted or moved by old recovery code", async (t) => {
  const h = await setup(t);
  await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  const before = await h.cursors();
  for (const mutation of [
    "DELETE FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
    "UPDATE cursors SET stream='orphan' WHERE tenant='a' AND connection='source' AND stream='sync'",
    "UPDATE cursors SET connection='destination' WHERE tenant='a' AND connection='source' AND stream='sync'",
  ]) {
    await assert.rejects(
      h.db.batch([
        h.store.statement(
          "UPDATE cursors SET generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='context'",
        ),
        h.store.statement(mutation),
      ]),
      /source policy cursor/,
    );
    assert.deepEqual(await h.cursors(), before);
  }
  // The existing bounded archive purge is still permitted.
  await h.store
    .statement(
      "DELETE FROM cursors WHERE tenant='a' AND connection='source' AND stream LIKE 'gap:%'",
    )
    .run();
  assert.equal((await h.cursors()).length, 2);
});

test("leased reset archives current progress and clears readiness without resetting generations", async (t) => {
  const h = await setup(t);
  const first = await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  const forward = {
    ...first.cursor.cursor,
    mode: "forward" as const,
    operations: { watermark: 600, complete: true },
    qsos: { watermark: 700, complete: true },
  };
  await h.store.checkpoint(
    h.lease,
    "source",
    "sync",
    8,
    forward,
    [
      h.store.statement(
        "UPDATE source_read_policies SET phase='ready',completed_sync_generation=9,completed_at=? WHERE tenant='a' AND source='source'",
        NOW + 1,
      ),
    ],
    NOW + 1,
  );
  const inventory = await h.store
    .statement("SELECT * FROM source_inventory_epochs")
    .first();
  const result = await resetSourceReadPolicy(
    h.store,
    h.source,
    h.lease,
    { epoch: first.policy.epoch, generation: 9 },
    "cursor_gap",
    NOW + 2,
  );
  assert.equal(result.activated, true);
  assert.equal(result.cursor.generation, 10);
  assert.notEqual(result.policy.epoch, first.policy.epoch);
  assert.equal(result.policy.started_at, NOW + 2);
  assert.equal(result.policy.phase, "backfill");
  assert.equal(result.policy.completed_sync_generation, null);
  assert.equal(result.policy.completed_at, null);
  assert.deepEqual(result.cursor.cursor.operations, {});
  assert.deepEqual(result.cursor.cursor.qsos, {});
  assert.equal(result.cursor.cursor.policyEpoch, result.policy.epoch);
  const rows = await h.cursors();
  const archives = rows.filter((row) => String(row.stream).startsWith("gap:"));
  assert.equal(archives.length, 2);
  assert.deepEqual(
    JSON.parse(
      archives.find((row) => row.stream === `gap:${result.policy.epoch}`)!
        .cursor as string,
    ),
    {
      stream: "sync",
      code: "cursor_gap",
      previous: forward,
      observedAt: NOW + 2,
    },
  );
  assert.equal(rows.find((row) => row.stream === "context")!.generation, 5);
  assert.deepEqual(
    await h.store.statement("SELECT * FROM source_inventory_epochs").first(),
    inventory,
  );
  await h.noGuards();
});

test("reset compares epoch, generation, lease and logical identity atomically", async (t) => {
  const h = await setup(t);
  const first = await ensureSourceReadPolicy(h.store, h.source, h.lease, NOW);
  const before = await h.cursors();
  for (const expected of [
    { epoch: "stale", generation: 8 },
    { epoch: first.policy.epoch, generation: 7 },
  ]) {
    await assert.rejects(
      resetSourceReadPolicy(
        h.store,
        h.source,
        h.lease,
        expected,
        "context_expired",
        NOW + 1,
      ),
      /source policy cursor changed|cursor changed/,
    );
    assert.deepEqual(await h.cursors(), before);
    assert.deepEqual(
      await sourceReadPolicy(h.store, "a", "source"),
      first.policy,
    );
  }
  await assert.rejects(
    resetSourceReadPolicy(
      h.store,
      h.source,
      { ...h.lease, token: "stale" },
      { epoch: first.policy.epoch, generation: 8 },
      "cursor_gap",
      NOW + 1,
    ),
    /lease lost/,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE source_read_policies SET epoch='not-leased',phase='backfill',started_at=?",
        NOW + 1,
      )
      .run(),
    /reset lease lost/,
  );
  await h.store
    .statement(
      "UPDATE connections SET config='{\"accountId\":\"other\"}' WHERE tenant='a' AND id='source'",
    )
    .run();
  await assert.rejects(
    resetSourceReadPolicy(
      h.store,
      h.source,
      h.lease,
      { epoch: first.policy.epoch, generation: 8 },
      "context_expired",
      NOW + 1,
    ),
    /source policy identity changed/,
  );
  assert.deepEqual(await h.cursors(), before);
  assert.deepEqual(
    await sourceReadPolicy(h.store, "a", "source"),
    first.policy,
  );
  await h.noGuards();
});

test("reset with no policy cannot install an orphan tagged cursor", async (t) => {
  const h = await setup(t);
  const before = await h.cursors();
  await assert.rejects(
    resetSourceReadPolicy(
      h.store,
      h.source,
      h.lease,
      { epoch: "missing", generation: 7 },
      "cursor_gap",
      NOW,
    ),
    /source policy cursor changed/,
  );
  assert.deepEqual(await h.cursors(), before);
  assert.equal(await sourceReadPolicy(h.store, "a", "source"), null);
  await h.noGuards();
});
