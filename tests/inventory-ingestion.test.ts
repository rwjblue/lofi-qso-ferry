import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InventoryIngestion,
  type InventoryObservation,
  type InventoryPageInput,
  inventoryJsonChunks,
} from "../src/inventory-ingestion.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, seed } from "./helpers.ts";

async function fixture() {
  const result = await database();
  await seed(result.store);
  await applyMigration(result.db, "0039_inventory_ingestion.sql");
  const inventory = new InventoryIngestion(result.store);
  await inventory.initialize(
    {
      tenant: "a",
      scope: "source",
      connection: "source",
      provider: "lofi",
      logicalIdentity: "source",
      adapterBinding: "test-v1",
      ordering: "numeric",
    },
    "sync",
    "all-clients-v1",
  );
  const lease = await result.store.claim(
    "a",
    "inventory:source",
    Date.now(),
    90_000,
  );
  assert.ok(lease);
  return {
    ...result,
    inventory,
    async page(
      observations: InventoryObservation[],
      overrides: Partial<InventoryPageInput> = {},
    ) {
      const stream = await inventory.snapshot("a", "source", "sync");
      assert.ok(stream);
      return inventory.prepare({
        pageId: crypto.randomUUID(),
        stream,
        lease,
        requestStartedAt: Date.now(),
        origin: "historical",
        facet: "source",
        observations,
        nextResume: { page: stream.version + 1 },
        ...overrides,
      });
    },
  };
}
function qso(key: string, order = 1): InventoryObservation {
  return {
    family: "qso",
    key,
    subtype: "qso",
    parentKey: "op",
    revision: String(order),
    order,
    status: "active",
    body: { key, order, call: "W1AW", note: "private contact" },
    semantic: { key, call: "W1AW" },
  };
}
async function empty(result: Awaited<ReturnType<typeof fixture>>) {
  for (const table of [
    "inventory_records",
    "inventory_record_facets",
    "inventory_payloads",
    "inventory_births",
    "projection_domains",
    "inventory_work",
    "ingestion_pages",
    "ingestion_page_rows",
    "ingestion_page_guards",
  ]) {
    const row = await result.db
      .prepare(`SELECT count(*) AS n FROM ${table}`)
      .first<{ n: number }>();
    assert.equal(row?.n, 0, table);
  }
  assert.equal(
    (await result.inventory.snapshot("a", "source", "sync"))?.version,
    0,
  );
}

