import { purgeAuth } from "./auth.ts";
import { establishCutovers, proveNewAfterCutover } from "./cutover.ts";
import { type DatabaseMetrics, measuredDatabase } from "./database-metrics.ts";
import type { DeliveryGates } from "./delivery.ts";
import {
  cancelStalePreparedSourceProof,
  contactReconciliationAdif,
  deliveryMode,
  dispatchAttempt,
  prepareDue,
  qrzNeighborhoodFallback,
  reconcileAttempt,
  refreshConfirmations,
} from "./delivery.ts";
import { createFailureDiagnostics } from "./failure-diagnostics.ts";
import {
  type HistoricalSourceCandidateResult,
  historicalSourceCandidates,
  historicalSourceCandidatesBatch,
} from "./historical-source-candidates.ts";
import type {
  HistoryInventoryInput,
  HistoryInventoryResult,
} from "./history-inventory.ts";
import {
  historyCandidates,
  historyCandidatesBatch,
  historyInventoryGuard,
  pruneHistoryInventory,
} from "./history-inventory.ts";
import {
  backfillLegacyQrzIdentity,
  type IdentityBackfillResult,
} from "./identity-backfill.ts";
import type { IntakeContact } from "./intake.ts";
import {
  expireSource,
  observeContact,
  observeContacts,
  pendingContactBatch,
  pendingContacts,
  pollSource,
  rereadOperation,
} from "./intake.ts";
import { LotwClient, LotwLoginError } from "./lotw.ts";
import { refreshLotwCertificates } from "./lotw-maintenance.ts";
import { backfillLotwOwnership } from "./lotw-ownership.ts";
import { purgeResolvedSource, rotatePrivateData } from "./maintenance.ts";
import type { Contact } from "./projection.ts";
import { sourceFingerprint } from "./projection.ts";
import { QrzClient, QrzError } from "./qrz.ts";
import type {
  HistoryAdoptionInput,
  ReconciliationEvidence,
  ReconciliationOutcome,
} from "./reconcile.ts";
import {
  adoptHistory,
  adoptHistoryBatch,
  classifyHistoricalAssociation,
  HISTORICAL_MATCHING_VERSION,
} from "./reconcile.ts";
import {
  finishReconciliationWork,
  finishReconciliationWorkStatement,
  reconciliationCheckStatement,
  reconciliationPreflight,
  reconciliationPreflightBatch,
  recordReconciliationCheck,
  syncReconciliationPolicy,
} from "./reconciliation-work.ts";
import {
  admitBackgroundSource,
  type BackgroundSource,
  backgroundSources,
} from "./scheduler-admission.ts";
import { keyring } from "./security.ts";
import { ensureSourceExportProofs } from "./source-export-coordinator.ts";
import {
  loadCurrentSourceExportProofs,
  loadCurrentSourcePresenceScope,
  loadSourceExportSnapshots,
  lotwFreshInsertCurrent,
  purgeExpiredSourceExportProofs,
  qrzFreshInsertCurrent,
  type SourceExportSnapshot,
} from "./source-export-proofs.ts";
import { backfillSourceHistoricalIndex } from "./source-historical-index.ts";
import type { SourcePresenceScope } from "./source-presence-store.ts";
import type { Connection, LedgerKey } from "./store.ts";
import { Store } from "./store.ts";
import type { VendorPriority } from "./vendor-requests.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

function uniqueRoutes(destinations: readonly Connection[], contact: Contact) {
  return (["qrz", "lotw"] as const).flatMap((kind) => {
    const matches = destinations.filter(
      (destination) =>
        destination.kind === kind && routeMatches(destination, contact),
    );
    return matches.length === 1 ? matches : [];
  });
}

/** A single unavailable or oversized context must not strand its valid neighbors. */
async function fittingSourceExportSnapshots(
  store: Store,
  scope: SourcePresenceScope,
  qsos: readonly string[],
  limit: number,
  now: () => number,
  expired: () => boolean,
): Promise<SourceExportSnapshot[]> {
  const first = qsos.slice(0, limit);
  const together = await loadSourceExportSnapshots(store, scope, first, now());
  if (together.length === first.length) return together;
  const selected: string[] = [];
  const dependencies = new Set<string>();
  for (const qso of qsos.slice(0, 20)) {
    if (expired() || selected.length >= limit) break;
    const [snapshot] = await loadSourceExportSnapshots(
      store,
      scope,
      [qso],
      now(),
    );
    if (!snapshot) continue;
    const next = new Set(dependencies);
    for (const target of snapshot.targets)
      next.add(JSON.stringify([target.kind, target.id]));
    if (next.size > 64) continue;
    selected.push(qso);
    for (const key of next) dependencies.add(key);
  }
  // Reload the chosen subset together: independently loaded generations must
  // never be assembled into a purported coherent snapshot.
  return selected.length && !expired()
    ? loadSourceExportSnapshots(store, scope, selected, now())
    : [];
}
export function deliveryGates(env: Env): DeliveryGates {
  const scope = (value: string | undefined): string[] | null => {
    const parsed: unknown = JSON.parse(value || "[]");
    if (
      !Array.isArray(parsed) ||
      parsed.some((v) => typeof v !== "string" || !v || v.length > 256) ||
      (parsed.includes("*") && parsed.length !== 1)
    )
      throw new Error("Invalid rollout scope");
    return parsed.length === 1 && parsed[0] === "*"
      ? null
      : (parsed as string[]);
  };
  return {
    allowedQsoIds: scope(env.ROLLOUT_QSO_IDS_JSON),
    allowedDestinationIds: scope(env.ROLLOUT_DESTINATION_IDS_JSON),
    exportsEnabled:
      String(env.EXPORTS_ENABLED) === "true" &&
      String(env.ROLLOUT_CHECKS_PASSED) === "true",
    liveWriteAuthorized:
      String(env.LIVE_WRITE_AUTHORIZATION) === "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    sourceBoundaryVerified: String(env.SOURCE_BOUNDARY_VERIFIED) === "true",
    qrzFreshInsertsEnabled: String(env.QRZ_FRESH_INSERTS_ENABLED) === "true",
    lotwFreshInsertsEnabled: String(env.LOTW_FRESH_INSERTS_ENABLED) === "true",
  };
}
export function exportsEffective(gates: DeliveryGates): boolean {
  return (
    (deliveryMode(gates, "qrz") !== null ||
      deliveryMode(gates, "lotw") !== null) &&
    (gates.allowedQsoIds === null || (gates.allowedQsoIds?.length ?? 0) > 0) &&
    (gates.allowedDestinationIds === null ||
      (gates.allowedDestinationIds?.length ?? 0) > 0)
  );
}
/** Public status reports the enabled mode without claiming source completeness. */
export function exportAuthorizationMode(gates: DeliveryGates) {
  if (!exportsEffective(gates)) return null;
  const qrz = deliveryMode(gates, "qrz");
  const lotw = deliveryMode(gates, "lotw");
  if (qrz === "source_boundary") return qrz;
  if (qrz && lotw) return "fresh_inserts";
  return qrz ?? lotw;
}
export function routeDeliveryMode(
  gates: DeliveryGates,
  qso: string,
  destination: Pick<Connection, "id" | "kind">,
) {
  if (
    !exportsEffective(gates) ||
    (destination.kind !== "qrz" && destination.kind !== "lotw") ||
    (gates.allowedQsoIds !== null && !gates.allowedQsoIds?.includes(qso)) ||
    (gates.allowedDestinationIds !== null &&
      !gates.allowedDestinationIds?.includes(destination.id))
  )
    return null;
  return deliveryMode(gates, destination.kind);
}

/** Structural eligibility only; preparation still requires fresh vendor reads. */
async function freshInsertRouteCurrent(
  store: Store,
  gates: DeliveryGates,
  key: LedgerKey,
  destination: Pick<Connection, "id" | "kind">,
) {
  const mode = routeDeliveryMode(gates, key.qso, destination);
  if (mode === "qrz_fresh_insert") return qrzFreshInsertCurrent(store, key);
  if (mode === "lotw_fresh_insert") return lotwFreshInsertCurrent(store, key);
  return false;
}

export function routeMatches(
  destination: Connection,
  contact: Contact,
): boolean {
  const config = JSON.parse(destination.config) as Record<string, unknown>;
  if (destination.kind === "qrz") {
    const date = new Date(contact.startAtMillis).toISOString().slice(0, 10);
    return (
      config.stationCallsign === contact.stationCall &&
      typeof config.startDate === "string" &&
      typeof config.endDate === "string" &&
      date >= config.startDate &&
      date <= config.endDate
    );
  }
  const stations = (
    Array.isArray(config.stations) ? config.stations : [config.station]
  ) as { callsign?: string; dxcc?: number }[];
  return stations.some(
    (station) =>
      station?.callsign === contact.stationCall &&
      (contact.dxcc === undefined || station.dxcc === contact.dxcc),
  );
}
class ReconciliationError extends Error {}

