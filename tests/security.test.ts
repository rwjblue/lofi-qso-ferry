import assert from "node:assert/strict";
import test from "node:test";
import { open, rewrap, seal } from "../src/security.ts";
import { keys } from "./helpers.ts";
const identity = {
  tenant: "a",
  connection: "c",
  id: "v1",
  kind: "credential",
  purpose: "storage",
};
test("encrypted envelope rejects tenant, purpose, identity and tampering; rotation preserves ciphertext", async () => {
  const envelope = await seal({ secret: "p12 and password" }, identity, keys);
  assert(!JSON.stringify(envelope).includes("password"));
  assert.deepEqual(await open(envelope, identity, keys), {
    secret: "p12 and password",
  });
  for (const changed of [{ tenant: "b" }, { purpose: "outbox" }, { id: "v2" }])
    await assert.rejects(open(envelope, { ...identity, ...changed }, keys));
  await assert.rejects(
    open(
      { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` },
      identity,
      keys,
    ),
  );
  const rotated = await rewrap(envelope, identity, { ...keys, active: "2" });
  assert.equal(rotated.ciphertext, envelope.ciphertext);
  assert.equal(rotated.nonce, envelope.nonce);
  assert.deepEqual(
    await open(rotated, identity, {
      active: "2",
      keys: { "2": keys.keys["2"] },
    }),
    { secret: "p12 and password" },
  );
  await assert.rejects(
    open(envelope, identity, { active: "2", keys: { "2": keys.keys["2"] } }),
  );
});
