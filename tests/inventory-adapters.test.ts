import assert from "node:assert/strict";
import test from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import {
  createLoFiInventoryAdapter,
  createLotwInventoryAdapter,
  createQrzInventoryAdapter,
  type InventoryReadContext,
  type LoFiInventoryRequest,
  type QrzInventoryRequest,
  type QrzInventoryResume,
} from "../src/inventory-adapters.ts";
import type { SourceRecord, SyncState } from "../src/lofi.ts";
import type { LotwQuery } from "../src/lotw.ts";
import type { QrzBook } from "../src/qrz.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const now = Date.parse("2026-11-07T14:00:00Z");
const binding = {
  scope: "scope-1",
  configVersion: 1,
  queryBinding: "query-v1",
};
const credentials = {
  key: "browser:synthetic",
  secret: "synthetic-secret",
  token: "synthetic-token",
};
const book: QrzBook = {
  bookId: "7",
  stationCallsign: "N1RWJ",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
};
const adif: AdifRecord = {
  APP_QRZLOG_LOGID: "1",
  STATION_CALLSIGN: "N1RWJ",
  CALL: "W1AW",
  QSO_DATE: "20261107",
  TIME_ON: "130500",
  BAND: "20m",
  MODE: "CW",
  QSL_RCVD: "N",
};
const query: LotwQuery = {
  startDate: "2026-11-01",
  endDate: "2026-11-14",
  stationCallsign: "N1RWJ",
  receivedSince: "2026-11-01",
};

function context(
  transport: typeof fetch,
  limits: Partial<InventoryReadContext["limits"]> = {},
): InventoryReadContext {
  return {
    transport,
    now: () => now,
    limits: {
      maxRequests: 4,
      maxResponseBytes: 8 * 1024 * 1024,
      maxRecords: 2000,
      deadlineAt: now + 10000,
      ...limits,
    },
  };
}
function lofiRequest(
  changes: Partial<LoFiInventoryRequest> = {},
): LoFiInventoryRequest {
  return {
    binding: { ...binding },
    fixedUpperBound: now - 1000,
    resume: {
      mode: "backfill",
      accountId: "account-1",
      readerPolicy: "all-clients-v1",
      policyEpoch: "epoch-1",
      operations: {},
      qsos: {},
    },
    ...changes,
  };
}
function source(key = "q1", stamp = 100): SourceRecord {
  return {
    uuid: key,
    syncedAtMillis: stamp,
    operation: null,
    their: { call: "W1AW" },
  };
}
function lofiResponse(
  qsos: SourceRecord[] = [],
  operations: SourceRecord[] = [],
  meta: SourceRecord = {},
) {
  return Response.json({
    account: { uuid: "account-1" },
    qsos,
    operations,
    meta: {
      operations: { records_left: 0 },
      qsos: { records_left: 0 },
      ...meta,
    },
  });
}
function qrzRequest(
  changes: Partial<QrzInventoryRequest> = {},
): QrzInventoryRequest {
  return {
    binding: { ...binding },
    selection: {
      between: ["2026-11-01", "2026-11-14"],
      modifiedSince: "2026-11-01",
    },
    ...changes,
  };
}
function statusBody(expected = book) {
  return new URLSearchParams({
    RESULT: "OK",
    DATA: new URLSearchParams({
      BOOKID: expected.bookId,
      CALLSIGN: expected.stationCallsign,
      START_DATE: expected.startDate,
      END_DATE: expected.endDate,
    }).toString(),
  }).toString();
}
function fetchBody(records: AdifRecord[], count = records.length) {
  return new URLSearchParams({
    RESULT: "OK",
    COUNT: String(count),
    ADIF: records.map(serializeAdifRecord).join(""),
  }).toString();
}
function lotwResponse(
  records: AdifRecord[],
  through: string | null = "2026-11-07 13:10:00",
) {
  return new Response(
    `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(records.length).length}>${records.length}${through === null ? "" : `<APP_LOTW_LASTQSORX:${through.length}>${through}`}<EOH>${records.map(serializeAdifRecord).join("")}<APP_LOTW_EOF>`,
  );
}

test("LoFi preserves vector progress, fixed backfill bounds and original binding through an opt-in 1000-record read", async () => {
  const request = lofiRequest({ pageSize: 1000 });
  const adapter = createLoFiInventoryAdapter(credentials, {
    allowLargePages: true,
  });
  const response = adapter.readStep(
    context(async (input, init) => {
      const sent = new Request(input, init);
      assert.equal(sent.url, "https://lofi.ham2k.net/v1/sync");
      const body = (await sent.json()) as {
        meta: { sync: { operations: SourceRecord; qsos: SourceRecord } };
      };
      for (const side of [body.meta.sync.operations, body.meta.sync.qsos]) {
        assert.equal(side.limit, 1000);
        assert.equal(side.anyClient, true);
        assert.equal(side.syncedUntilMillis, now - 1000);
      }
      return lofiResponse(
        Array.from({ length: 1000 }, (_, i) => source(`q${i}`, i + 1)),
        [],
        { qsos: { records_left: 1, next_cursor: "q-next" } },
      );
    }),
    request,
  );
  request.binding.queryBinding = "mutated";
  request.fixedUpperBound = now + 1000;
  const result = await response;
  assert.equal(result.kind, "page");
  if (result.kind !== "page") assert.fail(JSON.stringify(result));
  assert.equal(result.observations.length, 1000);
  assert.equal(result.progress.kind, "continue");
  assert.deepEqual(result.completedStreams, ["operations"]);
  assert.deepEqual(result.streamProgress, {
    operations: "observed_complete",
    qsos: "continue",
  });
  assert.equal(result.requestStartedAt, now);
  assert.deepEqual(result.binding, binding);
  assert.equal(result.usage.requests, 1);
  assert.equal(result.usage.records, 1000);
  assert.ok(result.usage.responseBytes > 0);
  assert.equal("proposedCheckpoint" in result.progress, false);
});

