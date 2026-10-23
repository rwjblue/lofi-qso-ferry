import { establishCutovers, proveNewAfterCutover } from "./cutover.ts";
import { rotatePrivateData, purgeResolvedSource } from "./maintenance.ts";
import { purgeAuth } from "./auth.ts";
import {
  contactAdif,
  dispatchAttempt,
  prepareDue,
  reconcileAttempt,
  refreshConfirmations,
} from "./delivery.ts";
import type { DeliveryGates } from "./delivery.ts";
import {
  expireSource,
  observeContact,
  pendingContacts,
  pollSource,
  rereadOperation,
} from "./intake.ts";
import { LotwClient } from "./lotw.ts";
import type { Contact } from "./projection.ts";
import { sourceFingerprint } from "./projection.ts";
import { QrzClient } from "./qrz.ts";
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
  if (!ledger || ledger.remote_id || ledger.state === "changed") return;
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
  const raw = destination.credential_version
    ? await store.private<{
        apiKey?: string;
        query?: { username: string; password: string };
      }>(
        key.tenant,
        destination.id,
        destination.credential_version,
        "credential",
      )
    : null;
  const record = contactAdif(contact);
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
/** Bounded cron work. One tenant/source cycle lease protects projection and staging. */
export async function tick(
  env: Env,
  fetcher: typeof fetch = fetch,
  clock?: number,
) {
  const now = clock ?? Date.now();
  const deps = { fetcher, ...(clock === undefined ? {} : { now }) };
  const deadline = Date.now() + 90_000;
  await purgeAuth(env, now);
  const store = new Store(env.DB, keyring(env));
  const gates = deliveryGates(env);
  await expireSource(store, now);
  await store.recover(now);
  await rotatePrivateData(store);
  const sources = (
    await store
      .statement(
        "SELECT c.*,COALESCE(json_extract(p.cursor,'$.mode'),'backfill') AS sync_mode FROM connections c LEFT JOIN cursors p ON p.tenant=c.tenant AND p.connection=c.id AND p.stream='sync' WHERE c.kind='lofi' AND c.status='active' ORDER BY ROW_NUMBER() OVER(PARTITION BY COALESCE(json_extract(p.cursor,'$.mode'),'backfill') ORDER BY COALESCE(c.last_poll_at,0),c.tenant,c.id),CASE WHEN json_extract(p.cursor,'$.mode')='forward' THEN 0 ELSE 1 END,c.tenant,c.id LIMIT 2",
      )
      .all<Connection & { sync_mode: "backfill" | "forward" }>()
  ).results;
  const result = {
    sources: 0,
    contacts: 0,
    attempts: 0,
    errors: 0,
    deferred: 0,
    exportsEnabled: exportsEffective(gates),
  };
  const processSource = async (
    source: (typeof sources)[number],
    priority: VendorPriority,
  ) => {
    if (Date.now() >= deadline) return;
    const lease = await store.claim(
      source.tenant,
      `cycle:${source.id}`,
      now,
      5 * 60_000,
    );
    if (!lease) return;
    const canonicalTurn =
      (source.sync_mode === "forward" ? "live" : "background") === priority;
    try {
      if (canonicalTurn) {
        try {
          await pollSource(store, source, fetcher, now, "sync", clock ?? null);
          result.sources++;
        } catch (error) {
          if (!(error instanceof VendorDeferredError)) throw error;
          result.deferred++;
        }
      }
      const rescan =
        priority === "background"
          ? await store
              .statement(
                "SELECT stream FROM cursors WHERE tenant=? AND connection=? AND (stream='repair' OR stream LIKE 'rescan:%' AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=cursors.tenant AND d.id=substr(cursors.stream,8) AND d.status='active')) AND COALESCE(json_extract(cursor,'$.rescanComplete'),0)=0 ORDER BY updated_at LIMIT 1",
                source.tenant,
                source.id,
              )
              .first<{ stream: string }>()
          : null;
      if (rescan)
        try {
          await pollSource(
            store,
            source,
            fetcher,
            now,
            rescan.stream,
            clock ?? null,
          );
        } catch (error) {
          if (error instanceof VendorDeferredError) result.deferred++;
          else result.errors++;
        }
      try {
        await rereadOperation(
          store,
          source,
          fetcher,
          now,
          priority,
          clock ?? null,
        );
      } catch (error) {
        if (error instanceof VendorDeferredError) result.deferred++;
        else result.errors++;
      }
      await establishCutovers(store, source, gates, now);
      for (const contact of await pendingContacts(
        store,
        source,
        priority === "live" ? 20 : 4,
        now,
        priority,
      )) {
        if (Date.now() >= deadline) break;
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
            if (Date.now() >= deadline) break;
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
                    "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=?",
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
                  "UPDATE ledger SET reason='Destination readback unavailable; retry automatically' WHERE tenant=? AND source=? AND qso=? AND destination=?",
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
              "UPDATE source_work SET state='waiting',processed_at=?,reason=? WHERE tenant=? AND source=? AND id=? AND kind='qso'",
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
    } catch (error) {
      if (error instanceof VendorDeferredError) result.deferred++;
      else {
        result.errors++;
        await store
          .statement(
            "UPDATE connections SET config=json_set(config,'$.lastError','Source sync requires attention','$.lastSyncFailureAt',?) WHERE tenant=? AND id=?",
            now,
            source.tenant,
            source.id,
          )
          .run();
      }
    } finally {
      try {
        // A failed source still consumes its scheduling turn. Otherwise two
        // unavailable accounts can permanently starve every other tenant.
        if (canonicalTurn)
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
  };
  const processAttempts = async (priority: VendorPriority, limit: number) => {
    if (limit === 0) return 0;
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
      if (Date.now() >= deadline) break;
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
          await dispatchAttempt(store, attempt.tenant, attempt.attempt, gates, {
            ...deps,
            priority,
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
  // Reserve the first phase for forward changes and their prepared deliveries.
  // Historical imports cannot spend these contact/attempt or request budgets.
  for (const source of sources) await processSource(source, "live");
  await processAttempts("live", 6);
  // Finish saved imports before inventory reads can spend the next window's
  // background allowance. Newly prepared imports may use any remaining turns.
  const backgroundTurns = await processAttempts("background", 2);
  for (const source of sources) await processSource(source, "background");
  await processAttempts("background", 2 - backgroundTurns);
  const tenants = (
    await store
      .statement(
        "SELECT c.tenant FROM connections c LEFT JOIN leases l ON l.tenant=c.tenant AND l.scope='confirmation-refresh' WHERE c.kind='lotw' AND c.status='active' AND COALESCE(l.expires_at,0)<=? GROUP BY c.tenant ORDER BY COALESCE(MAX(l.fence),0),c.tenant LIMIT 2",
        now,
      )
      .all<{ tenant: string }>()
  ).results;
  for (const { tenant } of tenants)
    try {
      if (Date.now() >= deadline) break;
      await refreshConfirmations(store, tenant, deps);
    } catch (error) {
      if (error instanceof VendorDeferredError) result.deferred++;
      else result.errors++;
    }
  await purgeResolvedSource(store);
  return result;
}
