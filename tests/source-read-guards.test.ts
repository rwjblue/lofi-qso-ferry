import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  establishCutovers,
  proveNewAfterCutover,
  recordBirth,
} from "../src/cutover.ts";
import {
  claimedAttemptCurrent,
  destinationIdentityClaim,
} from "../src/identity-claims.ts";
import { ensureSourceReadPolicy } from "../src/source-read-policy.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const NOW = 1_800_000_000_000;
const record = {
  STATION_CALLSIGN: "W1AW",
  CALL: "K1ABC",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "FT8",
};

async function fixture(
  t: TestContext,
  vendor: "qrz" | "lotw" = "qrz",
  activate = true,
) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  const key = await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await h.store
    .statement(
      "UPDATE connections SET kind=? WHERE tenant='a' AND id='destination'",
      vendor,
    )
    .run();
  const source = (await h.store.connection("a", "source"))!;
  const template =
    vendor === "qrz"
      ? await h.store.saveTemplate("a", "destination", {})
      : null;
  const claim = await destinationIdentityClaim(vendor, record);
  await h.store.observe(key, "g1", "hash", 20, false, 0);
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',operation_id='op',context_generation=CASE WHEN ? THEN 1 ELSE NULL END WHERE tenant='a' AND source='source' AND qso='q1'",
      activate ? 1 : 0,
    )
    .run();
  for (const [id, kind, event] of [
    ["op", "operation", 0],
    ["q1", "qso", 0],
    ["event", "qso", 1],
  ] as const) {
    await (
      await h.store.putPrivate("a", "source", id, "source", { uuid: id })
    ).run();
    await h.store
      .statement(
        "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at,synced_at,is_event) VALUES('a','source',?,?,'op',?,'revision',?,?,100,?)",
        id,
        kind,
        id,
        id === "q1" ? "pending" : "context",
        NOW + 3_600_000,
        event,
      )
      .run();
  }
  let epoch = "";
  async function ready(generation = 10) {
    await h.db.batch([
      h.store.statement(
        "UPDATE source_read_policies SET phase='ready',completed_sync_generation=?,completed_at=? WHERE tenant='a' AND source='source'",
        generation,
        NOW + 1,
      ),
      h.store.statement(
        "UPDATE cursors SET generation=?,cursor=? WHERE tenant='a' AND connection='source' AND stream='sync'",
        generation,
        JSON.stringify({
          mode: "forward",
          readerPolicy: "all-clients-v1",
          policyEpoch: epoch,
          accountId: "source",
          operations: { watermark: 100 },
          qsos: { watermark: 100 },
        }),
      ),
      h.store.statement(
        "UPDATE cursors SET generation=1,cursor=? WHERE tenant='a' AND connection='source' AND stream='context'",
        JSON.stringify({ complete: true, syncComplete: true }),
      ),
      h.store.statement(
        "UPDATE source_work SET policy_seen_epoch=? WHERE tenant='a' AND source='source'",
        epoch,
      ),
    ]);
  }
  if (activate) {
    const lease = (await h.store.claim("a", "poll:source:sync", NOW, 90_000))!;
    const policy = await ensureSourceReadPolicy(h.store, source, lease, NOW);
    epoch = policy.policy.epoch;
    await ready();
    await h.store.release(lease);
  }
  const stage = async (identity = true) => {
    const sourceVersion = await h.store
      .statement(
        "SELECT version FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso='q1'",
      )
      .first<number>("version");
    return h.store.stage(
      key,
      "g1",
      { record },
      "v1",
      template,
      NOW + 2,
      undefined,
      undefined,
      "live",
      identity ? { claim, sourceVersion: sourceVersion! } : undefined,
    );
  };
  const reset = () =>
    h.store
      .statement(
        "UPDATE source_read_policies SET phase='drain',completed_sync_generation=NULL,completed_at=NULL WHERE tenant='a' AND source='source'",
      )
      .run();
  return { ...h, key, source, claim, epoch, stage, ready, reset };
}

