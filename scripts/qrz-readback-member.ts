/** Derive private readback expectations from a native encrypted saved attempt. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { serializeAdifRecord } from "../src/adif.ts";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import {
  canonical,
  type Envelope,
  type Keyring,
  open,
  sha256,
} from "../src/security.ts";

type Row = Record<string, SQLInputValue>;
export interface ReadbackScope {
  tenant: string;
  source: string;
  destination: string;
  bookIdentity: string;
  credentialVersion: string;
  templateVersion: string;
  sourceAccountId: string;
  sourceCredentialVersion: string;
  sourcePolicyEpoch: string;
  sourceReaderPolicy: string;
}

/** No discovery, network, mutation, key persistence or acceptance side effects. */
export async function qrzReadbackMember(
  db: DatabaseSync,
  scope: ReadbackScope,
  attempt: string,
  keys: Keyring,
  interval: { openedAt: number; closedAt: number },
  now: number,
) {
  const one = (sql: string, ...params: SQLInputValue[]) => {
    const rows = db.prepare(sql).all(...params);
    assert.equal(rows.length, 1, "readback_member_cardinality");
    return rows[0] as Row;
  };
  const a = one(
    "SELECT * FROM attempts WHERE tenant=? AND id=?",
    scope.tenant,
    attempt,
  );
  for (const [name, value] of Object.entries({
    source: scope.source,
    destination: scope.destination,
    credential_version: scope.credentialVersion,
    template_version: scope.templateVersion,
  }))
    assert.equal(a[name], value, "readback_member_scope");
  assert(
    Number.isSafeInteger(a.created_at) &&
      Number(a.created_at) >= interval.openedAt &&
      Number(a.created_at) <= interval.closedAt &&
      interval.closedAt <= now,
    "readback_member_chronology",
  );
  const s = one(
    "SELECT * FROM attempt_state WHERE tenant=? AND attempt=?",
    scope.tenant,
    attempt,
  );
  assert.equal(s.state, "delivered");
  assert(typeof s.remote_id === "string" && /^[1-9][0-9]*$/.test(s.remote_id));
  assert(
    Number.isSafeInteger(s.dispatched_at) &&
      Number(s.dispatched_at) >= Number(a.created_at) &&
      Number(s.dispatched_at) <= Number(s.updated_at) &&
      Number(s.updated_at) <= interval.closedAt,
    "readback_dispatch_chronology",
  );
  const artifact = one(
    "SELECT * FROM attempt_artifacts WHERE tenant=? AND attempt=?",
    scope.tenant,
    attempt,
  );
  assert(Number(artifact.expires_at) > now, "readback_artifact_expired");
  assert(
    typeof artifact.envelope === "string" &&
      Buffer.byteLength(artifact.envelope) <= 1024 * 1024,
  );
  const payload = await open<{
    kind: string;
    operation: string;
    projectionHash: string;
    record: Record<string, string>;
  }>(
    JSON.parse(artifact.envelope) as Envelope,
    {
      tenant: scope.tenant,
      connection: scope.destination,
      id: String(a.payload_id),
      kind: "outbox",
      purpose: "storage",
    },
    keys,
  );
  assert.equal(payload.kind, "qrz");
  assert.equal(payload.operation, "insert");
  assert.equal(await sha256(canonical(payload.record)), a.payload_hash);
  assert.equal(payload.projectionHash, a.payload_hash);
  const pin = one(
    "SELECT pin.authorization_mode,p.proof,p.id,p.source,p.qso FROM attempt_source_export_proofs pin JOIN source_export_proofs p ON p.tenant=pin.tenant AND p.id=pin.proof_id WHERE pin.tenant=? AND pin.attempt=?",
    scope.tenant,
    attempt,
  );
  assert.equal(pin.authorization_mode, "qrz_fresh_insert");
  assert.equal(pin.source, scope.source);
  assert.equal(pin.qso, a.qso);
  const proof = JSON.parse(String(pin.proof));
  assert.equal(proof.id, pin.id);
  assert.equal(proof.qso, a.qso);
  assert.equal(proof.generation, a.generation);
  assert.deepEqual(proof.scope, {
    tenant: scope.tenant,
    source: scope.source,
    accountId: scope.sourceAccountId,
    credentialVersion: scope.sourceCredentialVersion,
    policyEpoch: scope.sourcePolicyEpoch,
    readerPolicy: scope.sourceReaderPolicy,
  });
  assert(
    Number.isSafeInteger(proof.createdAt) &&
      Number.isSafeInteger(proof.expiresAt) &&
      proof.createdAt <= Number(a.created_at) &&
      proof.expiresAt > Number(s.dispatched_at) &&
      proof.expiresAt - proof.createdAt <= 300_000,
    "readback_original_proof_chronology",
  );
  const claim = await destinationIdentityClaim("qrz", payload.record);
  const links = one(
    "SELECT COUNT(*) n FROM attempt_identity_claims i JOIN destination_identity_claims d ON d.tenant=i.tenant AND d.destination=i.destination AND d.vendor=i.vendor AND d.identity_hash=i.identity_hash WHERE i.tenant=? AND i.attempt=? AND i.destination=? AND i.vendor='qrz' AND i.source=? AND i.qso=? AND i.identity_hash=? AND d.source=i.source AND d.qso=i.qso",
    scope.tenant,
    attempt,
    scope.destination,
    scope.source,
    a.qso,
    claim.hash,
  );
  assert.equal(links.n, 1, "readback_original_identity_link");
  const owner = one(
    "SELECT COUNT(*) n FROM historical_remote_owners WHERE tenant=? AND vendor='qrz' AND book_identity=? AND remote_id=? AND source=? AND qso=? AND destination=?",
    scope.tenant,
    scope.bookIdentity,
    s.remote_id,
    scope.source,
    a.qso,
    scope.destination,
  );
  assert.equal(owner.n, 1, "readback_permanent_owner_link");
  return {
    vendor: "qrz" as const,
    tenant: scope.tenant,
    source: scope.source,
    destination: scope.destination,
    qso: String(a.qso),
    attempt,
    bookIdentity: scope.bookIdentity,
    credentialVersion: scope.credentialVersion,
    templateVersion: scope.templateVersion,
    recordHash: String(a.payload_hash),
    serializedAdifHash: await sha256(serializeAdifRecord(payload.record)),
    record: payload.record,
    serializedAdif: serializeAdifRecord(payload.record),
    logId: s.remote_id,
    attemptRow: a,
    artifactEnvelopeSha256: createHash("sha256")
      .update(artifact.envelope)
      .digest("hex"),
    identityHash: claim.hash,
  };
}
