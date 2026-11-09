import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { checkReadonlyDeploy } from "../scripts/check-readonly-deploy.ts";

const controls = {
  INVENTORY_RUNTIME_MODE: "read_only",
  EXPORTS_ENABLED: "false",
  ROLLOUT_CHECKS_PASSED: "false",
  QRZ_FRESH_INSERTS_ENABLED: "false",
  LOTW_FRESH_INSERTS_ENABLED: "false",
  LIVE_WRITE_AUTHORIZATION: "",
  ROLLOUT_QSO_IDS_JSON: "[]",
  ROLLOUT_DESTINATION_IDS_JSON: "[]",
};

test("all configured environments default to eight closed export controls", async () => {
  const config = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  for (const entry of [config, ...Object.values(config.env)] as {
    vars: Record<string, string>;
  }[])
    for (const [name, value] of Object.entries(controls))
      assert.equal(entry.vars[name], value, name);
});

const live = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const target = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const liveVersion = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const secondVersion = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const productionJson = [
  "--config",
  "wrangler.jsonc",
  "--env",
  "production",
  "--json",
];
const envelope = {
  v: 1,
  algorithm: "AES-256-GCM",
  kek: "1",
  nonce: "nonce",
  ciphertext: "raw-secret",
  wrapNonce: "wrap-nonce",
  wrappedKey: "wrapped-key",
};

async function deploymentConfig(id = target) {
  const config = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  config.env.production.d1_databases = [{ binding: "DB", database_id: id }];
  return config;
}

function servingVersion(id = live) {
  return { resources: { bindings: [{ type: "d1", name: "DB", id }] } };
}

test("read-only deployment refuses open or missing controls before contacting Wrangler", async () => {
  const config = await deploymentConfig();
  for (const name of Object.keys(controls))
    for (const value of [undefined, "open"]) {
      const changed = structuredClone(config);
      changed.env.production.vars[name] = value;
      assert.throws(
        () =>
          checkReadonlyDeploy(changed, () => {
            assert.fail(
              "Wrangler must not run before configuration validation",
            );
          }),
        new RegExp(name),
      );
    }
});

test("an unchanged production D1 binding avoids census queries", async () => {
  const config = await deploymentConfig(live);
  const calls: string[][] = [];
  assert.equal(
    checkReadonlyDeploy(config, (args) => {
      calls.push(args);
      return args[0] === "deployments"
        ? { versions: [{ version_id: liveVersion, percentage: 100 }] }
        : servingVersion();
    }),
    "same_database",
  );
  assert.deepEqual(calls, [
    ["deployments", "status", ...productionJson],
    ["versions", "view", liveVersion, ...productionJson],
  ]);
});

test("a production D1 switch checks continuity using SELECT-only census queries", async (t) => {
  const config = await deploymentConfig();
  const schema = await readFile(
    new URL("../migrations/0001_foundation.sql", import.meta.url),
    "utf8",
  );
  const create = () => {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec(schema);
    db.exec(`
      INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('tenant','operator@example.test','account-handle',0);
      INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at)
        VALUES('login-key','tenant','public-key',0,'{}','fixture',0);
      INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at)
        VALUES('tenant','provider','qrz','remote-identity','fixture','active','version-one',0);
      INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at)
        VALUES('tenant','provider','version-one','credential','${JSON.stringify(envelope)}',0);
    `);
    return db;
  };
  const source = create();
  const destination = create();
  const census: string[] = [];
  const run = (args: string[]) => {
    if (args[0] === "deployments")
      return { versions: [{ version_id: liveVersion, percentage: 100 }] };
    if (args[0] === "versions") return servingVersion();
    assert.deepEqual(args.slice(0, 2), ["d1", "execute"]);
    const database = args[2];
    assert.ok(database === live || database === "DB");
    assert.deepEqual(args.slice(3, -1), [
      ...productionJson,
      "--remote",
      "--command",
    ]);
    census.push(database);
    const db = database === live ? source : destination;
    db.exec("PRAGMA query_only=ON");
    try {
      const results = db.prepare(args.at(-1) ?? "").all();
      assert.ok(!JSON.stringify(results).includes("raw-secret"));
      return [{ success: true, results }];
    } finally {
      db.exec("PRAGMA query_only=OFF");
    }
  };
  assert.equal(checkReadonlyDeploy(config, run), "continuity_verified");
  assert.deepEqual(census, [live, "DB"]);

  const updateEnvelope = destination.prepare(
    "UPDATE private_data SET envelope=?",
  );
  for (const invalid of [
    "malformed JSON",
    JSON.stringify({ ...envelope, v: 2 }),
    JSON.stringify({ ...envelope, algorithm: "different" }),
    JSON.stringify({ ...envelope, nonce: "" }),
  ]) {
    updateEnvelope.run(invalid);
    assert.throws(
      () => checkReadonlyDeploy(config, run),
      /links \(1 missing, 1 unexpected\)/,
    );
  }
  updateEnvelope.run(JSON.stringify(envelope));
  destination.exec(`
    UPDATE passkeys SET revoked_at=1 WHERE id='login-key';
    INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at)
      VALUES('stale-key','tenant','different-key',0,'{}','fixture',0);
    UPDATE private_data SET expires_at=1 WHERE id='version-one';
    UPDATE accounts SET user_handle='wrong-handle' WHERE id='tenant';
  `);
  assert.throws(() => checkReadonlyDeploy(config, run), {
    message:
      "Refusing production D1 switch because continuity checks differ: accounts (1 missing, 1 unexpected), passkeys (1 missing, 1 unexpected), links (1 missing, 1 unexpected). Prepare and verify the target database before rerunning.",
  });
});

test("serving versions with different D1 bindings block a cutover", async () => {
  const config = await deploymentConfig();
  assert.throws(
    () =>
      checkReadonlyDeploy(config, (args) => {
        if (args[0] === "deployments")
          return {
            versions: [
              { version_id: liveVersion, percentage: 90 },
              { version_id: secondVersion, percentage: 10 },
            ],
          };
        assert.equal(args[0], "versions");
        return servingVersion(args[2] === liveVersion ? live : target);
      }),
    /Serving production versions use different D1 databases/,
  );
});
