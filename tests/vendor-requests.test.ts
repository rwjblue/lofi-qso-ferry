import assert from "node:assert/strict";
import test from "node:test";
import { VendorDeferredError, vendorFetch } from "../src/vendor-requests.ts";
import type { VendorPolicy } from "../src/vendor-requests.ts";
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
