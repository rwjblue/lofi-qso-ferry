import type { AdifRecord } from "./adif.ts";
import {
  ClubLogClient,
  type ClubLogCredentials,
  ClubLogError,
  clublogIdentity,
  clublogRecord,
  clublogRemoteIdentity,
  matchClublogHistory,
} from "./clublog.ts";
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
import { canonical, randomToken, sha256 } from "./security.ts";
import {
  type Connection,
  RETAINED_REMOTE_IDENTITY_NOTICE,
  type Store,
} from "./store.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

async function clientFor(
  store: Store,
  connection: Connection,
  version: string | null,
  deps: DeliveryDependencies,
  beforeWrite?: () => Promise<boolean>,
): Promise<ClubLogClient | null> {
  const credential = version
    ? await store.private<ClubLogCredentials>(
        connection.tenant,
        connection.id,
        version,
        "credential",
      )
    : null;
  if (!credential) return null;
  const config = JSON.parse(connection.config) as { stationCallsign?: string };
  if (credential.callsign !== config.stationCallsign)
    throw new ClubLogError("blocked", "Club Log credential route changed");
  return new ClubLogClient(credential, {
    apiKey: deps.clublogApiKey,
    fetcher: vendorFetch(store, "clublog", deps.fetcher, {
      priority: deps.priority,
      now: deps.now,
    }),
    writesEnabled: Boolean(beforeWrite),
    beforeWrite,
  });
}

/** Exclude only an exactly identified previous mapping, never nearby contacts. */
async function priorMapping(
  records: AdifRecord[],
  remoteId: string | null,
  retainedIds: string[] = [],
) {
  if (!remoteId && !retainedIds.length)
    return { current: records, prior: [] as AdifRecord[] };
  const retained = new Set(retainedIds);
  const current: AdifRecord[] = [];
  const prior: AdifRecord[] = [];
  for (const record of records) {
    const id = await clublogRemoteIdentity(record);
    if (id === remoteId) prior.push(record);
    else if (!retained.has(id)) current.push(record);
  }
  return { current, prior };
}

