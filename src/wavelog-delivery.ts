import { enabled } from "./delivery-support.ts";
import type {
  DeliveryAdapter,
  DeliveryDependencies,
  DispatchContext,
  DispatchOutcome,
  ObserveContext,
  ObserveOutcome,
  Preparation,
  PrepareContext,
} from "./delivery-types.ts";
import { handleProviderRejection } from "./provider-errors.ts";
import { canonical, seal, sha256 } from "./security.ts";
import type { Connection, Store } from "./store.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";
import {
  matchWavelogHistory,
  WavelogClient,
  WavelogError,
  wavelogComparable,
  wavelogRecord,
  wavelogRemoteIdentity,
  wavelogStation,
  wavelogStationMatches,
} from "./wavelog.ts";
import {
  discoverWavelogStation,
  ensureWavelogStation,
  readWavelogProvisioning,
  WavelogProvisioningError,
  wavelogStationKey,
} from "./wavelog-stations.ts";

interface WavelogConfiguration {
  baseUrl: string;
  ownerId: number;
  stationCallsign: string;
  logbookId: number;
  autoCreateStations: true;
  outboundPolicy: "ferry";
}

function configuration(connection: Connection): WavelogConfiguration {
  const config = JSON.parse(connection.config) as WavelogConfiguration;
  if (
    !config.baseUrl ||
    !Number.isSafeInteger(config.ownerId) ||
    config.ownerId <= 0 ||
    !Number.isSafeInteger(config.logbookId) ||
    config.logbookId <= 0 ||
    config.autoCreateStations !== true ||
    config.outboundPolicy !== "ferry"
  )
    throw new WavelogProvisioningError("wavelog_configuration_unsupported");
  return config;
}

async function clientFor(
  store: Store,
  connection: Connection,
  version: string | null,
  deps: DeliveryDependencies,
  beforeWrite?: () => Promise<boolean>,
): Promise<WavelogClient | null> {
  const credential = version
    ? await store.private<{ baseUrl: string; token: string }>(
        connection.tenant,
        connection.id,
        version,
        "credential",
      )
    : null;
  if (!credential) return null;
  const config = configuration(connection);
  if (credential.baseUrl !== config.baseUrl)
    throw new WavelogProvisioningError("wavelog_credential_route_changed");
  return new WavelogClient(credential, {
    fetcher: vendorFetch(store, "wavelog", deps.fetcher, {
      priority: deps.priority,
      now: deps.now,
      scope: config.baseUrl,
    }),
    writesEnabled: Boolean(beforeWrite),
    beforeWrite,
    allowedBaseUrls: deps.wavelogAllowedBaseUrls ?? [],
  });
}

async function hasQsoIntent(
  store: Store,
  tenant: string,
  destination: string,
  id: string,
): Promise<boolean> {
  // No expiry/revocation filter: any intent is evidence that a request may
  // have begun, even if ordinary encrypted-artifact reads would hide it.
  return Boolean(
    await store
      .statement(
        "SELECT 1 FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='wavelog_qso_intent'",
        tenant,
        destination,
        id,
      )
      .first(),
  );
}

async function markQsoIntent(ctx: DispatchContext): Promise<boolean> {
  const { store, tenant, id, data, lease, deps } = ctx;
  if (data.payload.kind !== "wavelog")
    throw new Error("Invalid Wavelog payload");
  const now = deps.now ?? Date.now();
  const envelope = await seal(
    { stationKey: data.payload.stationKey },
    {
      tenant,
      connection: data.attempt.destination,
      id,
      kind: "wavelog_qso_intent",
      purpose: "storage",
    },
    store.keys,
  );
  const result = await store
    .statement(
      "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) SELECT ?,?,?,'wavelog_qso_intent',?,? WHERE EXISTS(SELECT 1 FROM attempt_state s JOIN leases l ON l.tenant=s.tenant AND l.token=s.lease_token AND l.fence=s.fence WHERE s.tenant=? AND s.attempt=? AND s.state='dispatching' AND l.scope=? AND l.token=? AND l.fence=? AND l.expires_at>?) ON CONFLICT(tenant,connection,id,kind) DO NOTHING",
      tenant,
      data.attempt.destination,
      id,
      JSON.stringify(envelope),
      now,
      tenant,
      id,
      lease.scope,
      lease.token,
      lease.fence,
      now,
    )
    .run();
  return result.meta.changes === 1;
}

