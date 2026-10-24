import assert from "node:assert/strict";
import test from "node:test";
import { backgroundSources } from "../src/scheduler-admission.ts";
import { tick } from "../src/service.ts";
import { sourceReadPolicy } from "../src/source-read-policy.ts";
import { database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
  FIXTURE_NOW,
} from "./runtime-fixtures.ts";

test("legacy forward sources establish their baseline in the background before live admission", async (t) => {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await (
    await h.store.putPrivate("a", "source", "v2", "credential", {
      key: "fixture-client",
      secret: "fixture-secret",
      token: "fixture-token",
    })
  ).run();
  await h.db.batch([
    h.store.statement(
      "UPDATE connections SET credential_version='v2',config=? WHERE id='source'",
      JSON.stringify({ accountId: "source" }),
    ),
    h.store.statement(
      "UPDATE connections SET status='disabled' WHERE id='destination'",
    ),
    h.store.statement(
      "INSERT INTO cursors VALUES('a','source','sync',?,1,?)",
      JSON.stringify({
        mode: "forward",
        accountId: "source",
        operations: {},
        qsos: {},
      }),
      FIXTURE_NOW - 1,
    ),
  ]);
  assert.equal(
    (await backgroundSources(h.store, FIXTURE_NOW))[0]?.sync_mode,
    "backfill",
  );
  const requests: { forward: boolean; limit: number; anyClient: boolean }[] =
    [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://lofi.ham2k.net/v1/sync");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.meta.lastSyncAccountUUID, "source");
    assert.deepEqual(body.meta.sync.operations, body.meta.sync.qsos);
    requests.push({
      forward: Object.hasOwn(body.meta.sync.operations, "syncedSinceMillis"),
      limit: body.meta.sync.operations.limit,
      anyClient: body.meta.sync.operations.anyClient,
    });
    return Response.json({
      account: { uuid: "source" },
      operations: [],
      qsos: [],
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    });
  };
  const env = fixtureEnvironment(h.db);
  const first = await tick(env, fetcher, FIXTURE_NOW);
  assert.equal(first.errors, 0);
  assert.equal(first.sources, 3);
  assert.equal(first.exportsEnabled, false);
  assert.deepEqual(requests, [
    { forward: false, limit: 25, anyClient: true },
    { forward: true, limit: 25, anyClient: true },
    { forward: true, limit: 25, anyClient: true },
  ]);
  assert.equal(
    (await sourceReadPolicy(h.store, "a", "source"))?.phase,
    "ready",
  );
  assert.equal(
    (await backgroundSources(h.store, FIXTURE_NOW))[0]?.sync_mode,
    "forward",
  );
  const second = await tick(env, fetcher, FIXTURE_NOW + 1);
  assert.equal(second.errors, 0);
  assert.equal(second.sources, 1);
  assert.deepEqual(requests.at(-1), {
    forward: true,
    limit: 100,
    anyClient: true,
  });
  assert.deepEqual(
    await h.store
      .statement(
        "SELECT requests,background_requests FROM vendor_requests WHERE vendor='lofi'",
      )
      .first(),
    {
      requests: 4,
      background_requests: 3,
    },
  );
  assert.equal(
    await h.store.statement("SELECT count(*) n FROM attempts").first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM source_cutovers")
      .first("n"),
    0,
  );
  await h.store
    .statement(
      "UPDATE connections SET remote_identity='replacement',config=? WHERE id='source'",
      JSON.stringify({ accountId: "replacement" }),
    )
    .run();
  assert.equal(
    (await backgroundSources(h.store, FIXTURE_NOW))[0]?.sync_mode,
    "backfill",
    "a ready marker for another logical account cannot enter the live lane",
  );
});
