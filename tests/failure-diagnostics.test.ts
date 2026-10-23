import assert from "node:assert/strict";
import test from "node:test";
import {
  createFailureDiagnostics,
  type FailureStage,
  type FailureVendor,
} from "../src/failure-diagnostics.ts";
import { LotwLoginError } from "../src/lotw.ts";
import { QrzError } from "../src/qrz.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

test("shared failures count one event and all affected routes per fixed key", () => {
  const diagnostics = createFailureDiagnostics();
  const failure = new QrzError("transient", "private request details");
  diagnostics.record(failure, "history_read", "qrz");
  diagnostics.record(failure, "history_read", "qrz", 3);
  diagnostics.record(
    new QrzError("transient", "another private response"),
    "history_read",
    "qrz",
    2,
  );
  assert.deepEqual(diagnostics.counts["history_read:qrz:qrz_transient"], {
    events: 2,
    affected: 6,
  });
  diagnostics.record(failure, "history_group", "qrz");
  assert.deepEqual(diagnostics.counts["history_group:qrz:qrz_transient"], {
    events: 1,
    affected: 1,
  });
  const nextInvocation = createFailureDiagnostics();
  nextInvocation.record(failure, "history_read", "qrz");
  assert.deepEqual(nextInvocation.counts["history_read:qrz:qrz_transient"], {
    events: 1,
    affected: 1,
  });
});

test("known protocol, report, retention and D1 guard errors have fixed codes", () => {
  const cases: [unknown, string][] = [
    [
      new QrzError("protocol", "Inconsistent QRZ inventory framing"),
      "qrz_inventory_framing",
    ],
    [
      new QrzError("protocol", "Invalid or repeated QRZ LOGID"),
      "qrz_logid_invalid_or_repeated",
    ],
    [
      new QrzError("protocol", "private unknown protocol response"),
      "qrz_protocol",
    ],
    [
      new QrzError("protocol", "QRZ response body could not be read"),
      "qrz_response_body_unreadable",
    ],
    [
      new QrzError("protocol", "Invalid QRZ response UTF-8"),
      "qrz_response_utf8",
    ],
    [new QrzError("rejected", "private rejection"), "qrz_rejected"],
    [new LotwLoginError("credentials"), "lotw_credentials"],
    [new LotwLoginError("unavailable"), "lotw_login_unavailable"],
    [
      new Error("LoTW report count or program identity mismatch"),
      "lotw_report_count_or_identity",
    ],
    [new Error("Malformed ADIF field"), "adif_field_invalid"],
    [
      new Error("History response does not match partition scope"),
      "history_scope_mismatch",
    ],
    [
      new Error("History partition exceeds retained evidence bound"),
      "history_partition_bound",
    ],
    [
      new Error("D1_ERROR: history lease lost: SQLITE_CONSTRAINT"),
      "history_lease_lost",
    ],
    [
      new Error("D1_ERROR: history connection changed: SQLITE_CONSTRAINT"),
      "history_connection_changed",
    ],
    [
      new Error("D1_ERROR: too many SQL variables at offset 12: private SQL"),
      "db_bind_limit",
    ],
    [new Error("D1_ERROR: unknown private database detail"), "db_d1"],
    [new Error("D1_TYPE_ERROR: private bound value"), "db_bind_type"],
    [new VendorDeferredError(100), "vendor_budget_deferred"],
    [new VendorDeferredError(100, true), "vendor_response_deferred"],
  ];
  for (const [error, code] of cases) {
    const diagnostics = createFailureDiagnostics();
    diagnostics.record(error, "history_read");
    assert.deepEqual(Object.keys(diagnostics.counts), [
      `history_read:none:${code}`,
    ]);
  }
});

test("arbitrary messages, names, causes, thrown values and long SQL are never serialized", () => {
  const diagnostics = createFailureDiagnostics();
  const secret = "private-call-password-payload";
  const wrapped = new Error(secret, { cause: new QrzError("auth", secret) });
  wrapped.name = secret;
  wrapped.stack = secret;
  for (const error of [
    wrapped,
    secret,
    { message: secret, name: secret, cause: wrapped },
    null,
    new Error(`Malformed ADIF field ${secret}`),
  ])
    diagnostics.record(error, "contact");
  diagnostics.record(
    new Error(`D1_ERROR: history lease lost: ${secret.repeat(1000)}`),
    "history_group",
    "qrz",
  );
  assert.deepEqual(diagnostics.counts["contact:none:unknown"], {
    events: 5,
    affected: 5,
  });
  assert.deepEqual(diagnostics.counts["history_group:qrz:history_lease_lost"], {
    events: 1,
    affected: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(diagnostics.counts),
    /private|password|payload|cause|stack|auth/,
  );
});

test("telemetry ignores accessors and cannot throw from hostile error inspection", () => {
  const diagnostics = createFailureDiagnostics();
  const error = new Error();
  Object.defineProperties(error, {
    message: {
      get() {
        throw new Error("must not read message getter");
      },
    },
    cause: {
      get() {
        throw new Error("must not read cause getter");
      },
    },
    name: {
      get() {
        throw new Error("must not read name getter");
      },
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("private proxy detail");
      },
    },
  );
  assert.doesNotThrow(() => diagnostics.record(error, "contact"));
  assert.doesNotThrow(() => diagnostics.record(proxy, "contact"));
  assert.deepEqual(diagnostics.counts["contact:none:unknown"], {
    events: 2,
    affected: 2,
  });
});

test("invalid dimensions and numeric inputs cannot create unbounded or unsafe telemetry", () => {
  const diagnostics = createFailureDiagnostics();
  const error = new Error("private");
  diagnostics.record(error, "private-stage" as FailureStage, "qrz");
  for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    diagnostics.record(error, "contact", "qrz", count);
  assert.deepEqual(Object.keys(diagnostics.counts), []);
  diagnostics.record(error, "contact", "private-vendor" as FailureVendor, 2.9);
  assert.deepEqual(diagnostics.counts["contact:none:unknown"], {
    events: 1,
    affected: 2,
  });
  diagnostics.record(error, "contact", undefined, Number.MAX_VALUE);
  diagnostics.record(error, "contact", undefined, 1);
  assert.deepEqual(diagnostics.counts["contact:none:unknown"], {
    events: 1,
    affected: Number.MAX_SAFE_INTEGER,
  });
});