test("LoFi complete backfill emits both completed streams and only server-derived forward checkpoints", async () => {
  const adapter = createLoFiInventoryAdapter(credentials);
  const result = await adapter.readStep(
    context(async () =>
      lofiResponse([source()], [{ uuid: "op", syncedAtMillis: 80 }], {
        suggestedSyncCheckPeriod: 5000,
      }),
    ),
    lofiRequest(),
  );
  assert.equal(result.kind, "page");
  if (result.kind !== "page" || result.progress.kind !== "observed_complete")
    assert.fail(JSON.stringify(result));
  assert.deepEqual(result.completedStreams, ["operations", "qsos"]);
  assert.deepEqual(result.streamProgress, {
    operations: "observed_complete",
    qsos: "observed_complete",
  });
  assert.deepEqual(result.progress.proposedCheckpoint, {
    mode: "forward",
    accountId: "account-1",
    readerPolicy: "all-clients-v1",
    policyEpoch: "epoch-1",
    operations: { watermark: 80 },
    qsos: { watermark: 100 },
  });
  assert.equal(result.progress.coverage.immutableSnapshot, false);
  assert.equal(result.progress.coverage.absenceAuthority, false);
  assert.equal(result.progress.coverage.deletionCoverage, "unknown");
  assert.equal(result.nextReadAt, now + 5000);
});

test("LoFi empty incomplete reads preserve continuation and honor server pacing", async () => {
  const result = await createLoFiInventoryAdapter(credentials).readStep(
    context(async () =>
      lofiResponse([], [], {
        operations: { records_left: 1 },
        qsos: { records_left: 1 },
        suggestedSyncLoopDelay: 2500,
      }),
    ),
    lofiRequest(),
  );
  assert.equal(result.kind, "page");
  if (result.kind !== "page") assert.fail(JSON.stringify(result));
  assert.equal(result.progress.kind, "continue");
  assert.deepEqual(result.completedStreams, []);
  assert.equal(result.nextReadAt, now + 2500);
  assert.equal(result.observations.length, 0);
  assert.equal("proposedCheckpoint" in result.progress, false);
});

test("LoFi complete forward checkpoints keep the vector when terminal metadata includes cursors", async () => {
  const base = lofiRequest();
  const result = await createLoFiInventoryAdapter(credentials).readStep(
    context(async () =>
      lofiResponse([source("q", 105)], [], {
        operations: { records_left: 0, next_cursor: "terminal-operation" },
        qsos: { records_left: 0, next_cursor: "terminal-qso" },
      }),
    ),
    {
      ...base,
      resume: {
        ...base.resume,
        mode: "forward",
        operations: { watermark: 80 },
        qsos: { watermark: 100 },
      },
    },
  );
  assert.equal(result.kind, "page");
  if (result.kind !== "page" || result.progress.kind !== "observed_complete")
    assert.fail(JSON.stringify(result));
  assert.deepEqual(result.progress.proposedCheckpoint, {
    mode: "forward",
    accountId: "account-1",
    readerPolicy: "all-clients-v1",
    policyEpoch: "epoch-1",
    operations: { watermark: 80 },
    qsos: { watermark: 105 },
  });
  assert.deepEqual(result.progress.resume, result.progress.proposedCheckpoint);
});

test("LoFi refuses cursor fallback and accidental large reads before granting coverage", async () => {
  let requests = 0;
  const transport: typeof fetch = async () => {
    requests++;
    return Response.json({
      account: { uuid: "account-1" },
      operations: [],
      qsos: [],
      errors: { qsos: { pagination: "refused" } },
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    });
  };
  const adapter = createLoFiInventoryAdapter(credentials);
  const tooLarge = await adapter.readStep(
    context(transport),
    lofiRequest({ pageSize: 1000 }),
  );
  assert.equal(tooLarge.kind, "blocked");
  if (tooLarge.kind !== "blocked") assert.fail();
  assert.equal(tooLarge.code, "invalid_request");
  assert.equal(requests, 0);
  const refused = await adapter.readStep(context(transport), lofiRequest());
  assert.equal(refused.kind, "blocked");
  if (refused.kind !== "blocked") assert.fail();
  assert.equal(refused.code, "cursor_refused");
  assert.equal(refused.recovery, "restart");
  assert.equal("observations" in refused, false);
});

test("LoFi renewal is counted in the aggregate budget and same-client credentials survive deferral", async () => {
  const paths: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === "/v1/client") {
      const body = (await request.json()) as {
        client: { key: string; secret: string };
      };
      assert.equal(body.client.key, credentials.key);
      assert.equal(body.client.secret, credentials.secret);
      return Response.json({ token: "renewed-token" });
    }
    if (request.headers.get("Authorization") !== "Bearer renewed-token")
      return new Response("", { status: 401 });
    return lofiResponse();
  };
  const adapter = createLoFiInventoryAdapter(credentials);
  const deferred = await adapter.readStep(
    context(transport, { maxRequests: 2 }),
    lofiRequest(),
  );
  assert.equal(deferred.kind, "deferred");
  if (deferred.kind !== "deferred") assert.fail(JSON.stringify(deferred));
  assert.equal(deferred.code, "request_budget");
  assert.equal(deferred.usage.requests, 2);
  assert.deepEqual(paths, ["/v1/sync", "/v1/client"]);
  assert.equal(adapter.credentialsSnapshot().token, "renewed-token");
  assert.equal(credentials.token, "synthetic-token");
  const complete = await adapter.readStep(
    context(transport, { maxRequests: 1 }),
    lofiRequest(),
  );
  assert.equal(complete.kind, "page");
  assert.equal(complete.usage.requests, 1);
});

test("aggregate record limits count operations and QSOs together and yield no partial page", async () => {
  const result = await createLoFiInventoryAdapter(credentials).readStep(
    context(
      async () =>
        lofiResponse([source()], [{ uuid: "op", syncedAtMillis: 80 }]),
      { maxRecords: 1 },
    ),
    lofiRequest(),
  );
  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") assert.fail();
  assert.equal(result.code, "record_budget");
  assert.equal(result.usage.records, 2);
  assert.equal("observations" in result, false);
});

