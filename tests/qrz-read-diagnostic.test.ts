import assert from "node:assert/strict";
import test from "node:test";
import { qrzReadDiagnostic } from "../scripts/qrz-read-diagnostic.ts";
import { serializeAdifRecord } from "../src/adif.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const apiKey = "private-key-never-report";
const selection = {
  between: ["2026-01-01", "2026-01-07"] as [string, string],
  afterLogId: 123456789,
};
const control = {
  QSO_DATE: "20261023",
  APP_QRZLOG_LOGID: "987654321",
  CALL: "PRIVATE",
  COMMENT: "private response narrative",
};
function response(data: Record<string, string>): Response {
  return new Response(new URLSearchParams(data).toString());
}
const positive = () =>
  response({
    RESULT: "OK",
    COUNT: "876543210",
    ADIF: serializeAdifRecord(control),
  });

test("QRZ differential diagnostic generates only four allowlisted reads and reports fixed metadata", async () => {
  const requests: string[] = [];
  const report = await qrzReadDiagnostic({
    apiKey,
    selection,
    fetcher: async (url, init) => {
      assert.equal(url, "https://logbook.qrz.com/api");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert(init?.signal instanceof AbortSignal);
      assert.equal(
        new Headers(init?.headers).get("User-Agent"),
        "LoFiQSOFerry/0.1.0",
      );
      assert(init?.body instanceof URLSearchParams);
      assert.deepEqual([...init.body.keys()], ["KEY", "ACTION", "OPTION"]);
      assert.equal(init.body.get("KEY"), apiKey);
      assert.equal(init.body.get("ACTION"), "FETCH");
      requests.push(init.body.get("OPTION")!);
      if (requests.length <= 2)
        return response({
          RESULT: "FAIL",
          COUNT: "0",
          REASON: "private vendor rejection",
        });
      return positive();
    },
  });
  assert.deepEqual(requests, [
    "TYPE:ADIF,MAX:1,AFTERLOGID:123456789,BETWEEN:2026-01-01+2026-01-07",
    "TYPE:ADIF,MAX:0,AFTERLOGID:123456789,BETWEEN:2026-01-01+2026-01-07",
    "TYPE:ADIF,MAX:1,AFTERLOGID:0",
    "TYPE:ADIF,MAX:1,AFTERLOGID:0,BETWEEN:2026-10-23+2026-10-23",
  ]);
  assert.equal(report.requestAttempts, 4);
  assert.deepEqual(
    report.steps.map(({ step, result, count }) => ({ step, result, count })),
    [
      { step: "selection", result: "fail", count: "zero" },
      { step: "selection_count", result: "fail", count: "zero" },
      { step: "control", result: "ok", count: "positive" },
      { step: "control_date", result: "ok", count: "positive" },
    ],
  );
  assert.equal(report.steps[0].reasonPresent, true);
  assert.equal(report.steps[2].records, "one");
  assert.doesNotMatch(
    JSON.stringify(report),
    /private|PRIVATE|2026|123456789|987654321|876543210|BETWEEN|LOGID|API|KEY/,
  );
  assert(!JSON.stringify(report).includes("absence"));
});

test("QRZ diagnostic keeps rejected, absent and malformed control evidence unavailable", async (t) => {
  for (const [name, factory, records] of [
    ["rejected", () => response({ RESULT: "FAIL", COUNT: "0" }), "not_checked"],
    ["zero", () => response({ RESULT: "OK", COUNT: "0" }), "zero"],
    [
      "malformed",
      () => response({ RESULT: "OK", COUNT: "1", ADIF: "private-not-adif" }),
      "invalid",
    ],
    [
      "multiple",
      () =>
        response({
          RESULT: "OK",
          COUNT: "2",
          ADIF: serializeAdifRecord(control).repeat(2),
        }),
      "multiple",
    ],
    [
      "invalid date",
      () =>
        response({
          RESULT: "OK",
          COUNT: "1",
          ADIF: serializeAdifRecord({ ...control, QSO_DATE: "20260230" }),
        }),
      "one",
    ],
    [
      "invalid identity",
      () =>
        response({
          RESULT: "OK",
          COUNT: "1",
          ADIF: serializeAdifRecord({
            ...control,
            APP_QRZLOG_LOGID: "private",
          }),
        }),
      "one",
    ],
    [
      "invalid count",
      () =>
        response({
          RESULT: "OK",
          COUNT: "private-count",
          ADIF: serializeAdifRecord(control),
        }),
      "one",
    ],
  ] as const)
    await t.test(name, async () => {
      const report = await qrzReadDiagnostic({
        apiKey,
        selection,
        fetcher: async () => factory(),
      });
      assert.equal(report.requestAttempts, 3);
      assert.equal(report.steps[2].records, records);
      assert.equal(report.steps[3].state, "skipped_no_control");
      assert.doesNotMatch(JSON.stringify(report), /private|2026/);
    });
});

