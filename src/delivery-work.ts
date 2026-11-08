import type { PreparedPayload } from "./delivery.ts";
import { canonical, type Envelope, open } from "./security.ts";
import {
  sourceExportProofGuard,
  type SourceExportAuthorization,
} from "./source-export-proofs.ts";
import type { Connection, Ledger, LedgerKey, Store } from "./store.ts";

export interface PreparationWork {
  ledger: Ledger;
  source: Connection;
  destination: Connection;
  credentials: {
    source_envelope: string;
    source_created_at: number;
    source_expires_at: number | null;
    destination_envelope: string;
    destination_created_at: number;
    destination_expires_at: number | null;
  } | null;
  template: { id: string; config: string } | null;
  held: boolean;
  unresolved: boolean;
  contextCurrent: boolean;
  freshCurrent: boolean;
  proofExpiresAt: number;
  ownership: { available: number; legacy: number; legacy_attempt: number };
  backgroundBacklog: number;
}
export interface PreparationMember {
  key: LedgerKey;
  generation: string;
  identityHash: string;
  proof: SourceExportAuthorization;
}
export function deliveryWorkKey(key: LedgerKey) {
  return canonical([key.tenant, key.source, key.qso, key.destination]);
}
function connectionJson(alias: "s" | "d") {
  return `json_object(${["tenant", "id", "kind", "remote_identity", "label", "status", "credential_version", "config", "cutover"].map((field) => `'${field}',${alias}.${field}`).join(",")})`;
}

export interface DispatchWork {
  attempt: {
    tenant: string;
    id: string;
    source: string;
    qso: string;
    destination: string;
    generation: string;
    payload_id: string;
    credential_version: string;
    attempt_state: string;
  };
  source: Connection;
  connection: Connection;
  payload: PreparedPayload;
  credential: { apiKey: string } | null;
  held: boolean;
  authorizationMode: SourceExportAuthorization["authorizationMode"] | null;
  proofExpiresAt: number;
  contextGeneration: number | null;
}

/** Read all immutable artifacts and their current connection/proof metadata once.
 * Mutable authorization is still checked when the attempt is claimed and sent. */
export async function loadDispatchWork(
  store: Store,
  tenant: string,
  ids: readonly string[],
  now: number,
): Promise<Map<string, DispatchWork>> {
  if (!ids.length || ids.length > 25 || new Set(ids).size !== ids.length)
    throw new Error("invalid dispatch cohort");
  type Row = DispatchWork["attempt"] & {
    source_json: string;
    destination_json: string;
    payload_envelope: string;
    credential_envelope: string | null;
    held: number;
    authorization_mode: DispatchWork["authorizationMode"];
    context_generation: number | null;
  };
  const [data, proofs] = await store.db.batch<
    Row | { attempt: string; expires_at: number }
  >([
    store.statement(
      `SELECT a.*,st.state attempt_state,${connectionJson("s")} source_json,${connectionJson("d")} destination_json,
       p.envelope payload_envelope,credential.envelope credential_envelope,l.context_generation,pin.authorization_mode,
       EXISTS(SELECT 1 FROM historical_association_write_blocks h WHERE h.tenant=a.tenant AND h.source=a.source AND h.qso=a.qso AND h.destination=a.destination) held
       FROM json_each(?1) requested JOIN attempts a ON a.tenant=?2 AND a.id=requested.value
       JOIN attempt_state st ON st.tenant=a.tenant AND st.attempt=a.id
       JOIN connections s ON s.tenant=a.tenant AND s.id=a.source AND s.status='active'
       JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination AND d.status='active'
       JOIN private_data p ON p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.payload_id AND p.kind='outbox' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?3)
       LEFT JOIN private_data credential ON credential.tenant=a.tenant AND credential.connection=a.destination AND credential.id=a.credential_version AND credential.kind='credential' AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>?3)
       LEFT JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination
       LEFT JOIN attempt_source_export_proofs pin ON pin.tenant=a.tenant AND pin.attempt=a.id`,
      JSON.stringify(ids),
      tenant,
      Math.max(now, Date.now()),
    ),
    store.statement(
      `SELECT p.attempt,p.expires_at FROM json_each(?1) requested JOIN attempt_source_export_proofs_current p
       ON p.tenant=?2 AND p.attempt=requested.value WHERE p.created_at<=?3 AND p.expires_at>?3`,
      JSON.stringify(ids),
      tenant,
      now,
    ),
  ]);
  const expiry = new Map(
    proofs.results.map((raw) => {
      const row = raw as { attempt: string; expires_at: number };
      return [row.attempt, row.expires_at];
    }),
  );
  const result = new Map<string, DispatchWork>();
  for (const raw of data.results) {
    const row = raw as Row;
    const connection = JSON.parse(row.destination_json) as Connection;
    result.set(row.id, {
      attempt: row,
      source: JSON.parse(row.source_json) as Connection,
      connection,
      payload: await open<PreparedPayload>(
        JSON.parse(row.payload_envelope) as Envelope,
        {
          tenant,
          connection: row.destination,
          id: row.payload_id,
          kind: "outbox",
          purpose: "storage",
        },
        store.keys,
      ),
      credential:
        connection.kind === "qrz" && row.credential_envelope
          ? await open<{ apiKey: string }>(
              JSON.parse(row.credential_envelope) as Envelope,
              {
                tenant,
                connection: row.destination,
                id: row.credential_version,
                kind: "credential",
                purpose: "storage",
              },
              store.keys,
            )
          : null,
      held: Boolean(row.held),
      authorizationMode: row.authorization_mode,
      proofExpiresAt: expiry.get(row.id) ?? 0,
      contextGeneration: row.context_generation,
    });
  }
  return result;
}