async function removeDefinitelyUnsentQsoIntent(
  ctx: DispatchContext,
): Promise<void> {
  const { store, tenant, id, data, lease, deps } = ctx;
  await store
    .statement(
      "DELETE FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='wavelog_qso_intent' AND EXISTS(SELECT 1 FROM attempt_state s JOIN leases l ON l.tenant=s.tenant AND l.token=s.lease_token AND l.fence=s.fence WHERE s.tenant=? AND s.attempt=? AND s.state='dispatching' AND l.scope=? AND l.token=? AND l.fence=? AND l.expires_at>?)",
      tenant,
      data.attempt.destination,
      id,
      tenant,
      id,
      lease.scope,
      lease.token,
      lease.fence,
      deps.now ?? Date.now(),
    )
    .run();
}

/** Resume provisioning after a worker crash only with durable proof no QSO began. */
async function recoverProvisioning(ctx: ObserveContext): Promise<boolean> {
  const { store, tenant, data, deps } = ctx;
  const now = deps.now ?? Date.now();
  const lease = await store.claim(
    tenant,
    `delivery:${data.attempt.destination}`,
    now,
    120000,
  );
  if (!lease) return false;
  try {
    const result = await store
      .statement(
        "UPDATE attempt_state SET state='prepared',due_at=?,lease_token=NULL,fence=NULL,updated_at=?,reason='wavelog_provisioning_recovery_scheduled' WHERE tenant=? AND attempt=? AND state='uncertain' AND NOT EXISTS(SELECT 1 FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='wavelog_qso_intent') AND EXISTS(SELECT 1 FROM attempts a JOIN private_data p ON p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.payload_id AND p.kind='outbox' JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination WHERE a.tenant=? AND a.id=? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) AND c.status='active' AND c.credential_version=a.credential_version) AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?)",
        now,
        now,
        tenant,
        data.attempt.id,
        tenant,
        data.attempt.destination,
        data.attempt.id,
        tenant,
        data.attempt.id,
        now,
        tenant,
        lease.scope,
        lease.token,
        lease.fence,
        now,
      )
      .run();
    if (result.meta.changes !== 1) return false;
    await store
      .statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at,reason) VALUES(?,?,'retry_scheduled',?,'wavelog_provisioning_recovery_scheduled')",
        tenant,
        data.attempt.id,
        now,
      )
      .run();
    return true;
  } finally {
    await store.release(lease);
  }
}

async function prepare(ctx: PrepareContext): Promise<Preparation> {
  const { store, key, contact, row, connection, deps, now } = ctx;
  try {
    const config = configuration(connection);
    if (config.stationCallsign !== contact.stationCall)
      return { state: "blocked", reason: "wavelog_station_route_mismatch" };
    // Wavelog 3.2.4 PATCH can turn passive Club Log/HRDLog flags back on.
    // Holding an edit preserves the mapped QSO and its prior source baseline.
    if (row.remote_id)
      return { state: "blocked", reason: "wavelog_correction_requires_review" };
    const record = wavelogRecord(contact);
    const station = wavelogStation(contact);
    const naturalIdentity = await wavelogRemoteIdentity(record);
    const claim = await store.remoteIdentityClaimGuard(key, naturalIdentity);
    if (
      !(await store
        .statement(`SELECT 1 WHERE ${claim.sql}`, ...claim.params)
        .first())
    )
      return { state: "blocked", reason: "wavelog_identity_claimed_elsewhere" };
    const client = await clientFor(
      store,
      connection,
      connection.credential_version,
      deps,
    );
    if (!client) return { state: "blocked", reason: "credential_unavailable" };
    const existing = await discoverWavelogStation(client, station);
    if (existing) {
      const match = matchWavelogHistory(
        record,
        await client.findQsos(existing.id, record),
      );
      if (match.state !== "missing_current_identity")
        return {
          state: "blocked",
          reason: "wavelog_fresh_absence_check_found_candidate",
        };
    }
    return {
      state: "ready",
      payload: {
        kind: "wavelog",
        operation: "insert",
        record,
        station,
        stationKey: await wavelogStationKey(station, config.logbookId),
        stationId: existing?.id ?? null,
        logbookId: config.logbookId,
        remoteId: null,
        naturalIdentity,
        projectionHash: await sha256(canonical(wavelogComparable(record))),
        members: [{ id: contact.id, generation: contact.generation }],
        preparedAt: new Date(now).toISOString(),
      },
    };
  } catch (error) {
    if (await handleProviderRejection(store, connection, error, key))
      return {
        state: "blocked",
        reason: "wavelog_credentials_require_verification",
      };
    if (error instanceof WavelogProvisioningError)
      return { state: "blocked", reason: error.reason };
    if (error instanceof WavelogError && error.kind === "blocked")
      return {
        state: "blocked",
        reason: "wavelog_projection_or_route_unsupported",
      };
    throw error;
  }
}

