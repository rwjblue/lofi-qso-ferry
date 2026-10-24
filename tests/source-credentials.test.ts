import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { LoFiCredentials } from "../src/lofi.ts";
import { openSourceCredentials } from "../src/source-credentials.ts";
import { database, seed } from "./helpers.ts";

const credentials: LoFiCredentials = {
  key: "browser:fixture",
  secret: "fixture-secret",
  token: "original-token",
};
async function setup(t: TestContext) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await seed(h.store);
  await h.store
    .statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND id='v1' AND kind='credential'",
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "v1", "credential", credentials)
  ).run();
  const source = (await h.store.connection("a", "source"))!;
  const envelope = () =>
    h.store
      .statement(
        "SELECT envelope FROM private_data WHERE tenant='a' AND connection='source' AND id='v1' AND kind='credential'",
      )
      .first<{ envelope: string }>();
  const saved = () =>
    h.store.private<LoFiCredentials>("a", "source", "v1", "credential");
  return { ...h, source, envelope, saved };
}

test("source credentials persist only a renewed bearer without replacing logical identity", async (t) => {
  const h = await setup(t);
  const session = await openSourceCredentials(h.store, h.source);
  assert.deepEqual(session.credentials, credentials);
  const before = await h.envelope();
  await session.persistRenewal({ ...credentials });
  assert.deepEqual(await h.envelope(), before);
  await session.persistRenewal({ ...credentials, token: "renewed-token" });
  assert.deepEqual(await h.saved(), { ...credentials, token: "renewed-token" });
  assert.equal(
    (await h.store.connection("a", "source"))?.credential_version,
    "v1",
  );
  // A session can win only against its originally opened envelope.
  await session.persistRenewal({ ...credentials, token: "late-token" });
  assert.equal((await h.saved())?.token, "renewed-token");
});

test("unavailable credentials are rejected using actual expiry and revocation state", async (t) => {
  const h = await setup(t);
  await h.store
    .statement(
      "UPDATE private_data SET expires_at=? WHERE tenant='a' AND connection='source' AND id='v1' AND kind='credential'",
      Date.now() - 1,
    )
    .run();
  await assert.rejects(
    openSourceCredentials(h.store, h.source),
    /source_connection_unavailable/,
  );
  await h.store
    .statement(
      "UPDATE private_data SET expires_at=NULL,revoked_at=1 WHERE tenant='a' AND connection='source' AND id='v1' AND kind='credential'",
    )
    .run();
  await assert.rejects(
    openSourceCredentials(h.store, h.source),
    /source_connection_unavailable/,
  );
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=NULL WHERE tenant='a' AND connection='source' AND id='v1' AND kind='credential'",
    )
    .run();
  await assert.rejects(
    openSourceCredentials(h.store, { ...h.source, status: "disabled" }),
    /source_connection_unavailable/,
  );
  await assert.rejects(
    openSourceCredentials(h.store, { ...h.source, credential_version: null }),
    /source_connection_unavailable/,
  );
  await assert.rejects(
    openSourceCredentials(h.store, { ...h.source, tenant: "another-tenant" }),
    /source_connection_unavailable/,
  );
});

test("late bearer renewal cannot overwrite concurrent envelope, expiry, revocation, account or credential changes", async (t) => {
  for (const change of [
    "renewal",
    "expiry",
    "revocation",
    "account",
    "credential",
    "disabled",
  ] as const) {
    await t.test(change, async (t) => {
      const h = await setup(t);
      const session = await openSourceCredentials(h.store, h.source);
      if (change === "renewal") {
        const winner = await openSourceCredentials(h.store, h.source);
        await winner.persistRenewal({ ...credentials, token: "winning-token" });
      } else if (change === "expiry") {
        await h.store
          .statement(
            "UPDATE private_data SET expires_at=? WHERE tenant='a' AND connection='source' AND id='v1' AND kind='credential'",
            Date.now() - 1,
          )
          .run();
      } else if (change === "revocation") {
        await h.store
          .statement(
            "UPDATE private_data SET revoked_at=1 WHERE tenant='a' AND connection='source' AND id='v1' AND kind='credential'",
          )
          .run();
      } else if (change === "account") {
        await h.store
          .statement(
            "UPDATE connections SET remote_identity='another-account' WHERE tenant='a' AND id='source'",
          )
          .run();
      } else if (change === "credential") {
        await h.store
          .statement(
            "UPDATE connections SET credential_version='v2' WHERE tenant='a' AND id='source'",
          )
          .run();
      } else {
        await h.store
          .statement(
            "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source'",
          )
          .run();
      }
      const before = await h.envelope();
      await session.persistRenewal({ ...credentials, token: "late-token" });
      assert.deepEqual(await h.envelope(), before);
    });
  }
});

test("shared renewal API rejects client identity changes and isolates caller snapshots", async (t) => {
  const h = await setup(t);
  const session = await openSourceCredentials(h.store, h.source);
  const before = await h.envelope();
  for (const changed of [
    { ...credentials, key: "other-client", token: "new" },
    { ...credentials, secret: "other-secret", token: "new" },
  ])
    await assert.rejects(
      session.persistRenewal(changed),
      /source_client_identity_changed/,
    );
  assert.deepEqual(await h.envelope(), before);
  session.credentials.key = "mutated-output";
  await assert.rejects(
    session.persistRenewal({ ...session.credentials, token: "new" }),
    /source_client_identity_changed/,
  );
  h.source.remote_identity = "mutated-caller-object";
  h.source.credential_version = "mutated-caller-version";
  await session.persistRenewal({ ...credentials, token: "safe-renewal" });
  assert.equal((await h.saved())?.token, "safe-renewal");
});