test("QRZ verifies book identity and carries inclusive LOGID paging with a fixed modification selection", async () => {
  const actions: string[] = [];
  const adapter = createQrzInventoryAdapter("synthetic-key", book);
  const ctx = context(
    async (input, init) => {
      const form = new URLSearchParams(await new Request(input, init).text());
      const action = form.get("ACTION") ?? "";
      actions.push(action);
      if (action === "STATUS") return new Response(statusBody());
      const options = form.get("OPTION") ?? "";
      assert.ok(options.includes("MODSINCE:2026-11-01"));
      assert.ok(options.includes("BETWEEN:2026-11-01+2026-11-14"));
      return new Response(
        options.includes("AFTERLOGID:0") ? fetchBody([adif]) : fetchBody([]),
      );
    },
    { maxRequests: 2 },
  );
  const first = await adapter.readStep(ctx, qrzRequest({ pageSize: 1 }));
  assert.equal(first.kind, "page");
  if (first.kind !== "page" || first.progress.kind !== "continue")
    assert.fail(JSON.stringify(first));
  const resume = first.progress.resume as QrzInventoryResume;
  assert.equal(resume.afterLogId, 2);
  assert.equal(first.usage.requests, 2);
  assert.deepEqual(first.completedStreams, []);
  const second = await adapter.readStep(
    ctx,
    qrzRequest({ pageSize: 1, resume }),
  );
  assert.equal(second.kind, "page");
  if (second.kind !== "page" || second.progress.kind !== "observed_complete")
    assert.fail(JSON.stringify(second));
  assert.deepEqual(second.completedStreams, ["selection"]);
  assert.deepEqual(second.progress.proposedCheckpoint, {
    kind: "qrz_selection_complete",
    queryKey: resume.queryKey,
    modifiedSince: "2026-11-01",
    observedStartedAt: now,
  });
  assert.equal(second.progress.coverage.selection, "book_modified_selection");
  assert.equal(second.progress.coverage.absenceAuthority, false);
  assert.deepEqual(actions, ["STATUS", "FETCH", "STATUS", "FETCH"]);
  const changed = await adapter.readStep(
    ctx,
    qrzRequest({
      resume,
      selection: {
        between: ["2026-11-01", "2026-11-14"],
        modifiedSince: "2026-11-02",
      },
    }),
  );
  assert.equal(changed.kind, "blocked");
  assert.equal(changed.usage.requests, 0);
});

test("QRZ STATUS mismatch and contradictory result scope block the entire selection", async () => {
  for (const statusMismatch of [true, false]) {
    let calls = 0;
    const result = await createQrzInventoryAdapter("key", book).readStep(
      context(async () => {
        calls++;
        if (calls === 1)
          return new Response(
            statusBody(statusMismatch ? { ...book, bookId: "8" } : book),
          );
        return new Response(fetchBody([{ ...adif, STATION_CALLSIGN: "W2AW" }]));
      }),
      qrzRequest(),
    );
    assert.equal(result.kind, "blocked");
    if (result.kind !== "blocked") assert.fail();
    assert.equal(result.code, "scope_mismatch");
    assert.equal(result.recovery, "verify");
    assert.equal(calls, statusMismatch ? 1 : 2);
    assert.equal("observations" in result, false);
  }
});

test("QRZ reads apply the ADIF operator fallback without replacing explicit station evidence", async () => {
  for (const [station, operator, accepted] of [
    [undefined, book.stationCallsign, true],
    [undefined, "W2AW", false],
    [undefined, undefined, false],
    ["W2AW", book.stationCallsign, false],
    ["", book.stationCallsign, false],
    [book.stationCallsign, "W2AW", true],
  ] as const) {
    const record = { ...adif };
    delete record.STATION_CALLSIGN;
    if (station !== undefined) record.STATION_CALLSIGN = station;
    if (operator !== undefined) record.OPERATOR = operator;
    let calls = 0;
    const result = await createQrzInventoryAdapter("key", book).readStep(
      context(
        async () =>
          new Response(++calls === 1 ? statusBody() : fetchBody([record])),
      ),
      qrzRequest(),
    );
    assert.equal(result.kind, accepted ? "page" : "blocked");
    if (result.kind === "page")
      assert.deepEqual(
        result.observations[0]?.body,
        record,
        "raw observations preserve the original fields",
      );
    else
      assert.ok(result.kind === "blocked" && result.code === "scope_mismatch");
  }
});

test("QRZ ambiguous empty remains verification work and STATUS consumes request/byte budgets", async () => {
  const status = statusBody();
  const ambiguous = "RESULT=FAIL&COUNT=0";
  const transport: typeof fetch = async (input, init) => {
    const form = new URLSearchParams(await new Request(input, init).text());
    return new Response(form.get("ACTION") === "STATUS" ? status : ambiguous);
  };
  const result = await createQrzInventoryAdapter("key", book).readStep(
    context(transport),
    qrzRequest(),
  );
  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") assert.fail();
  assert.equal(result.code, "ambiguous_empty");
  assert.equal(result.recovery, "verify");
  assert.equal(result.usage.requests, 2);
  const requestBudget = await createQrzInventoryAdapter("key", book).readStep(
    context(transport, { maxRequests: 1 }),
    qrzRequest(),
  );
  assert.equal(requestBudget.kind, "deferred");
  if (requestBudget.kind !== "deferred") assert.fail();
  assert.equal(requestBudget.code, "request_budget");
  assert.equal(requestBudget.usage.requests, 1);
  const byteBudget = await createQrzInventoryAdapter("key", book).readStep(
    context(transport, {
      maxResponseBytes:
        Buffer.byteLength(status) + Buffer.byteLength(ambiguous) - 1,
    }),
    qrzRequest(),
  );
  assert.equal(byteBudget.kind, "blocked");
  if (byteBudget.kind !== "blocked") assert.fail();
  assert.equal(byteBudget.code, "response_budget");
  assert.equal(byteBudget.usage.requests, 2);
});

