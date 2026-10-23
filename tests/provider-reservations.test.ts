import assert from "node:assert/strict";
import test from "node:test";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("natural reservations remain distinct from assigned remote IDs across uncertain delivery", async (t) => {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  const key = await seed(h.store);
  const other = { ...key, qso: "q2" };
  const template = await h.store.saveTemplate("a", "destination", {});
  for (const k of [key, other]) {
    await h.store.observe(k, "g1", "h1", 30, false, 0);
  }
  await h.store
    .statement("UPDATE ledger SET state='missing_current_identity',due_at=0")
    .run();
  const first = await h.store.stage(
    key,
    "g1",
    { record: "one" },
    "v1",
    template,
    100,
  );
  const second = await h.store.stage(
    other,
    "g1",
    { record: "two" },
    "v1",
    template,
    100,
  );
  const lease = await h.store.claim("a", "delivery", 100, 1000);
  assert(lease);
  assert(
    await h.store.claimAttempt(
      "a",
      first,
      lease,
      101,
      undefined,
      "natural:contact",
    ),
  );
  assert.deepEqual(
    await h.store
      .statement(
        "SELECT reservation_id,remote_id FROM attempt_state WHERE attempt=?",
        first,
      )
      .first(),
    {
      reservation_id: "natural:contact",
      remote_id: null,
    },
  );
  await h.store.resolve("a", first, lease, "uncertain", null, 102);
  assert.equal(
    await h.store.claimAttempt(
      "a",
      second,
      lease,
      103,
      undefined,
      "natural:contact",
    ),
    false,
  );
  assert(
    await h.store.resolveReconciled("a", first, lease, "assigned:42", 104),
  );
  assert.equal((await h.store.ledger(key))?.remote_id, "assigned:42");
  for (const identity of ["natural:contact", "assigned:42"]) {
    const guard = await h.store.remoteIdentityClaimGuard(other, identity);
    assert.equal(
      await h.store
        .statement(`SELECT 1 ok WHERE ${guard.sql}`, ...guard.params)
        .first(),
      null,
    );
  }
});
