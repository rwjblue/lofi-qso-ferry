import assert from "node:assert/strict";
import test from "node:test";
import type { VendorPolicy } from "../src/vendor-requests.ts";
import {
  VENDOR_POLICIES,
  VendorDeferredError,
  vendorFetch,
  vendorRequestsAvailable,
} from "../src/vendor-requests.ts";
import { database } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const endpoint = "https://vendor.example.test/records";
const policy: VendorPolicy = { windowMs: 1000, total: 5, background: 2 };

async function fixture() {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    return h;
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("overlapping wrappers share atomic vendor budgets and reserve capacity for live reads and uploads", async () => {
  const h = await fixture();
  try {
    const sent: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      sent.push(init?.method ?? "GET");
      return new Response("ok");
    };
    const background = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        vendorFetch(h.store, "qrz", fetcher, {
          priority: "background",
          now: 100,
          policy,
        })(endpoint),
      ),
    );
    assert.equal(background.filter((r) => r.status === "fulfilled").length, 2);
    for (const result of background) {
      if (result.status !== "rejected") continue;
      assert(result.reason instanceof VendorDeferredError);
      assert.equal(result.reason.retryAt, 1000);
      assert.equal(result.reason.requestSent, false);
    }
    const live = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        vendorFetch(h.store, "qrz", fetcher, { now: 100, policy })(endpoint, {
          method: "POST",
          body: "contact",
        }),
      ),
    );
    assert.equal(live.filter((r) => r.status === "fulfilled").length, 3);
    assert.deepEqual(sent.sort(), ["GET", "GET", "POST", "POST", "POST"]);
    assert.deepEqual(
      await h.store
        .statement(
          "SELECT requests,background_requests FROM vendor_requests WHERE vendor='qrz'",
        )
        .first(),
      { requests: 5, background_requests: 2 },
    );
    await vendorFetch(h.store, "lotw", fetcher, { now: 100, policy })(endpoint);
    assert.equal(sent.length, 6);
  } finally {
    await h.mf.dispose();
  }
});

test("availability hints honor priority, cooldown and rollover without reserving or bypassing quota", async () => {
  const h = await fixture();
  try {
    assert(await vendorRequestsAvailable(h.store, "qrz", "background", 100));
    assert.equal(
      await h.store
        .statement("SELECT count(*) n FROM vendor_requests")
        .first<number>("n"),
      0,
    );
    assert.deepEqual(VENDOR_POLICIES.lofi, {
      windowMs: 300_000,
      total: 24,
      background: 4,
    });
    for (const vendor of ["qrz", "lotw"] as const) {
      assert.deepEqual(VENDOR_POLICIES[vendor], {
        windowMs: 60_000,
        total: 60,
        background: 60,
      });
      // A persisted five-minute window begins on a minute boundary. Preserve
      // its count for that first minute and preserve cooldown across rollover.
      await h.store
        .statement(
          "INSERT INTO vendor_requests VALUES(?,300000,59,59,0)",
          vendor,
        )
        .run();
      await vendorFetch(h.store, vendor, async () => new Response("ok"), {
        priority: "background",
        now: 300_100,
      })(endpoint);
      assert.equal(
        await vendorRequestsAvailable(h.store, vendor, "live", 300_100),
        false,
      );
      assert.equal(
        await vendorRequestsAvailable(h.store, vendor, "background", 300_100),
        false,
      );
      await assert.rejects(
        vendorFetch(
          h.store,
          vendor,
          async () => assert.fail("Exhausted quota reached transport"),
          {
            priority: "background",
            now: 300_100,
          },
        )(endpoint),
        (error) =>
          error instanceof VendorDeferredError && error.retryAt === 360_000,
      );
      await h.store
        .statement(
          "UPDATE vendor_requests SET cooldown_until=410000 WHERE vendor=?",
          vendor,
        )
        .run();
      assert.equal(
        await vendorRequestsAvailable(h.store, vendor, "live", 360_000),
        false,
      );
      assert(
        await vendorRequestsAvailable(h.store, vendor, "background", 410_000),
      );
      await vendorFetch(h.store, vendor, async () => new Response("ok"), {
        priority: "background",
        now: 410_000,
      })(endpoint);
      assert.deepEqual(
        await h.store
          .statement(
            "SELECT window_start,requests,background_requests FROM vendor_requests WHERE vendor=?",
            vendor,
          )
          .first(),
        { window_start: 360_000, requests: 1, background_requests: 1 },
      );
    }
  } finally {
    await h.mf.dispose();
  }
});

