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
  options: {
    count?: number;
    baselineAgeMs?: number;
    stampStep?: number;
    qsoTimeOffsetMs?: number;
  } = {},
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
      startAtMillis:
        1_792_684_800_000 + i * 1000 + (options.qsoTimeOffsetMs ?? 0),
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
  const run = async (ids = ["q0"], remainingRequests = 4, store = h.store) => {
    await h.store.statement("DELETE FROM vendor_requests").run();
    const lease = await h.store.claim("a", "cycle:source", Date.now(), 120_000);
    assert(lease);
    try {
      return await ensureSourceExportProofs(store, scope, ids, lease, {
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
    operations,
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

/** Real retained anchors position each requested QSO behind one separate page. */
function scatteredCollection(
  h: Awaited<ReturnType<typeof fixture>>,
  failure?: "read" | "event" | "partial_drain",
  onCollection?: (count: number) => void,
) {
  let collections = 0;
  const selected = h.qsos.filter((_, index) => index % 2 === 0);
  const rows = [
    ...h.qsos,
    ...selected.flatMap((qso) =>
      Array.from({ length: 24 }, (_, index) => ({
        ...qso,
        uuid: `${qso.uuid}-neighbor-${index}`,
        syncedAtMillis: Number(qso.syncedAtMillis) - index - 1,
      })),
    ),
  ];
  h.intercept(async (url, init) => {
    if (!url.endsWith("/v1/sync")) return null;
    const sync = JSON.parse(String(init?.body)).meta.sync;
    if (sync.qsos.syncedSinceMillis !== undefined) {
      if (failure !== "partial_drain") return null;
      return Response.json({
        account: { uuid: "source" },
        operations: [],
        qsos: [
          { ...h.qsos[0], uuid: "drain-neighbor", syncedAtMillis: Date.now() },
        ],
        meta: {
          operations: { records_left: 0 },
          qsos: { records_left: 1, next_cursor: "unfinished-drain" },
        },
      });
    }
    collections++;
    onCollection?.(collections);
    if (failure === "read" && collections === 3)
      throw new Error("Synthetic collection transport failure");
    const page = rows
      .filter((row) => Number(row.syncedAtMillis) < sync.qsos.syncedUntilMillis)
      .sort((a, b) => Number(b.syncedAtMillis) - Number(a.syncedAtMillis))
      .slice(0, 25);
    if (failure === "event" && collections === 3)
      page[1] = {
        ...page[1],
        uuid: "unknown-collection-event",
        band: "event",
        event: {},
      };
    return Response.json({
      account: { uuid: "source" },
      operations: h.operations,
      qsos: page,
      meta: {
        operations: { records_left: 0 },
        qsos: { records_left: 1, next_cursor: `scattered-${collections}` },
      },
    });
  });
  return selected.map((row) => String(row.uuid));
}

test("a request-limited cohort drains and proves only complete witnessed contacts, then makes progress on the remainder", async (t) => {
  const h = await fixture(t, { count: 12, stampStep: 50 });
  await h.clearPresence();
  const selected = scatteredCollection(h);
  const first = await h.run(selected);
  assert.equal(first.held, "request_budget");
  assert.equal(first.actualAttempts, 4);
  assert.equal(first.remainingRequests, 0);
  assert.deepEqual(first.ready.map(({ contact }) => contact.id).sort(), [
    "q10",
    "q6",
    "q8",
  ]);
  assert.equal(await h.proofCount(), 3);
  assert.equal(first.sourceBoundaryVerified, false);
  assert.equal(first.writesAuthorized, false);
  const rows = await h.store
    .statement("SELECT proof FROM source_export_proofs ORDER BY qso")
    .all<{ proof: string }>();
  for (const row of rows.results) {
    const proof = JSON.parse(row.proof);
    assert.equal(proof.dependencies.length, 2);
    assert.ok(proof.completeReadStartedAt >= proof.collectionFinishedAt);
    assert.ok(
      proof.dependencies.every(
        (dependency: { requestStartedAt: number }) =>
          dependency.requestStartedAt <= proof.collectionFinishedAt &&
          proof.expiresAt <= dependency.requestStartedAt + 300_000,
      ),
    );
  }
  const completed = new Set(first.ready.map(({ contact }) => contact.id));
  const remaining = selected.filter((id) => !completed.has(id));
  const second = await h.run(remaining);
  assert.equal(second.held, null);
  assert.equal(second.actualAttempts, 4);
  assert.deepEqual(
    second.ready.map(({ contact }) => contact.id).sort(),
    remaining.sort(),
  );
  assert.equal(await h.proofCount(), 6);
});

test("partial witnesses never publish proofs after read errors, unknown events or an incomplete final drain", async (t) => {
  for (const failure of [
    "read",
    "event",
    "partial_drain",
    "new_final_event",
  ] as const)
    await t.test(failure, async (t) => {
      const h = await fixture(t, { count: 12, stampStep: 50 });
      await h.clearPresence();
      const selected = scatteredCollection(
        h,
        failure === "new_final_event" ? undefined : failure,
      );
      if (failure === "new_final_event") h.injectEvent();
      const result = await h.run(selected);
      assert.equal(
        result.held,
        failure === "read"
          ? "read_failed"
          : failure === "event"
            ? "dependency_changed"
            : "drain_incomplete",
      );
      assert.deepEqual(result.ready, []);
      assert.equal(
        result.actualAttempts,
        failure === "read" || failure === "event" ? 3 : 4,
      );
      assert.equal(await h.proofCount(), 0);
    });
});

test("request-budget partial collection cannot reuse positives that expire before its reserved drain", async (t) => {
  const h = await fixture(t, { count: 12, stampStep: 50 });
  const oldest = await h.store
    .statement("SELECT MIN(positive_observed_at) AS oldest FROM source_work")
    .first<number>("oldest");
  assert.ok(oldest);
  let clock = oldest + 299_000;
  t.mock.method(Date, "now", () => clock);
  await h.store
    .statement(
      "UPDATE source_work SET positive_observed_at=NULL,positive_policy_epoch=NULL,positive_credential_version=NULL WHERE id IN('q0','q2','q4','q6')",
    )
    .run();
  const selected = scatteredCollection(h, undefined, (count) => {
    if (count === 3) clock += 2_000;
  });
  const result = await h.run(selected);
  assert.equal(result.held, "witness_expired");
  assert.equal(result.actualAttempts, 3);
  assert.equal(result.remainingRequests, 1);
  assert.deepEqual(result.ready, []);
  assert.equal(await h.proofCount(), 0);
});

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

test("window cap stays original through collection and final drain; elapsed cap publishes no proof", async (t) => {
  for (const crosses of [false, true])
    await t.test(
      crosses ? "expiry during collection" : "caller cannot renew in flight",
      async (t) => {
        const h = await fixture(t, { count: 1 });
        await h.clearPresence();
        await h.store.statement("DELETE FROM vendor_requests").run();
        const lease = await h.store.claim(
          "a",
          "cycle:source",
          Date.now(),
          120000,
        );
        assert(lease);
        let crossed = false;
        const cap = Date.now() + 30000;
        const options = {
          rawFetcher: h.rawFetcher,
          now: () => (crossed ? cap + 1 : Date.now()),
          deadline: Date.now() + 90000,
          expiresAtCap: cap,
          remainingRequests: 4,
          routedDestinations: () => [h.destination],
        };
        const before = h.network.length;
        h.intercept(async () => {
          options.expiresAtCap = cap + 60000;
          if (crosses) crossed = true;
          return null;
        });
        const result = await ensureSourceExportProofs(
          h.store,
          h.scope,
          ["q0"],
          lease,
          options,
        ).finally(() => h.store.release(lease));
        if (crosses) {
          assert(result.held);
          assert.equal(result.ready.length, 0);
          assert.equal(await h.proofCount(), 0);
          assert.equal(h.network.length - before, 1);
        } else {
          assert.equal(result.held, null);
          assert.equal(result.ready.length, 1);
          assert.equal(result.ready[0].expiresAt, cap);
          assert.equal(h.network.length - before, 2);
        }
        assert.equal(
          await h.store
            .statement("SELECT count(*) n FROM attempts")
            .first<number>("n"),
          0,
        );
      },
    );
});

test("proof diagnostics: native millisecond source time survives collection, drain and proof mint", async (t) => {
  const h = await fixture(t, { count: 1, qsoTimeOffsetMs: 123 });
  await h.clearPresence();
  const logged: unknown[] = [];
  t.mock.method(console, "error", (...values: unknown[]) =>
    logged.push(values),
  );
  const result = await h.run();
  assert.equal(result.held, null);
  assert.equal(result.ready.length, 1);
  assert.equal(result.actualAttempts, 2);
  assert.equal(result.ready[0].contact.startAtMillis, 1_792_684_800_123);
  assert.equal(await h.proofCount(), 1);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM attempts")
      .first<number>("count(*)"),
    0,
  );
  assert.deepEqual(logged, []);
});

test("proof diagnostics: slow native clock read keeps the generic hold and submits no proof", async (t) => {
  const h = await fixture(t, { count: 1 });
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) =>
    logged.push(values),
  );
  const statement = h.store.statement.bind(h.store);
  let reads = 0;
  t.mock.method(
    h.store,
    "statement",
    (sql: string, ...values: (string | number | null)[]) => {
      const prepared = statement(sql, ...values);
      if (sql.includes("AS database_now") && sql.includes("FROM leases")) {
        return {
          first: async () => {
            reads++;
            const row = await prepared.first();
            await new Promise((resolve) => setTimeout(resolve, 510));
            return row;
          },
        } as D1PreparedStatement;
      }
      return prepared;
    },
  );
  const result = await h.run();
  assert.equal(result.held, "proof_unavailable");
  assert.deepEqual(result.ready, []);
  assert.equal(reads, 1);
  assert.equal(await h.proofCount(), 0);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM attempts")
      .first<number>("count(*)"),
    0,
  );
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(String(logged[0][0])), {
    event: "ferry_source_export_failure",
    phase: "mint",
    failures: {
      "source_proof:none:source_export_proof_admission_deadline": {
        events: 1,
        affected: 1,
      },
    },
  });
});