test("active policy staging checks each dependency even through legacy context and identity shortcuts", async (t) => {
  const h = await fixture(t);
  for (const id of ["q1", "op", "event"]) {
    await h.store
      .statement("UPDATE source_work SET policy_seen_epoch=NULL WHERE id=?", id)
      .run();
    await assert.rejects(
      h.stage(),
      /source read policy unavailable before stage/,
    );
    await assert.rejects(
      h.stage(false),
      /source read policy unavailable before stage/,
    );
    await h.store
      .statement(
        "UPDATE source_work SET policy_seen_epoch=? WHERE id=?",
        h.epoch,
        id,
      )
      .run();
  }
  await h.store
    .statement("UPDATE ledger SET operation_id=NULL WHERE qso='q1'")
    .run();
  await assert.rejects(
    h.stage(),
    /source read policy unavailable before stage/,
  );
  await h.store
    .statement("UPDATE ledger SET operation_id='op' WHERE qso='q1'")
    .run();
  await h.reset();
  await assert.rejects(
    h.stage(),
    /source read policy unavailable before stage/,
  );
  for (const table of [
    "attempts",
    "destination_identity_claims",
    "stage_guards",
  ])
    assert.equal(
      await h.store
        .statement(`SELECT count(*) FROM ${table}`)
        .first("count(*)"),
      0,
    );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM private_data WHERE kind='outbox'")
      .first("count(*)"),
    0,
  );
  await h.ready();
  assert(await h.stage(), "unchanged membership can be explicitly restored");
});

test("policy guards compose with existing source expiry, revision and identity fences", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement("UPDATE ledger SET context_generation=1 WHERE qso='q1'")
    .run();
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=? WHERE connection='source' AND id='event'",
      NOW,
    )
    .run();
  await assert.rejects(h.stage(), /source dependencies unavailable/);
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=NULL WHERE connection='source' AND id='event'",
    )
    .run();
  const attempt = await h.stage();
  assert(await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 3));
  await h.store
    .statement(
      "UPDATE reconciliation_work SET version=version+1 WHERE qso='q1'",
    )
    .run();
  assert.equal(
    await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 3),
    false,
  );
});

test("old noncanonical writes invalidate membership while identical ciphertext renewals preserve it", async (t) => {
  const h = await fixture(t);
  const membership = () =>
    h.store
      .statement("SELECT policy_seen_epoch FROM source_work WHERE id='q1'")
      .first<string | null>("policy_seen_epoch");
  await (
    await h.store.putPrivate("a", "source", "q1-renewed", "source", {
      uuid: "q1",
    })
  ).run();
  await h.store
    .statement(
      "UPDATE source_work SET private_id='q1-renewed',expires_at=? WHERE id='q1'",
      NOW + 7_200_000,
    )
    .run();
  assert.equal(await membership(), h.epoch);
  const attempt = await h.stage();
  // This is the old worker UPSERT: it has no policy column in either branch.
  await h.store
    .statement(
      "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at,synced_at) VALUES('a','source','q1','qso','op','q1-renewed','changed','pending',?,101) ON CONFLICT(tenant,source,id,kind) DO UPDATE SET revision=excluded.revision,synced_at=excluded.synced_at",
      NOW + 7_200_000,
    )
    .run();
  assert.equal(await membership(), null);
  assert.equal(
    await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 3),
    false,
  );
  const lease = (await h.store.claim("a", "delivery:destination", NOW + 3))!;
  await assert.rejects(
    h.store.claimAttempt("a", attempt, lease, NOW + 3),
    /source read policy unavailable before dispatch/,
  );
  await h.store
    .statement(
      "UPDATE attempt_state SET state='cancelled' WHERE attempt=?",
      attempt,
    )
    .run();
  await assert.rejects(
    h.stage(),
    /source read policy unavailable before stage/,
  );

  for (const change of [
    "revision='another-version'",
    "synced_at=102",
    "deleted=1",
    "is_event=1",
    "operation_id='another-operation'",
  ]) {
    await h.store
      .statement(
        "UPDATE source_work SET policy_seen_epoch=? WHERE id='q1'",
        h.epoch,
      )
      .run();
    await h.store
      .statement(`UPDATE source_work SET ${change} WHERE id='q1'`)
      .run();
    assert.equal(await membership(), null, change);
  }
});

