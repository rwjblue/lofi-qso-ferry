import type { AdifRecord } from "./adif.ts";
import { historicalCandidates } from "./historical-matching.ts";
import {
  lookupLotwOwnership,
  prepareLotwOwnershipEvidence,
} from "./lotw-ownership.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "./reconcile.ts";
import { canonical, randomToken, sha256 } from "./security.ts";
import type { Lease, LedgerKey, LotwIdentityEvidence, Store } from "./store.ts";

export interface LotwOwnershipWrite extends LedgerKey {
  identity: LotwIdentityEvidence;
  generation: string;
  sourceHash: string;
  attempt?: string;
  payloadHash?: string;
  artifactHash?: string;
  sourceVersion?: number;
  sourceProofId?: string;
  credentialVersion?: string;
  privateEnvelope?: string;
}
export class LotwOwnershipUnavailable extends Error {
  constructor() {
    super("LoTW ownership unavailable");
  }
}
const view = (record: AdifRecord) =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([k, v]) => v !== "" || (k !== "PROP_MODE" && k !== "SAT_NAME"),
    ),
  );
/** Decode only the immutable prepared artifact's actual exact identity. */
export async function lotwPayloadIdentity(
  payload: unknown,
): Promise<LotwIdentityEvidence> {
  const p = payload as {
    kind?: string;
    station?: { callsign: string };
    contact?: {
      call: string;
      date: string;
      time: string;
      band: string;
      mode: string;
      submode?: string;
      propagation?: string;
      satellite?: string;
    };
  };
  if (p?.kind !== "lotw" || !p.station || !p.contact)
    throw new LotwOwnershipUnavailable();
  const c = p.contact;
  const identity = canonicalLotwIdentity({
    STATION_CALLSIGN: p.station.callsign,
    CALL: c.call,
    QSO_DATE: c.date.replaceAll("-", ""),
    TIME_ON: c.time.replaceAll(":", "").replace("Z", ""),
    BAND: c.band,
    MODE: c.mode,
    ...(c.submode ? { SUBMODE: c.submode } : {}),
    PROP_MODE: c.propagation ?? "",
    SAT_NAME: c.satellite ?? "",
  });
  return { identity, remoteId: await lotwRemoteIdentity(identity) };
}
export async function prepareLotwOwnershipBatch(
  store: Store,
  phase: "stage" | "claim" | "check" | "mapping" | "receipt",
  supplied: readonly LotwOwnershipWrite[],
  now = Date.now(),
  existingLease?: Lease,
  options: { partialMappings?: boolean } = {},
) {
  if (options.partialMappings && phase !== "mapping")
    throw new LotwOwnershipUnavailable();
  // Capture every primitive before the first await. No caller can change scope.
  const inputs = supplied.map((x) => ({
    ...x,
    identity: {
      remoteId: x.identity.remoteId,
      identity: { ...x.identity.identity },
    },
  }));
  if (
    !inputs.length ||
    inputs.length > 20 ||
    new Set(inputs.map((x) => x.tenant)).size !== 1 ||
    !Number.isSafeInteger(now)
  )
    throw new LotwOwnershipUnavailable();
  const tenant = inputs[0]?.tenant;
  if (!tenant) throw new LotwOwnershipUnavailable();
  const lease =
    existingLease ?? (await store.claim(tenant, "lotw-ownership", now, 120000));
  if (
    !lease ||
    lease.tenant !== tenant ||
    lease.scope !== "lotw-ownership" ||
    lease.expires_at <= now
  )
    throw new LotwOwnershipUnavailable();
  try {
    let snapshot: { clock: number; keyId: string } | undefined;
    let prepared = [];
    const excluded = new Set<number>();
    for (const [inputIndex, input] of inputs.entries()) {
      const observed = await lookupLotwOwnership(
        store,
        tenant,
        input.identity.identity,
      );
      if (observed.state !== "observed" || !observed.snapshot)
        throw new LotwOwnershipUnavailable();
      const conflict = observed.candidates.some(
        (c) =>
          c.source !== input.source ||
          c.qso !== input.qso ||
          (phase !== "mapping" &&
            phase !== "receipt" &&
            c.destination !== input.destination &&
            c.evidence.firstEvidence !== "reserved"),
      );
      if (
        snapshot &&
        (snapshot.clock !== observed.snapshot.clock ||
          snapshot.keyId !== observed.snapshot.keyId)
      )
        throw new LotwOwnershipUnavailable();
      snapshot = observed.snapshot;
      if (conflict) {
        if (!options.partialMappings) throw new LotwOwnershipUnavailable();
        excluded.add(inputIndex);
        continue;
      }
      const evidence = await prepareLotwOwnershipEvidence(
        store,
        input,
        input.identity.identity,
        now,
      );
      if (
        evidence.identityHash !== input.identity.remoteId ||
        evidence.keyId !== snapshot.keyId
      )
        throw new LotwOwnershipUnavailable();
      prepared.push({
        inputIndex,
        ...input,
        ...evidence,
        identity: input.identity,
        identityHash: evidence.identityHash,
        evidenceId: evidence.id,
        identityPrivateId: `identity:${await sha256(canonical([input.source, input.qso]))}:${evidence.identityHash}`,
      });
    }
    for (const [a, left] of prepared.entries())
      for (const right of prepared.slice(a + 1)) {
        if (left.source === right.source && left.qso === right.qso) {
          if (phase === "stage" && left.destination !== right.destination)
            throw new LotwOwnershipUnavailable();
          continue;
        }
        const match = historicalCandidates(
          "lotw",
          view(left.identity.identity),
          [view(right.identity.identity)],
        );
        if (match.state !== "none") {
          if (!options.partialMappings) throw new LotwOwnershipUnavailable();
          excluded.add(left.inputIndex);
          excluded.add(right.inputIndex);
        }
      }
    if (!snapshot) throw new LotwOwnershipUnavailable();
    prepared = prepared.filter((p) => !excluded.has(p.inputIndex));
    const id = randomToken(),
      expiresAt = Math.min(now + 60000, lease.expires_at);
    if (!prepared.length)
      return {
        begin: [] as D1PreparedStatement[],
        account: [] as D1PreparedStatement[],
        checks: [] as D1PreparedStatement[],
        finish: [] as D1PreparedStatement[],
        excluded: [...excluded],
        lease,
        expiresAt,
        release: () =>
          existingLease ? Promise.resolve() : store.release(lease),
      };
    const plan = prepared.map(
      ({
        inputIndex: _inputIndex,
        identity: _,
        envelope: __,
        bucket: ___,
        id: ____,
        keyId: _____,
        ...p
      }) => p,
    );
    const begin = [
      store.statement(
        "INSERT INTO lotw_ownership_write_guards(id,tenant,phase,key_id,clock,comparison_policy,plan,lease_token,lease_fence,checked_at,expires_at) VALUES(?,?,?,?,?,1,?,?,?,?,?)",
        id,
        tenant,
        phase,
        snapshot.keyId,
        snapshot.clock,
        canonical(plan),
        lease.token,
        lease.fence,
        now,
        expiresAt,
      ),
    ];
    if (phase === "stage" || phase === "mapping")
      for (const p of prepared)
        begin.push(
          store.statement(
            "INSERT INTO lotw_ownership_evidence(tenant,id,destination,source,qso,exact_hash,key_id,bucket,envelope,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM lotw_ownership_evidence WHERE tenant=? AND id=?)",
            tenant,
            p.evidenceId,
            p.destination,
            p.source,
            p.qso,
            p.identityHash,
            p.keyId,
            p.bucket,
            p.envelope,
            now,
            tenant,
            p.evidenceId,
          ),
        );
    const finish: D1PreparedStatement[] = [];
    for (const p of prepared) {
      // Only facts produced by this exact plan are covered. Unrelated old/new
      // writers remain pending and make the final whole-transaction assertion fail.
      finish.push(
        store.statement(
          `UPDATE lotw_ownership_inputs AS i SET status='covered',checked_at=?,evidence_id=? WHERE i.tenant=? AND i.destination=? AND i.status!='covered' AND EXISTS(SELECT 1 FROM lotw_ownership_write_guards WHERE id=?) AND EXISTS(SELECT 1 FROM lotw_ownership_evidence e WHERE e.tenant=i.tenant AND e.id=? AND e.destination=? AND e.source=? AND e.qso=? AND e.exact_hash=?) AND ((i.kind='claim' AND i.reference=? AND i.source=? AND i.qso=? AND i.exact_hash=?) OR (i.kind='attempt' AND i.reference=? AND i.source=? AND i.qso=? AND EXISTS(SELECT 1 FROM attempt_identity_claims c WHERE c.tenant=i.tenant AND c.attempt=i.reference AND c.destination=i.destination AND c.vendor='lotw' AND c.identity_hash=? AND c.source=i.source AND c.qso=i.qso)) OR (i.kind='mapping' AND i.reference=? AND i.source=? AND i.qso=? AND i.exact_hash=? AND EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=i.tenant AND l.source=i.source AND l.qso=i.qso AND l.destination=i.destination AND l.remote_id=i.exact_hash)) OR (i.kind='identity' AND i.reference=? AND EXISTS(SELECT 1 FROM private_data d WHERE d.tenant=i.tenant AND d.connection=i.destination AND d.id=i.reference AND d.kind='lotw_identity' AND d.envelope=? AND d.revoked_at IS NULL AND d.expires_at IS NULL)))`,
          now,
          p.evidenceId,
          tenant,
          p.destination,
          id,
          p.evidenceId,
          p.destination,
          p.source,
          p.qso,
          p.identityHash,
          p.identityHash,
          p.source,
          p.qso,
          p.identityHash,
          p.attempt ?? null,
          p.source,
          p.qso,
          p.identityHash,
          JSON.stringify([p.source, p.qso, p.identityHash]),
          p.source,
          p.qso,
          p.identityHash,
          p.identityPrivateId,
          p.privateEnvelope ?? null,
        ),
      );
    }
    const account = [...finish];
    if (phase !== "mapping" && phase !== "receipt")
      finish.push(
        store.statement(
          `INSERT INTO lotw_ownership_checks(tenant,attempt,clock,key_id,comparison_policy,lease_token,lease_fence,checked_at,expires_at) SELECT p.tenant,p.planned_attempt,s.clock,p.key_id,p.comparison_policy,p.lease_token,p.lease_fence,p.checked_at,p.expires_at FROM lotw_ownership_planned p JOIN lotw_ownership_state s ON s.tenant=p.tenant JOIN attempt_lotw_ownership_pins pin ON pin.tenant=p.tenant AND pin.attempt=p.planned_attempt AND pin.identity_hash=p.identity_hash AND pin.artifact_hash=p.artifact_hash WHERE p.id=? ON CONFLICT(tenant,attempt) DO UPDATE SET clock=excluded.clock,key_id=excluded.key_id,comparison_policy=excluded.comparison_policy,lease_token=excluded.lease_token,lease_fence=excluded.lease_fence,checked_at=excluded.checked_at,expires_at=excluded.expires_at`,
          id,
        ),
      );
    if (phase === "receipt")
      finish.push(
        store.statement(
          `INSERT INTO lotw_ownership_receipt_checks(tenant,attempt,identity_hash,clock,key_id,comparison_policy,lease_token,lease_fence,expires_at) SELECT p.tenant,p.planned_attempt,p.identity_hash,s.clock,p.key_id,p.comparison_policy,p.lease_token,p.lease_fence,p.expires_at FROM lotw_ownership_planned p JOIN lotw_ownership_state s ON s.tenant=p.tenant WHERE p.id=? ON CONFLICT(tenant,attempt) DO UPDATE SET identity_hash=excluded.identity_hash,clock=excluded.clock,key_id=excluded.key_id,comparison_policy=excluded.comparison_policy,lease_token=excluded.lease_token,lease_fence=excluded.lease_fence,expires_at=excluded.expires_at`,
          id,
        ),
      );
    const checks = finish.slice(account.length);
    finish.push(
      store.statement("DELETE FROM lotw_ownership_write_guards WHERE id=?", id),
    );
    return {
      excluded: [...excluded],
      begin,
      account,
      checks,
      finish,
      lease,
      expiresAt,
      release: () => (existingLease ? Promise.resolve() : store.release(lease)),
    };
  } catch (error) {
    if (!existingLease) await store.release(lease);
    throw error;
  }
}
export async function attemptLotwOwnershipWrite(
  store: Store,
  tenant: string,
  attempt: string,
  payload: unknown,
  privateEnvelope?: string,
): Promise<LotwOwnershipWrite> {
  payload = structuredClone(payload);
  const pin = await store
    .statement(
      "SELECT p.*,a.credential_version FROM attempt_lotw_ownership_pins p JOIN attempts a ON a.tenant=p.tenant AND a.id=p.attempt WHERE p.tenant=? AND p.attempt=?",
      tenant,
      attempt,
    )
    .first<{
      source: string;
      qso: string;
      destination: string;
      generation: string;
      source_hash: string;
      identity_hash: string;
      payload_hash: string;
      artifact_hash: string;
      source_version: number;
      source_export_proof_id: string;
      credential_version: string;
    }>();
  if (!pin || (await sha256(canonical(payload))) !== pin.artifact_hash)
    throw new LotwOwnershipUnavailable();
  const identity = await lotwPayloadIdentity(payload);
  if (identity.remoteId !== pin.identity_hash)
    throw new LotwOwnershipUnavailable();
  return {
    tenant,
    source: pin.source,
    qso: pin.qso,
    destination: pin.destination,
    attempt,
    generation: pin.generation,
    sourceHash: pin.source_hash,
    payloadHash: pin.payload_hash,
    artifactHash: pin.artifact_hash,
    sourceVersion: pin.source_version,
    sourceProofId: pin.source_export_proof_id,
    credentialVersion: pin.credential_version,
    identity,
    privateEnvelope,
  };
}
export async function renewAttemptLotwOwnership(
  store: Store,
  tenant: string,
  attempt: string,
  payload: unknown,
  now = Date.now(),
  lease?: Lease,
) {
  const input = await attemptLotwOwnershipWrite(
    store,
    tenant,
    attempt,
    payload,
  );
  const prepared = await prepareLotwOwnershipBatch(
    store,
    "check",
    [input],
    now,
    lease,
  );
  try {
    await store.db.batch([...prepared.begin, ...prepared.finish]);
    return { lease: prepared.lease, expiresAt: prepared.expiresAt };
  } catch (error) {
    await prepared.release();
    throw error;
  }
}
export async function attemptLotwOwnershipCurrent(
  store: Store,
  tenant: string,
  attempt: string,
  now = Date.now(),
) {
  return Boolean(
    await store
      .statement(
        "SELECT 1 present FROM attempt_lotw_ownership_current WHERE tenant=? AND attempt=? AND expires_at>?",
        tenant,
        attempt,
        now,
      )
      .first(),
  );
}

