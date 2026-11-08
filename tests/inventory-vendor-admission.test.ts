import assert from "node:assert/strict";
import test from "node:test";
import {
  InventoryIngestion,
  type InventoryStream,
} from "../src/inventory-ingestion.ts";
import {
  InventoryVendorAdmissionError,
  inventorySourcePacing,
  inventorySourcePacingStatement,
  inventoryVendorFetch,
} from "../src/inventory-vendor-admission.ts";
import type { Lease } from "../src/store.ts";
import { VendorDeferredError, vendorFetch } from "../src/vendor-requests.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const endpoint = "https://lofi.ham2k.net/v1/accounts";
const WINDOW = 300_000;
async function fixture(count = 4) {
  const h = await database();
  try {
    await applyMigration(h.db, "0009_vendor_requests.sql");
    await applyMigration(h.db, "0039_inventory_ingestion.sql");
    await applyMigration(h.db, "0041_inventory_vendor_admission.sql");
    const inventory = new InventoryIngestion(h.store);
    const sources: { stream: InventoryStream; lease: Lease }[] = [];
    for (let index = 0; index < count; index++) {
      const tenant = `a${index}`;
      await seed(h.store, tenant);
      const stream = await inventory.initialize(
        {
          tenant,
          scope: "source",
          connection: "source",
          provider: "lofi",
          logicalIdentity: "source",
          adapterBinding: "admission-test-v1",
          ordering: "numeric",
        },
        "sync",
        "all-clients-v1",
      );
      const lease = await h.store.claim(
        tenant,
        "inventory:source",
        Date.now(),
        3_600_000,
      );
      assert.ok(lease);
      sources.push({ stream, lease });
    }
    const now = Math.ceil(Date.now() / WINDOW) * WINDOW + 1000;
    let sent = 0;
    const fetcher: typeof fetch = async () => {
      sent++;
      return new Response("ok");
    };
    return {
      ...h,
      sources,
      inventory,
      now,
      fetcher,
      sent: () => sent,
      read(
        source: number,
        at: number,
        priority: "bootstrap" | "background" | "live" = "bootstrap",
      ) {
        const selected = sources[source];
        assert.ok(selected);
        return inventoryVendorFetch(
          h.store,
          selected.stream,
          selected.lease,
          fetcher,
          { priority, now: at },
        )(endpoint);
      },
      async budget() {
        return h.db
          .prepare(
            "SELECT window_start,requests,background_requests,cooldown_until FROM vendor_requests WHERE vendor='lofi'",
          )
          .first<{
            window_start: number;
            requests: number;
            background_requests: number;
            cooldown_until: number;
          }>();
      },
    };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}
function unsent(error: unknown): error is VendorDeferredError {
  return error instanceof VendorDeferredError && !error.requestSent;
}

test("legacy background and inventory bootstrap share twenty slots while four foreground slots remain", async () => {
  const h = await fixture();
  try {
    for (let index = 0; index < 4; index++)
      await vendorFetch(h.store, "lofi", h.fetcher, {
        priority: "background",
        now: h.now,
      })(endpoint);
    for (let index = 0; index < 16; index++)
      await h.read(index % 4, h.now + index * 5000);
    await assert.rejects(h.read(0, h.now + 80_000), unsent);
    assert.equal((await h.budget())?.requests, 20);
    assert.equal((await h.budget())?.background_requests, 4);
    assert.equal(
      await h.db
        .prepare("SELECT requests FROM inventory_vendor_bootstrap")
        .first<number>("requests"),
      16,
    );
    for (let index = 0; index < 4; index++)
      await vendorFetch(h.store, "lofi", h.fetcher, {
        priority: "live",
        now: h.now + 90_000,
      })(endpoint);
    await assert.rejects(
      vendorFetch(h.store, "lofi", h.fetcher, { now: h.now + 90_000 })(
        endpoint,
      ),
      unsent,
    );
    assert.equal((await h.budget())?.requests, 24);
    assert.equal(h.sent(), 24);
  } finally {
    await h.mf.dispose();
  }
});

test("bootstrap first blocks legacy background reservations without consuming foreground quota", async () => {
  const h = await fixture();
  try {
    for (let index = 0; index < 20; index++)
      await h.read(index % 4, h.now + index * 5000);
    await assert.rejects(
      vendorFetch(h.store, "lofi", h.fetcher, {
        priority: "background",
        now: h.now + 100_000,
      })(endpoint),
      unsent,
    );
    assert.equal((await h.budget())?.requests, 20);
    assert.equal((await h.budget())?.background_requests, 0);
    for (let index = 0; index < 4; index++)
      await vendorFetch(h.store, "lofi", h.fetcher, { now: h.now + 100_000 })(
        endpoint,
      );
    assert.equal((await h.budget())?.requests, 24);
    assert.equal(h.sent(), 24);
  } finally {
    await h.mf.dispose();
  }
});

test("overlapping inventory wrappers reserve once and failed pacing consumes nothing", async () => {
  const h = await fixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => h.read(index % 4, h.now)),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    for (const result of results)
      if (result.status === "rejected") assert.ok(unsent(result.reason));
    assert.equal(h.sent(), 1);
    assert.equal((await h.budget())?.requests, 1);
    assert.equal(
      await h.db
        .prepare("SELECT requests FROM inventory_vendor_bootstrap")
        .first<number>("requests"),
      1,
    );
    assert.equal(
      await h.db
        .prepare("SELECT count(*) n FROM inventory_request_guards")
        .first<number>("n"),
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("concurrent legacy background and bootstrap cannot overbook their last shared slot", async () => {
  const h = await fixture();
  try {
    for (let index = 0; index < 19; index++)
      await h.read(index % 4, h.now + index * 5000);
    const now = h.now + 95_000;
    const results = await Promise.allSettled([
      h.read(3, now),
      ...Array.from({ length: 4 }, () =>
        vendorFetch(h.store, "lofi", h.fetcher, {
          priority: "background",
          now,
        })(endpoint),
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const result of results)
      if (result.status === "rejected") assert.ok(unsent(result.reason));
    const budget = await h.budget();
    const bootstrap = await h.db
      .prepare("SELECT requests FROM inventory_vendor_bootstrap")
      .first<number>("requests");
    assert.equal((budget?.background_requests ?? 0) + (bootstrap ?? 0), 20);
    assert.equal(budget?.requests, 20);
    assert.equal(h.sent(), 20);
  } finally {
    await h.mf.dispose();
  }
});

test("global five-second and default source twenty-second pacing persist across wrappers", async () => {
  const h = await fixture();
  try {
    await h.read(0, h.now);
    await assert.rejects(
      h.read(1, h.now + 4999),
      (error) => unsent(error) && error.retryAt === h.now + 5000,
    );
    await h.read(1, h.now + 5000);
    await assert.rejects(
      h.read(0, h.now + 19_999),
      (error) => unsent(error) && error.retryAt === h.now + 20_000,
    );
    await h.read(0, h.now + 20_000);
    assert.equal(h.sent(), 3);
    assert.equal((await h.budget())?.requests, 3);
  } finally {
    await h.mf.dispose();
  }
});

test("validated zero and short server hints permit the source five-second floor on future requests", async () => {
  const h = await fixture();
  try {
    const { stream, lease } = h.sources[0];
    await h.read(0, h.now);
    const hinted = (at: number, sourceDelayMs: number) =>
      inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
        priority: "bootstrap",
        now: at,
        sourceDelayMs,
      })(endpoint);
    // Learning a hint does not shorten a previously reserved fallback delay.
    await assert.rejects(
      hinted(h.now + 5000, 0),
      (error) => unsent(error) && error.retryAt === h.now + 20_000,
    );
    await hinted(h.now + 20_000, 0);
    await assert.rejects(
      hinted(h.now + 24_999, 1000),
      (error) => unsent(error) && error.retryAt === h.now + 25_000,
    );
    await hinted(h.now + 25_000, 1000);
    const other = h.sources[1];
    await assert.rejects(
      inventoryVendorFetch(h.store, other.stream, other.lease, h.fetcher, {
        priority: "bootstrap",
        now: h.now + 25_000,
        sourceDelayMs: 0,
      })(endpoint),
      (error) => unsent(error) && error.retryAt === h.now + 30_000,
    );
    await inventoryVendorFetch(h.store, other.stream, other.lease, h.fetcher, {
      priority: "bootstrap",
      now: h.now + 30_000,
      sourceDelayMs: 0,
    })(endpoint);
    assert.equal(h.sent(), 4);
    assert.equal((await h.budget())?.requests, 4);
  } finally {
    await h.mf.dispose();
  }
});

test("publication of validated zero or short hints retains a five-second minimum", async () => {
  const h = await fixture(1);
  try {
    const { stream, lease } = h.sources[0];
    await inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
      priority: "bootstrap",
      now: h.now,
      sourceDelayMs: 0,
    })(endpoint);
    for (const hint of [0, 1000]) {
      await inventorySourcePacingStatement(
        h.store,
        stream,
        h.now - 1000,
        hint,
      ).run();
      assert.deepEqual(
        await h.db
          .prepare(
            "SELECT last_requested_at,next_allowed_at FROM inventory_read_pacing WHERE tenant=? AND source=?",
          )
          .bind(stream.tenant, stream.connection)
          .first(),
        { last_requested_at: h.now, next_allowed_at: h.now + 5000 },
      );
    }
    assert.equal(h.sent(), 1);
  } finally {
    await h.mf.dispose();
  }
});

test("retained zero hints survive new wrappers and omitted fields while newer hints replace stale hints", async () => {
  const h = await fixture(1);
  try {
    const { stream, lease } = h.sources[0];
    assert.deepEqual(await inventorySourcePacing(h.store, stream), {
      nextAllowedAt: 0,
    });
    await h.read(0, h.now);
    await inventorySourcePacingStatement(h.store, stream, h.now, 0, {
      loopDelayMs: 0,
      checkPeriodMs: 60_000,
      observedAt: h.now,
    }).run();
    const retained = await inventorySourcePacing(h.store, stream);
    assert.deepEqual(retained, {
      loopDelayMs: 0,
      checkPeriodMs: 60_000,
      nextAllowedAt: h.now + 20_000,
    });
    await inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
      priority: "bootstrap",
      now: retained.nextAllowedAt,
      sourceDelayMs: retained.loopDelayMs,
    })(endpoint);
    await inventorySourcePacingStatement(
      h.store,
      stream,
      h.now + 20_000,
      0,
    ).run();
    await inventorySourcePacingStatement(h.store, stream, h.now + 20_000, 0, {
      checkPeriodMs: 90_000,
      observedAt: h.now + 21_000,
    }).run();
    const current = {
      loopDelayMs: 0,
      checkPeriodMs: 90_000,
      nextAllowedAt: h.now + 26_000,
    };
    assert.deepEqual(await inventorySourcePacing(h.store, stream), current);
    await inventorySourcePacingStatement(
      h.store,
      stream,
      h.now + 20_000,
      90_000,
      {
        loopDelayMs: 90_000,
        checkPeriodMs: 1000,
        observedAt: h.now + 1000,
      },
    ).run();
    assert.deepEqual(await inventorySourcePacing(h.store, stream), current);
    await inventorySourcePacingStatement(h.store, stream, h.now + 20_000, 0, {
      loopDelayMs: 35_000,
      observedAt: h.now + 30_000,
    }).run();
    assert.deepEqual(await inventorySourcePacing(h.store, stream), {
      loopDelayMs: 35_000,
      checkPeriodMs: 90_000,
      nextAllowedAt: h.now + 65_000,
    });
    assert.deepEqual(
      await h.db
        .prepare(
          "SELECT hints_observed_at,policy_version FROM inventory_read_pacing WHERE tenant=? AND source=?",
        )
        .bind(stream.tenant, stream.connection)
        .first(),
      { hints_observed_at: h.now + 30_000, policy_version: 1 },
    );
    assert.deepEqual(
      await h.db
        .prepare(
          "SELECT loop_delay_ms,check_period_ms,hints_observed_at FROM inventory_read_pacing WHERE tenant='' AND source=''",
        )
        .first(),
      { loop_delay_ms: null, check_period_ms: null, hints_observed_at: null },
    );
    assert.equal(h.sent(), 2);
  } finally {
    await h.mf.dispose();
  }
});