test("bulk publication encrypts source bodies and commits vector progress without touching credentials", async () => {
  const f = await fixture();
  try {
    const credential = await f.store.private("a", "source", "v1", "credential");
    const observations = Array.from({ length: 1000 }, (_, i) => qso(`q${i}`));
    const page = await f.page(observations, {
      nextResume: {
        operations: { cursor: "op-next" },
        qsos: { cursor: "q-next" },
      },
    });
    const receipt = await f.inventory.publish(page);
    assert.equal(receipt.changed, 1000);
    assert.ok(receipt.statements < 30, `${receipt.statements} statements`);
    assert.equal(receipt.currentVersion, 1);
    assert.deepEqual(
      (await f.inventory.snapshot("a", "source", "sync"))?.resume,
      page.input.nextResume,
    );
    assert.deepEqual(
      (await f.inventory.snapshot("a", "source", "sync"))?.checkpoint,
      {},
    );
    assert.deepEqual(
      await f.inventory.body("a", "source", "qso", "q0", "source"),
      observations[0].body,
    );
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    const payload = await f.db
      .prepare("SELECT envelope FROM inventory_payloads LIMIT 1")
      .first<{ envelope: string }>();
    assert.ok(!payload?.envelope.includes("private contact"));
    for (const table of [
      "ingestion_page_rows",
      "ingestion_page_guards",
      "ledger",
      "attempts",
    ])
      assert.equal(
        (
          await f.db
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
      );
  } finally {
    await f.mf.dispose();
  }
});

test("stable polls reuse ciphertext, newer metadata leaves semantic work stable, and stale data cannot refresh a witness", async () => {
  const f = await fixture();
  try {
    await f.inventory.publish(await f.page([qso("q", 2)]));
    const before = await f.db
      .prepare("SELECT * FROM inventory_record_facets")
      .first<Record<string, unknown>>();
    const repeated = await f.inventory.publish(await f.page([qso("q", 2)]));
    assert.equal(repeated.changed, 0);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_payloads")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    const changed = await f.inventory.publish(
      await f.page([qso("q", 3)], { nextCheckpoint: { watermark: 3 } }),
    );
    assert.equal(changed.changed, 1);
    const current = await f.db
      .prepare("SELECT * FROM inventory_record_facets")
      .first<Record<string, unknown>>();
    assert.equal(current?.semantic_version, before?.semantic_version);
    assert.equal(current?.raw_version, 2);
    const stale = await f.inventory.publish(await f.page([qso("q", 1)]));
    assert.equal(stale.accepted, 0);
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM inventory_record_facets").first(),
      current,
    );
    assert.deepEqual(
      (await f.inventory.snapshot("a", "source", "sync"))?.checkpoint,
      { watermark: 3 },
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT work_version FROM inventory_work")
          .first<{ work_version: number }>()
      )?.work_version,
      1,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_births")
          .first<{ n: number }>()
      )?.n,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("same-page variants detect older equal-stamp conflicts and preserve operation barriers once per page", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.page([
        qso("q", 1),
        qso("q", 2),
        { ...qso("q", 1), body: { conflict: true } },
      ]),
      /inventory_equal_revision_conflict/,
    );
    await empty(f);
    const event = {
      ...qso("event"),
      subtype: "event" as const,
      parentKey: "old",
    };
    const page = await f.page([
      event,
      {
        ...event,
        order: 2,
        revision: "2",
        parentKey: "new",
        body: { moved: true },
      },
      { ...event, key: "event2" },
    ]);
    await f.inventory.publish(page);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT operation_key,topology_version,ready_version FROM projection_domains ORDER BY operation_key",
          )
          .all()
      ).results,
      [
        { operation_key: "new", topology_version: 1, ready_version: 0 },
        { operation_key: "old", topology_version: 1, ready_version: 0 },
      ],
    );
  } finally {
    await f.mf.dispose();
  }
});