async function dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
  const { store, tenant, id, data, deps, lease, beforeWrite, gates } = ctx;
  if (data.payload.kind !== "wavelog")
    throw new Error("Invalid Wavelog payload");
  const payload = data.payload;
  let qsoPhase = false;
  let qsoStarted = false;
  const authorize = async () => {
    const allowed = enabled(gates) && (await beforeWrite());
    if (allowed && qsoPhase) {
      if (!(await markQsoIntent(ctx))) return false;
      if (!enabled(gates) || !(await beforeWrite())) {
        await removeDefinitelyUnsentQsoIntent(ctx);
        return false;
      }
      qsoStarted = true;
    }
    return allowed;
  };
  try {
    if (await hasQsoIntent(store, tenant, data.attempt.destination, id))
      return {
        state: "uncertain",
        reason: "wavelog_qso_intent_requires_readback",
      };
    const config = configuration(data.connection);
    if (
      config.logbookId !== payload.logbookId ||
      config.stationCallsign !== payload.station.callsign ||
      (await wavelogStationKey(payload.station, payload.logbookId)) !==
        payload.stationKey
    )
      return { state: "rejected", reason: "wavelog_prepared_route_changed" };
    const client = await clientFor(
      store,
      data.connection,
      data.attempt.credential_version,
      deps,
      authorize,
    );
    if (!client) return { state: "rejected", reason: "credential_revoked" };
    const target = await ensureWavelogStation({
      store,
      connection: data.connection,
      client,
      station: payload.station,
      logbookId: payload.logbookId,
      lease,
      beforeWrite: authorize,
      now: deps.now ?? Date.now(),
    });
    if (payload.stationId !== null && payload.stationId !== target.stationId)
      return { state: "rejected", reason: "wavelog_prepared_station_changed" };
    const fresh = matchWavelogHistory(
      payload.record,
      await client.findQsos(target.stationId, payload.record),
    );
    if (fresh.state !== "missing_current_identity")
      return {
        state: "rejected",
        reason: "wavelog_fresh_collision_before_dispatch",
      };
    qsoPhase = true;
    const remote = await client.createQso(target.stationId, payload.record);
    const match = matchWavelogHistory(payload.record, [remote], {
      requirePassive: true,
      strictAbsent: true,
    });
    if (
      match.state !== "adopted_existing" ||
      remote.stationId !== target.stationId
    )
      return { state: "uncertain", reason: "wavelog_created_qso_unverified" };
    return { state: "delivered", remoteId: String(remote.id) };
  } catch (error) {
    if (error instanceof VendorDeferredError && !error.requestSent) {
      if (qsoStarted) await removeDefinitelyUnsentQsoIntent(ctx);
      qsoStarted = false;
    }
    const suspended = await handleProviderRejection(
      store,
      data.connection,
      error,
    );
    if (qsoStarted)
      return {
        state: "uncertain",
        reason: suspended
          ? "wavelog_suspended_with_unknown_delivery"
          : "wavelog_delivery_outcome_unknown",
      };
    if (suspended)
      return {
        state: "rejected",
        reason: "wavelog_credentials_require_verification",
      };
    if (
      (error instanceof WavelogProvisioningError && !error.recoverable) ||
      (error instanceof WavelogError && error.kind === "blocked")
    )
      return {
        state: "rejected",
        reason:
          error instanceof WavelogProvisioningError
            ? error.reason
            : "wavelog_write_blocked",
      };
    // No QSO transport began. Provisioning intents make replay safe even when
    // a station/link response was lost: recovery performs reads before writes.
    const reason =
      error instanceof WavelogProvisioningError
        ? error.reason
        : "wavelog_provisioning_or_preflight_pending";
    await store.retryUnsent(
      tenant,
      id,
      lease,
      reason,
      deps.now ?? Date.now(),
      error instanceof VendorDeferredError ? error.retryAt : 0,
    );
    return { state: "retry_scheduled", attemptId: id, reason };
  }
}

