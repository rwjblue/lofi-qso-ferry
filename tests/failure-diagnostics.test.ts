import assert from "node:assert/strict";
import test from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { serializeAdifRecord } from "../src/adif.ts";
import {
  createFailureDiagnostics,
  type FailureStage,
  type FailureVendor,
} from "../src/failure-diagnostics.ts";
import { LotwClient, LotwLoginError } from "../src/lotw.ts";
import { QrzError } from "../src/qrz.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { applyMigration } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

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
    [
      new QrzError(
        "rejected",
        "private rejection",
        "ambiguous_empty_selection",
      ),
      "qrz_ambiguous_empty_selection",
    ],
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
      new Error("History response is missing required identity fields"),
      "history_identity_missing",
    ],
    [
      new Error("History response is missing station callsign"),
      "history_station_missing",
    ],
    [
      new Error("History response station does not match partition"),
      "history_station_mismatch",
    ],
    [
      new Error("History response date is outside partition"),
      "history_date_outside_partition",
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

test("rejected LoTW responses retain safe actionable diagnostic categories", async () => {
  const record = {
    CALL: "K1ABC",
    STATION_CALLSIGN: "W1AW",
    BAND: "20m",
    MODE: "FT8",
    QSO_DATE: "20261022",
    TIME_ON: "123456",
    QSL_RCVD: "N",
  };
  for (const [row, stationCallsign, code] of [
    [{ ...record, QSO_DATE: "20260230" }, "W1AW", "lotw_report_fields_invalid"],
    [{ ...record, CALL: "K2ABC" }, "W1AW", "lotw_report_scope_mismatch"],
    [record, "bad station", "lotw_query_callsign_invalid"],
  ] as const) {
    const diagnostics = createFailureDiagnostics();
    const client = new LotwClient(
      { username: "private-account", password: "private-password" },
      {
        fetcher: async () =>
          new Response(
            `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>1<EOH>${serializeAdifRecord(row)}<APP_LOTW_EOF>`,
          ),
      },
    );
    await assert.rejects(
      client.query({
        startDate: "2026-10-22",
        endDate: "2026-10-22",
        stationCallsign,
        workedCallsign: "K1ABC",
      }),
      (error: unknown) => {
        diagnostics.record(error, "history_read", "lotw");
        return true;
      },
    );
    assert.deepEqual(
      { ...diagnostics.counts },
      {
        [`history_read:lotw:${code}`]: { events: 1, affected: 1 },
      },
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostics.counts),
      /private|K1ABC|K2ABC|W1AW/,
    );
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

test("fixed D1 provider categories distinguish transport, limits and native holds without changing outcomes", () => {
  const cases = [
    ["D1 DB reset because its code was updated.", "db_reset"],
    [
      "Internal error while starting up D1 DB storage caused object to be reset.",
      "db_reset",
    ],
    ["Internal error in D1 DB storage caused object to be reset.", "db_reset"],
    ["Network connection lost.", "db_connection_lost"],
    ["Replica disconnected from primary.", "db_connection_lost"],
    [
      "Cannot resolve D1 DB due to transient issue on remote node.",
      "db_remote_unavailable",
    ],
    [
      "Can't read from request stream because client disconnected.",
      "db_request_disconnected",
    ],
    [
      "D1 DB storage operation exceeded timeout which caused object to be reset.",
      "db_storage_timeout",
    ],
    ["D1 DB is overloaded. Requests queued for too long.", "db_queue_timeout"],
    ["D1 DB is overloaded. Too many requests queued.", "db_queue_full"],
    [
      "D1 DB's isolate exceeded its memory limit and was reset.",
      "db_memory_limit",
    ],
    ["D1 DB exceeded its CPU time limit and was reset.", "db_cpu_limit"],
    [
      "source historical index publication stale: SQLITE_CONSTRAINT",
      "source_index_stale",
    ],
    ["LoTW ownership changed: SQLITE_CONSTRAINT", "lotw_ownership_changed"],
    [
      "LoTW historical publication changed: SQLITE_CONSTRAINT",
      "lotw_history_publication_changed",
    ],
    ["CHECK constraint failed: private table / SQL", "db_constraint"],
    ["UNIQUE constraint failed: private table / SQL", "db_constraint"],
    ["NOT NULL constraint failed: private table / SQL", "db_constraint"],
    ["FOREIGN KEY constraint failed: private table / SQL", "db_constraint"],
  ];
  for (const [message, code] of cases) {
    const error = new Error(`D1_ERROR: ${message}`);
    const diagnostics = createFailureDiagnostics();
    diagnostics.record(error, "contact");
    diagnostics.record(error, "source_cycle", "lofi");
    assert.deepEqual(Object.keys(diagnostics.counts), [
      `contact:none:${code}`,
      `source_cycle:lofi:${code}`,
    ]);
    assert.equal(error.message, `D1_ERROR: ${message}`);
    assert.doesNotMatch(
      JSON.stringify(diagnostics.counts),
      /private|SQLITE|D1_ERROR|table/,
    );
  }
  for (const message of [
    "Too many API requests by single Worker invocation",
    "Too many API requests by single Worker invocation.",
    "D1_ERROR: Too many API requests by single Worker invocation",
  ]) {
    const diagnostics = createFailureDiagnostics();
    diagnostics.record(new Error(message), "scheduler");
    assert.deepEqual(Object.keys(diagnostics.counts), [
      "scheduler:none:db_invocation_limit",
    ]);
  }
});

test("D1 diagnostic text inside private context or causes does not become provider evidence", () => {
  for (const error of [
    new Error("D1_ERROR: private SQL contains Network connection lost."),
    new Error("D1_ERROR: Network connection lost-ish private detail"),
    new Error("D1_ERROR: LoTW ownership changed privately"),
    new Error("D1_ERROR: provider detail unavailable", {
      cause: new Error("D1_ERROR: Network connection lost."),
    }),
  ]) {
    const diagnostics = createFailureDiagnostics();
    diagnostics.record(error, "contact");
    assert.deepEqual(Object.keys(diagnostics.counts), ["contact:none:db_d1"]);
  }
  const wrapped = new Error("private wrapper", {
    cause: new Error("D1_ERROR: Network connection lost."),
  });
  const diagnostics = createFailureDiagnostics();
  diagnostics.record(wrapped, "contact");
  assert.deepEqual(Object.keys(diagnostics.counts), ["contact:none:unknown"]);
});

test("actual native D1 ownership guard rejection stays rejected and emits only its fixed category", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default {fetch(){return new Response("local")}}',
      compatibilityDate: "2026-10-22",
      d1Databases: ["DB"],
      outboundService: () => {
        throw new Error("outbound forbidden");
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await applyMigration(db, "0001_foundation.sql");
    await applyAdditionalMigrations(db);
    const now = Date.now();
    const diagnostics = createFailureDiagnostics();
    await assert.rejects(
      db
        .prepare(
          "INSERT INTO lotw_ownership_write_guards(id,tenant,phase,key_id,clock,comparison_policy,plan,lease_token,lease_fence,checked_at,expires_at) VALUES('private-guard','private-tenant','mapping','private-key',0,1,json_array(json_object('generation','g','sourceHash','h')),'private-lease',1,?,?)",
        )
        .bind(now, now + 1000)
        .run(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^D1_ERROR: LoTW ownership unavailable(?::|$)/,
        );
        diagnostics.record(error, "reconciliation", "lotw");
        assert.deepEqual(Object.keys(diagnostics.counts), [
          "reconciliation:lotw:lotw_ownership_unavailable",
        ]);
        return true;
      },
    );
    assert.equal(
      await db
        .prepare("SELECT COUNT(*) FROM lotw_ownership_write_guards")
        .first("COUNT(*)"),
      0,
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostics.counts),
      /private|SQLITE|D1_ERROR/,
    );
  } finally {
    await mf.dispose();
  }
});
