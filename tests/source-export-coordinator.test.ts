import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { pollSource, rereadOperation } from "../src/intake.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { ensureSourceExportProofs } from "../src/source-export-coordinator.ts";
import { loadCurrentSourceExportProof } from "../src/source-export-proofs.ts";
import type { SourcePresenceScope } from "../src/source-presence-store.ts";
import { sourceReadPolicy } from "../src/source-read-policy.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

async function fixture(
  t: TestContext,
  options: { count?: number; baselineAgeMs?: number; stampStep?: number } = {},
) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET credential_version='source-key',config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "source-key", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    })
  ).run();
  const source = await h.store.connection("a", "source");
  const destination = await h.store.connection("a", "destination");
  assert(source && destination);
  const operations: SourceRecord[] = [
    { uuid: "op", stationCall: "N0CALL", grid: "FN31AA", syncedAtMillis: 99 },
  ];
  const qsos: SourceRecord[] = Array.from(
    { length: options.count ?? 20 },
    (_, i) => ({
      uuid: `q${i}`,
      operation: "op",
      syncedAtMillis: 100 + i * (options.stampStep ?? 1),
      startAtMillis: 1_792_684_800_000 + i * 1000,
      band: "20m",
      mode: "FT8",
      freq: 14074,
      their: { call: "W1AW" },
      our: { dxccCode: 291 },
    }),
  );
  const requests: { forward: boolean; allClients: boolean; until?: number }[] =
    [];
  const network: string[] = [];
  let intercept:
    | ((url: string, init?: RequestInit) => Promise<Response | null>)
    | null = null;
  let injectEvent = false;
  const rawFetcher: typeof fetch = async (url, init) => {
    network.push(new URL(String(url)).pathname);
    const overridden = await intercept?.(String(url), init);
    if (overridden) return overridden;
    if (String(url).startsWith("https://lofi.ham2k.net/v1/operations/op/qsos"))
      return Response.json({ qsos, meta: { qsos: { records_left: 0 } } });
    assert.equal(url, "https://lofi.ham2k.net/v1/sync");
    const sync = JSON.parse(String(init?.body)).meta.sync;
    const forward = typeof sync.qsos.syncedSinceMillis === "number";
    requests.push({
      forward,
      ...(forward ? {} : { until: sync.qsos.syncedUntilMillis }),
      allClients:
        sync.qsos.anyClient === true && sync.operations.anyClient === true,
    });
    if (forward && injectEvent) {
      injectEvent = false;
      qsos.push({
        uuid: "new-event",
        operation: "op",
        band: "event",
        syncedAtMillis: Date.now(),
        startAtMillis: 1_792_684_799_000,
        event: {},
      });
    }
    const select = (
      rows: SourceRecord[],
      side: {
        syncedSinceMillis?: number;
        syncedUntilMillis?: number;
        limit: number;
      },
    ) =>
      rows
        .filter((row) =>
          side.syncedSinceMillis === undefined
            ? Number(row.syncedAtMillis) < Number(side.syncedUntilMillis)
            : Number(row.syncedAtMillis) > side.syncedSinceMillis,
        )
        .sort(
          (a, b) =>
            (forward ? 1 : -1) *
            (Number(a.syncedAtMillis) - Number(b.syncedAtMillis)),
        )
        .slice(0, side.limit);
    return Response.json({
      account: { uuid: "source" },
      operations: select(operations, sync.operations),
      qsos: select(qsos, sync.qsos),
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    });
  };
  const baselineAt = Date.now() - (options.baselineAgeMs ?? 0);
  for (let i = 0; i < 3; i++)
    await pollSource(h.store, source, rawFetcher, baselineAt + i, "sync", null);
  await rereadOperation(
    h.store,
    source,
    rawFetcher,
    baselineAt + 3,
    "background",
    null,
  );
  const policy = await sourceReadPolicy(h.store, "a", "source");
  assert.equal(policy?.phase, "ready");
  assert(policy);
  const scope: SourcePresenceScope = {
    tenant: "a",
    source: "source",
    accountId: "source",
    readerPolicy: "all-clients-v1",
    policyEpoch: policy.epoch,
    credentialVersion: "source-key",
  };
  const clearPresence = () =>
    h.store
      .statement(
        "UPDATE source_work SET positive_observed_at=NULL,positive_policy_epoch=NULL,positive_credential_version=NULL",
      )
      .run();
  const proofCount = async () =>
    (await h.store
      .statement("SELECT count(*) AS n FROM source_export_proofs")
      .first<{ n: number }>())!.n;
  const cursor = async () =>
    JSON.parse(
      (await h.store
        .statement(
          "SELECT cursor FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
        )
        .first<{ cursor: string }>())!.cursor,
    ) as { completeReadStartedAt?: number; qsos: { cursor?: string } };
  const run = async (ids = ["q0"], remainingRequests = 4) => {
    await h.store.statement("DELETE FROM vendor_requests").run();
    const lease = await h.store.claim("a", "cycle:source", Date.now(), 120_000);
    assert(lease);
    try {
      return await ensureSourceExportProofs(h.store, scope, ids, lease, {
        rawFetcher,
        deadline: Date.now() + 90_000,
        remainingRequests,
        routedDestinations: () => [destination],
      });
    } finally {
      await h.store.release(lease);
    }
  };
  return {
    ...h,
    source,
    destination,
    scope,
    qsos,
    requests,
    network,
    rawFetcher,
    clearPresence,
    proofCount,
    cursor,
    run,
    injectEvent: () => {
      injectEvent = true;
    },
    intercept: (handler: typeof intercept) => {
      intercept = handler;
    },
  };
}

