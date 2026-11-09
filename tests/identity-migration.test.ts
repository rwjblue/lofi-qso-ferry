import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  destinationIdentityClaim,
  lotwRemoteIdentity,
} from "../src/destination-receipts.ts";
import { canonical, randomToken, sha256 } from "../src/security.ts";
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

async function setup() {
  const vendor = "lotw";
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
    const scopeKey = (qso: string, source = "source") => ({
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
      const value = scopeKey(qso, source);
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
    async function stage(key: ReturnType<typeof scopeKey>) {
      // Exercise the actual 0023 transaction/guards as an old worker would.
      // Current Store.stage requires the later 0036 ownership bridge, which
      // is intentionally absent from this migration's historical schema.
      const id = randomToken();
      const payload = { kind: vendor, record: remote };
      const claim = await destinationIdentityClaim(vendor, remote);
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
    async function counts() {
      return h.store
        .statement(
          "SELECT (SELECT COUNT(*) FROM destination_identity_claims) claims,(SELECT COUNT(*) FROM attempt_identity_claims) attempt_claims,(SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM private_data WHERE kind='outbox') outboxes",
        )
        .first();
    }
    return {
      ...h,
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
  const h = await setup();
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
