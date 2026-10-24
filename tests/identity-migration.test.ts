import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  bindLegacyQrzIdentity,
  destinationIdentityClaim,
} from "../src/identity-claims.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import { canonical, randomToken, sha256 } from "../src/security.ts";
import type { LedgerKey } from "../src/store.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const NOW = Date.parse("2027-01-01T00:00:00Z");
const MIGRATION = "0023_outbound_identity_claims.sql";
const remote: AdifRecord = {
  STATION_CALLSIGN: "W1AW",
  CALL: "K1OLD",
  QSO_DATE: "20261022",
  TIME_ON: "123456",
  BAND: "20m",
  MODE: "FT8",
};

async function setup(vendor: "qrz" | "lotw") {
  const h = await database();
  try {
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter(
        (name) =>
          name.endsWith(".sql") &&
          name > "0001_foundation.sql" &&
          name < MIGRATION,
      )
      .sort())
      await applyMigration(h.db, name);
    await seed(h.store);
    await h.store
      .statement("UPDATE connections SET kind=? WHERE id='destination'")
      .bind(vendor)
      .run();
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','other-source','lofi','other-source','Other source','active','v1',0)",
      )
      .run();
    await (
      await h.store.putPrivate("a", "other-source", "v1", "credential", {
        secret: "synthetic",
      })
    ).run();
    const key = (qso: string, source = "source"): LedgerKey => ({
      tenant: "a",
      source,
      qso,
      destination: "destination",
    });
    async function ledger(
      qso: string,
      remoteId: string | null = null,
      source = "source",
    ) {
      const value = key(qso, source);
      await h.store
        .statement(
          "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,narrative,remote_id,due_at,updated_at) VALUES(?,?,?,?, 'g1','edited-source',?,'remote_preserved',?,0,100)",
          value.tenant,
          value.source,
          value.qso,
          value.destination,
          remoteId ? "adopted_existing" : "missing_current_identity",
          remoteId,
        )
        .run();
      return value;
    }
    async function stage(key: LedgerKey, record = remote) {
      if (vendor === "lotw") {
        // Exercise the actual 0023 transaction/guards as an old worker would.
        // Current Store.stage requires the later 0036 ownership bridge, which
        // is intentionally absent from this migration's historical schema.
        const id = randomToken();
        const payload = { kind: vendor, record };
        const claim = await destinationIdentityClaim(vendor, record);
        await h.db.batch([
          h.store.statement(
            "INSERT INTO stage_guards(id,tenant,source,qso,destination,generation,template_version,now,credential_version,identity_vendor,identity_hash,identity_source_version,identity_lotw_owner_id) VALUES(?,?,?,?,?,'g1',NULL,?,'v1','lotw',?,NULL,?)",
            id,
            key.tenant,
            key.source,
            key.qso,
            key.destination,
            NOW,
            claim.hash,
            `identity:${await sha256(canonical([key.source, key.qso]))}:${claim.hash}`,
          ),
          await h.store.putPrivate(
            key.tenant,
            key.destination,
            id,
            "outbox",
            payload,
            NOW + 7 * 86400_000,
          ),
          h.store.statement(
            "INSERT INTO attempts SELECT ?,?,?,?,?,?,?,?,NULL,'v1',?,source_hash FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=?",
            key.tenant,
            id,
            key.source,
            key.qso,
            key.destination,
            "g1",
            id,
            await sha256(canonical(payload)),
            NOW,
            key.tenant,
            key.source,
            key.qso,
            key.destination,
          ),
          h.store.statement(
            "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at,priority) VALUES(?,?,'prepared',?,?,'live')",
            key.tenant,
            id,
            NOW,
            NOW,
          ),
          h.store.statement(
            "INSERT INTO attempt_identity_claims(tenant,attempt,destination,vendor,identity_hash,source,qso,source_version) VALUES(?,?,?,'lotw',?,?,?,NULL)",
            key.tenant,
            id,
            key.destination,
            claim.hash,
            key.source,
            key.qso,
          ),
          h.store.statement(
            "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES(?,?,'prepared',?)",
            key.tenant,
            id,
            NOW,
          ),
          h.store.statement("DELETE FROM stage_guards WHERE id=?", id),
        ]);
        return id;
      }
      return h.store.stage(
        key,
        "g1",
        { kind: vendor, record },
        "v1",
        null,
        NOW,
        undefined,
        undefined,
        "live",
        { claim: await destinationIdentityClaim(vendor, record) },
      );
    }
    async function counts() {
      return h.store
        .statement(
          "SELECT (SELECT COUNT(*) FROM destination_identity_claims) claims,(SELECT COUNT(*) FROM attempt_identity_claims) attempt_claims,(SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM private_data WHERE kind='outbox') outboxes",
        )
        .first();
    }
    return {
      ...h,
      key,
      ledger,
      stage,
      counts,
      migrate: () => applyMigration(h.db, MIGRATION),
    };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("migration retains canonical 43-character LoTW identities across source routes and later mapping changes", async () => {
  const h = await setup("lotw");
  try {
    const identity = await lotwRemoteIdentity(remote);
    assert.equal(identity.length, 43);
    assert.equal(
      (await destinationIdentityClaim("lotw", remote)).hash,
      identity,
    );
    const owner = await h.ledger("same-qso", identity);
    const contender = await h.ledger("same-qso", null, "other-source");
    await h.migrate();
    assert.deepEqual(
      await h.store
        .statement(
          "SELECT tenant,destination,vendor,identity_hash,source,qso FROM destination_identity_claims",
        )
        .first(),
      {
        tenant: "a",
        destination: "destination",
        vendor: "lotw",
        identity_hash: identity,
        source: owner.source,
        qso: owner.qso,
      },
    );
    await assert.rejects(
      h.stage(contender),
      /outbound identity claim conflict/,
    );
    assert.deepEqual(await h.counts(), {
      claims: 1,
      attempt_claims: 0,
      attempts: 0,
      outboxes: 0,
    });
    await h.store
      .statement(
        "UPDATE ledger SET remote_id=NULL,state='source_deleted' WHERE source='source'",
      )
      .run();
    await assert.rejects(
      h.stage(contender),
      /outbound identity claim conflict/,
    );
    await assert.rejects(
      h.store.statement("DELETE FROM destination_identity_claims").run(),
      /explicit review/,
    );
    assert.deepEqual(await h.counts(), {
      claims: 1,
      attempt_claims: 0,
      attempts: 0,
      outboxes: 0,
    });
  } finally {
    await h.mf.dispose();
  }
});