test("only a current tagged canonical checkpoint can retain changed-version membership", async (t) => {
  const h = await fixture(t);
  const cursor = JSON.parse(
    (await h.store
      .statement(
        "SELECT cursor FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
      )
      .first<string>("cursor"))!,
  );
  const membership = () =>
    h.store
      .statement("SELECT policy_seen_epoch FROM source_work WHERE id='q1'")
      .first<string | null>("policy_seen_epoch");
  const lease = (await h.store.claim("a", "poll:source:sync", NOW + 3))!;
  const guard = (id: string, revision: string, stamp: number) =>
    h.store.statement(
      "INSERT INTO source_write_guards VALUES(?,'a','source','q1','qso',?,?,?)",
      id,
      stamp,
      revision,
      h.source.credential_version,
    );
  const update = (revision: string, stamp: number) =>
    h.store.statement(
      "UPDATE source_work SET revision=?,synced_at=?,policy_seen_epoch=? WHERE id='q1'",
      revision,
      stamp,
      h.epoch,
    );
  await h.store.checkpoint(
    lease,
    "source",
    "sync",
    10,
    cursor,
    [
      guard("first", "revision", 100),
      update("canonical-first", 101),
      h.store.statement("DELETE FROM source_write_guards WHERE id='first'"),
      guard("second", "canonical-first", 101),
      update("canonical-second", 102),
      h.store.statement("DELETE FROM source_write_guards WHERE id='second'"),
    ],
    NOW + 4,
  );
  assert.equal(
    await membership(),
    h.epoch,
    "duplicate page rows keep exact CAS",
  );
  await assert.rejects(
    h.store.checkpoint(
      lease,
      "source",
      "sync",
      11,
      cursor,
      [update("must-rollback", 103), guard("stale", "canonical-second", 102)],
      NOW + 5,
    ),
    /source row changed/,
  );
  assert.equal(
    await h.store
      .statement("SELECT revision FROM source_work WHERE id='q1'")
      .first("revision"),
    "canonical-second",
  );
  assert.equal(await membership(), h.epoch);
  await assert.rejects(
    h.store.checkpoint(
      lease,
      "source",
      "sync",
      11,
      { mode: "forward" },
      [update("old-worker-canonical", 103)],
      NOW + 5,
    ),
    /source policy cursor changed/,
  );
  assert.equal(
    await membership(),
    h.epoch,
    "old cursor failure rolls back body change",
  );

  const rescan = (await h.store.claim("a", "poll:source:rescan", NOW + 6))!;
  await h.store.checkpoint(
    rescan,
    "source",
    "rescan",
    0,
    { mode: "backfill" },
    [update("rescan", 103)],
    NOW + 7,
  );
  assert.equal(
    await membership(),
    null,
    "another stream lease cannot witness membership",
  );
  await h.store
    .statement(
      "UPDATE source_work SET policy_seen_epoch=? WHERE id='q1'",
      h.epoch,
    )
    .run();
  await h.store.checkpoint(
    lease,
    "source",
    "sync",
    11,
    cursor,
    [
      h.store.statement(
        "UPDATE leases SET expires_at=? WHERE tenant='a' AND scope='poll:source:sync'",
        NOW + 8,
      ),
      update("expired-lease", 104),
    ],
    NOW + 8,
  );
  assert.equal(
    await membership(),
    null,
    "lease expiry cannot preserve membership",
  );
});

test("both vendors reject a policy reset after preparation and preserve ownership", async (t) => {
  for (const vendor of ["qrz", "lotw"] as const)
    await t.test(vendor, async (t) => {
      const h = await fixture(t, vendor);
      const attempt = await h.stage();
      const lease = (await h.store.claim(
        "a",
        "delivery:destination",
        NOW + 3,
        90_000,
      ))!;
      assert(
        await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 3),
      );
      await h.reset();
      assert.equal(
        await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 4),
        false,
      );
      await assert.rejects(
        h.store.claimAttempt("a", attempt, lease, NOW + 4),
        /source read policy unavailable before dispatch/,
      );
      assert.equal(
        await h.store
          .statement("SELECT state FROM attempt_state WHERE attempt=?", attempt)
          .first("state"),
        "prepared",
      );
      assert.equal(
        await h.store
          .statement("SELECT count(*) FROM destination_identity_claims")
          .first("count(*)"),
        1,
      );
      await h.ready();
      assert(await h.store.claimAttempt("a", attempt, lease, NOW + 5));
      assert(
        await claimedAttemptCurrent(
          h.store,
          "a",
          attempt,
          h.claim,
          NOW + 5,
          lease,
        ),
      );
      // Destination readback/certificate checks can be in flight after claiming.
      await h.reset();
      assert.equal(
        await claimedAttemptCurrent(
          h.store,
          "a",
          attempt,
          h.claim,
          NOW + 6,
          lease,
        ),
        false,
      );
      await h.store
        .statement(
          "UPDATE attempt_state SET state='uncertain' WHERE attempt=?",
          attempt,
        )
        .run();
      assert.equal(
        await h.store
          .statement("SELECT state FROM attempt_state WHERE attempt=?", attempt)
          .first("state"),
        "uncertain",
      );
      assert.equal(
        await h.store
          .statement("SELECT count(*) FROM attempt_identity_claims")
          .first("count(*)"),
        1,
      );
    });
});

