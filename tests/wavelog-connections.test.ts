import assert from "node:assert/strict";
import test from "node:test";
import type { SessionIdentity } from "../src/auth.ts";
import { connectionRoute } from "../src/connections.ts";
import { digestCode, sha256 } from "../src/security.ts";
import { database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

const baseUrl = "https://logs.example.test/wavelog/";
const scopes = [
  "station:read",
  "station:write",
  "qso:read",
  "qso:write",
  "logbook:read",
  "logbook:write",
];
const input = {
  baseUrl,
  token: "wl2_synthetic_wavelog_token_000",
  stationCallsign: "W1AW",
  logbookId: 5,
  autoCreateStations: true,
  outboundPolicy: "ferry",
};
const station = {
  id: 12,
  uuid: "12345678-1234-4123-8123-123456789abc",
  name: "Synthetic station",
  callsign: "W1AW",
  gridsquare: "FN31AA",
  dxcc: 291,
  cq: 5,
  itu: 8,
  state: "CT",
  cnty: "Tolland",
  pota: "",
  sota: "",
  wwff: "",
  sig: "",
  sig_info: "",
  active: false,
  power: null,
  clublog_upload: "disabled",
  eqsl_qth_nickname: "",
};

async function setup() {
  const h = await database();
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  const now = Date.now();
  await h.db.batch([
    h.db
      .prepare(
        "INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at) VALUES('key-a','a','fixture',0,'{}','fixture',?)",
      )
      .bind(now),
    h.db
      .prepare(
        "INSERT INTO sessions(token_hash,tenant,credential_id,created_at,verified_at,expires_at) VALUES('session-a','a','key-a',?,?,?)",
      )
      .bind(now, now, now + 86400000),
  ]);
  const identity: SessionIdentity = {
    tenant: "a",
    credentialId: "key-a",
    tokenHash: "session-a",
    verifiedAt: now,
  };
  const env = fixtureEnvironment(h.db);
  async function request(path: string, body: unknown = {}) {
    return new Request(`${env.ORIGIN}/api/connections${path}`, {
      method: "POST",
      headers: {
        Origin: env.ORIGIN,
        "Content-Type": "application/json",
        Cookie:
          "__Host-ferry_browser=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "X-CSRF-Token": await digestCode(
          env.AUTH_SECRET,
          `csrf:${await sha256("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")}:anonymous`,
        ),
      },
      body: JSON.stringify(body),
    });
  }
  const calls: string[] = [];
  const vendor = {
    tokenId: 10,
    ownerId: 7,
    scopes: [...scopes],
    logbookId: 5,
    stationIds: [] as number[],
    stations: [] as (typeof station)[],
  };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.redirect, "manual");
    assert.match(
      new Headers(init?.headers).get("Authorization") ?? "",
      /^Bearer wl2_synthetic_/,
    );
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const envelope = (data: unknown) =>
      Response.json({ status: "success", data });
    if (path === "/wavelog/index.php/api/v2/token")
      return envelope({
        id: vendor.tokenId,
        user_id: vendor.ownerId,
        owner: "synthetic-owner",
        scopes: vendor.scopes,
        expires_at: null,
      });
    if (path === `/wavelog/index.php/api/v2/logbook/${vendor.logbookId}`)
      return envelope({
        id: vendor.logbookId,
        name: "Synthetic logbook",
        active: false,
        station_ids: vendor.stationIds,
      });
    if (path === "/wavelog/index.php/api/v2/station")
      return envelope(vendor.stations);
    throw new Error(`Unexpected fixture path ${path}`);
  };
  const services = { fetcher, wavelogAllowedBaseUrls: [baseUrl] };
  async function connect(body: unknown = input) {
    return connectionRoute(
      await request("/wavelog", body),
      env,
      identity,
      services,
    );
  }
  return { ...h, env, identity, request, calls, vendor, services, connect };
}

