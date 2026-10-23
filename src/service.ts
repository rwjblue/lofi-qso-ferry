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
  pendingContactBatch,
  pendingContacts,
  pollSource,
  rereadOperation,
} from "./intake.ts";
import { LotwClient, LotwLoginError } from "./lotw.ts";
import { refreshLotwCertificates } from "./lotw-maintenance.ts";
import type { Contact } from "./projection.ts";
import { sourceFingerprint } from "./projection.ts";
import { QrzClient, QrzError } from "./qrz.ts";
import { adoptHistory, classifyHistory } from "./reconcile.ts";
import type { ReconciliationEvidence } from "./reconcile.ts";
import { keyring } from "./security.ts";
import { Store } from "./store.ts";
import type { Connection, LedgerKey } from "./store.ts";
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
async function reconcileContact(
  store: Store,
  source: Connection,
  destination: Connection,
  contact: Contact,
  gates: DeliveryGates,
  fetcher: typeof fetch,
  now: number,
  priority: VendorPriority,
  vendorNow: number | undefined,
) {
  const key: LedgerKey = {
    tenant: source.tenant,
    source: source.id,
    qso: contact.id,
    destination: destination.id,
  };
  const ledger = await store.ledger(key);
  if (
    !ledger ||
    ledger.remote_id ||
    ledger.state === "changed" ||
    ledger.provenance === "adoption_conflict"
  )
    return;
  if (
    await store
      .statement(
        "SELECT 1 n FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.source=? AND a.qso=? AND a.destination=? AND s.state NOT IN('delivered','observed','rejected','cancelled') LIMIT 1",
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      )
      .first()
  )
    return;
  let record: ReturnType<typeof contactReconciliationAdif>;
  try {
    record = contactReconciliationAdif(contact);
  } catch {
    throw new ReconciliationError(
      "Source fields cannot be represented in ADIF; review contact",
    );
  }
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
  let remote: Record<string, string>[] = [];
  let readAccess = false;
  if (destination.kind === "qrz" && raw?.apiKey) {
    remote = await new QrzClient(raw.apiKey, {
      fetch: vendorFetch(store, "qrz", fetcher, { priority, now: vendorNow }),
    }).findNeighborhood(record);
    readAccess = true;
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
  }
  const evidence: ReconciliationEvidence = {
    destination: destination.kind as "qrz" | "lotw",
    capturedGeneration: contact.generation,
    currentGeneration: contact.generation,
    readAccess,
    inventoryComplete: readAccess,
    catchupComplete: true,
    freshCheckComplete: readAccess,
    provenNewAfterCutover:
      gates.sourceBoundaryVerified && (await proveNewAfterCutover(store, key)),
  };
  let outcome = classifyHistory(record, remote, evidence);
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
  await adoptHistory(
    store,
    key,
    contact.generation,
    outcome,
    now,
    outcome.state === "adopted_existing" && destination.kind === "qrz"
      ? await sourceFingerprint(contact, "qrz", true)
      : undefined,
  );
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
  const expired = () => Date.now() >= deadline;
  await purgeAuth(env, now);
  const store = new Store(env.DB, keyring(env));
  const gates = deliveryGates(env);
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
    stopReason: "idle" as "idle" | "deadline",
  };
  const completedPolls = new Set<string>();
  const completedRescans = new Map<string, Set<string>>();
  const stoppedRereads = new Set<string>();
  const processSource = async (
    source: (typeof sources)[number],
    priority: VendorPriority,
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
    const pollTurn = canonicalTurn && !completedPolls.has(sourceKey);
    const processRetainedContacts = async (readyContextOnly = false) => {
      if (expired()) return 0;
      await establishCutovers(store, source, gates, currentTime());
      if (expired()) return 0;
      const batch = await pendingContactBatch(
        store,
        source,
        1,
        currentTime(),
        priority,
        undefined,
        nowAtStart,
        readyContextOnly,
      );
      progress += batch.selected;
      for (const contact of batch.contacts) {
        if (expired()) break;
        const now = currentTime();
        try {
          result.contacts++;
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
              await reconcileContact(
                store,
                source,
                destination,
                contact,
                gates,
                fetcher,
                now,
                priority,
                clock,
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
          if (error instanceof VendorDeferredError) result.deferred++;
          else result.errors++;
        }
      }
      return batch.selected;
    };
    let retainedSelected = 0;
    try {
      if (pollTurn) {
        try {
          const page = await pollSource(
            store,
            source,
            fetcher,
            currentTime(),
            "sync",
            clock ?? null,
          );
          result.sources += page.pages;
          progress += page.pages;
          if (page.complete || page.pages === 0 || page.records === 0)
            completedPolls.add(sourceKey);
        } catch (error) {
          completedPolls.add(sourceKey);
          if (!(error instanceof VendorDeferredError)) throw error;
          result.deferred++;
        }
      }
      if (expired()) return progress;
      if (priority === "background") {
        // Retained contacts with complete context get a bounded turn before
        // historical ingestion can consume the remaining wall-time budget.
        retainedSelected = await processRetainedContacts(true);
        if (expired()) return progress;
      }
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
          const page = await pollSource(
            store,
            source,
            fetcher,
            currentTime(),
            rescan.stream,
            clock ?? null,
          );
          progress += page.pages;
          if (page.complete || page.pages === 0 || page.records === 0)
            rescans.add(rescan.stream);
        } catch (error) {
          rescans.add(rescan.stream);
          if (error instanceof VendorDeferredError) result.deferred++;
          else result.errors++;
        }
      if (expired()) return progress;
      if (!stoppedRereads.has(rereadKey)) {
        try {
          const reread = await rereadOperation(
            store,
            source,
            fetcher,
            currentTime(),
            priority,
            clock ?? null,
            nowAtStart,
          );
          progress += reread.pages;
        } catch (error) {
          stoppedRereads.add(rereadKey);
          if (error instanceof VendorDeferredError) result.deferred++;
          else result.errors++;
        }
      }
      if (expired()) return progress;
      if (priority === "live" || retainedSelected === 0)
        await processRetainedContacts();
    } catch (error) {
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
        if (pollTurn)
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
    for (const source of round)
      passProgress += await processSource(source, "background");
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
  await purgeResolvedSource(store);
  result.elapsedMs = Math.max(0, Date.now() - startedAt);
  result.stopReason = expired() ? "deadline" : "idle";
  return result;
}
