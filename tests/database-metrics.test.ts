import assert from "node:assert/strict";
import test from "node:test";
import { measuredDatabase } from "../src/database-metrics.ts";

function fixture(reply: (method: string, args: unknown[]) => unknown) {
  const originals = new Set<unknown>();
  const calls: { method: string; args: unknown[] }[] = [];
  const invoke = async (method: string, args: unknown[]) => {
    calls.push({ method, args });
    return reply(method, args);
  };
  const statement = () => {
    const value = {
      bind: (..._values: unknown[]) => statement(),
      all: (...args: unknown[]) => invoke("all", args),
      run: (...args: unknown[]) => invoke("run", args),
      first: (...args: unknown[]) => invoke("first", args),
      raw: (...args: unknown[]) => invoke("raw", args),
    };
    originals.add(value);
    return value;
  };
  const database = {
    prepare: (_query: string) => statement(),
    batch: (statements: unknown[]) => {
      assert.ok(statements.every((item) => originals.has(item)));
      return invoke("batch", statements);
    },
  } as unknown as D1Database;
  return { ...measuredDatabase(database), calls };
}

test("run/all/batch aggregate each statement once and prefer SQL timings over duration", async () => {
  const responses = [
    {
      meta: {
        timings: { sql_duration_ms: 1.25 },
        duration: 999,
        rows_read: 3,
        rows_written: 1,
        total_attempts: 3,
        served_by_region: "ENAM",
      },
      results: [{ private: "not retained" }],
    },
    {
      meta: {
        duration: 2.5,
        rows_read: 0,
        rows_written: 0,
        total_attempts: 1,
        served_by_region: "WEUR",
      },
    },
    [
      {
        meta: {
          timings: { sql_duration_ms: 0 },
          duration: 999,
          rows_read: 7,
          rows_written: 2,
          total_attempts: 2,
          served_by_region: "ENAM",
        },
      },
      {
        meta: {
          duration: 4,
          rows_read: 8,
          rows_written: 4,
          served_by_region: "private-region",
          served_by_colo: "private-colo",
        },
      },
    ],
  ];
  let index = 0;
  const measured = fixture(() => responses[index++]);
  const statement = measured.database.prepare("private SQL").bind("private");
  assert.equal(await statement.run(), responses[0]);
  assert.equal(await statement.all(), responses[1]);
  assert.equal(
    await measured.database.batch([statement, statement]),
    responses[2],
  );
  assert.deepEqual(measured.metrics, {
    calls: 3,
    statements: 4,
    durationMs: measured.metrics.durationMs,
    wallMs: measured.metrics.wallMs,
    metadataStatements: 4,
    sqlDurationMs: 7.75,
    sqlTimingStatements: 4,
    rowsRead: 18,
    rowsReadStatements: 4,
    rowsWritten: 7,
    rowsWrittenStatements: 4,
    retryAttempts: 3,
    retryStatements: 3,
    servedByRegions: { ENAM: 2, WEUR: 1 },
  });
  assert.doesNotMatch(JSON.stringify(measured.metrics), /private|retained|999/);
});

test("first/raw preserve arguments, row identity and errors without inspecting row metadata", async () => {
  const row = { meta: { duration: 999, rows_read: 999 } };
  const raw = [[row]];
  const missingColumn = new Error("D1_ERROR: column missing");
  const measured = fixture((method, args) => {
    if (method === "first" && args[0] === "missing") throw missingColumn;
    return method === "first" ? row : raw;
  });
  const statement = measured.database.prepare("SELECT");
  assert.equal(await statement.first(), row);
  assert.equal(await statement.first("meta"), row);
  const options = { columnNames: true } as const;
  assert.equal(await statement.raw(options), raw);
  await assert.rejects(statement.first("missing"), (error) => {
    assert.equal(error, missingColumn);
    return true;
  });
  assert.deepEqual(measured.calls, [
    { method: "first", args: [] },
    { method: "first", args: ["meta"] },
    { method: "raw", args: [options] },
    { method: "first", args: ["missing"] },
  ]);
  assert.equal(measured.metrics.calls, 4);
  assert.equal(measured.metrics.statements, 4);
  assert.equal(measured.metrics.metadataStatements, 0);
  assert.equal(measured.metrics.sqlDurationMs, 0);
  assert.equal(measured.metrics.rowsRead, 0);
});

test("missing metadata and rejected calls do not fabricate response coverage", async () => {
  const failure = new Error("private failure");
  const responses = [null, {}, [null, {}]];
  let index = 0;
  const measured = fixture(() => {
    if (index === responses.length) throw failure;
    return responses[index++];
  });
  const statement = measured.database.prepare("SELECT");
  assert.equal(await statement.run(), null);
  await statement.all();
  await measured.database.batch([statement, statement]);
  await assert.rejects(statement.run(), (error) => error === failure);
  assert.equal(measured.metrics.calls, 4);
  assert.equal(measured.metrics.statements, 5);
  assert.equal(measured.metrics.metadataStatements, 0);
  assert.equal(measured.metrics.sqlTimingStatements, 0);
  assert.equal(measured.metrics.rowsReadStatements, 0);
  assert.equal(measured.metrics.rowsWrittenStatements, 0);
  assert.equal(measured.metrics.retryStatements, 0);
  assert.deepEqual(measured.metrics.servedByRegions, {});
});