/** Fixed categories only: vendor errors can contain credentials or contact data. */
function reconciliationFailure(error: unknown, preparing: boolean): string {
  if (error instanceof ReconciliationError) return error.message;
  if (error instanceof QrzError) {
    if (error.kind === "auth")
      return "QRZ rejected readback credentials; review connection";
    if (error.kind === "protocol")
      return "QRZ readback response is invalid or incomplete; retry automatically";
  }
  if (error instanceof LotwLoginError && error.reason === "credentials")
    return "LoTW rejected readback credentials; review connection";
  return preparing
    ? "Delivery preparation failed; review contact and connection"
    : "Destination reconciliation failed; retry automatically";
}
export function reconciliationCommitGuard(
  key: LedgerKey,
  contact: IntakeContact,
  inventory: HistoryInventoryResult,
  commitTime: number,
) {
  const inventoryFence = inventory.fence
    ? historyInventoryGuard(key, inventory.fence, commitTime)
    : { sql: inventory.state === "ready" ? "0" : "1", params: [] };
  return {
    sql: `${inventoryFence.sql} AND EXISTS(SELECT 1 FROM reconciliation_work r JOIN source_work w ON w.tenant=r.tenant AND w.source=r.source AND w.id=r.qso AND w.kind='qso' JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source' JOIN cursors c ON c.tenant=r.tenant AND c.connection=r.source AND c.stream='context' WHERE r.tenant=? AND r.source=? AND r.qso=? AND r.version=? AND w.state IN('pending','waiting') AND w.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)) AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER))) AND c.generation=? AND json_extract(c.cursor,'$.complete')=1 AND (? IS NULL OR EXISTS(SELECT 1 FROM source_work o JOIN private_data op ON op.tenant=o.tenant AND op.connection=o.source AND op.id=o.private_id AND op.kind='source' WHERE o.tenant=w.tenant AND o.source=w.source AND o.id=? AND o.kind='operation' AND o.state='context' AND o.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)) AND op.revoked_at IS NULL AND (op.expires_at IS NULL OR op.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER))) AND NOT EXISTS(SELECT 1 FROM source_work e LEFT JOIN private_data ep ON ep.tenant=e.tenant AND ep.connection=e.source AND ep.id=e.private_id AND ep.kind='source' WHERE e.tenant=o.tenant AND e.source=o.source AND e.operation_id=o.id AND e.kind='qso' AND e.is_event=1 AND e.deleted=0 AND (e.expires_at<=MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)) OR ep.id IS NULL OR ep.revoked_at IS NOT NULL OR (ep.expires_at IS NOT NULL AND ep.expires_at<=MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER))))))))`,
    params: [
      ...inventoryFence.params,
      key.tenant,
      key.source,
      key.qso,
      contact.reconciliationVersion ?? -1,
      commitTime,
      commitTime,
      contact.contextGeneration,
      contact.operationId,
      contact.operationId,
      commitTime,
      commitTime,
      commitTime,
      commitTime,
    ],
  };
}

export async function classifyReconciliationHistory(
  store: Store,
  source: Connection,
  destination: Connection,
  contact: Contact,
  records: ReturnType<typeof contactReconciliationAdif>[],
  evidence: ReconciliationEvidence,
  now: number,
) {
  const record = contactReconciliationAdif(contact);
  const outcome = classifyHistoricalAssociation(record, records, evidence);
  if (!outcome.associationOnly || !outcome.remote) return outcome;
  const comparison = await historicalSourceCandidates(store, {
    tenant: source.tenant,
    destination,
    remote: outcome.remote,
    selected: {
      source: source.id,
      qso: contact.id,
      generation: contact.generation,
    },
    vendor: evidence.destination,
    routeMatches,
    now,
  });
  return withHistoricalSourceComparison(outcome, destination, comparison);
}