test("QRZ delta fallback requires one complete positive date selection", async () => {
  for (const [fallback, outcome] of [
    [fetchBody([adif]), "complete"],
    [fetchBody([]), "ambiguous_empty"],
    [fetchBody([adif], 2), "ambiguous_empty"],
    [fetchBody([adif, { ...adif, APP_QRZLOG_LOGID: "2" }]), "ambiguous_empty"],
    [fetchBody([{ ...adif, STATION_CALLSIGN: "W2AW" }]), "scope_mismatch"],
  ] as const) {
    const options: string[] = [];
    const request = qrzRequest({
      verifyAmbiguousDelta: true,
      pageSize: 2,
      selection: {
        between: ["2026-11-01", "2026-11-14"],
        modifiedSince: "2026-11-07",
      },
    });
    const result = await createQrzInventoryAdapter("key", book).readStep(
      context(async (input, init) => {
        const form = new URLSearchParams(await new Request(input, init).text());
        if (form.get("ACTION") === "STATUS") return new Response(statusBody());
        assert.equal(form.get("ACTION"), "FETCH");
        const option = form.get("OPTION") ?? "";
        options.push(option);
        return new Response(
          option.includes("MODSINCE:") ? "RESULT=FAIL&COUNT=0" : fallback,
        );
      }),
      request,
    );
    assert.equal(result.usage.requests, 3);
    assert.equal(options.length, 2);
    assert.equal(options[0], `${options[1]},MODSINCE:2026-11-07`);
    assert.match(
      options[1],
      /MAX:2,AFTERLOGID:0,BETWEEN:2026-11-01\+2026-11-14/,
    );
    assert.deepEqual(result.binding, request.binding);
    if (outcome === "complete") {
      assert.ok(
        result.kind === "page" && result.progress.kind === "observed_complete",
      );
      assert.deepEqual(
        result.observations.map((row) => row.body),
        [adif],
      );
      assert.equal(result.progress.coverage.selection, "book_date_selection");
      assert.equal(result.progress.coverage.absenceAuthority, false);
    } else {
      assert.equal(result.kind, "blocked");
      assert.equal(result.code, outcome);
      assert.equal("observations" in result, false);
    }
  }
});

test("LoTW receipt checkpoints remain restricted to their original static query scope", async () => {
  const adapter = createLotwInventoryAdapter({
    username: "synthetic-user",
    password: "synthetic-password",
  });
  const result = await adapter.readStep(
    context(async (input, init) => {
      const request = new Request(input, init);
      const params = new URL(request.url).searchParams;
      assert.equal(params.get("qso_qsl"), "no");
      assert.equal(params.get("qso_qsorxsince"), query.receivedSince);
      assert.equal(params.get("qso_owncall"), "N1RWJ");
      assert.equal(params.get("qso_startdate"), query.startDate);
      assert.equal(params.get("qso_enddate"), query.endDate);
      return lotwResponse([adif]);
    }),
    { binding, query },
  );
  assert.equal(result.kind, "page");
  if (result.kind !== "page" || result.progress.kind !== "observed_complete")
    assert.fail(JSON.stringify(result));
  assert.deepEqual(result.completedStreams, ["selection"]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].order, null);
  assert.deepEqual(result.progress.proposedCheckpoint, {
    selection: {
      startDate: query.startDate,
      endDate: query.endDate,
      stationCallsign: "N1RWJ",
    },
    receivedThrough: "2026-11-07 13:10:00",
  });
  assert.equal(result.progress.coverage.immutableSnapshot, false);
  assert.equal(result.progress.coverage.purpose, "receipt");
  assert.equal(adapter.capabilities.confirmation, "unsupported");
});

test("LoTW confirmation support is explicit and empty reports do not fabricate wall-clock checkpoints", async () => {
  let calls = 0;
  const ctx = context(async () => {
    calls++;
    return lotwResponse([], null);
  });
  const adapter = createLotwInventoryAdapter({
    username: "user",
    password: "password",
  });
  const unsupported = await adapter.readStep(ctx, {
    binding,
    query,
    purpose: "confirmation",
  });
  assert.equal(unsupported.kind, "unsupported");
  assert.equal(calls, 0);
  const empty = await adapter.readStep(ctx, { binding, query });
  assert.equal(empty.kind, "page");
  if (empty.kind !== "page" || empty.progress.kind !== "observed_complete")
    assert.fail(JSON.stringify(empty));
  assert.equal(empty.progress.proposedCheckpoint, null);
  assert.equal(empty.observations.length, 0);
});

test("LoTW empty report with LASTQSORX is observed complete without advancing a checkpoint", async () => {
  const result = await createLotwInventoryAdapter({
    username: "user",
    password: "password",
  }).readStep(
    context(async () => lotwResponse([], "2026-11-07 13:10:00")),
    { binding, query },
  );
  assert.equal(result.kind, "page");
  if (result.kind !== "page" || result.progress.kind !== "observed_complete")
    assert.fail(JSON.stringify(result));
  assert.equal(result.progress.proposedCheckpoint, null);
  assert.equal(result.observations.length, 0);
  assert.deepEqual(result.completedStreams, ["selection"]);
  assert.equal(result.progress.coverage.absenceAuthority, false);
});

test("LoTW LASTQSORX agrees with present first-row RXQSO and never precedes another returned timestamp", async () => {
  const adapter = createLotwInventoryAdapter({
    username: "user",
    password: "password",
  });
  const through = "2026-11-07 13:10:00";
  const complete = await adapter.readStep(
    context(async () =>
      lotwResponse(
        [
          { ...adif, APP_LOTW_RXQSO: through },
          { ...adif, CALL: "W2AW", APP_LOTW_RXQSO: "2026-11-07 12:10:00" },
        ],
        through,
      ),
    ),
    { binding, query },
  );
  assert.equal(complete.kind, "page");
  if (
    complete.kind !== "page" ||
    complete.progress.kind !== "observed_complete"
  )
    assert.fail(JSON.stringify(complete));
  assert.equal(
    (complete.progress.proposedCheckpoint as { receivedThrough: string })
      .receivedThrough,
    through,
  );
  for (const records of [
    [{ ...adif, APP_LOTW_RXQSO: "2026-11-07 13:09:00" }],
    [
      { ...adif, APP_LOTW_RXQSO: through },
      { ...adif, CALL: "W2AW", APP_LOTW_RXQSO: "2026-11-07 13:11:00" },
    ],
    [adif, { ...adif, CALL: "W2AW", APP_LOTW_RXQSO: "2026-11-07 13:11:00" }],
    [
      { ...adif, APP_LOTW_RXQSO: through },
      { ...adif, CALL: "W2AW", APP_LOTW_RXQSO: "2026-02-30 13:00:00" },
    ],
  ]) {
    const result = await adapter.readStep(
      context(async () => lotwResponse(records, through)),
      { binding, query },
    );
    assert.equal(result.kind, "blocked");
    if (result.kind !== "blocked") assert.fail();
    assert.equal(result.code, "invalid_response");
    assert.equal(result.recovery, "verify");
    assert.equal("progress" in result, false);
  }
});