test("mapped legacy QRZ blocks all preparation until exact LOGID binding and preserves the old identity", async () => {
  const h = await setup("qrz");
  try {
    const owner = await h.ledger("old", "41");
    const contender = await h.ledger("new", null, "other-source");
    await h.migrate();
    const before = await h.store.ledger(owner);
    assert.deepEqual(
      await h.store
        .statement(
          "SELECT source,qso,remote_id FROM legacy_qrz_identity_reservations",
        )
        .first(),
      { source: "source", qso: "old", remote_id: "41" },
    );
    const distinct = { ...remote, CALL: "K1NEW" };
    await assert.rejects(
      h.stage(contender, distinct),
      /legacy QRZ identity backfill required/,
    );
    assert.deepEqual(await h.counts(), {
      claims: 0,
      attempt_claims: 0,
      attempts: 0,
      outboxes: 0,
    });
    assert.equal(
      await bindLegacyQrzIdentity(
        h.store,
        owner,
        { ...remote, APP_QRZLOG_LOGID: "42" },
        "g1",
        "v1",
        NOW,
      ),
      false,
    );
    assert.equal(
      await bindLegacyQrzIdentity(
        h.store,
        owner,
        { ...remote, APP_QRZLOG_LOGID: "41" },
        "g1",
        "v1",
        NOW,
      ),
      true,
    );
    assert.deepEqual(await h.store.ledger(owner), before);
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM legacy_qrz_identity_reservations")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await assert.rejects(
      h.stage(contender),
      /outbound identity claim conflict/,
    );
    const attempt = await h.stage(contender, distinct);
    assert.equal(typeof attempt, "string");
    assert.deepEqual(await h.counts(), {
      claims: 2,
      attempt_claims: 1,
      attempts: 1,
      outboxes: 1,
    });
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT identity_hash FROM destination_identity_claims WHERE source='source' AND qso='old'",
          )
          .first<{ identity_hash: string }>()
      )?.identity_hash,
      (await destinationIdentityClaim("qrz", remote)).hash,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("legacy QRZ possible writes without LOGIDs remain reserved after outbox expiry and cancellation", async (t) => {
  for (const state of ["dispatching", "uncertain"])
    await t.test(state, async () => {
      const h = await setup("qrz");
      try {
        const owner = await h.ledger("old");
        const contender = await h.ledger("new", null, "other-source");
        // Stage through the old schema without a new identity claim, then model
        // a request whose outcome could already exist outside this database.
        const attempt = await h.store.stage(
          owner,
          "g1",
          { kind: "qrz", record: remote },
          "v1",
          null,
          NOW,
        );
        await h.store
          .statement(
            "UPDATE attempt_state SET state=? WHERE attempt=?",
            state,
            attempt,
          )
          .run();
        await h.migrate();
        assert.deepEqual(
          await h.store
            .statement(
              "SELECT tenant,destination,source,qso,attempt FROM legacy_outbound_identity_reservations",
            )
            .first(),
          { ...owner, attempt },
        );
        assert.equal(
          (
            await h.store
              .statement(
                "SELECT COUNT(*) n FROM legacy_qrz_identity_reservations",
              )
              .first<{ n: number }>()
          )?.n,
          0,
          "there is no LOGID to backfill",
        );
        await assert.rejects(
          h.stage(contender),
          /legacy outbound identity backfill required/,
        );
        await h.store
          .statement(
            "DELETE FROM private_data WHERE kind='outbox' AND expires_at<=?",
            NOW + 8 * 86400_000,
          )
          .run();
        await h.store
          .statement(
            "UPDATE attempt_state SET state='cancelled' WHERE attempt=?",
            attempt,
          )
          .run();
        await assert.rejects(
          h.stage(contender),
          /legacy outbound identity backfill required/,
        );
        assert.equal(
          (
            await h.store
              .statement(
                "SELECT COUNT(*) n FROM legacy_outbound_identity_reservations",
              )
              .first<{ n: number }>()
          )?.n,
          1,
        );
        assert.deepEqual(await h.counts(), {
          claims: 0,
          attempt_claims: 0,
          attempts: 1,
          outboxes: 0,
        });
      } finally {
        await h.mf.dispose();
      }
    });
});