test("QRZ diagnostic reports bounded HTTP classes without consuming error bodies or following redirects", async (t) => {
  for (const [status, expected] of [
    [302, "redirect"],
    [401, "auth"],
    [403, "auth"],
    [404, "client_error"],
    [503, "server_error"],
  ] as const)
    await t.test(String(status), async () => {
      let reads = 0;
      let cancellations = 0;
      const report = await qrzReadDiagnostic({
        apiKey,
        selection,
        fetcher: async () => {
          const body = new ReadableStream<Uint8Array>(
            {
              pull() {
                reads++;
              },
              cancel() {
                cancellations++;
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body, {
            status,
            headers: { Location: "https://private.invalid/INSERT" },
          });
        },
      });
      assert.equal(reads, 0);
      assert.equal(cancellations, 3);
      assert(
        report.steps
          .slice(0, 3)
          .every(
            (step) => step.state === "http_error" && step.http === expected,
          ),
      );
      assert.equal(report.requestAttempts, 3);
      assert.doesNotMatch(JSON.stringify(report), /private|INSERT/);
    });
});

test("QRZ diagnostic bounds response bodies and discards arbitrary parser and transport errors", async (t) => {
  for (const [name, factory, state] of [
    [
      "size",
      () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
      "response_bound",
    ],
    [
      "html",
      () => new Response("<html>private response</html>"),
      "invalid_response",
    ],
    ["utf8", () => new Response(new Uint8Array([0xff])), "invalid_response"],
    [
      "duplicate",
      () => new Response("RESULT=FAIL&RESULT=OK&REASON=private"),
      "invalid_response",
    ],
    [
      "transport",
      () => {
        throw new Error("private credential", {
          cause: new Error("private payload"),
        });
      },
      "transport_error",
    ],
  ] as const)
    await t.test(name, async () => {
      const report = await qrzReadDiagnostic({
        apiKey,
        selection,
        fetcher: async () => factory(),
      });
      assert.equal(report.steps[0].state, state);
      assert.equal(report.requestAttempts, 3);
      assert.doesNotMatch(
        JSON.stringify(report),
        /private|credential|payload|stack|cause/,
      );
    });
});

test("QRZ diagnostic stops at injected shared-budget deferral without calling another request", async () => {
  let calls = 0;
  const report = await qrzReadDiagnostic({
    apiKey,
    selection,
    fetcher: async () => {
      calls++;
      throw new VendorDeferredError(987654321);
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.requestAttempts, 1);
  assert(report.steps.every((step) => step.state === "budget_deferred"));
  assert.doesNotMatch(JSON.stringify(report), /987654321/);
});

test("QRZ diagnostic observes deadline and continuation budget before every request", async () => {
  let clock = 100;
  let calls = 0;
  const report = await qrzReadDiagnostic({
    apiKey,
    selection,
    now: () => clock,
    deadlineAt: 200,
    fetcher: async () => {
      calls++;
      clock = 200;
      return positive();
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.steps[0].state, "response");
  assert(report.steps.slice(1).every((step) => step.state === "deadline"));
  const skipped = await qrzReadDiagnostic({
    apiKey,
    selection,
    shouldContinue: () => false,
    fetcher: async () => {
      throw new Error("must not call");
    },
  });
  assert.equal(skipped.requestAttempts, 0);
  assert(skipped.steps.every((step) => step.state === "deadline"));
});

test("QRZ diagnostic aborts an in-flight read at its total deadline", async () => {
  let signal: AbortSignal | null | undefined;
  const report = await qrzReadDiagnostic({
    apiKey,
    selection,
    deadlineAt: Date.now() + 20,
    fetcher: async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    },
  });
  assert.equal(signal?.aborted, true);
  assert.equal(report.requestAttempts, 1);
  assert(report.steps.every((step) => step.state === "deadline"));
});

test("QRZ diagnostic rejects invalid selection configuration before transport", async () => {
  for (const invalid of [
    { between: ["2026-02-30", "2026-03-01"] as [string, string] },
    { between: ["2026-01-07", "2026-01-01"] as [string, string] },
    { ...selection, afterLogId: -1 },
    { ...selection, afterLogId: 1.5 },
  ])
    await assert.rejects(
      qrzReadDiagnostic({
        apiKey,
        selection: invalid,
        fetcher: async () => {
          throw new Error("must not call");
        },
      }),
      /Invalid QRZ read diagnostic configuration/,
    );
});