/** Original artifact recovery may retain facts even when this optional check holds. */
export async function prepareLotwReceiptOwnership(
  store: Store,
  tenant: string,
  attempt: string,
  identity: LotwIdentityEvidence,
  privateEnvelope: string | undefined,
  now: number,
) {
  identity = structuredClone(identity);
  const a = await store
    .statement(
      "SELECT * FROM attempts WHERE tenant=? AND id=?",
      tenant,
      attempt,
    )
    .first<{
      source: string;
      qso: string;
      destination: string;
      generation: string;
      source_hash: string;
      payload_hash: string;
      payload_id: string;
    }>();
  if (
    !a ||
    !(await store
      .statement(
        "SELECT 1 present FROM attempt_identity_claims WHERE tenant=? AND attempt=? AND vendor='lotw' AND identity_hash=? AND source=? AND qso=? AND destination=?",
        tenant,
        attempt,
        identity.remoteId,
        a.source,
        a.qso,
        a.destination,
      )
      .first())
  )
    throw new LotwOwnershipUnavailable();
  const payload = await store.private(
    tenant,
    a.destination,
    a.payload_id,
    "outbox",
  );
  const original = await lotwPayloadIdentity(payload);
  if (
    original.remoteId !== identity.remoteId ||
    canonical(original.identity) !== canonical(identity.identity)
  )
    throw new LotwOwnershipUnavailable();
  return prepareLotwOwnershipBatch(
    store,
    "receipt",
    [
      {
        tenant,
        attempt,
        source: a.source,
        qso: a.qso,
        destination: a.destination,
        generation: a.generation,
        sourceHash: a.source_hash,
        payloadHash: a.payload_hash,
        artifactHash: await sha256(canonical(payload)),
        identity: original,
        privateEnvelope,
      },
    ],
    now,
  );
}

export async function lotwOwnershipAvailable(
  store: Store,
  key: LedgerKey,
  identity: LotwIdentityEvidence,
) {
  const result = await lookupLotwOwnership(
    store,
    key.tenant,
    identity.identity,
  );
  return (
    result.state === "observed" &&
    result.candidates.every(
      (c) =>
        c.source === key.source &&
        c.qso === key.qso &&
        (c.destination === key.destination ||
          c.evidence.firstEvidence === "reserved"),
    ) &&
    !(await store
      .statement(
        "SELECT 1 held WHERE EXISTS(SELECT 1 FROM lotw_ownership_unsafe_attempts WHERE tenant=? AND source=? AND qso=? AND destination!=?) OR EXISTS(SELECT 1 FROM lotw_ownership_inputs WHERE tenant=? AND source=? AND qso=? AND destination!=? AND kind='mapping')",
        key.tenant,
        key.source,
        key.qso,
        key.destination,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      )
      .first())
  );
}