test("LoTW missing legacy RXQSO and unknown fields retain the captured partial scope and version", async () => {
  const request = {
    binding: { ...binding },
    query: { ...query, workedCallsign: "W1AW" },
  };
  const unknown = { ...adif, APP_FUTURE_RECEIPT_DETAIL: "preserve-this-value" };
  const pending = createLotwInventoryAdapter({
    username: "user",
    password: "password",
  }).readStep(
    context(async () => lotwResponse([unknown])),
    request,
  );
  request.binding.configVersion = 2;
  request.binding.queryBinding = "different-scope";
  request.query.stationCallsign = "W2AW";
  const result = await pending;
  assert.equal(result.kind, "page");
  if (result.kind !== "page" || result.progress.kind !== "observed_complete")
    assert.fail(JSON.stringify(result));
  assert.deepEqual(result.binding, binding);
  assert.deepEqual(result.progress.coverage.binding, binding);
  assert.deepEqual(result.observations[0].body, unknown);
  assert.equal(
    "APP_LOTW_RXQSO" in (result.observations[0].body as AdifRecord),
    false,
  );
  assert.deepEqual(result.progress.proposedCheckpoint, {
    selection: {
      startDate: query.startDate,
      endDate: query.endDate,
      stationCallsign: "N1RWJ",
      workedCallsign: "W1AW",
    },
    receivedThrough: "2026-11-07 13:10:00",
  });
});

test("LoTW oversized byte/record selections split inclusive date ranges without checkpointing", async () => {
  const adapter = createLotwInventoryAdapter({
    username: "user",
    password: "password",
  });
  for (const kind of ["bytes", "records"] as const) {
    const result = await adapter.readStep(
      context(
        async () =>
          kind === "bytes"
            ? new Response("x".repeat(1001))
            : lotwResponse([adif, { ...adif, CALL: "W2AW" }]),
        kind === "bytes" ? { maxResponseBytes: 1000 } : { maxRecords: 1 },
      ),
      { binding, query },
    );
    assert.equal(result.kind, "split");
    if (result.kind !== "split") assert.fail(JSON.stringify(result));
    assert.deepEqual(result.partitions, [
      { ...query, endDate: "2026-11-07" },
      { ...query, startDate: "2026-11-08" },
    ]);
    assert.equal("observations" in result, false);
    assert.equal(result.usage.requests, 1);
  }
  const daily = await adapter.readStep(
    context(async () => new Response("x".repeat(1001)), {
      maxResponseBytes: 1000,
    }),
    { binding, query: { ...query, endDate: query.startDate } },
  );
  assert.equal(daily.kind, "blocked");
  if (daily.kind !== "blocked") assert.fail();
  assert.equal(daily.recovery, "review");
  const errorPage = await adapter.readStep(
    context(async () => new Response("x".repeat(1001), { status: 503 }), {
      maxResponseBytes: 1000,
    }),
    { binding, query },
  );
  assert.equal(errorPage.kind, "blocked");
  if (errorPage.kind !== "blocked") assert.fail();
  assert.equal(errorPage.recovery, "retry");
});

test("LoTW scope contradictions and unsupported exact identities produce fixed holds", async () => {
  for (const [record, code] of [
    [{ ...adif, STATION_CALLSIGN: "W2AW" }, "scope_mismatch"],
    [{ ...adif, MODE: "PHONE" }, "unsupported_identity"],
  ] as const) {
    const result = await createLotwInventoryAdapter({
      username: "user",
      password: "password",
    }).readStep(
      context(async () => lotwResponse([record])),
      { binding, query },
    );
    assert.equal(result.kind, "blocked");
    if (result.kind !== "blocked") assert.fail();
    assert.equal(result.code, code);
    assert.equal("observations" in result, false);
    assert.ok(!JSON.stringify(result).includes("password"));
  }
});

test("LoTW splits a timed-out report body with progress and defers a stalled connection", async () => {
  const adapter = createLotwInventoryAdapter({
    username: "user",
    password: "password",
  });
  const response = (status: number, progress: boolean) =>
    new Response(
      new ReadableStream({
        start(controller) {
          if (progress)
            controller.enqueue(new TextEncoder().encode("<PROGRAMID:4>LoTW"));
        },
      }),
      { status },
    );
  const result = await adapter.readStep(
    context(async () => response(200, true), { deadlineAt: now + 20 }),
    { binding, query },
  );
  assert.equal(result.kind, "split");
  assert.ok(result.usage.responseBytes > 0);
  assert.equal("observations" in result, false);
  for (const transport of [
    async () => new Promise<Response>(() => {}),
    async () => response(200, false),
    async () => response(503, true),
  ]) {
    const stalled = await adapter.readStep(
      context(transport, { deadlineAt: now + 20 }),
      { binding, query },
    );
    assert.equal(stalled.kind, "deferred");
    if (stalled.kind !== "deferred") assert.fail();
    assert.equal(stalled.code, "deadline");
  }
});

test("caller cancellation and aggregate deadline bound stalled transport and response-body reads", async () => {
  const adapter = createLoFiInventoryAdapter(credentials);
  const abort = new AbortController();
  const ctx = context(async () => new Promise<Response>(() => {}));
  ctx.signal = abort.signal;
  const pending = adapter.readStep(ctx, lofiRequest());
  abort.abort();
  const cancelled = await pending;
  assert.equal(cancelled.kind, "deferred");
  if (cancelled.kind !== "deferred") assert.fail();
  assert.equal(cancelled.code, "aborted");
  let bodyCancelled = false;
  const stalled = await adapter.readStep(
    context(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
        ),
      { deadlineAt: now + 20 },
    ),
    lofiRequest(),
  );
  assert.equal(stalled.kind, "deferred");
  if (stalled.kind !== "deferred") assert.fail();
  assert.equal(stalled.code, "deadline");
  assert.equal(bodyCancelled, true);
});