test("window rollover refills limits without allowing stale invocations to refill again", async () => {
  const h = await fixture();
  try {
    let sent = 0;
    const fetcher: typeof fetch = async () => {
      sent++;
      return new Response("ok");
    };
    const one = { windowMs: 1000, total: 1, background: 1 };
    await vendorFetch(h.store, "lofi", fetcher, { now: 100, policy: one })(
      endpoint,
    );
    await vendorFetch(h.store, "lofi", fetcher, { now: 1000, policy: one })(
      endpoint,
    );
    await assert.rejects(
      vendorFetch(h.store, "lofi", fetcher, { now: 101, policy: one })(
        endpoint,
      ),
      (error) => error instanceof VendorDeferredError && error.retryAt === 2000,
    );
    assert.equal(sent, 2);
  } finally {
    await h.mf.dispose();
  }
});

test("429 persists numeric and HTTP-date Retry-After, with safe fallback and minimum delays", async () => {
  const h = await fixture();
  try {
    const now = Date.parse("2026-10-22T10:00:00Z");
    const cases: [string | null, number][] = [
      ["15", now + 15_000],
      [new Date(now + 30_000).toUTCString(), now + 30_000],
      ["0", now + 1000],
      [new Date(now - 30_000).toUTCString(), now + 1000],
      [null, now + 300_000],
      ["garbage", now + 300_000],
      ["1.5", now + 300_000],
      ["9999999999999999999999999999999", now + 300_000],
    ];
    for (const [header, expected] of cases) {
      await h.store.statement("DELETE FROM vendor_requests").run();
      const response = new Response("rate limited", {
        status: 429,
        headers: header === null ? {} : { "Retry-After": header },
      });
      let sent = 0;
      const fetcher: typeof fetch = async () => {
        sent++;
        return response;
      };
      await assert.rejects(
        vendorFetch(h.store, "qrz", fetcher, { now })(endpoint),
        (error) =>
          error instanceof VendorDeferredError &&
          error.requestSent &&
          error.retryAt === expected,
      );
      assert.equal(response.bodyUsed, true);
      await assert.rejects(
        vendorFetch(h.store, "qrz", fetcher, { now: now + 1 })(endpoint),
        (error) =>
          error instanceof VendorDeferredError &&
          !error.requestSent &&
          error.retryAt === expected,
      );
      assert.equal(sent, 1);
    }
  } finally {
    await h.mf.dispose();
  }
});