test("final dispatch proof rejects event membership and logical account changes in flight", async (t) => {
  const h = await fixture(t);
  const attempt = await h.stage();
  const lease = (await h.store.claim(
    "a",
    "delivery:destination",
    NOW + 3,
    90_000,
  ))!;
  assert(await h.store.claimAttempt("a", attempt, lease, NOW + 3));
  await h.store
    .statement(
      "UPDATE source_work SET policy_seen_epoch='old' WHERE id='event'",
    )
    .run();
  assert.equal(
    await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 4, lease),
    false,
  );
  await h.store
    .statement(
      "UPDATE source_work SET policy_seen_epoch=? WHERE id='event'",
      h.epoch,
    )
    .run();
  assert(
    await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 4, lease),
  );
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "other" }),
    )
    .run();
  assert.equal(
    await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 4, lease),
    false,
  );
});

test("policy birth and cutover fencing keeps drain discoveries historical and old births below a new baseline", async (t) => {
  const h = await fixture(t);
  await h.reset();
  await recordBirth(
    h.store,
    "a",
    "source",
    "drain-new",
    "sync",
    "forward",
    11,
    NOW + 3,
  ).run();
  assert.equal(
    await h.store
      .statement("SELECT phase FROM source_births WHERE qso='drain-new'")
      .first("phase"),
    "history",
  );
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO source_births VALUES('a','source','old-worker-new','forward_new',?,11,'sync')",
        NOW + 3,
      )
      .run(),
    /source read policy cannot establish new birth/,
  );
  assert.equal(
    await establishCutovers(
      h.store,
      h.source,
      { sourceBoundaryVerified: true },
      NOW + 3,
    ),
    0,
  );
  await h.ready();
  assert.equal(
    await establishCutovers(
      h.store,
      h.source,
      { sourceBoundaryVerified: true },
      NOW + 4,
    ),
    1,
  );
  await recordBirth(
    h.store,
    "a",
    "source",
    "q1",
    "sync",
    "forward",
    11,
    NOW + 5,
  ).run();
  assert.equal(
    await h.store
      .statement("SELECT phase FROM source_births WHERE qso='q1'")
      .first("phase"),
    "history",
    "retained source UUID remains historical",
  );
  await recordBirth(
    h.store,
    "a",
    "source",
    "after",
    "sync",
    "forward",
    11,
    NOW + 5,
  ).run();
  await h.store
    .statement(
      "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,state,expires_at,policy_seen_epoch) VALUES('a','source','after','qso','unused','revision','pending',?,?)",
      NOW + 3_600_000,
      h.epoch,
    )
    .run();
  await h.store
    .statement(
      "UPDATE cursors SET generation=11 WHERE tenant='a' AND connection='source' AND stream='sync'",
    )
    .run();
  assert(await proveNewAfterCutover(h.store, { ...h.key, qso: "after" }));
  await h.store
    .statement("UPDATE source_work SET policy_seen_epoch=NULL WHERE id='after'")
    .run();
  assert.equal(
    await proveNewAfterCutover(h.store, { ...h.key, qso: "after" }),
    false,
  );
  await h.ready(12);
  assert.equal(
    await proveNewAfterCutover(h.store, { ...h.key, qso: "after" }),
    false,
    "immutable old birth cannot pass a newer baseline",
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT first_cursor_generation FROM source_births WHERE qso='after'",
      )
      .first("first_cursor_generation"),
    11,
  );
});

test("old-worker cutover insertion is rejected atomically while a policy is not ready", async (t) => {
  const h = await fixture(t);
  const cursor = await h.store
    .statement(
      "SELECT cursor FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
    )
    .first<string>("cursor");
  await h.reset();
  await assert.rejects(
    h.db.batch([
      h.store.statement(
        "UPDATE ledger SET reason='must rollback' WHERE qso='q1'",
      ),
      h.store.statement(
        "INSERT INTO source_cutovers(tenant,source,destination,epoch,source_generation,source_cursor,evidence_kind,evidence_generation,created_at) VALUES('a','source','destination','old-worker',10,?,'initial_inventory',10,?)",
        cursor,
        NOW + 3,
      ),
    ]),
    /source read policy cannot establish cutover/,
  );
  assert.equal(
    await h.store
      .statement("SELECT reason FROM ledger WHERE qso='q1'")
      .first("reason"),
    null,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_cutovers")
      .first("count(*)"),
    0,
  );
});