test("publication rejects raced authority and rolls the entire page back", async (t) => {
  const mutations = [
    "UPDATE leases SET expires_at=0",
    "UPDATE leases SET fence=fence+1",
    "UPDATE accounts SET status='locked'",
    "UPDATE connections SET status='disabled' WHERE id='source'",
    "UPDATE connections SET credential_version='v2' WHERE id='source'",
    "UPDATE private_data SET revoked_at=1 WHERE connection='source'",
    "UPDATE private_data SET expires_at=1 WHERE connection='source'",
    "UPDATE connections SET config='{} ' WHERE id='source'",
    "UPDATE connections SET remote_identity='changed' WHERE id='source'",
    "UPDATE inventory_scopes SET config_version=config_version+1",
    "UPDATE inventory_streams SET checkpoint_version=checkpoint_version+1",
  ];
  for (const mutation of mutations)
    await t.test(mutation, async () => {
      const f = await fixture();
      try {
        const page = await f.page([qso("q")]);
        await f.db.prepare(mutation).run();
        await assert.rejects(
          f.inventory.publish(page),
          /inventory authority changed/,
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM inventory_records")
              .first<{ n: number }>()
          )?.n,
          0,
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM ingestion_pages")
              .first<{ n: number }>()
          )?.n,
          0,
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM inventory_payloads")
              .first<{ n: number }>()
          )?.n,
          0,
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("record CAS rejects expected absence and a late SQL error rolls all work back", async () => {
  const f = await fixture();
  try {
    const page = await f.page([qso("q")]);
    await f.db
      .prepare(
        "INSERT INTO inventory_records VALUES('a','source','qso','q','qso','op',1,'active',0,0,'other')",
      )
      .run();
    await assert.rejects(f.inventory.publish(page), /inventory record changed/);
    await f.db.prepare("DELETE FROM inventory_records").run();
    await f.db
      .prepare(
        "CREATE TRIGGER reject_inventory_tail BEFORE DELETE ON ingestion_page_guards BEGIN SELECT RAISE(ABORT,'tail rejected'); END",
      )
      .run();
    await assert.rejects(f.inventory.publish(page), /tail rejected/);
    await empty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("lost commit acknowledgement recovers receipt and replay never restores an old cursor", async () => {
  const f = await fixture();
  try {
    const page = await f.page([qso("q")]);
    const uncertain = new InventoryIngestion(
      new Store(
        new Proxy(f.db, {
          get(target, property) {
            if (property === "batch")
              return async (statements: D1PreparedStatement[]) => {
                await target.batch(statements);
                throw new Error("lost acknowledgement");
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
        f.store.keys,
      ),
    );
    const recovered = await uncertain.publish(page);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.committedVersion, 1);
    await f.inventory.publish(await f.page([qso("q", 2)]));
    const replay = await f.inventory.publish(page);
    assert.equal(replay.currentVersion, 2);
    assert.deepEqual(replay.resume, { page: 2 });
    await assert.rejects(
      f.inventory.publish(
        await f.page([qso("different")], { pageId: page.input.pageId }),
      ),
      /inventory_page_id_reused/,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_births")
          .first<{ n: number }>()
      )?.n,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("JSON chunking bounds UTF-8 bytes and refuses oversized rows", () => {
  const rows = ["☃☃", "☃☃", "☃☃"];
  const chunks = inventoryJsonChunks(rows, 20);
  assert.deepEqual(
    chunks.flatMap((chunk) => JSON.parse(chunk)),
    rows,
  );
  assert.ok(
    chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 20),
  );
  assert.throws(
    () => inventoryJsonChunks(["☃".repeat(100)], 20),
    /inventory_row_too_large/,
  );
});

test("newer numeric revision keeps its own original observation time", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    await f.inventory.publish(
      await f.page([qso("q", 1)], { requestStartedAt: now - 10 }),
    );
    await f.inventory.publish(
      await f.page([qso("q", 2)], {
        requestStartedAt: now - 20,
        nextCheckpoint: null,
      }),
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT last_observed_at FROM inventory_record_facets")
          .first<{ last_observed_at: number }>()
      )?.last_observed_at,
      now - 20,
    );
    const page = await f.page([qso("q", 3)], { nextCheckpoint: null });
    const result = await f.inventory.publish(page);
    assert.equal(result.checkpoint, null);
    assert.equal(
      (await f.inventory.snapshot("a", "source", "sync"))?.checkpoint,
      null,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("equal-order same-body semantic variants and prepared mutations fail closed", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.page([qso("q"), { ...qso("q"), parentKey: "other" }]),
      /inventory_equal_revision_conflict/,
    );
    const page = await f.page([qso("q")]);
    page.input.nextResume = { mutated: true };
    await assert.rejects(
      f.inventory.publish(page),
      /inventory_prepared_page_changed/,
    );
    await empty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("publish snapshots before awaiting and a replacement lease can recover the original receipt", async () => {
  const f = await fixture();
  try {
    const page = await f.page([qso("q")]);
    const publishing = f.inventory.publish(page);
    page.input.nextResume = { mutated: true };
    await publishing;
    assert.deepEqual(
      (await f.inventory.snapshot("a", "source", "sync"))?.resume,
      { page: 1 },
    );
    page.input.nextResume = { page: 1 };
    page.input.lease.token = "replacement-lease";
    assert.equal((await f.inventory.publish(page)).recovered, true);
    await assert.rejects(
      f.db.prepare("UPDATE inventory_scopes SET ordering='serialized'").run(),
      /inventory scope version required/,
    );
    await f.db
      .prepare(
        "UPDATE inventory_scopes SET ordering='serialized',config_version=2",
      )
      .run();
    await assert.rejects(
      f.db.prepare("UPDATE inventory_scopes SET config_version=1").run(),
      /inventory scope version regressed/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("publication assertions remain bounded as unrelated inventory grows", async () => {
  const f = await fixture();
  try {
    const first = await f.inventory.publish(
      await f.page(Array.from({ length: 100 }, (_, i) => qso(`first-${i}`))),
    );
    await f.db
      .prepare(
        "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<5000) INSERT INTO inventory_records SELECT 'a','source','qso',printf('unrelated-%d',n),'qso',NULL,1,'active',0,0,'unrelated' FROM seq",
      )
      .run();
    const next = await f.inventory.publish(
      await f.page(Array.from({ length: 100 }, (_, i) => qso(`next-${i}`))),
    );
    assert.ok(
      next.rowsRead < first.rowsRead + 200,
      `${first.rowsRead} -> ${next.rowsRead} reads`,
    );
  } finally {
    await f.mf.dispose();
  }
});
