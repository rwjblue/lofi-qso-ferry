import { measuredDatabase, type DatabaseMetrics } from "./database-metrics.ts";
import { createFailureDiagnostics } from "./failure-diagnostics.ts";
import { establishCutovers, proveNewAfterCutover } from "./cutover.ts";
import { rotatePrivateData, purgeResolvedSource } from "./maintenance.ts";
import { purgeAuth } from "./auth.ts";
import {
  contactReconciliationAdif,
  dispatchAttempt,
  prepareDue,
  reconcileAttempt,
  refreshConfirmations,
} from "./delivery.ts";
import type { DeliveryGates } from "./delivery.ts";
import {
  expireSource,
  observeContact,
  observeContacts,
  pendingContactBatch,
  pendingContacts,
  pollSource,
  rereadOperation,
} from "./intake.ts";
import {
  historyCandidates,
  historyCandidatesBatch,
  historyInventoryGuard,
  pruneHistoryInventory,
} from "./history-inventory.ts";
import {
  finishReconciliationWork,
  finishReconciliationWorkStatement,
  reconciliationCheckStatement,
  reconciliationPreflightBatch,
  reconciliationPreflight,
  recordReconciliationCheck,
  syncReconciliationPolicy,
} from "./reconciliation-work.ts";
import type { IntakeContact } from "./intake.ts";
import { LotwClient, LotwLoginError } from "./lotw.ts";
import { refreshLotwCertificates } from "./lotw-maintenance.ts";
import type { Contact } from "./projection.ts";
import { sourceFingerprint } from "./projection.ts";
import { QrzClient, QrzError } from "./qrz.ts";
import {
  adoptHistory,
  adoptHistoryBatch,
  classifyHistory,
} from "./reconcile.ts";
import type { HistoryAdoptionInput } from "./reconcile.ts";
import type {
  HistoryInventoryInput,
  HistoryInventoryResult,
} from "./history-inventory.ts";
import type { ReconciliationEvidence } from "./reconcile.ts";
import { keyring } from "./security.ts";
import { Store } from "./store.ts";
import type { Connection, LedgerKey } from "./store.ts";
import {
  admitBackgroundSource,
  backgroundSources,
  type BackgroundSource,
} from "./scheduler-admission.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";
import type { VendorPriority } from "./vendor-requests.ts";
export function deliveryGates(env: Env): DeliveryGates {
  const scope: unknown = JSON.parse(env.ROLLOUT_QSO_IDS_JSON || "[]");
  if (!Array.isArray(scope) || scope.some((v) => typeof v !== "string"))
    throw new Error("Invalid rollout scope");
  return {
    allowedQsoIds:
      scope.length === 1 && scope[0] === "*" ? null : (scope as string[]),
    exportsEnabled:
      String(env.EXPORTS_ENABLED) === "true" &&
      String(env.ROLLOUT_CHECKS_PASSED) === "true",
    liveWriteAuthorized:
      String(env.LIVE_WRITE_AUTHORIZATION) === "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    sourceBoundaryVerified: String(env.SOURCE_BOUNDARY_VERIFIED) === "true",
  };
}
export function exportsEffective(gates: DeliveryGates): boolean {
  return (
    gates.exportsEnabled &&
    gates.liveWriteAuthorized &&
    gates.sourceBoundaryVerified &&
    (gates.allowedQsoIds === null || (gates.allowedQsoIds?.length ?? 0) > 0)
  );
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
function reconciliationCommitGuard(
  key: LedgerKey,
  contact: IntakeContact,
  inventory: HistoryInventoryResult,
  commitTime: number,
) {
  const inventoryFence = inventory.fence
    ? historyInventoryGuard(key, inventory.fence, commitTime)
    : { sql: inventory.state === "ready" ? "0" : "1", params: [] };
  return {
    sql: `${inventoryFence.sql} AND EXISTS(SELECT 1 FROM reconciliation_work r JOIN source_work w ON w.tenant=r.tenant AND w.source=r.source AND w.id=r.qso AND w.kind='qso' JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source' JOIN cursors c ON c.tenant=r.tenant AND c.connection=r.source AND c.stream='context' WHERE r.tenant=? AND r.source=? AND r.qso=? AND r.version=? AND w.state IN('pending','waiting') AND w.expires_at>? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) AND c.generation=? AND json_extract(c.cursor,'$.complete')=1 AND (? IS NULL OR EXISTS(SELECT 1 FROM source_work o JOIN private_data op ON op.tenant=o.tenant AND op.connection=o.source AND op.id=o.private_id AND op.kind='source' WHERE o.tenant=w.tenant AND o.source=w.source AND o.id=? AND o.kind='operation' AND o.state='context' AND o.expires_at>? AND op.revoked_at IS NULL AND (op.expires_at IS NULL OR op.expires_at>?) AND NOT EXISTS(SELECT 1 FROM source_work e LEFT JOIN private_data ep ON ep.tenant=e.tenant AND ep.connection=e.source AND ep.id=e.private_id AND ep.kind='source' WHERE e.tenant=o.tenant AND e.source=o.source AND e.operation_id=o.id AND e.kind='qso' AND e.is_event=1 AND e.deleted=0 AND (e.expires_at<=? OR ep.id IS NULL OR ep.revoked_at IS NOT NULL OR (ep.expires_at IS NOT NULL AND ep.expires_at<=?))))))`,
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
    exportsEffective(gates)
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
  let outcome = classifyHistory(record, remote, evidence);
  if (inventory.state === "pending")
    outcome = {
      ...outcome,
      state: "inventory_pending",
      reason:
        inventory.reason ?? "Shared destination inventory is still loading",
    };
  if (
    outcome.state === "missing_current_identity" &&
    !gates.sourceBoundaryVerified
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
    const planned: { route: Route; adoption: HistoryAdoptionInput }[] = [];
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
              let outcome = classifyHistory(
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
                !gates.sourceBoundaryVerified
              )
                outcome = {
                  ...outcome,
                  state: "inventory_pending",
                  reason:
                    "Source replay/cutover evidence is not yet verified; absence cannot authorize backfill",
                };
              planned.push({
                route,
                adoption: {
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
                },
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
      sourceBoundaryVerified: gates.sourceBoundaryVerified,
      exportsEffective: exportsEffective(gates),
      allowedQsoIds: gates.allowedQsoIds,
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
  const sources = (
    await store
      .statement(
        "SELECT c.*,COALESCE(json_extract(p.cursor,'$.mode'),'backfill') AS sync_mode FROM connections c LEFT JOIN cursors p ON p.tenant=c.tenant AND p.connection=c.id AND p.stream='sync' WHERE c.kind='lofi' AND c.status='active' ORDER BY ROW_NUMBER() OVER(PARTITION BY COALESCE(json_extract(p.cursor,'$.mode'),'backfill') ORDER BY COALESCE(c.last_poll_at,0),c.tenant,c.id),CASE WHEN json_extract(p.cursor,'$.mode')='forward' THEN 0 ELSE 1 END,c.tenant,c.id",
      )
      .all<Connection & { sync_mode: "backfill" | "forward" }>()
  ).results;
  const result = {
    sources: 0,
    contacts: 0,
    attempts: 0,
    errors: certificateRefresh.errors,
    deferred: certificateRefresh.deferred,
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
    const processRetainedContacts = async (readyContextOnly = false) => {
      if (expired()) return 0;
      await establishCutovers(store, source, gates, currentTime());
      if (expired()) return 0;
      const batch = await measure("projection", () =>
        pendingContactBatch(
          store,
          source,
          priority === "live" ? 1 : 20,
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
          ),
        ).finally(() => {
          throughput.reconciliationBatchCalls += metered.metrics.calls - before;
        });
        result.errors += processed.errors;
        result.deferred += processed.deferred;
        return batch.selected;
      }
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
          const routed = (["qrz", "lotw"] as const).flatMap((kind) => {
            const matches = destinations.filter(
              (c) => c.kind === kind && routeMatches(c, contact),
            );
            return matches.length === 1 ? matches : [];
          });
          await observeContact(store, source, contact, now, routed);
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
            let preparing = false;
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
              preparing = true;
              const key = {
                tenant: source.tenant,
                source: source.id,
                qso: contact.id,
                destination: destination.id,
              };
              const prepared = await prepareDue(store, key, contact, gates, {
                ...deps,
                priority,
              });
              if (prepared.state === "blocked")
                await store
                  .statement(
                    "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND state IN('missing_current_identity','changed','live_new')",
                    prepared.reason ?? "Delivery preparation requires review",
                    key.tenant,
                    key.source,
                    key.qso,
                    key.destination,
                  )
                  .run();
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
      if (failed?.status === "rejected") throw failed.reason;
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
          if (page.complete || page.pages === 0 || page.records === 0)
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
      try {
        if (attempt.state === "prepared") {
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
  await measure("cleanup", () => purgeResolvedSource(store));
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