async function observe(ctx: ObserveContext): Promise<ObserveOutcome> {
  const { store, data, deps } = ctx;
  if (data.payload.kind !== "wavelog")
    throw new Error("Invalid Wavelog payload");
  const payload = data.payload;
  try {
    if (
      !(await hasQsoIntent(
        store,
        ctx.tenant,
        data.attempt.destination,
        data.attempt.id,
      ))
    ) {
      const recovered = await recoverProvisioning(ctx);
      return {
        state: "unresolved",
        reason: recovered
          ? "wavelog_provisioning_recovery_scheduled"
          : "wavelog_provisioning_recovery_pending",
      };
    }
    const client = await clientFor(
      store,
      data.connection,
      data.connection.credential_version,
      deps,
    );
    if (!client)
      return { state: "unresolved", reason: "credential_unavailable" };
    const journal = await readWavelogProvisioning(
      store,
      data.connection,
      payload.stationKey,
    );
    const stationId = journal?.stationId ?? payload.stationId;
    if (!stationId || journal?.phase !== "ready")
      return {
        state: "unresolved",
        reason: "wavelog_station_provisioning_unresolved",
      };
    const station = await client.getStation(stationId);
    const logbook = await client.getLogbook(payload.logbookId);
    if (
      !wavelogStationMatches(station, payload.station) ||
      station.uuid !== journal.stationUuid ||
      !logbook.station_ids.includes(stationId)
    )
      return { state: "unresolved", reason: "wavelog_station_mapping_changed" };
    const records = await client.findQsos(stationId, payload.record);
    const match = matchWavelogHistory(payload.record, records, {
      requirePassive: true,
      strictAbsent: true,
    });
    if (match.state !== "adopted_existing" || !match.remote)
      return { state: "unresolved", reason: `wavelog_${match.state}` };
    const exact = await client.readQso(match.remote.id);
    if (
      exact.stationId !== stationId ||
      matchWavelogHistory(payload.record, [exact], {
        requirePassive: true,
        strictAbsent: true,
      }).state !== "adopted_existing"
    )
      return { state: "unresolved", reason: "wavelog_exact_readback_changed" };
    return { state: "observed", remoteId: String(exact.id) };
  } catch (error) {
    if (await handleProviderRejection(store, data.connection, error))
      return {
        state: "unresolved",
        reason: "wavelog_credentials_require_verification",
      };
    if (error instanceof VendorDeferredError) throw error;
    return { state: "unresolved", reason: "wavelog_readback_unavailable" };
  }
}

export const wavelogDeliveryAdapter: DeliveryAdapter = {
  prepare,
  dispatch,
  observe,
  reservationId(payload) {
    if (payload.kind !== "wavelog") throw new Error("Invalid Wavelog payload");
    return payload.naturalIdentity;
  },
  async afterResolved({ store, tenant, data }) {
    await store
      .statement(
        "UPDATE ledger SET provenance='ferry_created' WHERE tenant=? AND destination=? AND EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=ledger.tenant AND a.id=? AND a.source=ledger.source AND a.qso=ledger.qso AND a.destination=ledger.destination AND s.state IN('delivered','observed') AND s.remote_id=ledger.remote_id AND a.source_hash=ledger.baseline_hash)",
        tenant,
        data.attempt.destination,
        data.attempt.id,
      )
      .run();
    await store
      .statement(
        "DELETE FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='wavelog_qso_intent' AND EXISTS(SELECT 1 FROM attempt_state WHERE tenant=? AND attempt=? AND state IN('delivered','observed','rejected','cancelled'))",
        tenant,
        data.attempt.destination,
        data.attempt.id,
        tenant,
        data.attempt.id,
      )
      .run();
  },
};
