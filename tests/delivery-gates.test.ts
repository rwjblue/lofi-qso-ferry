import assert from "node:assert/strict";
import test from "node:test";
import { deliveryGates, routeDeliveryMode } from "../src/delivery-gates.ts";
import { inventoryWriteStatus } from "../src/inventory-delivery-send.ts";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    EXPORTS_ENABLED: "true",
    ROLLOUT_CHECKS_PASSED: "true",
    LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    QRZ_FRESH_INSERTS_ENABLED: "true",
    LOTW_FRESH_INSERTS_ENABLED: "true",
    ROLLOUT_QSO_IDS_JSON: '["reviewed-contact"]',
    ROLLOUT_DESTINATION_IDS_JSON: '["reviewed-book"]',
    ...overrides,
  } as Env;
}

const closed = { exportsEnabled: false, exportMode: null };

test("native status follows the active sender and provider gates", () => {
  for (const mode of ["off", "read_only", "selected_qrz"])
    assert.deepEqual(
      inventoryWriteStatus(environment({ INVENTORY_RUNTIME_MODE: mode })),
      closed,
    );
  assert.deepEqual(
    inventoryWriteStatus(environment({ INVENTORY_RUNTIME_MODE: "managed" })),
    { exportsEnabled: true, exportMode: "fresh_inserts" },
  );
  assert.deepEqual(
    inventoryWriteStatus(
      environment({
        INVENTORY_RUNTIME_MODE: "managed",
        QRZ_FRESH_INSERTS_ENABLED: "false",
      }),
    ),
    { exportsEnabled: true, exportMode: "lotw_fresh_insert" },
  );
});

test("common write authorization and both scopes are required", () => {
  for (const field of [
    "EXPORTS_ENABLED",
    "ROLLOUT_CHECKS_PASSED",
    "LIVE_WRITE_AUTHORIZATION",
  ] as const)
    assert.deepEqual(
      inventoryWriteStatus(
        environment({ INVENTORY_RUNTIME_MODE: "managed", [field]: "false" }),
      ),
      closed,
    );
  for (const field of [
    "ROLLOUT_QSO_IDS_JSON",
    "ROLLOUT_DESTINATION_IDS_JSON",
  ] as const) {
    for (const value of [
      "[]",
      "",
      '["*","other"]',
      '[""]',
      "null",
      "{}",
      "[3]",
    ])
      assert.deepEqual(
        inventoryWriteStatus(
          environment({ INVENTORY_RUNTIME_MODE: "managed", [field]: value }),
        ),
        closed,
      );
    assert.equal(
      inventoryWriteStatus(
        environment({ INVENTORY_RUNTIME_MODE: "managed", [field]: '["*"]' }),
      ).exportsEnabled,
      true,
    );
  }
});

test("route authorization uses the actual contact, connection and provider", () => {
  const destination = { id: "reviewed-book", kind: "qrz" as const };
  const gates = deliveryGates(environment());
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", destination),
    "qrz_fresh_insert",
  );
  assert.equal(routeDeliveryMode(gates, "other-contact", destination), null);
  assert.equal(
    routeDeliveryMode(gates, "reviewed-contact", {
      ...destination,
      id: "other-book",
    }),
    null,
  );
  assert.equal(
    routeDeliveryMode(
      deliveryGates(environment({ QRZ_FRESH_INSERTS_ENABLED: "false" })),
      "reviewed-contact",
      destination,
    ),
    null,
  );
});
