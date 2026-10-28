import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  qrzReadbackMember,
  type ReadbackScope,
} from "../scripts/qrz-readback-member.ts";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import { canonical, seal, sha256 } from "../src/security.ts";
import { keys } from "./helpers.ts";

async function fixture() {
  const now = Date.now();
  const scope: ReadbackScope = {
    tenant: "tenant",
    source: "source",
    destination: "destination",
    bookIdentity: "book",
    credentialVersion: "credential",
    templateVersion: "template",
    sourceAccountId: "account",
    sourceCredentialVersion: "source-credential",
    sourcePolicyEpoch: "epoch",
    sourceReaderPolicy: "all-clients-v1",
  };
  const record = {
    STATION_CALLSIGN: "N1TEST",
    CALL: "K1TEST",
    QSO_DATE: "20261027",
    TIME_ON: "120123",
    BAND: "20M",
    MODE: "FT8",
    MY_GRIDSQUARE: "FN31AA12",
    COMMENT: "original narrative",
  };
  const hash = await sha256(canonical(record));
  const envelope = await seal(
    { kind: "qrz", operation: "insert", record, projectionHash: hash },
    {
      tenant: scope.tenant,
      connection: scope.destination,
      id: "payload",
      kind: "outbox",
      purpose: "storage",
    },
    keys,
  );
  const proof = {
    id: "proof",
    qso: "contact",
    generation: "generation",
    createdAt: now - 2_000,
    expiresAt: now + 60_000,
    scope: {
      tenant: scope.tenant,
      source: scope.source,
      accountId: scope.sourceAccountId,
      credentialVersion: scope.sourceCredentialVersion,
      policyEpoch: scope.sourcePolicyEpoch,
      readerPolicy: scope.sourceReaderPolicy,
    },
  };
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE attempts(tenant,id,source,qso,destination,credential_version,template_version,created_at,payload_id,payload_hash,generation);
    CREATE TABLE attempt_state(tenant,attempt,state,remote_id,dispatched_at,updated_at);
    CREATE TABLE attempt_artifacts(tenant,attempt,envelope,expires_at);
    CREATE TABLE attempt_source_export_proofs(tenant,attempt,proof_id,authorization_mode);
    CREATE TABLE source_export_proofs(tenant,id,source,qso,proof);
    CREATE TABLE attempt_identity_claims(tenant,attempt,destination,vendor,identity_hash,source,qso);
    CREATE TABLE destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso);
    CREATE TABLE historical_remote_owners(tenant,vendor,book_identity,remote_id,source,qso,destination);`);
  db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    scope.tenant,
    "attempt",
    scope.source,
    "contact",
    scope.destination,
    scope.credentialVersion,
    scope.templateVersion,
    now - 1_000,
    "payload",
    hash,
    "generation",
  );
  db.prepare("INSERT INTO attempt_state VALUES(?,?,?,?,?,?)").run(
    scope.tenant,
    "attempt",
    "delivered",
    "123",
    now - 500,
    now - 100,
  );
  db.prepare("INSERT INTO attempt_artifacts VALUES(?,?,?,?)").run(
    scope.tenant,
    "attempt",
    JSON.stringify(envelope),
    now + 86_400_000,
  );
  db.exec(
    "INSERT INTO attempt_source_export_proofs VALUES('tenant','attempt','proof','qrz_fresh_insert')",
  );
  db.prepare("INSERT INTO source_export_proofs VALUES(?,?,?,?,?)").run(
    scope.tenant,
    "proof",
    scope.source,
    "contact",
    JSON.stringify(proof),
  );
  const claim = await destinationIdentityClaim("qrz", record);
  db.prepare("INSERT INTO attempt_identity_claims VALUES(?,?,?,?,?,?,?)").run(
    scope.tenant,
    "attempt",
    scope.destination,
    "qrz",
    claim.hash,
    scope.source,
    "contact",
  );
  db.prepare("INSERT INTO destination_identity_claims VALUES(?,?,?,?,?,?)").run(
    scope.tenant,
    scope.destination,
    "qrz",
    claim.hash,
    scope.source,
    "contact",
  );
  db.exec(
    "INSERT INTO historical_remote_owners VALUES('tenant','qrz','book','123','source','contact','destination')",
  );
  return {
    db,
    record,
    read: () =>
      qrzReadbackMember(
        db,
        scope,
        "attempt",
        keys,
        {
          openedAt: now - 10_000,
          closedAt: now,
        },
        now,
      ),
  };
}

test("readback expectations preserve decrypted source seconds, grid and original narrative", async () => {
  const h = await fixture();
  try {
    const member = await h.read();
    assert.deepEqual(member.record, h.record);
    assert.equal(member.logId, "123");
    assert.equal(member.record.TIME_ON, "120123");
    assert.equal(member.record.MY_GRIDSQUARE, "FN31AA12");
    assert.equal(
      member.serializedAdifHash,
      await sha256(member.serializedAdif),
    );
  } finally {
    h.db.close();
  }
});

test("readback derivation rejects changed receipts, scope, payload, pins and ownership", async (t) => {
  for (const sql of [
    "UPDATE attempt_state SET state='uncertain'",
    "UPDATE attempts SET source='another-source'",
    "UPDATE attempts SET payload_hash='changed'",
    "UPDATE attempt_artifacts SET expires_at=0",
    "UPDATE attempt_artifacts SET envelope='{}'",
    "UPDATE attempt_source_export_proofs SET authorization_mode='source_boundary'",
    "UPDATE source_export_proofs SET proof=json_set(proof,'$.expiresAt',0)",
    "UPDATE destination_identity_claims SET qso='another-contact'",
    "UPDATE historical_remote_owners SET qso='another-contact'",
  ])
    await t.test(sql, async () => {
      const h = await fixture();
      try {
        h.db.exec(sql);
        await assert.rejects(h.read());
      } finally {
        h.db.close();
      }
    });
});