test("invalid numeric metadata, accessors and proxies cannot fail queries or retain values", async () => {
  const invalid = [-1, Number.NaN, Number.POSITIVE_INFINITY, "private", null];
  const responses: unknown[] = invalid.map((value) => ({
    meta: {
      timings: { sql_duration_ms: value },
      duration: value,
      rows_read: value,
      rows_written: value,
      total_attempts: value,
      served_by_region: "private-region",
    },
  }));
  let getterReads = 0;
  const accessors = Object.defineProperties(
    {},
    Object.fromEntries(
      [
        "duration",
        "timings",
        "rows_read",
        "rows_written",
        "total_attempts",
      ].map((field) => [
        field,
        {
          get() {
            getterReads++;
            throw new Error("private getter");
          },
        },
      ]),
    ),
  );
  responses.push({ meta: accessors });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  responses.push({ meta: revoked.proxy });
  responses.push({ meta: [] });
  responses.push({
    meta: {
      timings: { sql_duration_ms: -1 },
      duration: 0.5,
      rows_read: 0.5,
      rows_written: 0.5,
      total_attempts: 0,
      served_by_region: "WNAM",
    },
    get results() {
      throw new Error("must not inspect rows");
    },
  });
  let index = 0;
  const measured = fixture(() => responses[index++]);
  const statement = measured.database.prepare("SELECT");
  for (const response of responses)
    assert.equal(await statement.run(), response);
  assert.equal(getterReads, 0);
  assert.equal(measured.metrics.metadataStatements, 7);
  assert.equal(measured.metrics.sqlDurationMs, 0.5);
  assert.equal(measured.metrics.sqlTimingStatements, 1);
  assert.equal(measured.metrics.rowsReadStatements, 0);
  assert.equal(measured.metrics.rowsWrittenStatements, 0);
  assert.equal(measured.metrics.retryStatements, 0);
  assert.deepEqual(measured.metrics.servedByRegions, { WNAM: 1 });
  assert.doesNotMatch(JSON.stringify(measured.metrics), /private/);
});

test("metadata aggregates remain finite and bounded", async () => {
  const measured = fixture(() => ({
    meta: {
      duration: Number.MAX_SAFE_INTEGER,
      rows_read: Number.MAX_SAFE_INTEGER,
      rows_written: Number.MAX_SAFE_INTEGER,
      total_attempts: Number.MAX_SAFE_INTEGER,
    },
  }));
  await measured.database.prepare("SELECT").run();
  await measured.database.prepare("SELECT").run();
  assert.equal(measured.metrics.sqlDurationMs, Number.MAX_SAFE_INTEGER);
  assert.equal(measured.metrics.rowsRead, Number.MAX_SAFE_INTEGER);
  assert.equal(measured.metrics.rowsWritten, Number.MAX_SAFE_INTEGER);
  assert.equal(measured.metrics.retryAttempts, Number.MAX_SAFE_INTEGER);
  assert.equal(measured.metrics.sqlTimingStatements, 2);
});

test("batch metadata errors do not hide later members or inspect excess result entries", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const measured = fixture(() => [
    { meta: revoked.proxy },
    { meta: { duration: 3, total_attempts: 1 } },
    { meta: { duration: 999 } },
  ]);
  const statement = measured.database.prepare("SELECT");
  await measured.database.batch([statement, statement]);
  assert.equal(measured.metrics.calls, 1);
  assert.equal(measured.metrics.statements, 2);
  assert.equal(measured.metrics.metadataStatements, 1);
  assert.equal(measured.metrics.sqlTimingStatements, 1);
  assert.equal(measured.metrics.sqlDurationMs, 3);
  assert.equal(measured.metrics.retryAttempts, 0);
  assert.equal(measured.metrics.retryStatements, 1);
});

test("overlapping RPCs retain cumulative duration and union wall time on rejection", async (t) => {
  let now = 10;
  t.mock.method(Date, "now", () => now);
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  let index = 0;
  const measured = fixture(() =>
    index++ === 0 ? first.promise : second.promise,
  );
  const firstCall = measured.database.prepare("SELECT").all();
  now = 15;
  const secondCall = measured.database.prepare("SELECT").run();
  now = 25;
  first.resolve({ meta: { duration: 2 } });
  await firstCall;
  assert.equal(measured.metrics.durationMs, 15);
  assert.equal(measured.metrics.wallMs, 0);
  now = 40;
  const failure = new Error("private rejected RPC");
  second.reject(failure);
  await assert.rejects(secondCall, (error) => error === failure);
  assert.equal(measured.metrics.durationMs, 40);
  assert.equal(measured.metrics.wallMs, 30);
  assert.equal(measured.metrics.calls, 2);
  assert.equal(measured.metrics.statements, 2);
  assert.equal(measured.metrics.sqlDurationMs, 2);
  assert.equal(measured.metrics.sqlTimingStatements, 1);
});
