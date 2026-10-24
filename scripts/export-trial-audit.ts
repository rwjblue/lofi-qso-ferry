/**
 * One explicit contact's closed-gate metadata packet. This module constructs a
 * SELECT only: no database runner, vendor request, decryption, signing or writes.
 * The caller supplies identities from the normal projection/identity helper.
 * Passing these checks never proves source completeness or fresh remote absence.
 * A current mandatory source-export proof must still be collected and pinned by
 * the normal runtime; policy membership alone is not that proof.
 */
import type { DestinationIdentityClaim } from "../src/identity-claims.ts";
import { canonical, sha256 } from "../src/security.ts";

export interface ExportTrialAuditScope {
  tenant: string;
  source: string;
  qso: string;
  generation: string;
  sourceRevision: string;
  reconciliationVersion: number;
  contextGeneration: number;
  now: number;
  routes: readonly {
    destination: string;
    credentialVersion: string;
    identity: DestinationIdentityClaim;
  }[];
}
const required = [
  "source_active",
  "source_credential_available",
  "source_revision_current",
  "source_body_available",
  "dependencies_available",
  "source_version_current",
  "context_current",
  "sync_forward",
  "source_policy_ready",
  "source_policy_membership_current",
  "birth_present",
  "destination_active",
  "destination_credential_current",
  "destination_credential_available",
  "ledger_current",
  "quiet_period_complete",
  "first_insert_candidate",
] as const;
const prohibited = [
  "unresolved_attempts",
  "attempt_states_missing",
  "competing_claims",
  "legacy_lotw_claims",
  "legacy_qrz_reservations",
  "legacy_outbound_reservations",
  "adoption_conflict",
  "existing_mapping",
  "historical_association_blocks",
  "other_active_ledger_routes",
] as const;
const observations = ["owned_claims", "ledger_present"] as const;
const metrics = [...required, ...prohibited, ...observations] as const;
type Metric = (typeof metrics)[number];