async function prepare(ctx: PrepareContext): Promise<Preparation> {
  const { store, key, contact, row, connection, deps, now } = ctx;
  if (!deps.clublogApiKey)
    return { state: "blocked", reason: "clublog_application_key_unavailable" };
  const config = JSON.parse(connection.config) as { stationCallsign?: string };
  if (config.stationCallsign !== contact.stationCall)
    return { state: "blocked", reason: "clublog_station_route_mismatch" };
  try {
    const record = clublogRecord(contact);
    const projectionHash = await sha256(canonical(record));
    const remoteId = await clublogRemoteIdentity(record);
    const claimGuard = await store.remoteIdentityClaimGuard(key, remoteId);
    if (
      !(await store
        .statement(`SELECT 1 WHERE ${claimGuard.sql}`, ...claimGuard.params)
        .first())
    )
      return {
        state: "blocked",
        reason: "clublog_remote_identity_claimed_elsewhere",
      };
    const client = await clientFor(
      store,
      connection,
      connection.credential_version,
      deps,
    );
    if (!client) return { state: "blocked", reason: "credential_unavailable" };
    const records = await client.download();
    const retainedRemoteIds = (await store.retainedRemoteIds(key)).filter(
      (id) => id !== remoteId,
    );
    const { current, prior } = await priorMapping(
      records,
      row.remote_id !== remoteId ? row.remote_id : null,
      retainedRemoteIds,
    );
    const match = matchClublogHistory(record, current, {
      // A source edit cannot clear retained remote values by omitting fields.
      // Initial adoption/readback still treats absent source fields as unowned.
      strictAbsence:
        row.remote_id === remoteId && row.baseline_hash !== row.source_hash,
    });
    if (row.remote_id === remoteId) {
      if (match.state === "adopted_existing") {
        // The download may overlap deletion, rerouting, a new projection or
        // credential renewal. Settle only the same still-eligible source state.
        const settled = await store
          .statement(
            "UPDATE ledger SET baseline_hash=source_hash,state=CASE WHEN provenance='adopted' THEN 'adopted_existing' ELSE 'observed' END,updated_at=?1 WHERE tenant=?2 AND source=?3 AND qso=?4 AND destination=?5 AND generation=?6 AND remote_id=?7 AND source_hash=?8 AND state IN('missing_current_identity','changed','live_new') AND EXISTS(SELECT 1 FROM connections c JOIN private_data p ON p.tenant=c.tenant AND p.connection=c.id AND p.id=c.credential_version AND p.kind='credential' WHERE c.tenant=ledger.tenant AND c.id=ledger.destination AND c.status='active' AND c.credential_version=?9 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?1)) AND EXISTS(SELECT 1 FROM connections s WHERE s.tenant=ledger.tenant AND s.id=ledger.source AND s.status='active') AND (context_generation IS NULL OR (EXISTS(SELECT 1 FROM cursors c WHERE c.tenant=ledger.tenant AND c.connection=ledger.source AND c.stream='context' AND c.generation=ledger.context_generation AND json_extract(c.cursor,'$.complete')=1) AND EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=ledger.tenant AND w.source=ledger.source AND w.id=ledger.qso AND w.kind='qso' AND w.state IN('pending','waiting') AND w.expires_at>?1) AND (operation_id IS NULL OR EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=ledger.tenant AND w.source=ledger.source AND w.id=ledger.operation_id AND w.kind='operation' AND w.state='context' AND w.expires_at>?1))))",
            now,
            key.tenant,
            key.source,
            key.qso,
            key.destination,
            contact.generation,
            remoteId,
            row.source_hash,
            connection.credential_version,
          )
          .run();
        return {
          state: "skipped",
          reason:
            settled.meta.changes === 1
              ? "remote_projection_already_current"
              : "source_or_connection_changed",
        };
      }
      // The API does not promise replacement of duplicate structured fields.
      // Its delete key also omits MODE; never turn a mismatch into a blind delete.
      return {
        state: "blocked",
        reason:
          match.state === "history_mismatch"
            ? "clublog_same_identity_correction_requires_review"
            : "clublog_mapped_record_unverified",
      };
    }
    if (match.state !== "missing_current_identity")
      return {
        state: "blocked",
        reason: "clublog_fresh_absence_check_found_candidate",
      };
    let notice: string | undefined;
    if (row.remote_id) {
      if (prior.length !== 1)
        return {
          state: "blocked",
          reason: "clublog_prior_identity_unverified",
        };
      await (
        await store.putPrivate(
          key.tenant,
          key.destination,
          randomToken(),
          "identity_history",
          {
            source: key.source,
            qso: key.qso,
            provider: "clublog",
            oldIdentity: prior[0],
            newIdentity: record,
            oldRemoteId: row.remote_id,
            oldProvenance: row.provenance,
            cleanup: "retained_remote_identity",
          },
          now + 90 * 86400000,
        )
      ).run();
      notice = RETAINED_REMOTE_IDENTITY_NOTICE;
    }
    return {
      state: "ready",
      notice,
      ...(row.remote_id && prior[0]
        ? {
            priorIdentity: {
              remoteId: row.remote_id,
              identity: { ...clublogIdentity(prior[0]) },
            },
          }
        : {}),
      payload: {
        kind: "clublog",
        record,
        remoteId,
        previousRemoteId: row.remote_id,
        retainedRemoteIds,
        mode: deps.priority === "background" ? "background" : "live",
        projectionHash,
        members: [{ id: contact.id, generation: contact.generation }],
        preparedAt: new Date(now).toISOString(),
      },
    };
  } catch (error) {
    if (await handleProviderRejection(store, connection, error, key))
      return {
        state: "blocked",
        reason: "clublog_credentials_require_verification",
      };
    if (error instanceof ClubLogError && error.kind === "blocked")
      return {
        state: "blocked",
        reason: "clublog_projection_or_route_unsupported",
      };
    throw error;
  }
}