test("cooldowns survive window resets and both live and background wrappers", async () => {
  const h = await fixture();
  try {
    const response: typeof fetch = async () =>
      new Response("throttled", {
        status: 429,
        headers: { "Retry-After": "2" },
      });
    await assert.rejects(
      vendorFetch(h.store, "lofi", response, { now: 100, policy })(endpoint),
      VendorDeferredError,
    );
    let sent = 0;
    const fetcher: typeof fetch = async () => {
      sent++;
      return new Response("ok");
    };
    for (const priority of ["live", "background"] as const)
      await assert.rejects(
        vendorFetch(h.store, "lofi", fetcher, {
          priority,
          now: 1100,
          policy,
        })(endpoint),
        (error) =>
          error instanceof VendorDeferredError && error.retryAt === 2100,
      );
    assert.equal(sent, 0);
    await vendorFetch(h.store, "lofi", fetcher, { now: 2100, policy })(
      endpoint,
    );
    assert.equal(sent, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("503 honors Retry-After without hiding the response or replaying the request", async () => {
  const h = await fixture();
  try {
    const now = Date.parse("2026-10-22T10:00:00Z");
    const response = new Response("server unavailable", {
      status: 503,
      headers: { "Retry-After": new Date(now + 600_000).toUTCString() },
    });
    let sent = 0;
    const fetcher: typeof fetch = async () => {
      sent++;
      return response;
    };
    assert.equal(
      await vendorFetch(h.store, "lotw", fetcher, { now })(endpoint, {
        method: "POST",
      }),
      response,
    );
    assert.equal(await response.text(), "server unavailable");
    await assert.rejects(
      vendorFetch(h.store, "lotw", fetcher, { now: now + 300_000 })(endpoint),
      (error) =>
        error instanceof VendorDeferredError && error.retryAt === now + 600_000,
    );
    assert.equal(sent, 1);
    const noHeader = new Response("unavailable", { status: 503 });
    assert.equal(
      await vendorFetch(h.store, "qrz", async () => noHeader, { now })(
        endpoint,
      ),
      noHeader,
    );
    await vendorFetch(h.store, "qrz", async () => new Response("ok"), { now })(
      endpoint,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("concurrent throttle responses only extend the persisted cooldown", async () => {
  const h = await fixture();
  try {
    const now = 100;
    // Ensure both requests reserve capacity before either response is handled.
    const short = Promise.withResolvers<Response>();
    const holdLong = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    let sent = 0;
    const waitForResponse = async (response: Promise<Response>) => {
      if (++sent === 2) started.resolve();
      return response;
    };
    const longRequest = vendorFetch(
      h.store,
      "qrz",
      async () => waitForResponse(holdLong.promise),
      { now, policy },
    )(endpoint);
    const shortRequest = vendorFetch(
      h.store,
      "qrz",
      async () => waitForResponse(short.promise),
      { now, policy },
    )(endpoint);
    const guarded = Promise.allSettled([longRequest, shortRequest]);
    await started.promise;
    holdLong.resolve(
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "3600" },
      }),
    );
    await assert.rejects(longRequest, VendorDeferredError);
    short.resolve(
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "1" },
      }),
    );
    const results = await guarded;
    assert(results.every((result) => result.status === "rejected"));
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT cooldown_until FROM vendor_requests WHERE vendor='qrz'",
          )
          .first<{ cooldown_until: number }>()
      )?.cooldown_until,
      now + 3_600_000,
    );
    assert.equal(
      await h.store
        .statement("SELECT vendor FROM vendor_requests WHERE vendor='lotw'")
        .first(),
      null,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("failed network requests consume their reserved slot", async () => {
  const h = await fixture();
  try {
    const one = { windowMs: 1000, total: 1, background: 0 };
    let sent = 0;
    const failure = new Error("network failure");
    const fetcher: typeof fetch = async () => {
      sent++;
      throw failure;
    };
    await assert.rejects(
      vendorFetch(h.store, "qrz", fetcher, { now: 100, policy: one })(endpoint),
      failure,
    );
    await assert.rejects(
      vendorFetch(h.store, "qrz", fetcher, { now: 100, policy: one })(endpoint),
      VendorDeferredError,
    );
    await assert.rejects(
      vendorFetch(h.store, "lofi", fetcher, {
        now: 100,
        priority: "background",
        policy: one,
      })(endpoint),
      VendorDeferredError,
    );
    assert.equal(sent, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("guarded admission reserves the native slot once and cannot bypass exhaustion", async (t) => {
  const h = await fixture();
  t.after(() => h.mf.dispose());
  let sent = 0;
  let admissions = 0;
  const fetcher = vendorFetch(
    h.store,
    "qrz",
    async () => {
      sent++;
      return new Response("ok");
    },
    {
      now: 100,
      policy: { windowMs: 1000, total: 1, background: 0 },
      admit: async (reservation) => {
        admissions++;
        const results = await h.store.db.batch<{
          window_start: number;
          cooldown_until: number;
        }>([h.store.statement("SELECT 1 current"), reservation]);
        return results[1].results[0] ?? null;
      },
    },
  );
  await fetcher(endpoint);
  await assert.rejects(fetcher(endpoint), VendorDeferredError);
  assert.equal(sent, 1);
  assert.equal(admissions, 2);
  assert.equal(
    await h.store
      .statement("SELECT requests n FROM vendor_requests WHERE vendor='qrz'")
      .first("n"),
    1,
  );
});
