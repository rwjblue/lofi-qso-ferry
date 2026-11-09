import assert from "node:assert/strict";
import { test } from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import worker from "../src/index.ts";
import { InventoryAssociations } from "../src/inventory-associations.ts";
import type { InventoryProviderDashboard } from "../src/inventory-dashboard-types.ts";
import { pollInventoryLotwConfirmations } from "../src/inventory-lotw-confirmations.ts";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import { lotwInventoryObservations } from "../src/inventory-observations.ts";
import { sha256 } from "../src/security.ts";
import { database, seed } from "./helpers.ts";
import {
  matchingFixture,
  receipt,
  sourceContact,
} from "./inventory-matching-fixtures.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

test("the authenticated dashboard shows unambiguous native LoTW confirmations without ledger writes", async (t) => {
  const base = await database();
  t.after(() => base.mf.dispose());
  await applyAdditionalMigrations(base.db);
  const sources = [
    sourceContact("q1"),
    sourceContact("q2", "13:00:00", "W2AW"),
  ];
  const receipts = ["W1AW", "W2AW"].map((call) => ({
    ...(receipt("fixture", "130000", call).body as Record<string, string>),
    QSL_RCVD: "N",
  }));
  const f = await matchingFixture(
    {
      provider: "lotw",
      lotwReadAccess: true,
      sources,
      receipts: await lotwInventoryObservations(receipts),
    },
    base,
    "current",
  );
  const selected = sources.map(({ key }) => ({ scope: "source", key }));
  await new InventoryMatchingResults(f.store).match(
    "a",
    "destination",
    selected,
  );
  const associations = new InventoryAssociations(f.store);
  const page = await associations.prepare("a", "destination", selected);
  const lease = await f.store.claim("a", "inventory-ownership:lotw");
  assert.ok(lease);
  try {
    assert.equal(page.rows.length, 2);
    await associations.publish(page, lease);
  } finally {
    await f.store.release(lease);
  }
  await f.store.release(f.destinationLease);
  await (
    await f.store.putPrivate("a", "destination", "v2", "credential", {
      query: { username: "fixture", password: "fixture" },
    })
  ).run();
  await f.db
    .prepare(
      "UPDATE connections SET credential_version='v2' WHERE tenant='a' AND id='destination'",
    )
    .run();
  const stamp = "2026-11-08 14:00:00";
  const confirmed: AdifRecord[] = receipts.map((row) => ({
    ...row,
    QSL_RCVD: "Y",
    APP_LOTW_RXQSL: stamp,
  }));
  confirmed.push({ ...confirmed[1], MY_GRIDSQUARE: "FN32" });
  const qsl = await pollInventoryLotwConfirmations(
    f.store,
    {
      tenant: "a",
      scope: "destination",
      selection: {
        startDate: "2026-11-08",
        endDate: "2026-11-08",
        confirmedSince: stamp,
      },
    },
    async () =>
      new Response(
        `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>3<APP_LOTW_LASTQSL:19>${stamp}<EOH>${confirmed.map(serializeAdifRecord).join("\n")}<APP_LOTW_EOF>`,
      ),
  );
  assert.equal(qsl.state, "complete");
  assert.equal(qsl.added, 3);

  await seed(f.store, "b");
  await f.db
    .prepare(
      "UPDATE connections SET kind='lotw' WHERE tenant='b' AND id='destination'",
    )
    .run();
  let comparisonSummary: string | undefined;
  const dashboardDb = new Proxy(f.db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (sql.includes("WITH valid AS MATERIALIZED"))
            comparisonSummary = sql;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = fixtureEnvironment(dashboardDb);
  for (const tenant of ["a", "b"]) {
    await f.db.batch([
      f.db
        .prepare(
          "INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at) VALUES(?,?,'fixture',0,'{}','Fixture',0)",
        )
        .bind(`key-${tenant}`, tenant),
      f.db
        .prepare(
          "INSERT INTO sessions(token_hash,tenant,credential_id,created_at,verified_at,expires_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          await sha256(tenant.repeat(43)),
          tenant,
          `key-${tenant}`,
          Date.now(),
          Date.now(),
          Date.now() + 60_000,
        ),
    ]);
  }
  const dashboard = async (tenant: string) => {
    const response = await worker.fetch(
      new Request(`${env.ORIGIN}/api/dashboard`, {
        headers: { Cookie: `__Host-ferry_session=${tenant.repeat(43)}` },
      }),
      env,
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<{
      providers: InventoryProviderDashboard[];
      activity: { qso: string; state: string; confirmed: number }[];
    }>;
  };
  const initial = await dashboard("a");
  const lotw = initial.providers.find(
    (provider) => provider.provider === "lotw",
  );
  assert.ok(lotw);
  assert.equal(lotw.adopted, 2);
  assert.equal(lotw.contacts, 2);
  assert.deepEqual(
    lotw.matches.map(({ state, count }) => ({ state, count })),
    [{ state: "matched_existing", count: 2 }],
  );
  assert.deepEqual(
    lotw.coverage.map(({ state, count }) => ({ state, count })),
    [{ state: "ready", count: 1 }],
  );
  assert.deepEqual(
    initial.activity
      .map(({ qso, state, confirmed }) => ({ qso, state, confirmed }))
      .sort((a, b) => a.qso.localeCompare(b.qso)),
    [
      { qso: "q1", state: "adopted_existing", confirmed: 1 },
      { qso: "q2", state: "adopted_existing", confirmed: 0 },
    ],
  );
  assert.deepEqual((await dashboard("b")).activity, []);
  assert.ok(comparisonSummary);
  const plan = await f.db
    .prepare(`EXPLAIN QUERY PLAN ${comparisonSummary}`)
    .bind("b")
    .all<{ detail: string }>();
  const steps = plan.results.map(({ detail }) => detail);
  assert.ok(
    steps.some((detail) => /SEARCH w .*\(tenant=\?/.test(detail)),
    steps.join("\n"),
  );
  assert.ok(
    !steps.some((detail) => /^SCAN r(?: |$)/.test(detail)),
    steps.join("\n"),
  );
  assert.equal(
    await f.db.prepare("SELECT count(*) AS n FROM ledger").first("n"),
    0,
  );
  assert.equal(
    await f.db.prepare("SELECT count(*) AS n FROM attempts").first("n"),
    0,
  );
  assert.doesNotMatch(
    JSON.stringify(initial),
    /Private matching remote name|W1AW|inventory_lotw_confirmation/,
  );
  await f.db
    .prepare(
      `INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,due_at,updated_at)
     VALUES('a','source','q2','destination','fixture','fixture','changed',0,?)`,
    )
    .bind(Date.now())
    .run();
  const overlapped = await dashboard("a");
  assert.deepEqual(overlapped, initial);
});