test("proof diagnostics: failed and committed-ack-loss proof batches are never retried", async (t) => {
  for (const committed of [false, true])
    await t.test(String(committed), async (t) => {
      const h = await fixture(t, { count: 1 });
      const logged: unknown[][] = [];
      t.mock.method(console, "error", (...values: unknown[]) =>
        logged.push(values),
      );
      const statement = h.store.statement.bind(h.store);
      const proofInserts = new WeakSet<object>();
      t.mock.method(
        h.store,
        "statement",
        (sql: string, ...values: (string | number | null)[]) => {
          const prepared = statement(sql, ...values);
          if (sql.startsWith("INSERT INTO source_export_proofs("))
            proofInserts.add(prepared);
          return prepared;
        },
      );
      let submissions = 0;
      const store = new Proxy(h.store, {
        get(target, property, receiver) {
          if (property === "db")
            return new Proxy(target.db, {
              get(db, key, dbReceiver) {
                if (key === "batch")
                  return async (statements: D1PreparedStatement[]) => {
                    if (
                      !statements.some((statement) =>
                        proofInserts.has(statement),
                      )
                    )
                      return db.batch(statements);
                    submissions++;
                    if (committed) await db.batch(statements);
                    throw new Error(
                      "D1_ERROR: private SQL and credential-bearing detail",
                      {
                        cause: new Error(
                          "source_export_proof_admission_expired",
                        ),
                      },
                    );
                  };
                return Reflect.get(db, key, dbReceiver);
              },
            });
          return Reflect.get(target, property, receiver);
        },
      });
      const result = await h.run(["q0"], 4, store);
      assert.equal(result.held, "proof_unavailable");
      assert.deepEqual(result.ready, []);
      assert.equal(submissions, 1);
      assert.equal(await h.proofCount(), committed ? 1 : 0);
      assert.equal(
        await h.store
          .statement("SELECT count(*) FROM attempts")
          .first<number>("count(*)"),
        0,
      );
      assert.deepEqual(
        logged.map((args) => JSON.parse(String(args[0]))),
        [
          {
            event: "ferry_source_export_failure",
            phase: "mint",
            failures: { "source_proof:none:db_d1": { events: 1, affected: 1 } },
          },
        ],
      );
      assert.doesNotMatch(
        JSON.stringify(logged),
        /private|credential|expired|SELECT|INSERT/,
      );
    });
});

test("proof diagnostics: reporting failure cannot replace the original held result", async (t) => {
  const h = await fixture(t, { count: 1 });
  t.mock.method(console, "error", () => {
    throw new Error("synthetic logging unavailable");
  });
  const statement = h.store.statement.bind(h.store);
  t.mock.method(
    h.store,
    "statement",
    (sql: string, ...values: (string | number | null)[]) => {
      const prepared = statement(sql, ...values);
      if (sql.includes("SELECT 1 AS current FROM source_read_policy_ready")) {
        return new Proxy(prepared, {
          get(target, property, receiver) {
            if (property === "first")
              return async () => {
                throw new Error("private initial-scope read failure");
              };
            return Reflect.get(target, property, receiver);
          },
        });
      }
      return prepared;
    },
  );
  const result = await h.run();
  assert.equal(result.held, "proof_unavailable");
  assert.deepEqual(result.ready, []);
  assert.equal(result.actualAttempts, 0);
  assert.equal(await h.proofCount(), 0);
});