async function dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
  const {
    store,
    tenant,
    id,
    data,
    deps,
    lease,
    beforeWrite,
    hasStarted,
    gates,
  } = ctx;
  if (data.payload.kind !== "clublog")
    throw new Error("Invalid Club Log payload");
  if (!deps.clublogApiKey)
    return { state: "rejected", reason: "clublog_application_key_unavailable" };
  try {
    const client = await clientFor(
      store,
      data.connection,
      data.attempt.credential_version,
      deps,
      () => (enabled(gates) ? beforeWrite() : Promise.resolve(false)),
    );
    if (!client) return { state: "rejected", reason: "credential_revoked" };
    // Recheck immediately before the mutating request. A collision is evidence
    // for reconciliation, never permission to replace a remote contact.
    const { current, prior } = await priorMapping(
      await client.download(),
      data.payload.previousRemoteId,
      data.payload.retainedRemoteIds,
    );
    if (data.payload.previousRemoteId && prior.length !== 1)
      return {
        state: "rejected",
        reason: "clublog_prior_identity_changed_before_dispatch",
      };
    const match = matchClublogHistory(data.payload.record, current);
    if (match.state !== "missing_current_identity")
      return {
        state: "rejected",
        reason: "clublog_fresh_collision_before_dispatch",
      };
    const receipt = await client.upload(data.payload.record, data.payload.mode);
    // Both realtime receipts and queued batch receipts await exact readback.
    return {
      state: "submitted",
      ...(receipt.state === "duplicate"
        ? { reason: "clublog_duplicate_requires_readback" }
        : {}),
    };
  } catch (error) {
    if (error instanceof VendorDeferredError) throw error;
    if (await handleProviderRejection(store, data.connection, error)) {
      if (
        hasStarted() &&
        error instanceof ClubLogError &&
        error.kind === "uncertain"
      )
        return {
          state: "uncertain",
          reason: "clublog_suspended_with_unknown_delivery",
        };
      return {
        state: "rejected",
        reason: "clublog_credentials_require_verification",
      };
    }
    if (error instanceof ClubLogError && error.kind === "blocked")
      return { state: "rejected", reason: "clublog_write_blocked" };
    if (!hasStarted()) {
      await store.retryUnsent(
        tenant,
        id,
        lease,
        "clublog_readback_before_dispatch_failed",
        deps.now ?? Date.now(),
      );
      return {
        state: "retry_scheduled",
        attemptId: id,
        reason: "clublog_readback_before_dispatch_failed",
      };
    }
    return { state: "uncertain", reason: "clublog_delivery_outcome_unknown" };
  }
}

async function observe(ctx: ObserveContext): Promise<ObserveOutcome> {
  const { store, data, deps } = ctx;
  if (data.payload.kind !== "clublog")
    throw new Error("Invalid Club Log payload");
  try {
    const client = await clientFor(
      store,
      data.connection,
      data.connection.credential_version,
      deps,
    );
    if (!client)
      return { state: "unresolved", reason: "credential_unavailable" };
    const { current, prior } = await priorMapping(
      await client.download(),
      data.payload.previousRemoteId,
      data.payload.retainedRemoteIds,
    );
    if (prior.length > 1)
      return {
        state: "unresolved",
        reason: "clublog_prior_identity_ambiguous",
      };
    const match = matchClublogHistory(data.payload.record, current);
    if (match.state !== "adopted_existing")
      return { state: "unresolved", reason: `clublog_${match.state}` };
    return {
      state: "observed",
      remoteId: await clublogRemoteIdentity(match.record),
    };
  } catch (error) {
    if (await handleProviderRejection(store, data.connection, error))
      return {
        state: "unresolved",
        reason: "clublog_credentials_require_verification",
      };
    if (error instanceof VendorDeferredError) throw error;
    return { state: "unresolved", reason: "clublog_readback_unavailable" };
  }
}

export const clublogDeliveryAdapter: DeliveryAdapter = {
  prepare,
  dispatch,
  observe,
  reservationId(payload) {
    if (payload.kind !== "clublog") throw new Error("Invalid Club Log payload");
    return payload.remoteId;
  },
};