test("vendor cooldown and admission deferrals retain retryAt without exposing transport errors", async () => {
  const adapter = createLoFiInventoryAdapter(credentials);
  const cooldown = await adapter.readStep(
    context(
      async () =>
        new Response("", { status: 429, headers: { "Retry-After": "7" } }),
    ),
    lofiRequest(),
  );
  assert.equal(cooldown.kind, "deferred");
  if (cooldown.kind !== "deferred") assert.fail();
  assert.equal(cooldown.retryAt, now + 7000);
  const admitted = await adapter.readStep(
    context(async () => {
      throw new VendorDeferredError(now + 12000);
    }),
    lofiRequest(),
  );
  assert.equal(admitted.kind, "deferred");
  if (admitted.kind !== "deferred") assert.fail();
  assert.equal(admitted.retryAt, now + 12000);
  const failed = await adapter.readStep(
    context(async () => {
      throw new Error("private-credential-or-URL");
    }),
    lofiRequest(),
  );
  assert.equal(failed.kind, "blocked");
  assert.ok(!JSON.stringify(failed).includes("private-credential-or-URL"));
});

test("zero request budget, expired deadline and pre-aborted caller never dispatch", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return lofiResponse();
  };
  const adapter = createLoFiInventoryAdapter(credentials);
  const aborted = new AbortController();
  aborted.abort();
  for (const ctx of [
    context(transport, { maxRequests: 0 }),
    context(transport, { deadlineAt: now }),
    { ...context(transport), signal: aborted.signal },
  ]) {
    const result = await adapter.readStep(ctx, lofiRequest());
    assert.equal(result.kind, "deferred");
    assert.equal(result.usage.requests, 0);
  }
  assert.equal(calls, 0);
});

test("exact aggregate byte/request bounds succeed and redirects cannot become trusted buffered responses", async () => {
  const status = statusBody();
  const page = fetchBody([adif]);
  const expectedBytes = Buffer.byteLength(status) + Buffer.byteLength(page);
  const transport: typeof fetch = async (input, init) => {
    const form = new URLSearchParams(await new Request(input, init).text());
    return new Response(form.get("ACTION") === "STATUS" ? status : page);
  };
  const complete = await createQrzInventoryAdapter("key", book).readStep(
    context(transport, { maxRequests: 2, maxResponseBytes: expectedBytes }),
    qrzRequest(),
  );
  assert.equal(complete.kind, "page");
  assert.equal(complete.usage.requests, 2);
  assert.equal(complete.usage.responseBytes, expectedBytes);
  const redirect = await createLoFiInventoryAdapter(credentials).readStep(
    context(
      async () =>
        new Response("", {
          status: 302,
          headers: { Location: "https://untrusted.example" },
        }),
    ),
    lofiRequest(),
  );
  assert.equal(redirect.kind, "blocked");
  if (redirect.kind !== "blocked") assert.fail();
  assert.equal(redirect.code, "invalid_response");
  assert.equal(redirect.recovery, "verify");
});

test("LoTW invalid or regressing receive checkpoints never publish a proposed checkpoint", async () => {
  const adapter = createLotwInventoryAdapter({
    username: "user",
    password: "password",
  });
  for (const through of ["2026-02-30 13:10:00", "2026-10-31 13:10:00"]) {
    const result = await adapter.readStep(
      context(async () => lotwResponse([adif], through)),
      { binding, query },
    );
    assert.equal(result.kind, "blocked");
    if (result.kind !== "blocked") assert.fail();
    assert.equal(result.code, "invalid_response");
    assert.equal(result.recovery, "verify");
    assert.equal("progress" in result, false);
  }
  const invalidQuery = await adapter.readStep(
    context(async () => assert.fail("invalid date must not dispatch")),
    { binding, query: { ...query, receivedSince: "2026-02-30" } },
  );
  assert.equal(invalidQuery.kind, "blocked");
  if (invalidQuery.kind !== "blocked") assert.fail();
  assert.equal(invalidQuery.code, "invalid_request");
  assert.equal(invalidQuery.usage.requests, 0);
});

test("LoTW wide ranges split before network and its native two-MiB response cap also splits", async () => {
  const adapter = createLotwInventoryAdapter({
    username: "user",
    password: "password",
  });
  const wide = await adapter.readStep(
    context(async () => assert.fail("wide query must split before dispatch")),
    {
      binding,
      query: { ...query, startDate: "2026-01-01", endDate: "2026-03-01" },
    },
  );
  assert.equal(wide.kind, "split");
  assert.equal(wide.usage.requests, 0);
  const oversized = await adapter.readStep(
    context(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))),
    { binding, query },
  );
  assert.equal(oversized.kind, "split");
  assert.equal(oversized.usage.requests, 1);
});

test("LoFi final unauthorized and temporary service errors remain distinct fixed outcomes", async () => {
  for (const [status, code, recovery] of [
    [403, "credentials_unavailable", "reconnect"],
    [503, "vendor_unavailable", "retry"],
  ] as const) {
    const result = await createLoFiInventoryAdapter(credentials).readStep(
      context(async () => new Response("untrusted response", { status })),
      lofiRequest(),
    );
    assert.equal(result.kind, "blocked");
    if (result.kind !== "blocked") assert.fail();
    assert.equal(result.code, code);
    assert.equal(result.recovery, recovery);
    assert.equal("observations" in result, false);
  }
});

function qrzPagedTransport(
  records: AdifRecord[],
  fetches: { after: number; max: number }[],
  rewrite?: (
    after: number,
    max: number,
    selected: AdifRecord[],
  ) => Response | undefined,
): typeof fetch {
  return async (input, init) => {
    const form = new URLSearchParams(await new Request(input, init).text());
    if (form.get("ACTION") === "STATUS") return new Response(statusBody());
    const options = form.get("OPTION") ?? "";
    const after = Number(/(?:^|,)AFTERLOGID:(\d+)/.exec(options)?.[1]);
    const max = Number(/(?:^|,)MAX:(\d+)/.exec(options)?.[1]);
    assert.ok(Number.isSafeInteger(after));
    assert.ok(Number.isSafeInteger(max));
    fetches.push({ after, max });
    const matching = records.filter(
      (row) => Number(row.APP_QRZLOG_LOGID) >= after,
    );
    const selected = matching.slice(0, max);
    return (
      rewrite?.(after, max, selected) ??
      new Response(
        selected.length
          ? fetchBody(selected, matching.length)
          : "RESULT=FAIL&COUNT=0",
      )
    );
  };
}

