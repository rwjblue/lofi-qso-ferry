import assert from "node:assert/strict";
import test from "node:test";
import { getAdminOverview } from "../src/admin-metrics.ts";
import { VENDOR_POLICIES } from "../src/vendor-requests.ts";
import { database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

test("admin overview keeps local request capacity distinct from upstream cooldowns", async (t) => {
  const f = await database();
  t.after(() => f.mf.dispose());
  await applyAdditionalMigrations(f.db);
  await seed(f.store);
  const env = fixtureEnvironment(f.db);
  const now = Date.UTC(2026, 10, 9);
  await f.db.batch([
    f.db
      .prepare("INSERT INTO vendor_requests VALUES('qrz',?,?,?,0)")
      .bind(
        now,
        VENDOR_POLICIES.qrz.background,
        VENDOR_POLICIES.qrz.background,
      ),
    f.db
      .prepare("INSERT INTO vendor_requests VALUES('lotw',?,1,0,?)")
      .bind(now, now + 10 * 60_000),
    f.db.prepare(
      "UPDATE connections SET config=json_object('lastError','private provider response') WHERE kind='qrz'",
    ),
  ]);

  const snapshot = await getAdminOverview(env, now);
  assert.equal(snapshot.inventoryRuntime, "off");
  assert.equal(snapshot.gates.effective, false);
  assert.deepEqual(
    snapshot.providers.map(({ provider, contacts }) => [provider, contacts]),
    [
      ["lofi", 0],
      ["qrz", 0],
      ["lotw", 0],
    ],
  );
  assert.equal(snapshot.accounts.total, 1);
  assert.equal(snapshot.connections.total, 2);
  const qrz = snapshot.vendors.find(({ vendor }) => vendor === "qrz");
  assert.equal(qrz?.backgroundRequests, qrz?.backgroundLimit);
  assert.equal(qrz?.cooldownUntil, null);
  const lotw = snapshot.vendors.find(({ vendor }) => vendor === "lotw");
  assert.equal(lotw?.requests, 1);
  assert.equal(lotw?.cooldownUntil, now + 10 * 60_000);
  const connection = snapshot.connections.items.find(
    ({ kind }) => kind === "qrz",
  );
  assert.equal(connection?.hasError, true);
  assert.equal(connection?.coverageReady, 0);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private provider response|credential_version|envelope/,
  );

  const rollover = await getAdminOverview(
    env,
    now + VENDOR_POLICIES.qrz.windowMs,
  );
  assert.equal(
    rollover.vendors.find(({ vendor }) => vendor === "qrz")?.requests,
    0,
  );
  assert.equal(
    rollover.vendors.find(({ vendor }) => vendor === "lotw")?.cooldownUntil,
    now + 10 * 60_000,
  );
});