test("retained prior LoTW ciphertext excludes other UUIDs even without a current mapping or unexpired body", async () => {
  const h = await setup("lotw");
  try {
    const owner = await h.ledger("old");
    const contender = await h.ledger("new", null, "other-source");
    const identity = {
      remoteId: await lotwRemoteIdentity(remote),
      identity: canonicalLotwIdentity(remote),
    };
    await (
      await h.store.lotwIdentityStatement(owner, identity, "adopted", NOW - 1, {
        sql: "1",
        params: [],
      })
    ).run();
    await h.migrate();
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM destination_identity_claims")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await assert.rejects(
      h.stage(contender),
      /outbound identity claim conflict/,
    );
    await h.store
      .statement(
        "UPDATE private_data SET expires_at=? WHERE kind='lotw_identity'",
        NOW - 1,
      )
      .run();
    await assert.rejects(
      h.stage(contender),
      /outbound identity claim conflict/,
    );
    assert.deepEqual(await h.counts(), {
      claims: 0,
      attempt_claims: 0,
      attempts: 0,
      outboxes: 0,
    });
    // The exact previous owner can acquire the durable replacement reservation.
    await h.stage(owner);
    assert.deepEqual(await h.counts(), {
      claims: 1,
      attempt_claims: 1,
      attempts: 1,
      outboxes: 1,
    });
    assert.equal(
      (
        await h.store
          .statement("SELECT source,qso FROM destination_identity_claims")
          .first<{ source: string; qso: string }>()
      )?.qso,
      owner.qso,
    );
  } finally {
    await h.mf.dispose();
  }
});
