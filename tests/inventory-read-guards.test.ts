import assert from "node:assert/strict";
import test from "node:test";
import {
  inventoryReadAdmission,
  inventoryReadGuardStatements,
} from "../src/inventory-read-guards.ts";
import { QrzClient } from "../src/qrz.ts";
import { canonical } from "../src/security.ts";
import { vendorFetch } from "../src/vendor-requests.ts";
import { applyMigration } from "./helpers.ts";
import { inventoryRunFixture } from "./inventory-run-fixtures.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const f = await inventoryRunFixture("qrz");
  await applyMigration(f.db, "0009_vendor_requests.sql");
  const run = await f.begin();
  const context = await f.runs.context("a", run.id);
  return { ...f, run, context };
}

const INVENTORY_TABLES = [
  "inventory_scopes",
  "inventory_streams",
  "inventory_records",
  "inventory_record_facets",
  "inventory_payloads",
  "inventory_births",
  "inventory_work",
  "inventory_runs",
  "inventory_stream_jobs",
  "inventory_run_membership",
  "inventory_partition_membership",
  "inventory_coverage",
  "inventory_wakeups",
  "ingestion_pages",
  "ingestion_run_pages",
  "ingestion_page_rows",
  "ingestion_page_guards",
  "inventory_quarantine_rows",
] as const;

async function snapshot(f: Fixture) {
  return Promise.all(
    INVENTORY_TABLES.map(async (table) => ({
      table,
      rows: (await f.db.prepare(`SELECT * FROM ${table}`).all()).results
        .map(canonical)
        .sort(),
    })),
  );
}
function reader(f: Fixture, fetcher: typeof fetch, total = 5) {
  return vendorFetch(f.store, "qrz", fetcher, {
    admit: inventoryReadAdmission(f.store, f.context, f.lease),
    policy: { windowMs: 300_000, total, background: total },
    priority: "background",
  });
}

