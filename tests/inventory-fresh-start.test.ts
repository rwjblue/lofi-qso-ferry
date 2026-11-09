import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { inventoryFreshStart } from "../scripts/inventory-fresh-start.ts";
import { openInventoryTrial } from "../scripts/inventory-run-trial.ts";
import { InventoryQrzDispatch } from "../src/inventory-qrz-dispatch.ts";
import { inventoryRuntime } from "../src/inventory-runtime.ts";
import { applyMigration } from "./helpers.ts";
import { trialCapture } from "./inventory-trial-capture-fixtures.ts";

test("a fresh account copy retains credential bindings and quarantines prior unsettled work", async (t) => {
  const root = await mkdtemp(`${tmpdir()}/ferry-fresh-account-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await trialCapture(root);
  const prior = await openInventoryTrial(directory);
  try {
    await applyMigration(prior.db, "0006_account_templates.sql");
    await prior.db.batch([
      prior.store.statement(
        "INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at) VALUES('credential','trial','fixture-public-key',8,'{}','Test passkey',1)",
      ),
      prior.store.statement(
        "INSERT INTO sessions(token_hash,tenant,credential_id,created_at,verified_at,expires_at) VALUES('old-session','trial','credential',1,1,?)",
        Date.now() + 60000,
      ),
      prior.store.statement(
        "INSERT INTO account_templates VALUES('trial','default','{}',1)",
      ),
      prior.store.statement(
        "INSERT INTO active_account_templates VALUES('trial','default')",
      ),
      prior.store.statement(
        "INSERT INTO templates VALUES('trial','qrz','per-book','{}',1)",
      ),
      prior.store.statement(
        "INSERT INTO active_templates VALUES('trial','qrz','per-book')",
      ),
      prior.store.statement(
        "UPDATE connections SET last_poll_at=42,cutover='old-selection'",
      ),
      prior.store.statement(
        "INSERT INTO cursors VALUES('trial','lofi','context','{}',2,1)",
      ),
      prior.store.statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('trial','lofi','old-qso','qrz','generation','hash',1,1)",
      ),
      prior.store.statement(
        "INSERT INTO attempts VALUES('trial','old-attempt','lofi','old-qso','qrz','generation','body','digest',NULL,'fixture',1,'hash')",
      ),
      prior.store.statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('trial','old-attempt','uncertain',1,1)",
      ),
      await prior.store.putPrivate("trial", "qrz", "body", "outbox", {
        discarded: true,
      }),
    ]);
  } finally {
    await prior.mf.dispose();
  }
  const report = await inventoryFreshStart(directory, root);
  assert.deepEqual(report.decrypted, { lofi: 1, qrz: 1, lotw: 1 });
  assert.deepEqual(report.priorUnsettled, {
    legacy: 1,
    qrz: 0,
    lotwBatches: 0,
  });
  assert.equal(report.passkeys, 1);
  assert.equal(report.contactStateEmpty, true);
  assert.equal((await stat(report.directory)).mode & 0o077, 0);
  const fresh = await openInventoryTrial(report.directory);
  try {
    assert.equal(
      (await inventoryRuntime(fresh.store)).mode,
      "inventory_read_only",
    );
    assert.deepEqual(
      await fresh.db
        .prepare("SELECT id,counter,public_key FROM passkeys")
        .first(),
      { id: "credential", counter: 8, public_key: "fixture-public-key" },
    );
    assert.deepEqual(
      await fresh.db
        .prepare("SELECT last_poll_at,cutover FROM connections WHERE id='qrz'")
        .first(),
      { last_poll_at: null, cutover: null },
    );
    assert.equal(
      await fresh.db
        .prepare("SELECT version FROM active_templates")
        .first("version"),
      "per-book",
    );
    assert.equal(
      await fresh.db
        .prepare("SELECT version FROM active_account_templates")
        .first("version"),
      "default",
    );
    assert.deepEqual(
      await fresh.store.private("trial", "lotw", "fixture", "credential"),
      { query: { username: "synthetic", password: "synthetic" } },
    );
    assert.equal(
      await fresh.db
        .prepare(
          "SELECT count(*) AS n FROM private_data WHERE kind!='credential'",
        )
        .first("n"),
      0,
    );
    const sender = new InventoryQrzDispatch(fresh.store, async () =>
      assert.fail("a fresh rehearsal must not contact the sender"),
    );
    assert.deepEqual(
      await sender.send("trial", "old-attempt", () => ({
        exportsEnabled: true,
        liveWriteAuthorized: true,
        qrzFreshInsertsEnabled: true,
        sourceBoundaryVerified: false,
        allowedQsoIds: null,
        allowedDestinationIds: null,
      })),
      { kind: "held", reason: "fresh_start_requires_cutover" },
    );
    await assert.rejects(
      fresh.db.prepare("DELETE FROM inventory_fresh_start_lock").run(),
      /audited cutover/,
    );
    await assert.rejects(
      fresh.db
        .prepare(
          `INSERT INTO inventory_qrz_dispatch_guards(singleton,tenant,attempt_id,claim_id,observation_id,request_hash,lease_token,lease_fence,expires_at)
         VALUES(1,'trial','old-attempt','claim','observation','digest','token',1,?)`,
        )
        .bind(Date.now() + 60_000)
        .run(),
      /fresh start requires an audited cutover/,
    );
  } finally {
    await fresh.mf.dispose();
  }
  const reopened = await openInventoryTrial(directory);
  try {
    assert.equal(
      await reopened.db
        .prepare("SELECT state FROM attempt_state")
        .first("state"),
      "uncertain",
    );
    assert.equal(
      await reopened.db
        .prepare("SELECT count(*) AS n FROM inventory_records")
        .first("n"),
      1,
    );
  } finally {
    await reopened.mf.dispose();
  }
});