test("twenty contacts share positive collection and one canonical drain without destination I/O", async (t) => {
  const h = await fixture(t);
  const { destination, scope, qsos, requests, rawFetcher } = h;
  await h.clearPresence();
  await h.store.statement("DELETE FROM vendor_requests").run();
  const lease = await h.store.claim("a", "cycle:source", Date.now(), 120_000);
  assert(lease);
  const before = requests.length;
  const result = await ensureSourceExportProofs(
    h.store,
    scope,
    qsos.map((row) => String(row.uuid)),
    lease,
    {
      rawFetcher,
      deadline: Date.now() + 90_000,
      remainingRequests: 4,
      routedDestinations: () => [destination],
    },
  );
  assert.equal(result.held, null);
  assert.equal(result.ready.length, 20);
  assert.equal(result.actualAttempts, 2);
  assert.equal(requests.length - before, 2);
  assert.deepEqual(
    requests
      .slice(before)
      .map(({ forward, allClients }) => ({ forward, allClients })),
    [
      { forward: false, allClients: true },
      { forward: true, allClients: true },
    ],
  );
  assert.equal(result.sourceBoundaryVerified, false);
  assert.equal(result.writesAuthorized, false);
  const first = result.ready[0];
  assert(first);
  const reconciliationVersion = (
    first.contact as { reconciliationVersion: number }
  ).reconciliationVersion;
  assert(
    await loadCurrentSourceExportProof(
      h.store,
      scope,
      first.proofId,
      {
        qso: first.contact.id,
        generation: first.contact.generation,
        reconciliationVersion,
      },
      Date.now(),
    ),
  );
  assert.equal(
    (
      await h.store
        .statement("SELECT count(*) AS n FROM attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await h.store
        .statement("SELECT count(*) AS n FROM source_cutovers")
        .first<{ n: number }>()
    )?.n,
    0,
  );

  // A previously unknown event delivered by the shared final read prevents all
  // new proofs, even though every requested old dependency was observed.
  h.injectEvent();
  const held = await ensureSourceExportProofs(h.store, scope, ["q0"], lease, {
    rawFetcher,
    deadline: Date.now() + 90_000,
    remainingRequests: 4,
    routedDestinations: () => [destination],
  });
  assert.equal(held.held, "drain_incomplete");
  assert.equal(held.ready.length, 0);
  assert.equal(
    (
      await h.store
        .statement("SELECT count(*) AS n FROM source_export_proofs")
        .first<{ n: number }>()
    )?.n,
    20,
  );
  assert.equal(
    await loadCurrentSourceExportProof(
      h.store,
      scope,
      first.proofId,
      {
        qso: first.contact.id,
        generation: first.contact.generation,
        reconciliationVersion,
      },
      Date.now(),
    ),
    null,
  );
});

test("collection and final-drain authentication share one actual request cap", async (t) => {
  const h = await fixture(t, { count: 1 });
  for (const cap of [3, 4]) {
    await h.clearPresence();
    let challenged = false;
    let registered = false;
    const renewed = `renewed-${cap}`;
    h.intercept(async (url, init) => {
      if (url.endsWith("/v1/client")) {
        registered = true;
        return Response.json({ token: renewed });
      }
      const sync = JSON.parse(String(init?.body)).meta.sync;
      if (sync.qsos.syncedSinceMillis === undefined) return null;
      if (!challenged) {
        challenged = true;
        return new Response(null, { status: 401 });
      }
      assert(registered);
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${renewed}`,
      );
      return null;
    });
    const before = h.network.length;
    const result = await h.run(["q0"], cap);
    assert.equal(result.actualAttempts, cap);
    assert.equal(result.remainingRequests, 0);
    assert.deepEqual(
      h.network.slice(before),
      cap === 3
        ? ["/v1/sync", "/v1/sync", "/v1/client"]
        : ["/v1/sync", "/v1/sync", "/v1/client", "/v1/sync"],
    );
    assert(challenged && registered);
    assert.equal(result.held, cap === 3 ? "request_budget" : null);
    assert.equal(result.ready.length, cap === 3 ? 0 : 1);
    assert.equal(await h.proofCount(), cap === 3 ? 0 : 1);
    assert.equal(
      (
        await h.store.private<{ token: string }>(
          "a",
          "source",
          "source-key",
          "credential",
        )
      )?.token,
      renewed,
      "a renewed bearer persists even when the final retry exceeds the cap",
    );
  }
});

test("expired cached positives cannot skip collection or mint a proof with only a drain slot", async (t) => {
  const h = await fixture(t, { count: 1, baselineAgeMs: 600_000 });
  const prior = await h.store
    .statement(
      "SELECT count(*) AS n,MAX(positive_observed_at) AS newest FROM source_work WHERE positive_observed_at IS NOT NULL",
    )
    .first<{ n: number; newest: number }>();
  assert.equal(prior?.n, 2);
  assert(prior && Date.now() - prior.newest > 300_000);
  const before = h.network.length;
  const result = await h.run(["q0"], 1);
  assert.equal(result.held, "request_budget");
  assert.equal(result.actualAttempts, 0);
  assert.equal(result.remainingRequests, 1);
  assert.equal(h.network.length, before);
  assert.equal(result.ready.length, 0);
  assert.equal(await h.proofCount(), 0);
  assert.equal(
    (await h.cursor()).completeReadStartedAt! < Date.now() - 300_000,
    true,
  );
});

test("partial and terminal continuation drains cannot mint proofs before a fresh complete read", async (t) => {
  const h = await fixture(t, { count: 1 });
  assert.equal(typeof (await h.cursor()).completeReadStartedAt, "number");
  let phase: "partial" | "terminal" | "fresh" = "partial";
  h.intercept(async (url, init) => {
    assert(url.endsWith("/v1/sync"));
    const sync = JSON.parse(String(init?.body)).meta.sync;
    assert.equal(typeof sync.qsos.syncedSinceMillis, "number");
    if (phase === "partial") {
      phase = "terminal";
      const neighbor = {
        ...h.qsos[0],
        uuid: "partial-neighbor",
        operation: null,
        syncedAtMillis: 101,
      };
      h.qsos.push(neighbor);
      return Response.json({
        account: { uuid: "source" },
        operations: [],
        qsos: [neighbor],
        meta: {
          operations: { records_left: 0 },
          qsos: { records_left: 1, next_cursor: "continuation" },
        },
      });
    }
    if (phase === "terminal") {
      assert.equal(sync.qsos.cursor, "continuation");
      phase = "fresh";
    } else assert.equal(sync.qsos.cursor, undefined);
    return null;
  });
  const first = await h.run(["q0"], 1);
  assert.equal(first.held, "drain_incomplete");
  assert.equal(
    first.actualAttempts,
    1,
    "fresh exact cached positives need only the final drain",
  );
  assert.equal(first.ready.length, 0);
  assert.equal((await h.cursor()).completeReadStartedAt, undefined);
  assert.equal((await h.cursor()).qsos.cursor, "continuation");
  assert.equal(await h.proofCount(), 0);
  const pending = await h.run(["q0"], 1);
  assert.equal(pending.held, "source_unavailable");
  assert.equal(
    pending.actualAttempts,
    0,
    "incomplete canonical context must recover before proof collection",
  );
  await h.store.statement("DELETE FROM vendor_requests").run();
  const terminal = await pollSource(
    h.store,
    h.source,
    h.rawFetcher,
    Date.now(),
    "sync",
    null,
  );
  assert.equal(terminal.complete, true);
  assert.equal((await h.cursor()).completeReadStartedAt, undefined);
  assert.equal(await h.proofCount(), 0);
  const fresh = await h.run(["q0"], 1);
  assert.equal(fresh.held, null);
  assert.equal(fresh.actualAttempts, 1);
  assert.equal(fresh.ready.length, 1);
  assert.equal(await h.proofCount(), 1);
  assert.equal(typeof (await h.cursor()).completeReadStartedAt, "number");
});

test("an actually observed sparse anchor finds an old target below a dense newer suffix", async (t) => {
  const h = await fixture(t, { count: 2, stampStep: 100 });
  await h.clearPresence();
  const target = h.qsos[0];
  const anchor = Number(h.qsos[1].syncedAtMillis);
  for (let i = 0; i < 50; i++)
    h.qsos.push({
      ...target,
      uuid: `newer-${i}`,
      operation: null,
      syncedAtMillis: 1000 + i,
    });
  const before = h.requests.length;
  const result = await h.run(["q0"]);
  assert.equal(result.held, null);
  assert.equal(result.ready.length, 1);
  assert.equal(result.actualAttempts, 2);
  const selected = h.requests.slice(before);
  assert.equal(selected.length, 2);
  assert.deepEqual(
    selected.map((request) => request.forward),
    [false, true],
  );
  assert.equal(
    selected[0].until,
    anchor,
    "seek below an actual greater server stamp, never target+1 arithmetic",
  );
  assert(selected.every((request) => request.allClients));
  assert.equal(await h.proofCount(), 1);
});