test("a hint changed after scheduling still bounds the next native reservation", async () => {
  const h = await fixture(1);
  try {
    const { stream, lease } = h.sources[0];
    await inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
      priority: "bootstrap",
      now: h.now,
      sourceDelayMs: 0,
    })(endpoint);
    await inventorySourcePacingStatement(h.store, stream, h.now, 0, {
      loopDelayMs: 0,
      observedAt: h.now,
    }).run();
    const stale = await inventorySourcePacing(h.store, stream);
    await inventorySourcePacingStatement(h.store, stream, h.now, 0, {
      loopDelayMs: 35_000,
      observedAt: h.now + 1,
    }).run();
    await inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
      priority: "bootstrap",
      now: h.now + 35_001,
      sourceDelayMs: stale.loopDelayMs,
    })(endpoint);
    assert.equal(
      (await inventorySourcePacing(h.store, stream)).nextAllowedAt,
      h.now + 70_001,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("source pacing honors guidance from response completion while preserving request time", async () => {
  const h = await fixture(1);
  try {
    const { stream } = h.sources[0];
    await h.read(0, h.now);
    await inventorySourcePacingStatement(h.store, stream, h.now - 500, 35_000, {
      loopDelayMs: 35_000,
      observedAt: h.now + 1000,
    }).run();
    assert.deepEqual(
      await h.db
        .prepare(
          "SELECT last_requested_at,next_allowed_at,hints_observed_at FROM inventory_read_pacing WHERE tenant=? AND source=?",
        )
        .bind(stream.tenant, stream.connection)
        .first(),
      {
        last_requested_at: h.now,
        next_allowed_at: h.now + 36_000,
        hints_observed_at: h.now + 1000,
      },
    );
    await inventorySourcePacingStatement(h.store, stream, h.now, 90_000, {
      loopDelayMs: 90_000,
      observedAt: h.now,
    }).run();
    assert.equal(
      (await inventorySourcePacing(h.store, stream)).nextAllowedAt,
      h.now + 36_000,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("a completion-only observation anchors the fallback delay without clearing retained fields", async () => {
  const h = await fixture(1);
  try {
    const { stream } = h.sources[0];
    await h.read(0, h.now);
    await inventorySourcePacingStatement(h.store, stream, h.now, 0, {
      loopDelayMs: 0,
      checkPeriodMs: 60_000,
      observedAt: h.now,
    }).run();
    await inventorySourcePacingStatement(h.store, stream, h.now, 20_000, {
      observedAt: h.now + 1000,
    }).run();
    assert.deepEqual(await inventorySourcePacing(h.store, stream), {
      loopDelayMs: 0,
      checkPeriodMs: 60_000,
      nextAllowedAt: h.now + 21_000,
    });
    assert.equal(
      await h.db
        .prepare(
          "SELECT last_requested_at FROM inventory_read_pacing WHERE tenant=? AND source=?",
        )
        .bind(stream.tenant, stream.connection)
        .first<number>("last_requested_at"),
      h.now,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("invalid hints reject before publication and a failed publication rolls valid hints back", async () => {
  const h = await fixture(1);
  try {
    const { stream } = h.sources[0];
    await h.read(0, h.now);
    for (const hints of [
      { observedAt: h.now, checkPeriodMs: 0 },
      { observedAt: h.now, checkPeriodMs: -1 },
      { observedAt: h.now, loopDelayMs: -1 },
      { observedAt: Number.NaN, loopDelayMs: 0 },
    ])
      assert.throws(
        () => inventorySourcePacingStatement(h.store, stream, h.now, 0, hints),
        /invalid_inventory_pacing/,
      );
    await h.db
      .prepare(
        "CREATE TRIGGER reject_hint_publication BEFORE UPDATE OF checkpoint_version ON inventory_streams BEGIN SELECT RAISE(ABORT,'hint publication rejected'); END",
      )
      .run();
    await assert.rejects(
      h.store.db.batch([
        inventorySourcePacingStatement(h.store, stream, h.now, 0, {
          loopDelayMs: 0,
          checkPeriodMs: 60_000,
          observedAt: h.now,
        }),
        h.store.statement(
          "UPDATE inventory_streams SET checkpoint_version=checkpoint_version+1",
        ),
      ]),
      /hint publication rejected/,
    );
    assert.deepEqual(await inventorySourcePacing(h.store, stream), {
      nextAllowedAt: h.now + 20_000,
    });
    assert.equal(
      await h.db
        .prepare(
          "SELECT hints_observed_at FROM inventory_read_pacing WHERE tenant=? AND source=?",
        )
        .bind(stream.tenant, stream.connection)
        .first<number>("hints_observed_at"),
      null,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("validated larger server delays win, and streams on one connection share pacing", async () => {
  const h = await fixture(1);
  try {
    const { stream, lease } = h.sources[0];
    await inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
      priority: "bootstrap",
      now: h.now,
      sourceDelayMs: 60_000,
      globalDelayMs: 0,
    })(endpoint);
    const second = await h.inventory.initialize(stream, "other", "other-query");
    await assert.rejects(
      inventoryVendorFetch(h.store, second, lease, h.fetcher, {
        priority: "bootstrap",
        now: h.now + 20_000,
      })(endpoint),
      (error) => unsent(error) && error.retryAt === h.now + 60_000,
    );
    assert.throws(
      () =>
        inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
          priority: "bootstrap",
          sourceDelayMs: Number.NaN,
        }),
      /invalid_inventory_pacing/,
    );
    assert.equal(h.sent(), 1);
  } finally {
    await h.mf.dispose();
  }
});

test("window rollover resets bootstrap once and old invocations cannot refill it", async () => {
  const h = await fixture();
  try {
    await h.read(0, h.now);
    const next = Math.floor(h.now / WINDOW) * WINDOW + WINDOW + 1000;
    await h.read(0, next);
    const current = await h.budget();
    assert.equal(current?.window_start, Math.floor(next / WINDOW) * WINDOW);
    assert.equal(current?.requests, 1);
    await assert.rejects(h.read(1, h.now + 5000), unsent);
    assert.deepEqual(await h.budget(), current);
    assert.deepEqual(
      await h.db.prepare("SELECT * FROM inventory_vendor_bootstrap").first(),
      { vendor: "lofi", window_start: current?.window_start, requests: 1 },
    );
    assert.equal(h.sent(), 2);
  } finally {
    await h.mf.dispose();
  }
});

test("a five-minute boundary does not reset global inventory pacing", async () => {
  const h = await fixture();
  try {
    const before = Math.floor(h.now / WINDOW) * WINDOW + WINDOW - 2000;
    await h.read(0, before);
    await assert.rejects(
      h.read(1, before + 3000),
      (error) => unsent(error) && error.retryAt === before + 5000,
    );
    assert.equal((await h.budget())?.requests, 1);
    assert.equal((await h.budget())?.window_start, before - (WINDOW - 2000));
    await h.read(1, before + 5000);
    assert.equal((await h.budget())?.requests, 1);
    assert.equal((await h.budget())?.window_start, before + 2000);
    assert.equal(h.sent(), 2);
  } finally {
    await h.mf.dispose();
  }
});

test("guarded page publication can extend source pacing without changing request time", async () => {
  const h = await fixture(1);
  try {
    const { stream } = h.sources[0];
    await h.read(0, h.now);
    await inventorySourcePacingStatement(
      h.store,
      stream,
      h.now - 1000,
      35_000,
    ).run();
    assert.equal(
      await h.db
        .prepare(
          "SELECT next_allowed_at FROM inventory_read_pacing WHERE tenant=? AND source=?",
        )
        .bind(stream.tenant, stream.connection)
        .first<number>("next_allowed_at"),
      h.now + 35_000,
    );
    await inventorySourcePacingStatement(h.store, stream, h.now, 300_000).run();
    await inventorySourcePacingStatement(h.store, stream, h.now, 1).run();
    assert.deepEqual(
      await h.db
        .prepare(
          "SELECT last_requested_at,next_allowed_at FROM inventory_read_pacing WHERE tenant=? AND source=?",
        )
        .bind(stream.tenant, stream.connection)
        .first(),
      { last_requested_at: h.now, next_allowed_at: h.now + 300_000 },
    );
    await assert.rejects(
      h.read(0, h.now + 20_000),
      (error) => unsent(error) && error.retryAt === h.now + 300_000,
    );
    assert.equal((await h.budget())?.requests, 1);
    assert.equal(h.sent(), 1);
  } finally {
    await h.mf.dispose();
  }
});

test("inventory background retains its four-request cap and all renewal/status reads are counted", async () => {
  const h = await fixture();
  try {
    for (let index = 0; index < 4; index++)
      await h.read(index, h.now + index * 5000, "background");
    await assert.rejects(h.read(0, h.now + 20_000, "background"), unsent);
    assert.equal((await h.budget())?.background_requests, 4);
    assert.equal(
      await h.db
        .prepare("SELECT count(*) n FROM inventory_vendor_bootstrap")
        .first<number>("n"),
      0,
    );
    const { stream, lease } = h.sources[0];
    let clock = h.now + 20_000;
    const request = inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
      priority: "bootstrap",
      now: () => clock,
    });
    await request("https://lofi.ham2k.net/v1/client", { method: "POST" });
    await assert.rejects(request(endpoint), unsent);
    clock += 20_000;
    await request(endpoint);
    clock += 20_000;
    await request("https://lofi.ham2k.net/v1/sync", { method: "POST" });
    assert.equal(h.sent(), 7);
    assert.equal((await h.budget())?.requests, 7);
  } finally {
    await h.mf.dispose();
  }
});

test("native authority races reject requests before quota, pacing or transport", async (t) => {
  const mutations = [
    "UPDATE accounts SET status='locked'",
    "UPDATE connections SET status='disabled' WHERE id='source'",
    "UPDATE connections SET credential_version='v2' WHERE id='source'",
    "UPDATE private_data SET revoked_at=1 WHERE connection='source'",
    "UPDATE private_data SET expires_at=1 WHERE connection='source'",
    "UPDATE connections SET config='{} ' WHERE id='source'",
    "UPDATE connections SET remote_identity='other' WHERE id='source'",
    "UPDATE inventory_scopes SET state='held'",
    "UPDATE inventory_scopes SET config_version=config_version+1",
    "UPDATE inventory_scopes SET accepted_sequence=accepted_sequence+1",
    "UPDATE inventory_streams SET checkpoint_version=checkpoint_version+1",
    "UPDATE inventory_streams SET query_binding='other',checkpoint_version=1",
    "UPDATE leases SET fence=fence+1",
    "UPDATE leases SET expires_at=0",
  ];
  for (const mutation of mutations)
    await t.test(mutation, async () => {
      const h = await fixture(1);
      try {
        await h.db.prepare(mutation).run();
        await assert.rejects(
          h.read(0, h.now),
          (error) =>
            error instanceof InventoryVendorAdmissionError &&
            error.code === "inventory_authority_changed",
        );
        assert.equal(h.sent(), 0);
        for (const table of [
          "vendor_requests",
          "inventory_vendor_bootstrap",
          "inventory_read_pacing",
          "inventory_request_guards",
        ])
          assert.equal(
            await h.db
              .prepare(`SELECT count(*) n FROM ${table}`)
              .first<number>("n"),
            0,
            table,
          );
      } finally {
        await h.mf.dispose();
      }
    });
});

test("Retry-After persists through vendorFetch and denied cooldown attempts consume nothing", async () => {
  const h = await fixture();
  try {
    const { stream, lease } = h.sources[0];
    await assert.rejects(
      inventoryVendorFetch(
        h.store,
        stream,
        lease,
        async () =>
          new Response("limited", {
            status: 429,
            headers: { "Retry-After": "30" },
          }),
        { priority: "bootstrap", now: h.now },
      )(endpoint),
      (error) =>
        error instanceof VendorDeferredError &&
        error.requestSent &&
        error.retryAt === h.now + 30_000,
    );
    await assert.rejects(
      h.read(1, h.now + 20_000),
      (error) => unsent(error) && error.retryAt === h.now + 30_000,
    );
    assert.equal((await h.budget())?.requests, 1);
    assert.equal((await h.budget())?.cooldown_until, h.now + 30_000);
    await h.read(1, h.now + 30_000);
    assert.equal((await h.budget())?.requests, 2);
    assert.equal(h.sent(), 1);
  } finally {
    await h.mf.dispose();
  }
});

test("a late native error rolls all reservation and pacing changes back", async () => {
  const h = await fixture(1);
  try {
    await h.db
      .prepare(
        "CREATE TRIGGER reject_admission_tail BEFORE DELETE ON inventory_request_guards BEGIN SELECT RAISE(ABORT,'tail rejected'); END",
      )
      .run();
    await assert.rejects(h.read(0, h.now), /tail rejected/);
    assert.equal(h.sent(), 0);
    assert.equal(await h.budget(), null);
    assert.equal(
      await h.db
        .prepare("SELECT count(*) n FROM inventory_read_pacing")
        .first<number>("n"),
      0,
    );
    assert.equal(
      await h.db
        .prepare("SELECT count(*) n FROM inventory_vendor_bootstrap")
        .first<number>("n"),
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("503 cooldowns survive window boundaries without speculative quota consumption", async () => {
  const h = await fixture();
  try {
    const { stream, lease } = h.sources[0];
    const before = Math.floor(h.now / WINDOW) * WINDOW + WINDOW - 10_000;
    const response = await inventoryVendorFetch(
      h.store,
      stream,
      lease,
      async () =>
        new Response("maintenance", {
          status: 503,
          headers: { "Retry-After": "30" },
        }),
      { priority: "bootstrap", now: before },
    )(endpoint);
    assert.equal(response.status, 503);
    await assert.rejects(
      h.read(1, before + 25_000),
      (error) => unsent(error) && error.retryAt === before + 30_000,
    );
    assert.equal((await h.budget())?.requests, 1);
    assert.equal((await h.budget())?.window_start, before - (WINDOW - 10_000));
    await h.read(1, before + 30_000);
    assert.equal((await h.budget())?.requests, 1);
    assert.equal((await h.budget())?.window_start, before + 10_000);
    assert.equal(h.sent(), 1);
  } finally {
    await h.mf.dispose();
  }
});

test("a slow response starts Retry-After at response time without another reservation", async () => {
  const h = await fixture(1);
  try {
    const { stream, lease } = h.sources[0];
    let clock = h.now;
    await assert.rejects(
      inventoryVendorFetch(
        h.store,
        stream,
        lease,
        async () => {
          clock += 30_000;
          return new Response("limited", {
            status: 429,
            headers: { "Retry-After": "60" },
          });
        },
        { priority: "bootstrap", now: () => clock },
      )(endpoint),
      (error) =>
        error instanceof VendorDeferredError &&
        error.requestSent &&
        error.retryAt === h.now + 90_000,
    );
    assert.equal((await h.budget())?.requests, 1);
    assert.equal((await h.budget())?.cooldown_until, h.now + 90_000);
  } finally {
    await h.mf.dispose();
  }
});

test("additional native guards and cleanup compose with quota and pacing for every request", async () => {
  const h = await fixture(1);
  try {
    await h.db
      .prepare(
        "CREATE TABLE test_read_guard(id TEXT PRIMARY KEY,allowed INTEGER NOT NULL CHECK(allowed=1))",
      )
      .run();
    const { stream, lease } = h.sources[0];
    let calls = 0;
    let clock = h.now;
    const request = inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
      priority: "bootstrap",
      now: () => clock,
      guard: () => {
        const id = String(++calls);
        return {
          before: [
            h.store.statement("INSERT INTO test_read_guard VALUES(?,1)", id),
          ],
          after: [
            h.store.statement("DELETE FROM test_read_guard WHERE id=?", id),
          ],
        };
      },
    });
    await request(endpoint);
    clock += 20_000;
    await request(endpoint);
    assert.equal(calls, 2);
    assert.equal(h.sent(), 2);
    assert.equal((await h.budget())?.requests, 2);
    assert.equal(
      await h.db
        .prepare("SELECT count(*) n FROM test_read_guard")
        .first<number>("n"),
      0,
    );
    assert.equal(
      await h.db
        .prepare("SELECT count(*) n FROM inventory_request_guards")
        .first<number>("n"),
      0,
    );
    assert.equal(
      (await h.inventory.snapshot(stream.tenant, stream.scope, stream.stream))
        ?.version,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("a native run guard checks state after capture and rolls quota and pacing back on failure", async (t) => {
  for (const phase of ["before", "after"] as const)
    await t.test(phase, async () => {
      const h = await fixture(1);
      try {
        await h.db
          .prepare(
            "CREATE TABLE test_read_guard(id TEXT PRIMARY KEY,allowed INTEGER NOT NULL CHECK(allowed=1))",
          )
          .run();
        await h.db
          .prepare("CREATE TABLE test_run_state(allowed INTEGER NOT NULL)")
          .run();
        await h.db.prepare("INSERT INTO test_run_state VALUES(1)").run();
        const { stream, lease } = h.sources[0];
        const request = inventoryVendorFetch(
          h.store,
          stream,
          lease,
          h.fetcher,
          {
            priority: "bootstrap",
            now: h.now,
            guard: () => ({
              before: [
                phase === "before"
                  ? h.store.statement(
                      "INSERT INTO test_read_guard SELECT 'run',allowed FROM test_run_state",
                    )
                  : h.store.statement(
                      "INSERT INTO test_read_guard VALUES('run',1)",
                    ),
              ],
              after: [
                ...(phase === "after"
                  ? [
                      h.store.statement(
                        "UPDATE test_read_guard SET allowed=(SELECT allowed FROM test_run_state)",
                      ),
                    ]
                  : []),
                h.store.statement("DELETE FROM test_read_guard WHERE id='run'"),
              ],
            }),
          },
        );
        await h.db.prepare("UPDATE test_run_state SET allowed=0").run();
        await assert.rejects(request(endpoint), /CHECK constraint failed/);
        assert.equal(h.sent(), 0);
        assert.equal(await h.budget(), null);
        for (const table of [
          "inventory_vendor_bootstrap",
          "inventory_read_pacing",
          "inventory_request_guards",
          "test_read_guard",
        ])
          assert.equal(
            await h.db
              .prepare(`SELECT count(*) n FROM ${table}`)
              .first<number>("n"),
            0,
            table,
          );
      } finally {
        await h.mf.dispose();
      }
    });
});

test("a guard callback failure performs no reservation or transport", async () => {
  const h = await fixture(1);
  try {
    const { stream, lease } = h.sources[0];
    const failure = new Error("read guard unavailable");
    const request = inventoryVendorFetch(h.store, stream, lease, h.fetcher, {
      priority: "bootstrap",
      now: h.now,
      guard: () => {
        throw failure;
      },
    });
    await assert.rejects(request(endpoint), (error) => error === failure);
    assert.equal(h.sent(), 0);
    assert.equal(await h.budget(), null);
    for (const table of [
      "inventory_vendor_bootstrap",
      "inventory_read_pacing",
      "inventory_request_guards",
    ])
      assert.equal(
        await h.db
          .prepare(`SELECT count(*) n FROM ${table}`)
          .first<number>("n"),
        0,
      );
  } finally {
    await h.mf.dispose();
  }
});
