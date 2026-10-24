import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryGates,
  exportAuthorizationMode,
  exportsEffective,
  routeDeliveryMode,
} from "../src/service.ts";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    EXPORTS_ENABLED: "true",
    ROLLOUT_CHECKS_PASSED: "true",
    LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    SOURCE_BOUNDARY_VERIFIED: "true",
    ROLLOUT_QSO_IDS_JSON: '["reviewed-contact"]',
    ROLLOUT_DESTINATION_IDS_JSON: '["reviewed-qrz-book"]',
    ...overrides,
  } as Env;
}

test("production export scope requires explicit contacts and destinations", () => {
  const gates = deliveryGates(environment());
  assert.equal(exportsEffective(gates), true);
  assert.deepEqual(gates.allowedQsoIds, ["reviewed-contact"]);
  assert.deepEqual(gates.allowedDestinationIds, ["reviewed-qrz-book"]);
  for (const field of [
    "ROLLOUT_QSO_IDS_JSON",
    "ROLLOUT_DESTINATION_IDS_JSON",
  ] as const) {
    for (const value of ["[]", "", undefined])
      assert.equal(
        exportsEffective(deliveryGates(environment({ [field]: value }))),
        false,
      );
    assert.equal(
      exportsEffective(deliveryGates(environment({ [field]: '["*"]' }))),
      true,
    );
    for (const value of ['["*","other"]', '[""]', "null", "{}", "[3]"])
      assert.throws(() => deliveryGates(environment({ [field]: value })));
  }
});

test("destination scope cannot waive any existing export gate", () => {
  for (const field of [
    "EXPORTS_ENABLED",
    "ROLLOUT_CHECKS_PASSED",
    "LIVE_WRITE_AUTHORIZATION",
    "SOURCE_BOUNDARY_VERIFIED",
  ] as const)
    assert.equal(
      exportsEffective(deliveryGates(environment({ [field]: "false" }))),
      false,
    );
});

test("QRZ first inserts require explicit mode consent and both scopes without asserting a boundary", () => {
  const env = environment({
    SOURCE_BOUNDARY_VERIFIED: "false",
    QRZ_FRESH_INSERTS_ENABLED: "true",
  });
  const gates = deliveryGates(env);
  const qrz = { id: "reviewed-qrz-book", kind: "qrz" as const };
  assert.equal(exportAuthorizationMode(gates), "qrz_fresh_insert");
  assert.equal(gates.sourceBoundaryVerified, false);
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", qrz),
    "qrz_fresh_insert",
  );
  assert.equal(routeDeliveryMode(gates, "another-contact", qrz), null);
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", {
      ...qrz,
      id: "another-book",
    }),
    null,
  );
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", { ...qrz, kind: "lotw" }),
    null,
  );
  for (const [field, values] of [
    ["EXPORTS_ENABLED", ["false", undefined]],
    ["ROLLOUT_CHECKS_PASSED", ["false", undefined]],
    ["LIVE_WRITE_AUTHORIZATION", ["", "true", undefined]],
    ["QRZ_FRESH_INSERTS_ENABLED", ["false", "TRUE", "1", undefined]],
    ["ROLLOUT_QSO_IDS_JSON", ["[]", undefined]],
    ["ROLLOUT_DESTINATION_IDS_JSON", ["[]", undefined]],
  ] as const)
    for (const value of values) {
      const disabled = deliveryGates({ ...env, [field]: value } as Env);
      assert.equal(exportsEffective(disabled), false, `${field}=${value}`);
      assert.equal(routeDeliveryMode(disabled, "reviewed-contact", qrz), null);
    }
  const boundary = deliveryGates({ ...env, SOURCE_BOUNDARY_VERIFIED: "true" });
  assert.equal(exportAuthorizationMode(boundary), "source_boundary");
  assert.equal(
    routeDeliveryMode(boundary, "reviewed-contact", { ...qrz, kind: "lotw" }),
    "source_boundary",
  );
});

test("LoTW first inserts have independent consent and cannot enable QRZ or waive common gates", () => {
  const env = environment({
    SOURCE_BOUNDARY_VERIFIED: "false",
    LOTW_FRESH_INSERTS_ENABLED: "true",
    ROLLOUT_DESTINATION_IDS_JSON: '["reviewed-lotw"]',
  });
  const destination = { id: "reviewed-lotw", kind: "lotw" as const };
  const gates = deliveryGates(env);
  assert.equal(exportsEffective(gates), true);
  assert.equal(exportAuthorizationMode(gates), "lotw_fresh_insert");
  assert.equal(gates.sourceBoundaryVerified, false);
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", destination),
    "lotw_fresh_insert",
  );
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", {
      ...destination,
      kind: "qrz",
    }),
    null,
  );
  assert.equal(routeDeliveryMode(gates, "other-contact", destination), null);
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", {
      ...destination,
      id: "other-book",
    }),
    null,
  );
  for (const [field, values] of [
    ["EXPORTS_ENABLED", ["false", undefined]],
    ["ROLLOUT_CHECKS_PASSED", ["false", undefined]],
    ["LIVE_WRITE_AUTHORIZATION", ["", "true", undefined]],
    ["LOTW_FRESH_INSERTS_ENABLED", ["false", "TRUE", "1", undefined]],
    ["ROLLOUT_QSO_IDS_JSON", ["[]", undefined]],
    ["ROLLOUT_DESTINATION_IDS_JSON", ["[]", undefined]],
  ] as const) {
    for (const value of values) {
      const disabled = deliveryGates({ ...env, [field]: value } as Env);
      assert.equal(exportsEffective(disabled), false, `${field}=${value}`);
      assert.equal(exportAuthorizationMode(disabled), null);
      assert.equal(
        routeDeliveryMode(disabled, "reviewed-contact", destination),
        null,
      );
    }
  }
  const wildcard = deliveryGates({
    ...env,
    ROLLOUT_QSO_IDS_JSON: '["*"]',
    ROLLOUT_DESTINATION_IDS_JSON: '["*"]',
  });
  assert.equal(
    routeDeliveryMode(wildcard, "explicit-all-contact", {
      ...destination,
      id: "explicit-all-book",
    }),
    "lotw_fresh_insert",
  );
});

test("combined first-insert status never asserts source completeness", () => {
  const env = environment({
    SOURCE_BOUNDARY_VERIFIED: "false",
    QRZ_FRESH_INSERTS_ENABLED: "true",
    LOTW_FRESH_INSERTS_ENABLED: "true",
    ROLLOUT_DESTINATION_IDS_JSON: '["*"]',
  });
  const gates = deliveryGates(env);
  assert.equal(exportAuthorizationMode(gates), "fresh_inserts");
  for (const kind of ["qrz", "lotw"] as const)
    assert.equal(
      routeDeliveryMode(gates, "reviewed-contact", { id: kind, kind }),
      `${kind}_fresh_insert`,
    );
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", {
      id: "source",
      kind: "lofi",
    }),
    null,
  );
  assert.equal(
    exportAuthorizationMode(
      deliveryGates({ ...env, SOURCE_BOUNDARY_VERIFIED: "true" }),
    ),
    "source_boundary",
  );
  assert.equal(
    exportAuthorizationMode(
      deliveryGates({ ...env, EXPORTS_ENABLED: "false" }),
    ),
    null,
  );
});