async function qrzFullPage(size = 250) {
  const records = Array.from({ length: size }, (_, i) => ({
    ...adif,
    APP_QRZLOG_LOGID: String(i + 1),
  }));
  const fetches: { after: number; max: number }[] = [];
  const adapter = createQrzInventoryAdapter("key", book);
  const transport = qrzPagedTransport(records, fetches);
  const initial = await adapter.readStep(
    context(transport),
    qrzRequest({ pageSize: size }),
  );
  assert.equal(initial.kind, "page");
  if (initial.kind !== "page" || initial.progress.kind !== "continue")
    assert.fail(JSON.stringify(initial));
  return {
    records,
    fetches,
    adapter,
    transport,
    resume: initial.progress.resume as QrzInventoryResume,
  };
}

test("QRZ exact 250-record terminal FAIL recovers using explicit 249-record replay and successful one-record tail", async () => {
  const f = await qrzFullPage();
  assert.deepEqual(f.resume.previousFullPage, {
    afterLogId: 0,
    pageSize: 250,
    nextAfterLogId: 251,
  });
  assert.equal(f.resume.version, 1);
  const replay = await f.adapter.readStep(
    context(f.transport, { maxRequests: 3 }),
    qrzRequest({ resume: f.resume }),
  );
  assert.equal(replay.kind, "page");
  if (replay.kind !== "page" || replay.progress.kind !== "continue")
    assert.fail(JSON.stringify(replay));
  assert.equal(replay.observations.length, 249);
  assert.deepEqual(replay.completedStreams, []);
  assert.equal("proposedCheckpoint" in replay.progress, false);
  assert.equal(replay.usage.requests, 3);
  assert.equal(replay.usage.records, 249);
  const next = replay.progress.resume as QrzInventoryResume;
  assert.equal(next.afterLogId, 250);
  assert.equal(next.pageSize, 249);
  assert.deepEqual(next.previousFullPage, {
    afterLogId: 0,
    pageSize: 249,
    nextAfterLogId: 250,
  });
  const tail = await f.adapter.readStep(
    context(f.transport),
    qrzRequest({ resume: next, pageSize: 250 }),
  );
  assert.equal(tail.kind, "page");
  if (tail.kind !== "page" || tail.progress.kind !== "observed_complete")
    assert.fail(JSON.stringify(tail));
  assert.equal(tail.observations.length, 1);
  assert.equal(tail.observations[0].key, "250");
  assert.deepEqual(tail.completedStreams, ["selection"]);
  assert.equal(tail.progress.coverage.absenceAuthority, false);
  assert.deepEqual(f.fetches, [
    { after: 0, max: 250 },
    { after: 251, max: 250 },
    { after: 0, max: 249 },
    { after: 250, max: 249 },
  ]);
});

test("QRZ recovery budget exhaustion keeps the original resume and no partial observations", async () => {
  const f = await qrzFullPage();
  const before = structuredClone(f.resume);
  const result = await f.adapter.readStep(
    context(f.transport, { maxRequests: 2 }),
    qrzRequest({ resume: f.resume }),
  );
  assert.equal(result.kind, "deferred");
  if (result.kind !== "deferred") assert.fail(JSON.stringify(result));
  assert.equal(result.code, "request_budget");
  assert.equal(result.usage.requests, 2);
  assert.equal("progress" in result, false);
  assert.equal("observations" in result, false);
  assert.deepEqual(f.resume, before);
  assert.deepEqual(f.fetches, [
    { after: 0, max: 250 },
    { after: 251, max: 250 },
  ]);
});

test("QRZ absent recovery witness, MAX=1 and changed selection remain visible holds", async () => {
  const f = await qrzFullPage();
  const legacy = {
    afterLogId: f.resume.afterLogId,
    queryKey: f.resume.queryKey,
  };
  const unwitnessed = await f.adapter.readStep(
    context(f.transport),
    qrzRequest({ resume: legacy }),
  );
  assert.equal(unwitnessed.kind, "blocked");
  if (unwitnessed.kind !== "blocked") assert.fail();
  assert.equal(unwitnessed.code, "ambiguous_empty");
  assert.equal(unwitnessed.usage.requests, 2);
  const changed = await f.adapter.readStep(
    context(f.transport),
    qrzRequest({
      resume: f.resume,
      selection: {
        between: ["2026-11-02", "2026-11-14"],
        modifiedSince: "2026-11-01",
      },
    }),
  );
  assert.equal(changed.kind, "blocked");
  assert.equal(changed.usage.requests, 0);
  const single = await qrzFullPage(1);
  const exhausted = await single.adapter.readStep(
    context(single.transport),
    qrzRequest({ resume: single.resume, pageSize: 1 }),
  );
  assert.equal(exhausted.kind, "blocked");
  if (exhausted.kind !== "blocked") assert.fail();
  assert.equal(exhausted.code, "ambiguous_empty");
  assert.equal(exhausted.usage.requests, 2);
  assert.deepEqual(single.fetches, [
    { after: 0, max: 1 },
    { after: 2, max: 1 },
  ]);
});

test("QRZ failed, empty or contradictory recovery reads never borrow completion from FAIL", async () => {
  const f = await qrzFullPage();
  for (const response of [
    () => new Response("RESULT=FAIL&COUNT=0"),
    () => new Response(fetchBody([])),
    () => new Response("RESULT=OK&COUNT=249&ADIF=%3Cbad%3E"),
    () => new Response(fetchBody([{ ...adif, QSO_DATE: "20261201" }])),
  ]) {
    const transport = qrzPagedTransport(f.records, [], (after, max) =>
      after === 0 && max === 249 ? response() : undefined,
    );
    const result = await f.adapter.readStep(
      context(transport),
      qrzRequest({ resume: f.resume }),
    );
    assert.equal(result.kind, "blocked");
    assert.equal(result.usage.requests, 3);
    assert.equal("progress" in result, false);
    assert.equal("observations" in result, false);
  }
});

test("QRZ malformed or out-of-selection successful tail is never rescued by rewinding", async () => {
  const f = await qrzFullPage();
  for (const response of [
    () => new Response("RESULT=OK&COUNT=1&ADIF=%3Cbad%3E"),
    () =>
      new Response(
        fetchBody([
          { ...adif, APP_QRZLOG_LOGID: "251", STATION_CALLSIGN: "W2AW" },
        ]),
      ),
  ]) {
    const fetches: { after: number; max: number }[] = [];
    const result = await f.adapter.readStep(
      context(qrzPagedTransport(f.records, fetches, () => response())),
      qrzRequest({ resume: f.resume }),
    );
    assert.equal(result.kind, "blocked");
    assert.equal(result.usage.requests, 2);
    assert.deepEqual(fetches, [{ after: 251, max: 250 }]);
  }
});