test("no-policy behavior remains dormant during the phased migration", async (t) => {
  const h = await fixture(t, "qrz", false);
  assert(
    await h.stage(),
    "phased migration does not change sources without a policy row",
  );
  await seed(h.store, "b");
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) FROM source_read_contact_membership WHERE tenant='b'",
      )
      .first("count(*)"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_read_policies")
      .first("count(*)"),
    0,
  );
});

test("active policy refuses legacy null-context rows even when every membership marker is current", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement("UPDATE ledger SET context_generation=NULL WHERE qso='q1'")
    .run();
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=? WHERE connection='source' AND id='event'",
      NOW,
    )
    .run();
  await assert.rejects(
    h.stage(),
    /source read policy unavailable before stage/,
  );
  await assert.rejects(
    h.stage(false),
    /source read policy unavailable before stage/,
  );
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=NULL WHERE connection='source' AND id='event'",
    )
    .run();
  await h.store
    .statement("UPDATE ledger SET context_generation=1 WHERE qso='q1'")
    .run();
  const attempt = await h.stage();
  const lease = (await h.store.claim(
    "a",
    "delivery:destination",
    NOW + 3,
    90000,
  ))!;
  await h.store
    .statement("UPDATE ledger SET context_generation=NULL WHERE qso='q1'")
    .run();
  await h.store
    .statement(
      "UPDATE private_data SET expires_at=? WHERE connection='source' AND id='q1'",
      NOW,
    )
    .run();
  assert.equal(
    await claimedAttemptCurrent(h.store, "a", attempt, h.claim, NOW + 3),
    false,
  );
  await assert.rejects(
    h.store.claimAttempt("a", attempt, lease, NOW + 3),
    /source read policy unavailable before dispatch/,
  );
});

test("tenant-scoped policy membership cannot be borrowed from another ready source", async (t) => {
  const h = await fixture(t);
  const key = await seed(h.store, "b");
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='b' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  const source = (await h.store.connection("b", "source"))!;
  const lease = (await h.store.claim("b", "poll:source:sync", NOW, 90000))!;
  const activated = await ensureSourceReadPolicy(h.store, source, lease, NOW);
  const epoch = activated.policy.epoch;
  await h.db.batch([
    h.store.statement(
      "UPDATE source_read_policies SET phase='ready',completed_sync_generation=10,completed_at=? WHERE tenant='b' AND source='source'",
      NOW + 1,
    ),
    h.store.statement(
      "UPDATE cursors SET generation=10,cursor=? WHERE tenant='b' AND connection='source' AND stream='sync'",
      JSON.stringify({ ...activated.cursor.cursor, mode: "forward" }),
    ),
    h.store.statement(
      "UPDATE cursors SET generation=1,cursor=? WHERE tenant='b' AND connection='source' AND stream='context'",
      JSON.stringify({ complete: true, syncComplete: true }),
    ),
    h.store.statement(
      "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,state,expires_at,policy_seen_epoch) VALUES('b','source','q1','qso','q1','revision','pending',?,?)",
      NOW + 3600000,
      h.epoch,
    ),
  ]);
  await (
    await h.store.putPrivate("b", "source", "q1", "source", { uuid: "q1" })
  ).run();
  const template = await h.store.saveTemplate("b", "destination", {});
  await h.store.observe(key, "g1", "hash", 20, false, 0);
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',context_generation=1 WHERE tenant='b' AND qso='q1'",
    )
    .run();
  const stage = async () =>
    h.store.stage(
      key,
      "g1",
      { record },
      "v1",
      template,
      NOW + 2,
      undefined,
      undefined,
      "live",
      {
        claim: h.claim,
        sourceVersion: (await h.store
          .statement(
            "SELECT version FROM reconciliation_work WHERE tenant='b' AND qso='q1'",
          )
          .first<number>("version"))!,
      },
    );
  await assert.rejects(stage(), /source read policy unavailable before stage/);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM attempts WHERE tenant='b'")
      .first("count(*)"),
    0,
  );
  await h.store
    .statement(
      "UPDATE source_work SET policy_seen_epoch=? WHERE tenant='b' AND id='q1'",
      epoch,
    )
    .run();
  assert(await stage());
  assert(
    await h.stage(),
    "the same normalized identity remains independent in another tenant",
  );
});