const sql = `
WITH expected_routes AS (
 SELECT CAST(key AS INTEGER) route_slot,json_extract(value,'$.destination') destination,
   json_extract(value,'$.credentialVersion') credential_version,
   json_extract(value,'$.identity.vendor') vendor,json_extract(value,'$.identity.hash') identity_hash
 FROM json_each(?9)
), source AS (
 SELECT s.* FROM connections s JOIN accounts a ON a.id=s.tenant
 WHERE s.tenant=?1 AND s.id=?2 AND s.kind='lofi' AND s.status='active' AND a.status='active'
), contact AS (
 SELECT w.* FROM source_work w WHERE w.tenant=?1 AND w.source=?2 AND w.id=?3 AND w.kind='qso'
), context AS (
 SELECT c.* FROM cursors c WHERE c.tenant=?1 AND c.connection=?2 AND c.stream='context'
)
SELECT r.route_slot,r.vendor,
 (SELECT COUNT(*) FROM source) source_active,
 (SELECT COUNT(*) FROM source s JOIN private_data p ON p.tenant=s.tenant AND p.connection=s.id AND p.id=s.credential_version AND p.kind='credential'
   WHERE p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?8)) source_credential_available,
 (SELECT COUNT(*) FROM contact w WHERE w.revision=?5 AND w.deleted=0 AND w.is_event=0 AND w.state IN('pending','waiting')) source_revision_current,
 (SELECT COUNT(*) FROM contact w JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source'
   WHERE w.expires_at>?8 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?8)) source_body_available,
 (SELECT COUNT(*) FROM contact w WHERE w.operation_id IS NULL OR EXISTS(
   SELECT 1 FROM source_work o JOIN private_data p ON p.tenant=o.tenant AND p.connection=o.source AND p.id=o.private_id AND p.kind='source'
   WHERE o.tenant=w.tenant AND o.source=w.source AND o.id=w.operation_id AND o.kind='operation' AND o.state='context' AND o.deleted=0
     AND o.expires_at>?8 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?8)
     AND NOT EXISTS(SELECT 1 FROM source_work e LEFT JOIN private_data ep ON ep.tenant=e.tenant AND ep.connection=e.source AND ep.id=e.private_id AND ep.kind='source'
       WHERE e.tenant=o.tenant AND e.source=o.source AND e.operation_id=o.id AND e.kind='qso' AND e.is_event=1 AND e.deleted=0
         AND (e.expires_at<=?8 OR ep.id IS NULL OR ep.revoked_at IS NOT NULL OR (ep.expires_at IS NOT NULL AND ep.expires_at<=?8))))) dependencies_available,
 (SELECT COUNT(*) FROM reconciliation_work w WHERE w.tenant=?1 AND w.source=?2 AND w.qso=?3 AND w.version=?6) source_version_current,
 (SELECT COUNT(*) FROM context WHERE generation=?7 AND json_extract(cursor,'$.complete')=1 AND json_extract(cursor,'$.syncComplete')=1) context_current,
 (SELECT COUNT(*) FROM cursors WHERE tenant=?1 AND connection=?2 AND stream='sync' AND json_extract(cursor,'$.mode')='forward') sync_forward,
 (SELECT COUNT(*) FROM source_read_policy_ready WHERE tenant=?1 AND source=?2) source_policy_ready,
 (SELECT COUNT(*) FROM source_read_contact_membership WHERE tenant=?1 AND source=?2 AND qso=?3 AND operation_id IS (SELECT operation_id FROM contact)) source_policy_membership_current,
 (SELECT COUNT(*) FROM source_births WHERE tenant=?1 AND source=?2 AND qso=?3) birth_present,
 (SELECT COUNT(*) FROM connections d WHERE d.tenant=?1 AND d.id=r.destination AND d.kind=r.vendor AND d.status='active') destination_active,
 (SELECT COUNT(*) FROM connections d WHERE d.tenant=?1 AND d.id=r.destination AND d.credential_version=r.credential_version) destination_credential_current,
 (SELECT COUNT(*) FROM private_data p WHERE p.tenant=?1 AND p.connection=r.destination AND p.id=r.credential_version AND p.kind='credential'
   AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?8)) destination_credential_available,
 (SELECT COUNT(*) FROM ledger l WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND l.destination=r.destination AND l.generation=?4 AND l.context_generation=?7 AND l.operation_id IS (SELECT operation_id FROM contact)) ledger_current,
 (SELECT COUNT(*) FROM ledger l WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND l.destination=r.destination AND l.due_at<=?8) quiet_period_complete,
 (SELECT COUNT(*) FROM ledger l WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND l.destination=r.destination
   AND NOT EXISTS(SELECT 1 FROM historical_association_write_blocks h WHERE h.tenant=l.tenant AND h.source=l.source AND h.qso=l.qso AND h.destination=l.destination)
   AND ((r.vendor='qrz' AND EXISTS(SELECT 1 FROM qrz_fresh_insert_eligible f WHERE f.tenant=l.tenant AND f.source=l.source AND f.qso=l.qso AND f.destination=l.destination))
    OR (r.vendor='lotw' AND EXISTS(SELECT 1 FROM lotw_fresh_insert_eligible f WHERE f.tenant=l.tenant AND f.source=l.source AND f.qso=l.qso AND f.destination=l.destination)))) first_insert_candidate,
 (SELECT COUNT(*) FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=?1 AND a.source=?2 AND a.qso=?3 AND a.destination=r.destination AND s.state NOT IN('delivered','observed','rejected','cancelled')) unresolved_attempts,
 (SELECT COUNT(*) FROM attempts a LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=?1 AND a.source=?2 AND a.qso=?3 AND a.destination=r.destination AND s.attempt IS NULL) attempt_states_missing,
 (SELECT COUNT(*) FROM destination_identity_claims c WHERE c.tenant=?1 AND c.destination=r.destination AND c.vendor=r.vendor AND c.identity_hash=r.identity_hash AND (c.source!=?2 OR c.qso!=?3)) competing_claims,
 (SELECT COUNT(*) FROM private_data p WHERE r.vendor='lotw' AND p.tenant=?1 AND p.connection=r.destination AND p.kind='lotw_identity' AND substr(p.id,-44)=':'||r.identity_hash AND p.id!=?10||r.identity_hash AND p.revoked_at IS NULL) legacy_lotw_claims,
 (SELECT COUNT(*) FROM legacy_qrz_identity_reservations x WHERE x.tenant=?1 AND x.destination=r.destination) legacy_qrz_reservations,
 (SELECT COUNT(*) FROM legacy_outbound_identity_reservations x WHERE x.tenant=?1 AND x.destination=r.destination) legacy_outbound_reservations,
 (SELECT COUNT(*) FROM ledger l WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND l.destination=r.destination AND l.provenance='adoption_conflict') adoption_conflict,
 (SELECT COUNT(*) FROM ledger l WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND l.destination=r.destination AND l.remote_id IS NOT NULL) existing_mapping,
 (SELECT COUNT(*) FROM historical_association_write_blocks h WHERE h.tenant=?1 AND h.source=?2 AND h.qso=?3 AND h.destination=r.destination) historical_association_blocks,
 (SELECT COUNT(*) FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND d.status='active' AND l.state!='retained_old_route' AND NOT EXISTS(SELECT 1 FROM expected_routes e WHERE e.destination=l.destination)) other_active_ledger_routes,
 (SELECT COUNT(*) FROM destination_identity_claims c WHERE c.tenant=?1 AND c.destination=r.destination AND c.vendor=r.vendor AND c.identity_hash=r.identity_hash AND c.source=?2 AND c.qso=?3) owned_claims,
 (SELECT COUNT(*) FROM ledger l WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND l.destination=r.destination) ledger_present
FROM expected_routes r ORDER BY r.route_slot
`;
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}
export async function exportTrialAuditQuery(scope: ExportTrialAuditScope) {
  if (
    !scope ||
    ![
      scope.tenant,
      scope.source,
      scope.qso,
      scope.generation,
      scope.sourceRevision,
    ].every(identifier) ||
    ![scope.now, scope.reconciliationVersion, scope.contextGeneration].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !Array.isArray(scope.routes) ||
    scope.routes.length < 1 ||
    scope.routes.length > 2 ||
    new Set(scope.routes.map((route) => route?.destination)).size !==
      scope.routes.length ||
    new Set(scope.routes.map((route) => route?.identity?.vendor)).size !==
      scope.routes.length ||
    scope.routes.some(
      (route) =>
        !route ||
        !identifier(route.destination) ||
        !identifier(route.credentialVersion) ||
        !["qrz", "lotw"].includes(route.identity?.vendor) ||
        !/^[A-Za-z0-9_-]{43}$/.test(route.identity?.hash),
    )
  )
    throw new Error("Invalid export trial audit scope");
  // Uses the existing retained LoTW owner encoding, not a second vendor identity.
  const ownerPrefix = `identity:${await sha256(canonical([scope.source, scope.qso]))}:`;
  return {
    sql,
    params: [
      scope.tenant,
      scope.source,
      scope.qso,
      scope.generation,
      scope.sourceRevision,
      scope.reconciliationVersion,
      scope.contextGeneration,
      scope.now,
      JSON.stringify(scope.routes),
      ownerPrefix,
    ] as const,
  };
}