test("multiple STATUS/FETCH reservations use one captured run without changing inventory state", async () => {
  const f = await fixture();
  try {
    let requests = 0;
    const client = new QrzClient("synthetic-key", {
      fetch: reader(f, async () => {
        requests++;
        return new Response(
          new URLSearchParams({ RESULT: "OK", COUNT: "0", ADIF: "" }),
        );
      }),
    });
    const before = await snapshot(f);
    await client.status();
    await client.fetchPage({ max: 1 });
    assert.equal(requests, 2);
    assert.deepEqual(await snapshot(f), before);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT vendor,requests,background_requests FROM vendor_requests",
        )
        .first(),
      { vendor: "qrz", requests: 2, background_requests: 2 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("denied quota cleans temporary guards without changing run progress", async () => {
  const f = await fixture();
  try {
    let requests = 0;
    const request = reader(
      f,
      async () => {
        requests++;
        return new Response("synthetic");
      },
      1,
    );
    await request("https://logbook.qrz.com/api");
    const before = await snapshot(f);
    const budget = await f.db.prepare("SELECT * FROM vendor_requests").first();
    await assert.rejects(request("https://logbook.qrz.com/api"), /deferred/i);
    assert.equal(requests, 1);
    assert.deepEqual(await snapshot(f), before);
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM vendor_requests").first(),
      budget,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("read admission uses the D1 clock when the Worker clock is ahead", async (t) => {
  const f = await fixture();
  try {
    const before = await snapshot(f);
    const request = reader(f, async () => new Response("synthetic"));
    t.mock.method(Date, "now", () => f.context.run.startedAt + 60_000);
    assert.equal(
      await (await request("https://logbook.qrz.com/api")).text(),
      "synthetic",
    );
    assert.deepEqual(await snapshot(f), before);
  } finally {
    t.mock.restoreAll();
    await f.mf.dispose();
  }
});

test("raced run/job and current authority fail before charging vendor quota", async (t) => {
  const mutations = [
    "UPDATE inventory_runs SET version=version+1",
    "UPDATE inventory_stream_jobs SET work_version=work_version+1",
    "UPDATE inventory_stream_jobs SET active_run_id=NULL,work_version=work_version+1,state='idle'",
    "UPDATE inventory_streams SET checkpoint_version=checkpoint_version+1",
    "UPDATE inventory_scopes SET config_version=config_version+1",
    "UPDATE accounts SET status='locked'",
    "UPDATE connections SET status='disabled' WHERE id='destination'",
    "UPDATE connections SET config='{} ' WHERE id='destination'",
    "UPDATE private_data SET revoked_at=1 WHERE connection='destination' AND kind='credential'",
    "UPDATE leases SET expires_at=0",
  ];
  for (const mutation of mutations)
    await t.test(mutation, async () => {
      const f = await fixture();
      try {
        let requests = 0;
        const request = reader(f, async () => {
          requests++;
          return new Response("must not dispatch");
        });
        await f.db.prepare(mutation).run();
        const before = await snapshot(f);
        await assert.rejects(
          request("https://logbook.qrz.com/api"),
          /inventory/,
        );
        assert.equal(requests, 0);
        assert.deepEqual(await snapshot(f), before);
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM vendor_requests")
              .first<{ n: number }>()
          )?.n,
          0,
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("a held run rejects old admission, including after a replacement run starts", async () => {
  const f = await fixture();
  try {
    let requests = 0;
    const request = reader(f, async () => {
      requests++;
      return new Response("must not dispatch");
    });
    await f.inventory.publish(
      await f.runs.prepareHold(f.context, f.lease, "verification_required"),
    );
    await assert.rejects(request("https://logbook.qrz.com/api"), /inventory/);
    await f.runs.resumeHeldScope("a", f.scope, f.initial.logicalIdentity);
    const stream = await f.inventory.snapshot("a", f.scope, "sync");
    assert.ok(stream);
    const replacement = await f.runs.begin({
      stream,
      lease: f.lease,
      replaceHeld: true,
      definition: {
        id: "replacement-read-run",
        mode: "full",
        facet: "receipt",
        partition: f.run.partition,
        partitionBinding: f.run.partitionBinding,
        collectionBinding: f.run.collectionBinding,
        requiredStreams: ["selection"],
        fixedQuery: { day: "synthetic" },
        initialResume: {},
      },
    });
    const before = await snapshot(f);
    await assert.rejects(request("https://logbook.qrz.com/api"), /inventory/);
    assert.deepEqual(await snapshot(f), before);
    assert.equal((await f.runs.load("a", replacement.id))?.phase, "collecting");
    assert.equal(requests, 0);
  } finally {
    await f.mf.dispose();
  }
});

test("admission snapshots context and lease before caller mutation", async () => {
  const f = await fixture();
  try {
    const request = reader(f, async () => new Response("synthetic"));
    f.context.run.version++;
    f.context.run.collectionBinding = "caller mutation";
    f.context.stream.configVersion++;
    f.context.stream.resume = { changed: true };
    f.lease.token = "caller mutation";
    const before = await snapshot(f);
    await request("https://logbook.qrz.com/api");
    assert.deepEqual(await snapshot(f), before);
    assert.equal(
      (
        await f.db
          .prepare("SELECT requests FROM vendor_requests")
          .first<{ requests: number }>()
      )?.requests,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("late guard cleanup failure rolls back the quota reservation", async () => {
  const f = await fixture();
  try {
    const guards = inventoryReadGuardStatements(f.store, f.context, f.lease);
    const before = await snapshot(f);
    await f.db
      .prepare(
        "CREATE TRIGGER reject_read_guard_cleanup BEFORE DELETE ON ingestion_page_guards BEGIN SELECT RAISE(ABORT,'read cleanup rejected'); END",
      )
      .run();
    await assert.rejects(
      f.db.batch([
        ...guards.before,
        f.db.prepare(
          "INSERT INTO vendor_requests(vendor,window_start,requests,background_requests) VALUES('qrz',0,1,1) RETURNING window_start,cooldown_until",
        ),
        ...guards.after,
      ]),
      /read cleanup rejected/,
    );
    assert.deepEqual(await snapshot(f), before);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM vendor_requests")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("admit-only headers cannot be published as observation pages", async () => {
  const f = await fixture();
  try {
    const guards = inventoryReadGuardStatements(f.store, f.context, f.lease);
    const before = await snapshot(f);
    await assert.rejects(
      f.db.batch([
        ...guards.before,
        f.db.prepare(
          "UPDATE ingestion_pages SET state='committed' WHERE state='prepared'",
        ),
        ...guards.after,
      ]),
      /inventory/,
    );
    assert.deepEqual(await snapshot(f), before);
  } finally {
    await f.mf.dispose();
  }
});