test("Wavelog linking verifies owned empty logbooks read-only and encrypts the token", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  const response = await h.connect();
  assert.equal(response?.status, 201);
  const result = (await response!.json()) as { id: string; status: string };
  assert.equal(result.status, "active");
  assert.deepEqual(h.calls, [
    "/wavelog/index.php/api/v2/token",
    "/wavelog/index.php/api/v2/logbook/5",
    "/wavelog/index.php/api/v2/station",
  ]);
  assert.deepEqual(
    await h.db
      .prepare(
        "SELECT scope,requests,background_requests FROM vendor_scoped_requests WHERE vendor='wavelog'",
      )
      .first(),
    { scope: baseUrl, requests: 3, background_requests: 0 },
  );
  const saved = await h.store.connection("a", result.id);
  assert(saved?.credential_version);
  assert.equal(saved.kind, "wavelog");
  assert.deepEqual(JSON.parse(saved.config), {
    baseUrl,
    ownerId: 7,
    stationCallsign: "W1AW",
    logbookId: 5,
    autoCreateStations: true,
    outboundPolicy: "ferry",
    readAccess: true,
  });
  assert.deepEqual(
    await h.store.private(
      "a",
      saved.id,
      saved.credential_version,
      "credential",
    ),
    { baseUrl, token: input.token },
  );
  const listing = await connectionRoute(
    new Request(`${h.env.ORIGIN}/api/connections`),
    h.env,
    h.identity,
  );
  assert.equal((await listing!.text()).includes(input.token), false);
  const stored = await h.db.prepare("SELECT * FROM private_data").all();
  assert.equal(JSON.stringify(stored.results).includes(input.token), false);
  assert.equal(saved.config.includes(input.token), false);
  assert.equal(saved.remote_identity.includes(input.token), false);
});

test("Wavelog token renewal keeps the same logical destination and its ledger", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  h.vendor.stationIds = [station.id];
  h.vendor.stations = [station];
  const response = await h.connect();
  assert.equal(response?.status, 201);
  const { id } = (await response!.json()) as { id: string };
  const before = await h.store.connection("a", id);
  await h.store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,due_at,updated_at) VALUES('a','source','retained',?,'generation','hash','observed',0,0)",
      id,
    )
    .run();
  h.vendor.tokenId++;
  const renewed = await h.connect({
    ...input,
    baseUrl: "https://logs.example.test/wavelog/index.php",
    stationCallsign: " w1aw ",
    token: "wl2_synthetic_replacement_token_000",
  });
  assert.equal(renewed?.status, 201);
  assert.equal(((await renewed!.json()) as { id: string }).id, id);
  const after = await h.store.connection("a", id);
  assert.notEqual(after?.credential_version, before?.credential_version);
  assert.equal(after?.remote_identity, before?.remote_identity);
  assert.equal(
    (
      await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: "retained",
        destination: id,
      })
    )?.state,
    "observed",
  );
});

test("Wavelog permits one current account through pause; revocation retains history and permits another", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  const first = await h.connect();
  const { id } = (await first!.json()) as { id: string };
  await h.store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,due_at,updated_at) VALUES('a','source','retained',?,'generation','hash','observed',0,0)",
      id,
    )
    .run();
  await connectionRoute(await h.request("/disable", { id }), h.env, h.identity);
  for (const route of [{ logbookId: 6 }, { stationCallsign: "K1ABC" }]) {
    const changed = await h.connect({ ...input, ...route });
    assert.equal(changed?.status, 409);
  }
  h.vendor.ownerId = 8;
  const blocked = await h.connect();
  assert.equal(blocked?.status, 409);
  const resumed = await connectionRoute(
    await h.request("/enable", { id }),
    h.env,
    h.identity,
  );
  assert.equal(resumed?.status, 200);
  assert.equal((await h.store.connection("a", id))?.status, "active");
  await connectionRoute(await h.request("/revoke", { id }), h.env, h.identity);
  assert.equal(
    (
      await h.store.ledger({
        tenant: "a",
        source: "source",
        qso: "retained",
        destination: id,
      })
    )?.state,
    "observed",
  );
  const second = await h.connect();
  assert.equal(second?.status, 201);
  assert.notEqual(((await second!.json()) as { id: string }).id, id);
});

