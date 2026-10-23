import assert from "node:assert/strict";
import test from "node:test";
import { ClubLogError } from "../src/clublog.ts";
import {
  CLUBLOG_REJECTION_REASON,
  handleProviderRejection,
} from "../src/provider-errors.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("provider rejection is redacted and fenced against renewed credentials", async () => {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    const key = await seed(h.store);
    await h.store
      .statement("UPDATE connections SET kind='clublog' WHERE id='destination'")
      .run();
    await h.store.observe(key, "g1", "input", 30, false, 0);
    const old = (await h.store.connection("a", "destination"))!;
    await h.store
      .statement(
        "UPDATE connections SET credential_version='v2' WHERE id='destination'",
      )
      .run();
    const rejected = new ClubLogError(
      "auth",
      "private upstream credentials must not persist",
    );
    assert.equal(
      await handleProviderRejection(h.store, old, rejected, key),
      true,
    );
    assert.equal(
      (await h.store.connection("a", "destination"))?.status,
      "active",
    );
    assert.equal((await h.store.ledger(key))?.reason, null);
    const current = (await h.store.connection("a", "destination"))!;
    assert.equal(
      await handleProviderRejection(
        h.store,
        current,
        new ClubLogError("transient", "Retry later"),
        key,
      ),
      false,
    );
    assert.equal(
      await handleProviderRejection(h.store, current, rejected, key),
      true,
    );
    const paused = (await h.store.connection("a", "destination"))!;
    assert.equal(paused.status, "needs_verification");
    assert.deepEqual(JSON.parse(paused.config), {
      lastError: CLUBLOG_REJECTION_REASON,
      credentialRejected: true,
    });
    assert.equal((await h.store.ledger(key))?.reason, CLUBLOG_REJECTION_REASON);
    // A pause during the request keeps its paused state, but resume must still
    // require credential verification when this response arrives afterward.
    await h.store
      .statement(
        "UPDATE connections SET status='disabled',config='{}' WHERE id='destination'",
      )
      .run();
    await handleProviderRejection(h.store, current, rejected, key);
    const disabled = (await h.store.connection("a", "destination"))!;
    assert.equal(disabled.status, "disabled");
    assert.equal(JSON.parse(disabled.config).credentialRejected, true);
  } finally {
    await h.mf.dispose();
  }
});