/** One bounded read transaction, shared by the entire QRZ preparation cohort.
 * This is input data, never write authority. Stage/dispatch still apply their
 * native version, identity, proof, consent and connection guards. */
export async function loadPreparationWork(
  store: Store,
  members: readonly PreparationMember[],
  now: number,
): Promise<Map<string, PreparationWork>> {
  if (!members.length || members.length > 20)
    throw new Error("invalid preparation cohort");
  for (const member of members)
    sourceExportProofGuard(
      member.proof.scope,
      member.proof.proofId,
      {
        qso: member.key.qso,
        generation: member.generation,
        reconciliationVersion: member.proof.reconciliationVersion,
      },
      now,
    );
  const requested = JSON.stringify(
    members.map((member) => ({
      ...member.key,
      generation: member.generation,
      identity: member.identityHash,
      proof: member.proof.proofId,
      scope: canonical(member.proof.scope),
      version: member.proof.reconciliationVersion,
    })),
  );
  type Row = Ledger & {
    source_json: string;
    destination_json: string;
    source_envelope: string | null;
    source_created_at: number;
    source_expires_at: number | null;
    destination_envelope: string | null;
    destination_created_at: number;
    destination_expires_at: number | null;
    template_id: string | null;
    template_config: string | null;
    held: number;
    unresolved: number;
    context_current: number;
    fresh_current: number;
    available: number;
    legacy: number;
    legacy_attempt: number;
    background_backlog: number;
  };
  const [rows, proofs] = await store.db.batch<
    Row | { member: number; expires_at: number }
  >([
    store.statement(
      `SELECT l.*,${connectionJson("s")} source_json,${connectionJson("d")} destination_json,
       sp.envelope source_envelope,sp.created_at source_created_at,sp.expires_at source_expires_at,
       dp.envelope destination_envelope,dp.created_at destination_created_at,dp.expires_at destination_expires_at,
       t.id template_id,t.config template_config,
       EXISTS(SELECT 1 FROM historical_association_write_blocks h WHERE h.tenant=l.tenant AND h.source=l.source AND h.qso=l.qso AND h.destination=l.destination) held,
       EXISTS(SELECT 1 FROM attempts a JOIN attempt_state st ON st.tenant=a.tenant AND st.attempt=a.id WHERE a.tenant=l.tenant AND a.source=l.source AND a.qso=l.qso AND a.destination=l.destination AND st.state NOT IN('delivered','observed','rejected','cancelled')) unresolved,
       (l.context_generation IS NULL OR EXISTS(SELECT 1 FROM cursors c JOIN source_work w ON w.tenant=c.tenant AND w.source=c.connection AND w.id=l.qso AND w.kind='qso' WHERE c.tenant=l.tenant AND c.connection=l.source AND c.stream='context' AND c.generation=l.context_generation AND json_extract(c.cursor,'$.complete')=1 AND w.state IN('pending','waiting') AND w.expires_at>?2)) context_current,
       EXISTS(SELECT 1 FROM qrz_fresh_insert_eligible f WHERE f.tenant=l.tenant AND f.source=l.source AND f.qso=l.qso AND f.destination=l.destination) fresh_current,
       NOT EXISTS(SELECT 1 FROM destination_identity_claims claim WHERE claim.tenant=l.tenant AND claim.destination=l.destination AND claim.vendor='qrz' AND claim.identity_hash=json_extract(m.value,'$.identity') AND (claim.source!=l.source OR claim.qso!=l.qso)) available,
       EXISTS(SELECT 1 FROM legacy_qrz_identity_reservations r WHERE r.tenant=l.tenant AND r.destination=l.destination) legacy,
       EXISTS(SELECT 1 FROM legacy_outbound_identity_reservations r WHERE r.tenant=l.tenant AND r.destination=l.destination) legacy_attempt,
       (SELECT COUNT(*) FROM (SELECT 1 FROM attempt_state st JOIN attempts a ON a.tenant=st.tenant AND a.id=st.attempt JOIN connections dest ON dest.tenant=a.tenant AND dest.id=a.destination AND dest.status='active' JOIN connections src ON src.tenant=a.tenant AND src.id=a.source AND src.status='active' WHERE st.state='prepared' AND st.priority='background' AND dest.kind='qrz' AND a.credential_version=dest.credential_version AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?2)) LIMIT 2)) background_backlog
       FROM json_each(?1) m JOIN ledger l ON l.tenant=json_extract(m.value,'$.tenant') AND l.source=json_extract(m.value,'$.source') AND l.qso=json_extract(m.value,'$.qso') AND l.destination=json_extract(m.value,'$.destination')
       JOIN connections s ON s.tenant=l.tenant AND s.id=l.source JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination
       LEFT JOIN private_data sp ON sp.tenant=s.tenant AND sp.connection=s.id AND sp.id=s.credential_version AND sp.kind='credential' AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>?3)
       LEFT JOIN private_data dp ON dp.tenant=d.tenant AND dp.connection=d.id AND dp.id=d.credential_version AND dp.kind='credential' AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>?3)
       LEFT JOIN active_templates active ON active.tenant=l.tenant AND active.destination=l.destination
       LEFT JOIN templates t ON t.tenant=l.tenant AND t.destination=l.destination AND t.id=COALESCE(l.template_version,active.version)
       ORDER BY CAST(m.key AS INTEGER)`,
      requested,
      now,
      Math.max(now, Date.now()),
    ),
    // Keep the proof view outside the metadata query to bound SQLite nesting.
    store.statement(
      `SELECT CAST(m.key AS INTEGER) member,p.expires_at FROM json_each(?1) m JOIN source_export_proofs_current p
       ON p.tenant=json_extract(m.value,'$.tenant') AND p.id=json_extract(m.value,'$.proof')
       WHERE json_extract(p.proof,'$.scope')=json_extract(m.value,'$.scope') AND p.qso=json_extract(m.value,'$.qso')
        AND json_extract(p.proof,'$.generation')=json_extract(m.value,'$.generation') AND json_extract(p.proof,'$.reconciliationVersion')=json_extract(m.value,'$.version')
        AND p.created_at<=?2 AND p.expires_at>?2`,
      requested,
      now,
    ),
  ]);
  const expiry = new Map(
    proofs.results.map((row) => {
      const proof = row as { member: number; expires_at: number };
      return [deliveryWorkKey(members[proof.member].key), proof.expires_at];
    }),
  );
  return new Map(
    rows.results.map((raw) => {
      const row = raw as Row;
      return [
        deliveryWorkKey(row),
        {
          ledger: row,
          source: JSON.parse(row.source_json) as Connection,
          destination: JSON.parse(row.destination_json) as Connection,
          credentials:
            row.source_envelope && row.destination_envelope
              ? {
                  source_envelope: row.source_envelope,
                  source_created_at: row.source_created_at,
                  source_expires_at: row.source_expires_at,
                  destination_envelope: row.destination_envelope,
                  destination_created_at: row.destination_created_at,
                  destination_expires_at: row.destination_expires_at,
                }
              : null,
          template:
            row.template_id && row.template_config
              ? { id: row.template_id, config: row.template_config }
              : null,
          held: Boolean(row.held),
          unresolved: Boolean(row.unresolved),
          contextCurrent: Boolean(row.context_current),
          freshCurrent: Boolean(row.fresh_current),
          proofExpiresAt: expiry.get(deliveryWorkKey(row)) ?? 0,
          ownership: {
            available: row.available,
            legacy: row.legacy,
            legacy_attempt: row.legacy_attempt,
          },
          backgroundBacklog: row.background_backlog,
        },
      ];
    }),
  );
}