test("Wavelog admission and policy checks reject unapproved instances before sending a token", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  for (const changed of [
    { baseUrl: "https://unapproved.example.test/" },
    { baseUrl: "http://logs.example.test/wavelog/" },
    { baseUrl: "https://127.0.0.1/" },
    { baseUrl: "https://logs.example.test/other/" },
    { baseUrl: "https://secret@logs.example.test/wavelog/" },
    { autoCreateStations: false },
    { outboundPolicy: "wavelog" },
    { logbookId: 0 },
  ]) {
    const response = await h.connect({ ...input, ...changed });
    assert(response!.status >= 400);
  }
  const absent = await connectionRoute(
    await h.request("/wavelog", input),
    h.env,
    h.identity,
    { fetcher: h.services.fetcher },
  );
  assert.equal(absent?.status, 503);
  assert.equal(
    ((await absent!.json()) as { code: string }).code,
    "wavelog_not_configured",
  );
  assert.deepEqual(h.calls, []);
});

test("Wavelog verification rejects missing scopes and mixed or incomplete station routes without saving credentials", async (t) => {
  for (const failure of ["scope", "mixed", "hidden"] as const) {
    await t.test(failure, async (t) => {
      const h = await setup();
      t.after(() => h.mf.dispose());
      if (failure === "scope")
        h.vendor.scopes = scopes.filter((scope) => scope !== "station:write");
      else {
        h.vendor.stationIds = [station.id];
        h.vendor.stations =
          failure === "hidden" ? [] : [{ ...station, callsign: "K1ABC" }];
      }
      const response = await h.connect();
      assert.equal(response?.status, 400);
      assert.equal(
        ((await response!.json()) as { code: string }).code,
        failure === "scope"
          ? "wavelog_scopes_missing"
          : "wavelog_logbook_mismatch",
      );
      assert.equal(h.calls.length, failure === "scope" ? 1 : 3);
      assert.equal(
        (await h.store.connections("a")).some(
          (connection) => connection.kind === "wavelog",
        ),
        false,
      );
    });
  }
});

test("Wavelog vendor rejection never exposes a token or vendor response body", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  const response = await connectionRoute(
    await h.request("/wavelog", input),
    h.env,
    h.identity,
    {
      ...h.services,
      fetcher: async () =>
        new Response(`private vendor body ${input.token}`, { status: 403 }),
    },
  );
  assert.equal(response?.status, 400);
  const body = await response!.text();
  assert.equal(body.includes(input.token), false);
  assert.equal(body.includes("private vendor body"), false);
});

test("Wavelog rejected credentials require verified renewal after pause and resume", async (t) => {
  const h = await setup();
  t.after(() => h.mf.dispose());
  const first = await h.connect();
  const { id } = (await first!.json()) as { id: string };
  await h.store
    .statement(
      "UPDATE connections SET status='disabled',config=json_set(config,'$.credentialRejected',json('true')) WHERE tenant='a' AND id=?",
      id,
    )
    .run();
  const response = await connectionRoute(
    await h.request("/enable", { id }),
    h.env,
    h.identity,
  );
  assert.equal(response?.status, 200);
  const resumed = (await response!.json()) as {
    status: string;
    message: string;
  };
  assert.equal(resumed.status, "needs_verification");
  assert.match(resumed.message, /Wavelog credentials still need verification/);
  const renewed = await h.connect({
    ...input,
    token: "wl2_synthetic_renewed_token_000",
  });
  assert.equal(renewed?.status, 201);
  const current = await h.store.connection("a", id);
  assert.equal(current?.status, "active");
  assert.equal(JSON.parse(current!.config).credentialRejected, undefined);
});