function withHistoricalSourceComparison(
  outcome: ReconciliationOutcome,
  destination: Connection,
  comparison: HistoricalSourceCandidateResult,
): ReconciliationOutcome {
  if (comparison.state !== "unique")
    return {
      state:
        comparison.state === "ambiguous"
          ? ("history_ambiguous" as const)
          : ("inventory_pending" as const),
      reason:
        comparison.state === "ambiguous"
          ? "Multiple source contacts match this destination record; review associations"
          : "Historical source coverage or context is incomplete; retry after it is current",
      evidence: outcome.evidence,
    };
  return {
    ...outcome,
    associationProof: {
      bookIdentity: destination.remote_identity,
      commitGuard: comparison.commitGuard,
    },
  };
}
async function reconcileContact(
  store: Store,
  source: Connection,
  destination: Connection,
  contact: IntakeContact,
  gates: DeliveryGates,
  fetcher: typeof fetch,
  now: number,
  priority: VendorPriority,
  vendorNow: number | undefined,
  metrics: ThroughputMetrics,
) {
  const key: LedgerKey = {
    tenant: source.tenant,
    source: source.id,
    qso: contact.id,
    destination: destination.id,
  };
  if (!(await reconciliationPreflight(store, key, contact.generation, now)))
    return;
  let record: ReturnType<typeof contactReconciliationAdif>;
  try {
    record = contactReconciliationAdif(contact);
  } catch {
    throw new ReconciliationError(
      "Source fields cannot be represented in ADIF; review contact",
    );
  }
  const input = {
    source,
    destination,
    qso: contact.id,
    record,
    generation: contact.generation,
  };
  const options = { fetcher, now: vendorNow, priority, vendorNow };
  let inventory = await historyCandidates(store, input, options);
  if (inventory.fetched) metrics.inventoryFetches++;
  // Complete a small QRZ base/catch-up pair within one contact turn. Large
  // partitions resume in later turns; this never loops through an entire book.
  if (inventory.state === "pending" && inventory.progressed) {
    inventory = await historyCandidates(store, input, options);
    if (inventory.fetched) metrics.inventoryFetches++;
  }
  if (inventory.state === "ready" && !inventory.fetched)
    metrics.inventoryCacheHits++;
  let remote = inventory.records;
  let readAccess = inventory.readAccess;
  let freshCheckComplete = false;
  if (
    inventory.state === "ready" &&
    remote.length === 0 &&
    routeDeliveryMode(gates, key.qso, destination) !== null &&
    (gates.sourceBoundaryVerified ||
      (await freshInsertRouteCurrent(store, gates, key, destination)))
  ) {
    let raw: {
      apiKey?: string;
      query?: { username: string; password: string };
    } | null;
    try {
      raw = destination.credential_version
        ? await store.private<typeof raw>(
            key.tenant,
            destination.id,
            destination.credential_version,
            "credential",
          )
        : null;
    } catch {
      throw new ReconciliationError(
        "Saved destination credentials could not be opened; review connection",
      );
    }
    if (destination.kind === "qrz" && raw?.apiKey) {
      remote = await new QrzClient(raw.apiKey, {
        fetch: vendorFetch(store, "qrz", fetcher, { priority, now: vendorNow }),
        neighborhoodFallback: qrzNeighborhoodFallback(
          store,
          source,
          destination,
          vendorNow,
        ),
      }).findNeighborhood(record);
      readAccess = true;
      freshCheckComplete = true;
    } else if (destination.kind === "lotw" && raw?.query) {
      const date = new Date(contact.startAtMillis).toISOString().slice(0, 10);
      remote = (
        await new LotwClient(raw.query, {
          fetcher: vendorFetch(store, "lotw", fetcher, {
            priority,
            now: vendorNow,
          }),
        }).query({
          startDate: date,
          endDate: date,
          stationCallsign: contact.stationCall,
          workedCallsign: contact.call,
        })
      ).records;
      readAccess = true;
      freshCheckComplete = true;
    }
  }
  const evidence: ReconciliationEvidence = {
    destination: destination.kind as "qrz" | "lotw",
    capturedGeneration: contact.generation,
    currentGeneration: contact.generation,
    readAccess,
    inventoryComplete: inventory.state === "ready",
    catchupComplete: inventory.state === "ready",
    freshCheckComplete,
    inventoryPositiveOnly: true,
    provenNewAfterCutover:
      gates.sourceBoundaryVerified &&
      destination.kind === "lotw" &&
      !readAccess &&
      (await proveNewAfterCutover(store, key)),
  };
  let outcome = await classifyReconciliationHistory(
    store,
    source,
    destination,
    contact,
    remote,
    evidence,
    vendorNow ?? Date.now(),
  );
  if (inventory.state === "pending")
    outcome = {
      ...outcome,
      state: "inventory_pending",
      reason:
        inventory.reason ?? "Shared destination inventory is still loading",
    };
  if (
    outcome.state === "missing_current_identity" &&
    !gates.sourceBoundaryVerified &&
    !(await freshInsertRouteCurrent(store, gates, key, destination))
  )
    outcome = {
      ...outcome,
      state: "inventory_pending",
      reason:
        "Source replay/cutover evidence is not yet verified; absence cannot authorize backfill",
    };
  const commitTime = vendorNow ?? Date.now();
  const commitGuard = reconciliationCommitGuard(
    key,
    contact,
    inventory,
    commitTime,
  );
  const adopted = await adoptHistory(
    store,
    key,
    contact.generation,
    outcome,
    commitTime,
    outcome.state === "adopted_existing" && destination.kind === "qrz"
      ? await sourceFingerprint(contact, "qrz", true)
      : undefined,
    commitGuard,
  );
  if (adopted.applied) {
    metrics.classifiedDestinations++;
    if (outcome.state === "adopted_existing") metrics.adoptedDestinations++;
    await recordReconciliationCheck(
      store,
      key,
      contact.generation,
      outcome,
      now,
      contact.reconciliationVersion,
    );
  }
}
/** Bounded read-only cohorts share evidence, while each mutation keeps its own fence. */
async function reconcileReadOnlyBatch(
  store: Store,
  source: Connection,
  destinations: Connection[],
  contacts: IntakeContact[],
  gates: DeliveryGates,
  fetcher: typeof fetch,
  priority: VendorPriority,
  currentTime: () => number,
  vendorNow: number | undefined,
  expired: () => boolean,
  metrics: ThroughputMetrics,
  diagnostics: ReturnType<typeof createFailureDiagnostics>,
  afterObservation: () => Promise<void>,
) {
  const result = { contacts: contacts.length, errors: 0, deferred: 0 };
  const statements: D1PreparedStatement[] = [];
  const observations = contacts.map((contact) => ({
    contact,
    routedDestinations: (["qrz", "lotw"] as const).flatMap((kind) => {
      const matches = destinations.filter(
        (destination) =>
          destination.kind === kind && routeMatches(destination, contact),
      );
      return matches.length === 1 ? matches : [];
    }),
  }));
  const observed = await observeContacts(
    store,
    source,
    observations,
    currentTime(),
  );
  await afterObservation();
  const ready = observations.filter((_, index) => {
    const observation = observed[index];
    if (observation.status === "fulfilled") return true;
    diagnostics.record(observation.reason, "observation");
    if (observation.reason instanceof VendorDeferredError) result.deferred++;
    else result.errors++;
    return false;
  });
  const diagnose = (
    contact: IntakeContact,
    destination: Connection,
    reason: string,
  ) => {
    statements.push(
      store.statement(
        "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND EXISTS(SELECT 1 FROM reconciliation_work r WHERE r.tenant=ledger.tenant AND r.source=ledger.source AND r.qso=ledger.qso AND r.version=?)",
        reason,
        source.tenant,
        source.id,
        contact.id,
        destination.id,
        contact.generation,
        contact.reconciliationVersion ?? -1,
      ),
    );
  };
  type Route = {
    contact: IntakeContact;
    destination: Connection;
    input: HistoryInventoryInput;
  };
  const routes: Route[] = [];
  const routingIssues = new Map<string, string[]>();
  for (const { contact, routedDestinations } of ready) {
    const issues: string[] = [];
    routingIssues.set(contact.id, issues);
    for (const kind of ["qrz", "lotw"] as const) {
      if (routedDestinations.some((destination) => destination.kind === kind))
        continue;
      const candidates = destinations.filter(
        (destination) => destination.kind === kind,
      );
      if (!candidates.length) continue;
      const multiple = candidates.some((destination) =>
        routeMatches(destination, contact),
      );
      issues.push(
        multiple
          ? `Multiple ${kind.toUpperCase()} routes match; resolve routing`
          : `No ${kind.toUpperCase()} route matches station and date`,
      );
      for (const destination of candidates)
        diagnose(
          contact,
          destination,
          multiple
            ? "Multiple connections match this station; resolve routing"
            : "No connection matches this station and date",
        );
    }
    for (const destination of routedDestinations) {
      try {
        routes.push({
          contact,
          destination,
          input: {
            source,
            destination,
            qso: contact.id,
            generation: contact.generation,
            record: contactReconciliationAdif(contact),
          },
        });
      } catch (error) {
        diagnostics.record(error, "projection", destination.kind);
        result.errors++;
        diagnose(
          contact,
          destination,
          "Source fields cannot be represented in ADIF; review contact",
        );
      }
    }
  }
  try {
    const ledgers = await reconciliationPreflightBatch(
      store,
      source,
      routes.map(({ contact, destination }) => ({
        qso: contact.id,
        destination: destination.id,
        generation: contact.generation,
      })),
      currentTime(),
    );
    const ledgerByRoute = new Map(
      ledgers.map((ledger) => [
        JSON.stringify([ledger.qso, ledger.destination]),
        ledger,
      ]),
    );
    const groups = new Map<string, Route[]>();
    for (const route of routes) {
      if (
        !ledgerByRoute.has(
          JSON.stringify([route.contact.id, route.destination.id]),
        )
      )
        continue;
      const scope = JSON.stringify([
        route.destination.id,
        route.contact.stationCall,
      ]);
      const group = groups.get(scope) ?? [];
      group.push(route);
      groups.set(scope, group);
    }
    const pending = [...groups.values()];
    const forwardPlans = new Map<Route, HistoryAdoptionInput>();
    let nextGroup = 0;
    // Await every started cohort before commits/finalization and cycle release.
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (!expired()) {
          const group = pending[nextGroup++];
          if (!group) return;
          try {
            const options = {
              fetcher,
              now: vendorNow,
              vendorNow,
              priority,
              shouldContinue: () => !expired(),
              coldAdvanceConcurrency: Math.floor(
                4 / Math.min(4, pending.length),
              ),
            };
            const inventory = await historyCandidatesBatch(
              store,
              group.map((route) => route.input),
              options,
            );
            for (const evidence of inventory)
              if (evidence.fetched) metrics.inventoryFetches++;
            // Preserve the small QRZ base/catch-up allowance without repeating it per contact.
            if (
              !expired() &&
              inventory.some(
                (evidence) =>
                  evidence.state === "pending" &&
                  evidence.progressed &&
                  !("failure" in evidence),
              )
            ) {
              const retry = group.flatMap((route, index) =>
                inventory[index].state === "pending" &&
                !("failure" in inventory[index])
                  ? [{ route, index }]
                  : [],
              );
              const refreshed = await historyCandidatesBatch(
                store,
                retry.map(({ route }) => route.input),
                options,
              );
              for (const [index, evidence] of refreshed.entries()) {
                if (evidence.fetched) metrics.inventoryFetches++;
                inventory[retry[index].index] = evidence;
              }
            }
            for (const [index, route] of group.entries()) {
              const ledger = ledgerByRoute.get(
                JSON.stringify([route.contact.id, route.destination.id]),
              );
              if (!ledger) continue;
              const evidence = inventory[index];
              if ("failure" in evidence) {
                diagnostics.record(
                  evidence.failure,
                  "history_read",
                  route.destination.kind,
                );
                if (evidence.failure instanceof VendorDeferredError)
                  result.deferred++;
                else {
                  result.errors++;
                  diagnose(
                    route.contact,
                    route.destination,
                    reconciliationFailure(evidence.failure, false),
                  );
                }
                continue;
              }
              if (evidence.state === "ready" && !evidence.fetched)
                metrics.inventoryCacheHits++;
              const key: LedgerKey = {
                tenant: source.tenant,
                source: source.id,
                qso: route.contact.id,
                destination: route.destination.id,
              };
              let outcome = classifyHistoricalAssociation(
                route.input.record,
                evidence.records,
                {
                  destination: route.destination.kind as "qrz" | "lotw",
                  capturedGeneration: route.contact.generation,
                  currentGeneration: route.contact.generation,
                  readAccess: evidence.readAccess,
                  inventoryComplete: evidence.state === "ready",
                  catchupComplete: evidence.state === "ready",
                  freshCheckComplete: false,
                  inventoryPositiveOnly: true,
                  provenNewAfterCutover:
                    gates.sourceBoundaryVerified &&
                    route.destination.kind === "lotw" &&
                    !evidence.readAccess &&
                    (await proveNewAfterCutover(store, key)),
                },
              );
              if (evidence.state === "pending")
                outcome = {
                  ...outcome,
                  state: "inventory_pending",
                  reason:
                    evidence.reason ??
                    "Shared destination inventory is still loading",
                };
              if (
                outcome.state === "missing_current_identity" &&
                !gates.sourceBoundaryVerified &&
                !(await freshInsertRouteCurrent(
                  store,
                  gates,
                  key,
                  route.destination,
                ))
              )
                outcome = {
                  ...outcome,
                  state: "inventory_pending",
                  reason:
                    "Source replay/cutover evidence is not yet verified; absence cannot authorize backfill",
                };
              forwardPlans.set(route, {
                key,
                generation: route.contact.generation,
                outcome,
                ledger,
                adoptedSourceHash:
                  outcome.state === "adopted_existing" &&
                  route.destination.kind === "qrz"
                    ? await sourceFingerprint(route.contact, "qrz", true)
                    : undefined,
                commitGuard: (at) =>
                  reconciliationCommitGuard(key, route.contact, evidence, at),
              });
            }
          } catch (error) {
            diagnostics.record(
              error,
              "history_group",
              group[0].destination.kind,
              group.length,
            );
            for (const { contact, destination } of group) {
              if (error instanceof VendorDeferredError) result.deferred++;
              else {
                result.errors++;
                diagnose(
                  contact,
                  destination,
                  reconciliationFailure(error, false),
                );
              }
            }
          }
        }
      }),
    );
    const failed = workers.find((worker) => worker.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    // Inventory groups finish independently, but reverse comparisons share one
    // bounded source census across routes in the original contact order. Each
    // result still carries its own unchanged source/context/inventory fences.
    const positiveRoutes = routes.flatMap((route) => {
      const adoption = forwardPlans.get(route);
      const outcome = adoption?.outcome;
      return adoption &&
        outcome?.state === "adopted_existing" &&
        outcome.associationOnly &&
        outcome.remote
        ? [{ route, adoption, remote: outcome.remote }]
        : [];
    });
    type PositiveRoute = (typeof positiveRoutes)[number];
    const compare = async (
      group: PositiveRoute[],
    ): Promise<PositiveRoute[]> => {
      // An unexamined positive must not acquire an association or a success memo.
      if (expired()) {
        for (const { route } of group) forwardPlans.delete(route);
        return [];
      }
      try {
        const comparisons = await historicalSourceCandidatesBatch(
          store,
          source.tenant,
          group.map(({ route, adoption, remote }) => ({
            destination: route.destination,
            remote,
            selected: {
              source: source.id,
              qso: route.contact.id,
              generation: route.contact.generation,
            },
            vendor: adoption.outcome.evidence.destination,
            routeMatches,
          })),
          { now: currentTime() },
        );
        if (comparisons.length !== group.length)
          throw new Error("Incomplete historical source comparison batch");
        const split: PositiveRoute[] = [];
        for (const [index, item] of group.entries()) {
          const comparison = comparisons[index];
          if (
            group.length > 1 &&
            comparison.state === "held" &&
            comparison.reason === "cohort_bound"
          ) {
            split.push(item);
            continue;
          }
          item.adoption.outcome = withHistoricalSourceComparison(
            item.adoption.outcome,
            item.route.destination,
            comparison,
          );
        }
        return split;
      } catch (error) {
        // A failed bounded comparison cannot strand other completed batches or
        // turn its original positive candidate into an unguarded adoption.
        for (const { route } of group) {
          forwardPlans.delete(route);
          diagnostics.record(error, "reconciliation", route.destination.kind);
          if (error instanceof VendorDeferredError) result.deferred++;
          else {
            result.errors++;
            diagnose(
              route.contact,
              route.destination,
              reconciliationFailure(error, false),
            );
          }
        }
        return [];
      }
    };
    for (let offset = 0; offset < positiveRoutes.length; offset += 20) {
      const queue = [positiveRoutes.slice(offset, offset + 20)];
      while (queue.length) {
        const group = queue.shift();
        if (!group) break;
        // Only aggregate admission overflow may split. A binary tree has at
        // most 2n-1 calls (39 for twenty routes); each node is attempted once.
        // Unknown evidence, intrinsic bounds and DB/ack errors never retry.
        // compare() releases its shared raw/projection results before the next
        // call, retaining only each route's independent immutable guard.
        const split = await compare(group);
        if (split.length) {
          const middle = Math.ceil(split.length / 2);
          queue.unshift(split.slice(0, middle));
          if (middle < split.length) queue.splice(1, 0, split.slice(middle));
        }
      }
    }
    const planned = routes.flatMap((route) => {
      const adoption = forwardPlans.get(route);
      return adoption ? [{ route, adoption }] : [];
    });
    const applied = await adoptHistoryBatch(
      store,
      source,
      planned.map((item) => item.adoption),
      currentTime,
    );
    for (const [index, item] of planned.entries()) {
      if (!applied[index].applied) continue;
      metrics.classifiedDestinations++;
      if (item.adoption.outcome.state === "adopted_existing")
        metrics.adoptedDestinations++;
      const check = reconciliationCheckStatement(
        store,
        item.adoption.key,
        item.adoption.generation,
        item.adoption.outcome,
        currentTime(),
        item.route.contact.reconciliationVersion,
      );
      if (check) statements.push(check);
    }
  } catch (error) {
    diagnostics.record(error, "reconciliation", undefined, routes.length);
    throw error;
  } finally {
    for (const { contact } of ready)
      statements.push(
        store.statement(
          "UPDATE source_work SET state='waiting',processed_at=?,reason=? WHERE tenant=? AND source=? AND id=? AND kind='qso' AND state IN('pending','waiting') AND EXISTS(SELECT 1 FROM reconciliation_work r WHERE r.tenant=source_work.tenant AND r.source=source_work.source AND r.qso=source_work.id AND r.version=?)",
          currentTime(),
          routingIssues.get(contact.id)?.join("; ") || null,
          source.tenant,
          source.id,
          contact.id,
          contact.reconciliationVersion ?? -1,
        ),
      );
    for (const contact of contacts) {
      const finish = finishReconciliationWorkStatement(
        store,
        source,
        contact.id,
        contact.reconciliationVersion,
        currentTime(),
      );
      if (finish) statements.push(finish);
    }
    for (let offset = 0; offset < statements.length; offset += 80)
      await store.db.batch(statements.slice(offset, offset + 80));
  }
  return result;
}
export interface ThroughputMetrics {
  sourceRecords: number;
  rescanPages: number;
  rereadPages: number;
  classifiedDestinations: number;
  adoptedDestinations: number;
  inventoryFetches: number;
  inventoryCacheHits: number;
  reconciliationBatchCalls: number;
  sourceIndexExamined: number;
  sourceIndexPublished: number;
  sourceIndexHeld: number;
  lotwOwnershipPasses: number;
  lotwOwnershipExamined: number;
  lotwOwnershipCovered: number;
  lotwOwnershipOwnersHashed: number;
  identityBackfill?: IdentityBackfillResult;
  failures: ReturnType<typeof createFailureDiagnostics>["counts"];
  stageMs: Record<string, number>;
  database: DatabaseMetrics;
}
/** Drain fair rounds until idle or out of time, with fenced source cycles. */
export async function tick(
  env: Env,
  fetcher: typeof fetch = fetch,
  clock?: number,
) {
  const startedAt = Date.now();
  const currentTime = () => clock ?? Date.now();
  const now = currentTime();
  const nowAtStart = now;
  const deadline = startedAt + 90_000;
  const metered = measuredDatabase(env.DB);
  // Leave request headroom for a bounded in-flight operation and cleanup.
  // A checkpoint sends many statements in one D1 request; retain both counts.
  const expired = () => Date.now() >= deadline || metered.metrics.calls >= 850;
  const diagnostics = createFailureDiagnostics();
  const throughput: ThroughputMetrics = {
    sourceRecords: 0,
    rescanPages: 0,
    rereadPages: 0,
    classifiedDestinations: 0,
    adoptedDestinations: 0,
    inventoryFetches: 0,
    inventoryCacheHits: 0,
    reconciliationBatchCalls: 0,
    sourceIndexExamined: 0,
    sourceIndexPublished: 0,
    sourceIndexHeld: 0,
    lotwOwnershipPasses: 0,
    lotwOwnershipExamined: 0,
    lotwOwnershipCovered: 0,
    lotwOwnershipOwnersHashed: 0,
    failures: diagnostics.counts,
    stageMs: {},
    database: metered.metrics,
  };
  const measure = async <T>(
    stage: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const start = Date.now();
    try {
      return await work();
    } finally {
      throughput.stageMs[stage] =
        (throughput.stageMs[stage] ?? 0) + Math.max(0, Date.now() - start);
    }
  };
  await purgeAuth(env, now);
  const store = new Store(metered.database, keyring(env));
  const gates = deliveryGates(env);
  await syncReconciliationPolicy(
    store,
    JSON.stringify({
      historicalMatchingVersion: HISTORICAL_MATCHING_VERSION,
      sourceBoundaryVerified: gates.sourceBoundaryVerified,
      qrzFreshInsertsEnabled: gates.qrzFreshInsertsEnabled === true,
      lotwFreshInsertsEnabled: gates.lotwFreshInsertsEnabled === true,
      exportsEffective: exportsEffective(gates),
      allowedQsoIds: gates.allowedQsoIds,
      allowedDestinationIds: gates.allowedDestinationIds,
    }),
  );
  await pruneHistoryInventory(store, now);
  await expireSource(store, now);
  await store.recover(now);
  await rotatePrivateData(store);
  const deps = {
    fetcher,
    ...(clock === undefined ? {} : { now: clock }),
  };
  const certificateRefresh = await refreshLotwCertificates(store, deps);
  const identityBackfill = await measure("identityBackfill", () =>
    backfillLegacyQrzIdentity(store, {
      ...deps,
      shouldContinue: () => !expired(),
      onFailure: (error) => diagnostics.record(error, "history_read", "qrz"),
    }),
  );
  throughput.identityBackfill = identityBackfill;
  const sources = (
    await store
      .statement(
        "SELECT c.*,CASE WHEN p.source IS NOT NULL THEN 'forward' ELSE 'backfill' END AS sync_mode FROM connections c LEFT JOIN source_read_policy_ready p ON p.tenant=c.tenant AND p.source=c.id WHERE c.kind='lofi' AND c.status='active' ORDER BY ROW_NUMBER() OVER(PARTITION BY p.source IS NOT NULL ORDER BY COALESCE(c.last_poll_at,0),c.tenant,c.id),CASE WHEN p.source IS NOT NULL THEN 0 ELSE 1 END,c.tenant,c.id",
      )
      .all<Connection & { sync_mode: "backfill" | "forward" }>()
  ).results;
  const result = {
    sources: 0,
    contacts: 0,
    attempts: 0,
    errors: certificateRefresh.errors + identityBackfill.errors,
    deferred: certificateRefresh.deferred + identityBackfill.deferred,
    exportsEnabled: exportsEffective(gates),
    rounds: 0,
    elapsedMs: 0,
    stopReason: "idle" as "idle" | "deadline" | "database_budget",
  };
  throughput.stageMs.startup = Math.max(0, Date.now() - startedAt);
  const attemptedPolls = new Set<string>();
  const completedPolls = new Set<string>();
  const completedRescans = new Map<string, Set<string>>();
  const stoppedRereads = new Set<string>();
  const unavailableHistoricalIndexes = new Set<string>();
  const maintainedLotwOwnership = new Set<string>();
  // Freshly prepared attempts share the existing round's dispatch allowance.
  const attemptSlots: Record<VendorPriority, number> = {
    live: 6,
    background: 2,
  };
  const sourceProofAttempts = new Map<string, number>();
  const maintainLotwOwnership = async (tenant: string) => {
    if (!maintainedLotwOwnership.has(tenant) && metered.metrics.calls < 720) {
      maintainedLotwOwnership.add(tenant);
      const beganAt = metered.metrics.calls;
      // One tenant phase per cycle, at most 1,000 inputs and 120 admitted RPCs.
      // Reserve room for contact work and yield before another tenant's phase.
      const admitted = () =>
        !expired() &&
        metered.metrics.calls < 720 &&
        metered.metrics.calls - beganAt < 120;
      try {
        for (let pass = 0; pass < 10 && admitted(); pass++) {
          const ownership = await measure("lotwOwnership", () =>
            backfillLotwOwnership(store, tenant, {
              limit: 100,
              now: currentTime(),
              shouldContinue: admitted,
            }),
          );
          throughput.lotwOwnershipPasses++;
          throughput.lotwOwnershipExamined += ownership.examined;
          throughput.lotwOwnershipCovered += ownership.covered;
          throughput.lotwOwnershipOwnersHashed += ownership.ownersHashed;
          if (
            ownership.reason !== "examined" ||
            !(ownership.advanced || ownership.covered || ownership.ownersHashed)
          )
            break;
        }
      } catch (error) {
        diagnostics.record(error, "reconciliation", "lotw");
        result.errors++;
      }
    }
  };
  const processSource = async (
    source: (typeof sources)[number],
    priority: VendorPriority,
    admission?: BackgroundSource,
  ) => {
    if (expired()) return 0;
    const now = currentTime();
    const sourceKey = JSON.stringify([source.tenant, source.id]);
    const rereadKey = JSON.stringify([source.tenant, source.id, priority]);
    let progress = 0;
    const lease = await store.claim(
      source.tenant,
      `cycle:${source.id}`,
      now,
      5 * 60_000,
    );
    if (!lease) return 0;
    // The all-client baseline, forward drain and quarantine share background
    // admission. A legacy forward cursor still needs that baseline first.
    const canonicalTurn =
      (source.sync_mode === "forward" ? "live" : "background") === priority;
    // Independent background admission can choose a forward source before
    // its live roster turn. Refresh it first without repeating a poll already
    // attempted this invocation; polling still uses the cursor's live budget.
    const pollTurn =
      (canonicalTurn && !completedPolls.has(sourceKey)) ||
      (priority === "background" &&
        source.sync_mode === "forward" &&
        !attemptedPolls.has(sourceKey));
    let polled = false;
    const prepareExportCohort = async (
      routes: { contact: IntakeContact; destination: Connection }[],
      destinations: Connection[],
      finished: Map<string, IntakeContact>,
      priorBudgetHolds: Set<string>,
      budgetBackoffs: Map<string, number>,
    ) => {
      if (!exportsEffective(gates) || expired() || attemptSlots[priority] <= 0)
        return;
      const at = currentTime();
      // History failures never enter this list. Re-read eligibility after every
      // route's history turn, preserving quiet periods and unresolved outcomes.
      const due = (
        await store
          .statement(
            `SELECT l.qso,l.destination,l.generation FROM json_each(?1) candidate
         JOIN ledger l ON l.tenant=?2 AND l.source=?3 AND l.qso=json_extract(candidate.value,'$.qso') AND l.destination=json_extract(candidate.value,'$.destination') AND l.generation=json_extract(candidate.value,'$.generation')
         JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination AND d.status='active'
         WHERE l.due_at<=?4 AND l.state IN('missing_current_identity','changed','live_new') AND l.provenance!='adoption_conflict'
          AND (?5=1
            OR (?6=1 AND d.kind='qrz' AND EXISTS(SELECT 1 FROM qrz_fresh_insert_eligible f WHERE f.tenant=l.tenant AND f.source=l.source AND f.qso=l.qso AND f.destination=l.destination))
            OR (?7=1 AND d.kind='lotw' AND EXISTS(SELECT 1 FROM lotw_fresh_insert_eligible f WHERE f.tenant=l.tenant AND f.source=l.source AND f.qso=l.qso AND f.destination=l.destination)))
          AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=l.tenant AND a.source=l.source AND a.qso=l.qso AND a.destination=l.destination AND s.state NOT IN('delivered','observed','rejected','cancelled') AND (s.state!='prepared' OR EXISTS(SELECT 1 FROM attempt_source_export_proofs_current pin WHERE pin.tenant=s.tenant AND pin.attempt=s.attempt))) ORDER BY CAST(candidate.key AS INTEGER)`,
            JSON.stringify(
              routes.map(({ contact, destination }) => ({
                qso: contact.id,
                destination: destination.id,
                generation: contact.generation,
              })),
            ),
            source.tenant,
            source.id,
            at,
            gates.sourceBoundaryVerified ? 1 : 0,
            gates.qrzFreshInsertsEnabled ? 1 : 0,
            gates.lotwFreshInsertsEnabled ? 1 : 0,
          )
          .all<{ qso: string; destination: string; generation: string }>()
      ).results;
      if (!due.length || expired()) return;
      const hold = async (reason: string, rows = due) => {
        if (!rows.length) return;
        await store.db.batch(
          rows.map((row) =>
            store.statement(
              "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND state IN('missing_current_identity','changed','live_new')",
              reason,
              source.tenant,
              source.id,
              row.qso,
              row.destination,
              row.generation,
            ),
          ),
        );
      };
      const scope = await loadCurrentSourcePresenceScope(
        store,
        source,
        currentTime(),
      );
      if (!scope) {
        await hold("source_export_proof_unavailable");
        return;
      }
      // History can clear a route's diagnostic reason. Use only the exact
      // generation captured before that work to shrink a repeated budget hold
      // to one contact; an individually bounded closure can then make progress.
      const retry = due.find((row) =>
        priorBudgetHolds.has(
          JSON.stringify([row.qso, row.destination, row.generation]),
        ),
      );
      const snapshots = await fittingSourceExportSnapshots(
        store,
        scope,
        retry ? [retry.qso] : [...new Set(due.map((row) => row.qso))],
        Math.min(20, attemptSlots[priority]),
        currentTime,
        expired,
      );
      if (!snapshots.length || expired()) {
        await hold("source_export_proof_unavailable");
        return;
      }
      const selectedIds = new Set(snapshots.map(({ contact }) => contact.id));
      await hold(
        retry
          ? "source_export_proof_request_budget"
          : "source_export_proof_unavailable",
        due.filter((row) => !selectedIds.has(row.qso)),
      );
      const cached = await loadCurrentSourceExportProofs(
        store,
        scope,
        snapshots.map(({ contact }) => ({
          qso: contact.id,
          generation: contact.generation,
          reconciliationVersion: contact.reconciliationVersion,
        })),
        currentTime(),
      );
      let ready: {
        contact: IntakeContact;
        proofId: string;
        expiresAt: number;
      }[];
      if (
        cached.length === snapshots.length &&
        cached.every((proof) => proof !== null)
      ) {
        // Existing IDs are reused verbatim. No read, timestamp refresh or rebind.
        ready = cached.flatMap((proof, index) =>
          proof
            ? [
                {
                  contact: snapshots[index].contact,
                  proofId: proof.id,
                  expiresAt: proof.expiresAt,
                },
              ]
            : [],
        );
      } else {
        const remainingRequests = 4 - (sourceProofAttempts.get(sourceKey) ?? 0);
        if (remainingRequests <= 0) {
          await hold("source_export_proof_request_budget");
          result.deferred++;
          return;
        }
        const cohort = await measure("sourceProof", () =>
          ensureSourceExportProofs(
            store,
            scope,
            snapshots.map(({ contact }) => contact.id),
            lease,
            {
              rawFetcher: fetcher,
              now: currentTime,
              deadline: currentTime() + Math.max(0, deadline - Date.now()),
              remainingRequests,
              priority,
              routedDestinations: (contact) =>
                uniqueRoutes(destinations, contact),
            },
          ),
        );
        sourceProofAttempts.set(
          sourceKey,
          (sourceProofAttempts.get(sourceKey) ?? 0) + cohort.actualAttempts,
        );
        if (cohort.held) {
          result.deferred++;
          if (cohort.held !== "request_budget" || !cohort.ready.length) {
            if (
              retry &&
              cohort.held === "request_budget" &&
              cohort.actualAttempts > 0
            )
              budgetBackoffs.set(
                retry.qso,
                snapshots[0].contact.reconciliationVersion,
              );
            await hold(`source_export_proof_${cohort.held}`);
            return;
          }
          // The coordinator completed the reserved final drain and minted
          // exact proofs for this subset. A budget hold is not evidence for
          // any other contact, nor may another failure yield partial authority.
          const proven = new Set(cohort.ready.map(({ contact }) => contact.id));
          await hold(
            "source_export_proof_request_budget",
            due.filter((row) => !proven.has(row.qso)),
          );
        }
        // A new drain invalidated all old IDs. Only its refreshed contacts and
        // newly minted proof IDs may reach preparation.
        ready = cohort.ready;
      }
      const eligible = new Set(
        due.map((row) => JSON.stringify([row.qso, row.destination])),
      );
      for (const item of ready) {
        finished.set(item.contact.id, item.contact);
        const reconciliationVersion = item.contact.reconciliationVersion;
        if (reconciliationVersion === undefined) continue;
        for (const destination of uniqueRoutes(destinations, item.contact)) {
          if (expired() || attemptSlots[priority] <= 0) return;
          if (!eligible.has(JSON.stringify([item.contact.id, destination.id])))
            continue;
          const authorizationMode = routeDeliveryMode(
            gates,
            item.contact.id,
            destination,
          );
          if (authorizationMode === null) continue;
          const key = {
            tenant: source.tenant,
            source: source.id,
            qso: item.contact.id,
            destination: destination.id,
          };
          try {
            const prepared = await prepareDue(store, key, item.contact, gates, {
              ...deps,
              priority,
              sourceProof: {
                proofId: item.proofId,
                scope,
                reconciliationVersion,
                authorizationMode,
              },
            });
            if (prepared.state === "blocked")
              await store
                .statement(
                  "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND state IN('missing_current_identity','changed','live_new')",
                  prepared.reason ?? "Delivery preparation requires review",
                  key.tenant,
                  key.source,
                  key.qso,
                  key.destination,
                  item.contact.generation,
                )
                .run();
            if (
              prepared.state === "prepared" &&
              prepared.attemptId &&
              !expired()
            ) {
              // Dispatch while this source still has the qualifying generation,
              // before the next canonical poll can invalidate its immutable pin.
              attemptSlots[priority]--;
              await dispatchAttempt(
                store,
                source.tenant,
                prepared.attemptId,
                gates,
                {
                  ...deps,
                  priority,
                  sourceContact: item.contact,
                },
              );
              result.attempts++;
            }
          } catch (error) {
            diagnostics.record(error, "preparation", destination.kind);
            if (error instanceof VendorDeferredError) result.deferred++;
            else {
              result.errors++;
              await store
                .statement(
                  "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND state IN('missing_current_identity','changed','live_new')",
                  reconciliationFailure(error, true),
                  key.tenant,
                  key.source,
                  key.qso,
                  key.destination,
                  item.contact.generation,
                )
                .run();
            }
          }
        }
      }
    };
    const processRetainedContacts = async (readyContextOnly = false) => {
      if (expired()) return 0;
      // Intake maintains new entries atomically. Older retained contacts receive
      // bounded incremental indexing without scanning their ciphertext per match.
      if (!unavailableHistoricalIndexes.has(source.tenant))
        try {
          const indexed = await measure("sourceHistoricalIndex", () =>
            backfillSourceHistoricalIndex(store, source.tenant, {
              limit: 100,
              now: currentTime(),
            }),
          );
          throughput.sourceIndexExamined += indexed.examined;
          throughput.sourceIndexPublished += indexed.published;
          throughput.sourceIndexHeld += indexed.held;
          progress += indexed.published;
        } catch (error) {
          // QRZ remains held by its comparison check. A key/index failure must
          // not prevent independent LoTW history from being reconciled.
          unavailableHistoricalIndexes.add(source.tenant);
          diagnostics.record(error, "reconciliation", "qrz");
          result.errors++;
        }
      if (expired()) return 0;
      await establishCutovers(store, source, gates, currentTime());
      if (expired()) return 0;
      const batch = await measure("projection", () =>
        pendingContactBatch(
          store,
          source,
          priority === "live"
            ? exportsEffective(gates)
              ? Math.max(1, Math.min(6, attemptSlots.live))
              : 1
            : 20,
          currentTime(),
          priority,
          undefined,
          nowAtStart,
          readyContextOnly,
        ),
      );
      progress += batch.selected;
      const destinations = batch.contacts.length
        ? (await store.connections(source.tenant)).filter(
            (c) => c.kind !== "lofi" && c.status === "active",
          )
        : [];
      if (
        priority === "background" &&
        !exportsEffective(gates) &&
        batch.contacts.length >= 4
      ) {
        const before = metered.metrics.calls;
        result.contacts += batch.contacts.length;
        const processed = await measure("history", () =>
          reconcileReadOnlyBatch(
            store,
            source,
            destinations,
            batch.contacts,
            gates,
            fetcher,
            priority,
            currentTime,
            clock,
            expired,
            throughput,
            diagnostics,
            () => maintainLotwOwnership(source.tenant),
          ),
        ).finally(() => {
          throughput.reconciliationBatchCalls += metered.metrics.calls - before;
        });
        result.errors += processed.errors;
        result.deferred += processed.deferred;
        return batch.selected;
      }
      // Register this bounded cohort through the normal projection guards before
      // the tenant's single ownership maintenance phase. Newly observed owners
      // must not wait a whole cycle merely because maintenance ran first.
      const observations = await observeContacts(
        store,
        source,
        batch.contacts.map((contact) => ({
          contact,
          routedDestinations: (["qrz", "lotw"] as const).flatMap((kind) => {
            const matches = destinations.filter(
              (destination) =>
                destination.kind === kind && routeMatches(destination, contact),
            );
            return matches.length === 1 ? matches : [];
          }),
        })),
        currentTime(),
      );
      const observationByContact = new Map(
        batch.contacts.map((contact, index) => [
          contact.id,
          observations[index],
        ]),
      );
      if (batch.contacts.length) await maintainLotwOwnership(source.tenant);
      const priorBudgetHolds = new Set<string>();
      if (exportsEffective(gates) && batch.contacts.length) {
        const markers = await store
          .statement(
            `SELECT l.qso,l.destination,l.generation FROM json_each(?1) contact
             JOIN ledger l ON l.tenant=?2 AND l.source=?3 AND l.qso=json_extract(contact.value,'$.qso') AND l.generation=json_extract(contact.value,'$.generation')
             WHERE l.reason='source_export_proof_request_budget'`,
            JSON.stringify(
              batch.contacts.map((contact) => ({
                qso: contact.id,
                generation: contact.generation,
              })),
            ),
            source.tenant,
            source.id,
          )
          .all<{ qso: string; destination: string; generation: string }>();
        for (const row of markers.results)
          priorBudgetHolds.add(
            JSON.stringify([row.qso, row.destination, row.generation]),
          );
      }
      const exportRoutes: {
        contact: IntakeContact;
        destination: Connection;
      }[] = [];
      const finished = new Map<string, IntakeContact>();
      const budgetBackoffs = new Map<string, number>();
      const historyTurns = new Map<string, Promise<void>>();
      const historyTurn = async (
        destination: Connection,
        contact: IntakeContact,
        work: () => Promise<void>,
      ) => {
        // Contacts in the same week share inventory. Let the first read finish
        // before another contact asks for that coverage in this source batch.
        const key = JSON.stringify([
          destination.id,
          Math.floor(contact.startAtMillis / (7 * 86_400_000)),
        ]);
        const previous = historyTurns.get(key);
        let release!: () => void;
        const turn = new Promise<void>((resolve) => {
          release = resolve;
        });
        historyTurns.set(key, turn);
        await previous;
        try {
          if (!expired()) await work();
        } finally {
          release();
          if (historyTurns.get(key) === turn) historyTurns.delete(key);
        }
      };
      const processContact = async (contact: IntakeContact) => {
        const now = currentTime();
        try {
          result.contacts++;
          const observation = observationByContact.get(contact.id);
          if (!observation)
            throw new Error("Missing contact observation result");
          if (observation.status === "rejected") throw observation.reason;
          const routingIssues: string[] = [];
          for (const kind of ["qrz", "lotw"] as const) {
            if (expired()) break;
            const candidates = destinations.filter(
              (c) => c.kind === kind && routeMatches(c, contact),
            );
            if (candidates.length !== 1) {
              if (destinations.some((c) => c.kind === kind))
                routingIssues.push(
                  candidates.length
                    ? `Multiple ${kind.toUpperCase()} routes match; resolve routing`
                    : `No ${kind.toUpperCase()} route matches station and date`,
                );

              for (const candidate of destinations.filter(
                (c) => c.kind === kind,
              ))
                await store
                  .statement(
                    "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=?",
                    candidates.length
                      ? "Multiple connections match this station; resolve routing"
                      : "No connection matches this station and date",
                    source.tenant,
                    source.id,
                    contact.id,
                    candidate.id,
                  )
                  .run();
              continue;
            }
            const destination = candidates[0];
            const preparing = false;
            try {
              await historyTurn(destination, contact, () =>
                measure("history", () =>
                  reconcileContact(
                    store,
                    source,
                    destination,
                    contact,
                    gates,
                    fetcher,
                    now,
                    priority,
                    clock,
                    throughput,
                  ),
                ),
              );
              if (expired()) break;
              // Read-only adoption must retain its actual history diagnosis.
              // Closed rollout gates are global status, not a contact failure.
              if (!exportsEffective(gates)) continue;
              if (routeDeliveryMode(gates, contact.id, destination) !== null)
                exportRoutes.push({ contact, destination });
            } catch (error) {
              diagnostics.record(
                error,
                preparing ? "preparation" : "reconciliation",
                destination.kind,
              );
              if (error instanceof VendorDeferredError) {
                result.deferred++;
                continue;
              }
              result.errors++;
              await store
                .statement(
                  "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=?",
                  reconciliationFailure(error, preparing),
                  source.tenant,
                  source.id,
                  contact.id,
                  destination.id,
                )
                .run();
            }
          }
          await store
            .statement(
              "UPDATE source_work SET state='waiting',processed_at=?,reason=? WHERE tenant=? AND source=? AND id=? AND kind='qso' AND state IN('pending','waiting')",
              now,
              routingIssues.join("; ") || null,
              source.tenant,
              source.id,
              contact.id,
            )
            .run();
        } catch (error) {
          diagnostics.record(error, "contact");
          if (error instanceof VendorDeferredError) result.deferred++;
          else result.errors++;
        } finally {
          if (exportsEffective(gates)) finished.set(contact.id, contact);
          else
            await finishReconciliationWork(
              store,
              source,
              contact.id,
              contact.reconciliationVersion,
              currentTime(),
            );
        }
      };
      // Read-only background work can overlap database latency. Live work and
      // any enabled export path retain their sequential dispatch ordering.
      const concurrency =
        priority === "background" && !exportsEffective(gates) ? 4 : 1;
      let nextContact = 0;
      const workers = await Promise.allSettled(
        Array.from(
          { length: Math.min(concurrency, batch.contacts.length) },
          async () => {
            while (!expired()) {
              const contact = batch.contacts[nextContact++];
              if (!contact) return;
              await processContact(contact);
            }
          },
        ),
      );
      // Retain the cycle lease until all started work has settled, even if a
      // worker's final queue update fails outside the contact error handler.
      const failed = workers.find((worker) => worker.status === "rejected");
      try {
        if (failed?.status === "rejected") throw failed.reason;
        if (
          exportsEffective(gates) &&
          exportRoutes.length &&
          !expired() &&
          attemptSlots[priority] > 0
        )
          await prepareExportCohort(
            exportRoutes,
            destinations,
            finished,
            priorBudgetHolds,
            budgetBackoffs,
          );
      } finally {
        // An edit during the shared drain has a newer version; the ordinary CAS
        // leaves that work awake instead of parking it with this older turn.
        for (const contact of finished.values())
          await finishReconciliationWork(
            store,
            source,
            contact.id,
            contact.reconciliationVersion,
            currentTime(),
          );
        if (budgetBackoffs.size) {
          // An individually oversized closure yields one extra retry interval
          // to its neighbors. Only the exact selected queue version may move;
          // new source work stays awake, and existing later deadlines survive.
          const retryAt = currentTime() + 10 * 60_000;
          await store.db.batch(
            [...budgetBackoffs].map(([qso, version]) =>
              store.statement(
                "UPDATE reconciliation_work SET next_due_at=MAX(next_due_at,?) WHERE tenant=? AND source=? AND qso=? AND version=?",
                retryAt,
                source.tenant,
                source.id,
                qso,
                version,
              ),
            ),
          );
        }
      }
      return batch.selected;
    };
    const processRescan = async () => {
      const rescans = completedRescans.get(sourceKey) ?? new Set<string>();
      completedRescans.set(sourceKey, rescans);
      const rescan =
        priority === "background"
          ? await store
              .statement(
                "SELECT stream FROM cursors WHERE tenant=? AND connection=? AND (stream='repair' OR stream LIKE 'rescan:%' AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=cursors.tenant AND d.id=substr(cursors.stream,8) AND d.status='active')) AND COALESCE(json_extract(cursor,'$.rescanComplete'),0)=0 AND stream NOT IN(SELECT value FROM json_each(?)) ORDER BY updated_at,stream LIMIT 1",
                source.tenant,
                source.id,
                JSON.stringify([...rescans]),
              )
              .first<{ stream: string }>()
          : null;
      if (rescan)
        try {
          const page = await measure("sourceRescan", () =>
            pollSource(
              store,
              source,
              fetcher,
              currentTime(),
              rescan.stream,
              clock ?? null,
            ),
          );
          throughput.rescanPages += page.pages;
          throughput.sourceRecords += page.records;
          progress += page.pages;
          if (page.complete || page.pages === 0 || page.records === 0)
            rescans.add(rescan.stream);
        } catch (error) {
          diagnostics.record(error, "source_rescan", "lofi");
          rescans.add(rescan.stream);
          if (error instanceof VendorDeferredError) result.deferred++;
          else result.errors++;
        }
    };
    const processContextReread = async () => {
      if (!stoppedRereads.has(rereadKey)) {
        try {
          const reread = await measure("contextReread", () =>
            rereadOperation(
              store,
              source,
              fetcher,
              currentTime(),
              priority,
              clock ?? null,
              nowAtStart,
            ),
          );
          throughput.rereadPages += reread.pages;
          progress += reread.pages;
        } catch (error) {
          diagnostics.record(error, "context", "lofi");
          stoppedRereads.add(rereadKey);
          if (error instanceof VendorDeferredError) result.deferred++;
          else result.errors++;
        }
      }
    };
    let retainedSelected = 0;
    try {
      if (
        priority === "background" &&
        (!admission ||
          !(await admitBackgroundSource(
            store,
            admission,
            lease,
            currentTime(),
          )))
      )
        return 0;
      if (pollTurn) {
        polled = true;
        attemptedPolls.add(sourceKey);
        try {
          const page = await measure("sourcePoll", () =>
            pollSource(
              store,
              source,
              fetcher,
              currentTime(),
              "sync",
              clock ?? null,
            ),
          );
          throughput.sourceRecords += page.records;
          result.sources += page.pages;
          progress += page.pages;
          if (
            page.complete ||
            page.pages === 0 ||
            (page.records === 0 && !page.policyProgress)
          )
            completedPolls.add(sourceKey);
        } catch (error) {
          diagnostics.record(error, "source_poll", "lofi");
          completedPolls.add(sourceKey);
          if (!(error instanceof VendorDeferredError)) throw error;
          result.deferred++;
        }
      }
      if (expired()) return progress;
      if (priority === "background") {
        // Persist the next first lane before doing work: any one lane can
        // consume the deadline or fail, but cannot keep the others behind it.
        // This metadata stream is separate from source/context proof cursors.
        const turn = await store
          .statement(
            "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) SELECT ?1,?2,'scheduler:background','{}',1,?3 WHERE EXISTS(SELECT 1 FROM leases WHERE tenant=?1 AND scope=?4 AND token=?5 AND fence=?6 AND expires_at>?3) AND EXISTS(SELECT 1 FROM connections WHERE tenant=?1 AND id=?2 AND kind='lofi' AND status='active') ON CONFLICT(tenant,connection,stream) DO UPDATE SET generation=cursors.generation+1,updated_at=excluded.updated_at RETURNING generation",
            source.tenant,
            source.id,
            currentTime(),
            lease.scope,
            lease.token,
            lease.fence,
          )
          .first<{ generation: number }>();
        if (!turn) return progress;
        const lanes = [
          async () => {
            retainedSelected = await processRetainedContacts(true);
          },
          processRescan,
          processContextReread,
        ];
        const firstLane = (turn.generation - 1) % lanes.length;
        for (const lane of [
          ...lanes.slice(firstLane),
          ...lanes.slice(0, firstLane),
        ]) {
          if (expired()) return progress;
          await lane();
        }
      } else await processContextReread();
      if (expired()) return progress;
      if (priority === "live" || retainedSelected === 0)
        await processRetainedContacts();
    } catch (error) {
      diagnostics.record(error, "source_cycle", "lofi");
      if (error instanceof VendorDeferredError) result.deferred++;
      else {
        result.errors++;
        await store
          .statement(
            "UPDATE connections SET config=json_set(config,'$.lastError','Source sync requires attention','$.lastSyncFailureAt',?) WHERE tenant=? AND id=?",
            currentTime(),
            source.tenant,
            source.id,
          )
          .run();
      }
    } finally {
      try {
        // A failed source still consumes its scheduling turn. Otherwise two
        // unavailable accounts can permanently starve every other tenant.
        if (polled)
          await store
            .statement(
              "UPDATE connections SET last_poll_at=MAX(COALESCE(last_poll_at,0),?) WHERE tenant=? AND id=? AND status='active'",
              now,
              source.tenant,
              source.id,
            )
            .run();
      } finally {
        await store.release(lease);
      }
    }
    return progress;
  };
  const processAttempts = async (priority: VendorPriority, limit: number) => {
    limit = Math.min(limit, attemptSlots[priority]);
    if (limit === 0 || expired()) return 0;
    const now = currentTime();
    const attempts = (
      await store
        .statement(
          "SELECT s.tenant,s.attempt,s.state,a.source,a.qso FROM attempt_state s JOIN attempts a ON a.tenant=s.tenant AND a.id=s.attempt WHERE s.state IN('prepared','uncertain','submitted') AND s.due_at<=? AND s.priority=? ORDER BY s.updated_at LIMIT ?",
          now,
          priority,
          limit,
        )
        .all<{
          tenant: string;
          attempt: string;
          state: string;
          source: string;
          qso: string;
        }>()
    ).results;
    let turns = 0;
    for (const attempt of attempts) {
      if (expired()) break;
      const now = currentTime();
      turns++;
      attemptSlots[priority]--;
      try {
        if (attempt.state === "prepared") {
          if (
            await cancelStalePreparedSourceProof(
              store,
              attempt.tenant,
              attempt.attempt,
              now,
            )
          ) {
            // Cancellation used its bounded queue turn but performed no
            // dispatch. Preserve the round's original transport allowance so
            // a background source can refresh and replace it in this turn.
            attemptSlots[priority]++;
            continue;
          }
          const source = await store.connection(attempt.tenant, attempt.source);
          if (source?.status !== "active") continue;
          const [contact] = await pendingContacts(
            store,
            source,
            1,
            now,
            undefined,
            attempt.qso,
          );
          if (!contact) continue;
          // Polling advances the context fence even without source changes.
          // Refresh from retained inputs before the dispatch guard; an actual
          // edit cancels the saved unsent artifact through observeContact.
          const destinations = (await store.connections(source.tenant)).filter(
            (c) => c.kind !== "lofi" && c.status === "active",
          );
          const routed = (["qrz", "lotw"] as const).flatMap((kind) => {
            const matches = destinations.filter(
              (c) => c.kind === kind && routeMatches(c, contact),
            );
            return matches.length === 1 ? matches : [];
          });
          await observeContact(store, source, contact, now, routed);
          if (expired()) continue;
          await dispatchAttempt(store, attempt.tenant, attempt.attempt, gates, {
            ...deps,
            priority,
            sourceContact: contact,
          });
        } else
          await reconcileAttempt(store, attempt.tenant, attempt.attempt, {
            ...deps,
            priority,
          });
        result.attempts++;
      } catch (error) {
        if (error instanceof VendorDeferredError) {
          result.deferred++;
          await store
            .statement(
              "UPDATE attempt_state SET due_at=MAX(due_at,?) WHERE tenant=? AND attempt=?",
              error.retryAt,
              attempt.tenant,
              attempt.attempt,
            )
            .run();
        } else result.errors++;
      } finally {
        // Reconciliation with missing credentials or an unavailable vendor must
        // yield its bounded slot while retaining the same immutable attempt.
        await store
          .statement(
            "UPDATE attempt_state SET updated_at=MAX(updated_at,?),due_at=MAX(due_at,?) WHERE tenant=? AND attempt=? AND state IN('prepared','uncertain','submitted')",
            now,
            now + 5 * 60000,
            attempt.tenant,
            attempt.attempt,
          )
          .run();
      }
    }
    return turns;
  };
  let sourceOffset = 0;
  let passProgress = 0;
  while (!expired()) {
    result.rounds++;
    attemptSlots.live = 6;
    attemptSlots.background = 2;
    const round = sources.slice(sourceOffset, sourceOffset + 2);
    // Small contact turns leave request capacity for delivery. Poll live
    // changes before dispatch so newly observed edits can cancel stale bytes.
    for (const source of round)
      passProgress += await processSource(source, "live");
    passProgress += await processAttempts("live", 6);
    // Saved historical uploads precede new history inventory, which could
    // otherwise consume the entire background request allowance.
    const backgroundTurns = await processAttempts("background", 2);
    passProgress += backgroundTurns;
    // Live polling timestamps do not indicate whether background work got a
    // turn. Choose its accounts independently so a slow first batch cannot
    // indefinitely strand the second member of every live pair.
    if (!expired())
      for (const source of await backgroundSources(store, currentTime(), 2))
        passProgress += await processSource(source, "background", source);
    passProgress += await processAttempts("background", 2 - backgroundTurns);
    sourceOffset += round.length;
    // A quiet pair does not imply later accounts are idle. Finish the entire
    // fair pass before stopping, including when there are no active sources.
    if (sourceOffset >= sources.length) {
      if (passProgress === 0) break;
      sourceOffset = 0;
      passProgress = 0;
    }
  }
  // Empty early baseline turns must not consume maintenance before a later
  // cohort registers owners. Tenants with no selected contacts still get one
  // bounded phase after the fair source pass, if the cycle budget permits it.
  for (const tenant of new Set(sources.map((source) => source.tenant))) {
    if (expired()) break;
    await maintainLotwOwnership(tenant);
  }
  const tenants = (
    await store
      .statement(
        "SELECT c.tenant FROM connections c LEFT JOIN leases l ON l.tenant=c.tenant AND l.scope='confirmation-refresh' WHERE c.kind='lotw' AND c.status='active' AND COALESCE(l.expires_at,0)<=? GROUP BY c.tenant ORDER BY COALESCE(MAX(l.fence),0),c.tenant LIMIT 2",
        currentTime(),
      )
      .all<{ tenant: string }>()
  ).results;
  for (const { tenant } of tenants)
    try {
      if (expired()) break;
      await refreshConfirmations(store, tenant, deps);
    } catch (error) {
      if (error instanceof VendorDeferredError) result.deferred++;
      else result.errors++;
    }
  await measure("cleanup", async () => {
    await purgeResolvedSource(store);
    await purgeExpiredSourceExportProofs(store, currentTime());
  });
  result.elapsedMs = Math.max(0, Date.now() - startedAt);
  result.stopReason =
    metered.metrics.calls >= 850
      ? "database_budget"
      : expired()
        ? "deadline"
        : "idle";
  const measured: { throughput?: ThroughputMetrics } = { throughput };
  return { ...result, ...measured };
}
