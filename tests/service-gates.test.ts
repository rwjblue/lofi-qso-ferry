import assert from "node:assert/strict";
import test from "node:test";
import { deliveryGates, exportsEffective } from "../src/service.ts";

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