test("QRZ newly added records keep normal paging and a later ambiguous boundary can shrink again", async () => {
  const f = await qrzFullPage();
  let extended = false;
  const transport = qrzPagedTransport(
    f.records,
    f.fetches,
    (after, max, selected) => {
      if (after === 251 && max === 250 && !selected.length && !extended) {
        extended = true;
        f.records.push(
          ...Array.from({ length: 248 }, (_, i) => ({
            ...adif,
            APP_QRZLOG_LOGID: String(i + 251),
          })),
        );
        return new Response("RESULT=FAIL&COUNT=0");
      }
      return undefined;
    },
  );
  let resume = f.resume;
  const counts: number[] = [];
  for (let turn = 0; turn < 4; turn++) {
    const page = await f.adapter.readStep(
      context(transport),
      qrzRequest({ resume }),
    );
    assert.equal(page.kind, "page");
    if (page.kind !== "page") assert.fail(JSON.stringify(page));
    counts.push(page.observations.length);
    if (turn === 3) {
      assert.equal(page.progress.kind, "observed_complete");
      assert.equal(page.observations[0].key, "498");
    } else {
      assert.equal(page.progress.kind, "continue");
    }
    resume = page.progress.resume as QrzInventoryResume;
  }
  assert.deepEqual(counts, [249, 249, 248, 1]);
  assert.equal(resume.pageSize, 248);
});

test("LoFi raw pacing retains a zero loop hint for core run-phase scheduling", async () => {
  const result = await createLoFiInventoryAdapter(credentials).readStep(
    context(async () =>
      lofiResponse([], [], {
        operations: { records_left: 1 },
        qsos: { records_left: 1 },
        suggestedSyncLoopDelay: 0,
        suggestedSyncCheckPeriod: 5000,
      }),
    ),
    lofiRequest(),
  );
  assert.equal(result.kind, "page");
  if (result.kind !== "page") assert.fail();
  assert.deepEqual(result.pacing, { loopDelayMs: 0, checkPeriodMs: 5000 });
  assert.equal(result.progress.kind, "continue");
});

test("LoFi contradictory backfill/forward stamps hold without publishing observations or progress", async () => {
  const base = lofiRequest();
  for (const [mode, stamp] of [
    ["backfill", 201],
    ["forward", 199],
  ] as const) {
    const request = lofiRequest({
      resume: {
        ...base.resume,
        mode,
        operations: {},
        qsos: { watermark: 200, cursor: "prior-cursor" },
      },
    });
    const result = await createLoFiInventoryAdapter(credentials).readStep(
      context(async () =>
        lofiResponse([source("q", stamp)], [], {
          qsos: { records_left: 1, next_cursor: "next-cursor" },
        }),
      ),
      request,
    );
    assert.equal(result.kind, "blocked");
    if (result.kind !== "blocked") assert.fail(JSON.stringify(result));
    assert.equal(result.code, "scope_mismatch");
    assert.equal(result.recovery, "verify");
    assert.equal(result.usage.requests, 1);
    assert.equal("observations" in result, false);
    assert.equal("progress" in result, false);
    assert.equal(request.resume.qsos.watermark, 200);
    assert.equal(request.resume.qsos.cursor, "prior-cursor");
  }
  const future = await createLoFiInventoryAdapter(credentials).readStep(
    context(async () =>
      lofiResponse([source("future", base.fixedUpperBound + 1)]),
    ),
    base,
  );
  assert.equal(future.kind, "blocked");
  if (future.kind !== "blocked") assert.fail();
  assert.equal(future.code, "scope_mismatch");
});

test("LoFi numeric windows use separate side watermarks and permit boundary ties", async () => {
  const base = lofiRequest();
  for (const mode of ["backfill", "forward"] as const) {
    const request = lofiRequest({
      resume: {
        ...base.resume,
        mode,
        operations: { watermark: 80 },
        qsos: { watermark: 100 },
      },
    });
    const result = await createLoFiInventoryAdapter(credentials).readStep(
      context(async () =>
        lofiResponse([source("q", 100)], [{ uuid: "op", syncedAtMillis: 80 }]),
      ),
      request,
    );
    assert.equal(result.kind, "page");
    if (result.kind !== "page" || result.progress.kind !== "observed_complete")
      assert.fail(JSON.stringify(result));
    assert.equal(result.observations.length, 2);
    assert.deepEqual(result.completedStreams, ["operations", "qsos"]);
    const contradictoryOperation = await createLoFiInventoryAdapter(
      credentials,
    ).readStep(
      context(async () =>
        lofiResponse(
          [source("q", 100)],
          [{ uuid: "op", syncedAtMillis: mode === "backfill" ? 81 : 79 }],
        ),
      ),
      request,
    );
    assert.equal(contradictoryOperation.kind, "blocked");
    if (contradictoryOperation.kind !== "blocked") assert.fail();
    assert.equal(contradictoryOperation.code, "scope_mismatch");
  }
});

test("LoFi malformed stored modes, side progress and watermarks are rejected before HTTP", async () => {
  const base = lofiRequest();
  let calls = 0;
  const ctx = context(async () => {
    calls++;
    return lofiResponse();
  });
  const invalid: unknown[] = [
    null,
    {},
    { ...base.resume, mode: "other" },
    { ...base.resume, operations: [] },
    { ...base.resume, qsos: null },
    { ...base.resume, operations: { watermark: "100" } },
    { ...base.resume, qsos: { watermark: -1 } },
    { ...base.resume, qsos: { watermark: 1.5 } },
    { ...base.resume, operations: { latest: "100" } },
    { ...base.resume, qsos: { cursor: 7 } },
    { ...base.resume, operations: { complete: "true" } },
  ];
  for (const resume of invalid) {
    const result = await createLoFiInventoryAdapter(credentials).readStep(
      ctx,
      lofiRequest({ resume: resume as SyncState }),
    );
    assert.equal(result.kind, "blocked");
    if (result.kind !== "blocked") assert.fail(JSON.stringify(result));
    assert.equal(result.code, "invalid_request");
    assert.equal(result.usage.requests, 0);
    assert.equal("observations" in result, false);
  }
  assert.equal(calls, 0);
});
