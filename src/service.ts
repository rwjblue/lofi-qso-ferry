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
) {
  const key: LedgerKey = {
    tenant: source.tenant,
    source: source.id,
    qso: contact.id,
    destination: destination.id,
  };
  const ledger = await store.ledger(key);
  if (!ledger || ledger.remote_id || ledger.state === "changed") return;
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
      fetch: fetcher,
    }).findNeighborhood(record);
    readAccess = true;
  } else if (destination.kind === "lotw" && raw?.query) {
    const date = new Date(contact.startAtMillis).toISOString().slice(0, 10);
    remote = (
      await new LotwClient(raw.query, { fetcher }).query({
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
        "SELECT * FROM connections WHERE kind='lofi' AND status='active' ORDER BY COALESCE(last_poll_at,0) LIMIT 2",
      )
      .all<Connection>()
  ).results;
  const result = {
    sources: 0,
    contacts: 0,
    attempts: 0,
    errors: 0,
    exportsEnabled: exportsEffective(gates),
  };
  for (const source of sources) {
    if (Date.now() >= deadline) break;
    const lease = await store.claim(
      source.tenant,
      `cycle:${source.id}`,
      now,
      5 * 60_000,
    );
    if (!lease) continue;
    try {
      await pollSource(store, source, fetcher, now);
      const rescan = await store
        .statement(
          "SELECT stream FROM cursors WHERE tenant=? AND connection=? AND stream LIKE 'rescan:%' AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=cursors.tenant AND d.id=substr(cursors.stream,8) AND d.status='active') AND COALESCE(json_extract(cursor,'$.rescanComplete'),0)=0 ORDER BY updated_at LIMIT 1",
          source.tenant,
          source.id,
        )
        .first<{ stream: string }>();
      if (rescan)
        try {
          await pollSource(store, source, fetcher, now, rescan.stream);
        } catch {
          result.errors++;
        }
      try {
        await rereadOperation(store, source, fetcher, now);
      } catch {
        result.errors++;
      }
      await establishCutovers(store, source, gates, now);
      result.sources++;
      for (const contact of await pendingContacts(store, source, 20, now)) {
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
              );
              const key = {
                tenant: source.tenant,
                source: source.id,
                qso: contact.id,
                destination: destination.id,
              };
              const prepared = await prepareDue(
                store,
                key,
                contact,
                gates,
                deps,
              );
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
            } catch {
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
        } catch {
          result.errors++;
        }
      }
    } catch {
      result.errors++;
      await store
        .statement(
          "UPDATE connections SET config=json_set(config,'$.lastError','Source sync requires attention') WHERE tenant=? AND id=?",
          source.tenant,
          source.id,
        )
        .run();
    } finally {
      try {
        // A failed source still consumes its scheduling turn. Otherwise two
        // unavailable accounts can permanently starve every other tenant.
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
  }
  const attempts = (
    await store
      .statement(
        "SELECT tenant,attempt,state FROM attempt_state WHERE state IN('prepared','uncertain','submitted') AND due_at<=? ORDER BY updated_at LIMIT 8",
        now,
      )
      .all<{ tenant: string; attempt: string; state: string }>()
  ).results;
  for (const attempt of attempts) {
    if (Date.now() >= deadline) break;
    try {
      if (attempt.state === "prepared")
        await dispatchAttempt(
          store,
          attempt.tenant,
          attempt.attempt,
          gates,
          deps,
        );
      else await reconcileAttempt(store, attempt.tenant, attempt.attempt, deps);
      result.attempts++;
    } catch {
      result.errors++;
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
    } catch {
      result.errors++;
    }
  await purgeResolvedSource(store);
  return result;
}