/** Safe to display: ignore extra columns and never include private input scope. */
export function exportTrialAuditReport(
  rows: unknown,
  expectedVendors: readonly ("qrz" | "lotw")[],
) {
  if (
    !Array.isArray(rows) ||
    !Array.isArray(expectedVendors) ||
    expectedVendors.length < 1 ||
    expectedVendors.length > 2 ||
    new Set(expectedVendors).size !== expectedVendors.length ||
    expectedVendors.some((vendor) => !["qrz", "lotw"].includes(vendor)) ||
    rows.length !== expectedVendors.length
  )
    throw new Error("Invalid export trial audit result");
  const routes = rows.map((row: unknown, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("Invalid export trial audit result");
    const value = row as Record<string, unknown>;
    if (value.route_slot !== index || value.vendor !== expectedVendors[index])
      throw new Error("Invalid export trial audit result");
    const counts = {} as Record<Metric, number>;
    for (const metric of metrics) {
      const count = value[metric];
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        (([...required, ...observations] as readonly string[]).includes(
          metric,
        ) &&
          count > 1)
      )
        throw new Error("Invalid export trial audit result");
      counts[metric] = count;
    }
    return {
      slot: index,
      vendor: expectedVendors[index],
      metadataChecksPass:
        required.every((metric) => counts[metric] === 1) &&
        prohibited.every((metric) => counts[metric] === 0),
      counts,
    };
  });
  return {
    evidence: "local-metadata-only" as const,
    writesAuthorized: false as const,
    sourceBoundaryVerified: false as const,
    sourceExportProofVerified: false as const,
    requiresCurrentSourceExportProof: true as const,
    freshVendorChecksComplete: false as const,
    routes,
  };
}
