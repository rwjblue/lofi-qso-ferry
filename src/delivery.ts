import { deliveryAdapters } from "./delivery-adapters.ts";
import { enabled } from "./delivery-support.ts";
import type {
  AttemptRow,
  DeliveryDependencies,
  DeliveryGates,
  DeliveryResult,
  PreparedPayload,
} from "./delivery-types.ts";
import type { Contact } from "./projection.ts";
import { isDestinationKind } from "./providers.ts";
import type { Connection, LedgerKey, Store } from "./store.ts";
import { VendorDeferredError } from "./vendor-requests.ts";

export { refreshConfirmations, templateContext } from "./delivery-support.ts";
export type {
  DeliveryDependencies,
  DeliveryGates,
  DeliveryResult,
  PreparedPayload,
} from "./delivery-types.ts";
export { contactAdif } from "./projection.ts";

/** Prepare one immutable attempt using the destination's own field contract. */
export async function prepareDue(
  store: Store,
  key: LedgerKey,
  contact: Contact,
  gates: DeliveryGates,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  const now = deps.now ?? Date.now();
  if (gates.allowedQsoIds && !gates.allowedQsoIds.includes(key.qso))
    return { state: "blocked", reason: "qso_outside_rollout_scope" };
  const row = await store.ledger(key);
  if (
    !row ||
    row.generation !== contact.generation ||
    contact.id !== key.qso ||
    contact.deleted ||
    row.due_at > now ||
    !["missing_current_identity", "changed", "live_new"].includes(row.state)
  )
    return { state: "skipped", reason: "not_due_or_current" };
  const unresolved = await store
    .statement(
      "SELECT 1 n FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.source=? AND a.qso=? AND a.destination=? AND s.state NOT IN('delivered','observed','rejected','cancelled') LIMIT 1",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    )
    .first();
  if (unresolved) return { state: "skipped", reason: "unresolved_attempt" };
  const connection = await store.connection(key.tenant, key.destination);
  const source = await store.connection(key.tenant, key.source);
  if (
    connection?.status !== "active" ||
    source?.status !== "active" ||
    !connection.credential_version
  )
    return { state: "blocked", reason: "connection_inactive" };
  if (deps.priority === "background") {
    const backlog = await store
      .statement(
        "SELECT COUNT(*) n FROM (SELECT 1 FROM attempt_state s JOIN attempts a ON a.tenant=s.tenant AND a.id=s.attempt JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination AND c.status='active' JOIN connections src ON src.tenant=a.tenant AND src.id=a.source AND src.status='active' WHERE s.state='prepared' AND s.priority='background' AND c.kind=? AND a.credential_version=c.credential_version AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)) LIMIT 2)",
        connection.kind,
        now,
      )
      .first<{ n: number }>();
    if ((backlog?.n ?? 0) >= 2)
      return { state: "skipped", reason: "background_outbox_full" };
  }
  if (!gates.sourceBoundaryVerified && !row.remote_id)
    return { state: "blocked", reason: "source_replay_boundary_unverified" };
  if (!isDestinationKind(connection.kind))
    return { state: "blocked", reason: "invalid_destination" };
  const prepared = await deliveryAdapters[connection.kind].prepare({
    store,
    key,
    contact,
    gates,
    deps,
    row,
    connection: {
      ...connection,
      credential_version: connection.credential_version,
    },
    now,
  });
  if (prepared.state !== "ready") return prepared;
  const attemptId = await store.stage(
    key,
    contact.generation,
    prepared.payload,
    connection.credential_version,
    prepared.template ?? null,
    now,
    prepared.payload.projectionHash,
    prepared.lotwIdentityId,
    deps.priority ?? "live",
    prepared.notice,
    prepared.priorIdentity,
  );
  return { state: "prepared", attemptId };
}
async function attemptData(
  store: Store,
  tenant: string,
  id: string,
): Promise<{
  attempt: AttemptRow;
  connection: Connection;
  payload: PreparedPayload;
} | null> {
  const attempt = await store
    .statement("SELECT * FROM attempts WHERE tenant=? AND id=?", tenant, id)
    .first<AttemptRow>();
  if (!attempt) return null;
  const connection = await store.connection(tenant, attempt.destination);
  if (
    connection?.status !== "active" ||
    (await store.connection(tenant, attempt.source))?.status !== "active"
  )
    return null;
  const payload = await store.private<PreparedPayload>(
    tenant,
    attempt.destination,
    attempt.payload_id,
    "outbox",
  );
  return payload &&
    isDestinationKind(connection.kind) &&
    payload.kind === connection.kind
    ? { attempt, connection, payload }
    : null;
}
export async function dispatchAttempt(
  store: Store,
  tenant: string,
  id: string,
  gates: DeliveryGates,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  if (!enabled(gates)) return { state: "blocked", reason: "exports_disabled" };
  const now = deps.now ?? Date.now();
  const data = await attemptData(store, tenant, id);
  if (
    data &&
    gates.allowedQsoIds &&
    !gates.allowedQsoIds.includes(data.attempt.qso)
  )
    return { state: "blocked", reason: "qso_outside_rollout_scope" };
  if (!data)
    return { state: "blocked", reason: "attempt_or_connection_unavailable" };
  const adapter = deliveryAdapters[data.payload.kind];
  const lease = await store.claim(
    tenant,
    `delivery:${data.attempt.destination}`,
    now,
    120000,
  );
  if (!lease) return { state: "skipped", reason: "delivery_lease_busy" };
  let mutationStarted = false;
  const beforeWrite = async () => {
    const current = await store.connection(tenant, data.attempt.destination);
    const activeSource = await store.connection(tenant, data.attempt.source);
    const liveLease = await store
      .statement(
        "SELECT 1 n FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?",
        tenant,
        lease.scope,
        lease.token,
        lease.fence,
        deps.now ?? Date.now(),
      )
      .first();
    // Readbacks can yield long enough for a source edit, tombstone or context
    // invalidation. Recheck the immutable attempt immediately before transport.
    const currentSource = await store
      .statement(
        "SELECT 1 n FROM attempts a JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination WHERE a.tenant=? AND a.id=? AND l.source_hash=a.source_hash AND l.state NOT IN('source_deleted','retained_old_route') AND (l.context_generation IS NULL OR (EXISTS(SELECT 1 FROM cursors c WHERE c.tenant=l.tenant AND c.connection=l.source AND c.stream='context' AND c.generation=l.context_generation AND json_extract(c.cursor,'$.complete')=1) AND EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=l.tenant AND w.source=l.source AND w.id=l.qso AND w.kind='qso' AND w.state IN('pending','waiting') AND w.expires_at>?) AND (l.operation_id IS NULL OR EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=l.tenant AND w.source=l.source AND w.id=l.operation_id AND w.kind='operation' AND w.state='context' AND w.expires_at>?))))",
        tenant,
        id,
        deps.now ?? Date.now(),
        deps.now ?? Date.now(),
      )
      .first();
    const active =
      enabled(gates) &&
      current?.status === "active" &&
      current.credential_version === data.attempt.credential_version &&
      activeSource?.status === "active" &&
      Boolean(liveLease) &&
      Boolean(currentSource) &&
      Boolean(
        await store.private(
          tenant,
          data.attempt.destination,
          data.attempt.credential_version,
          "credential",
        ),
      );
    if (active) mutationStarted = true;
    return active;
  };
  try {
    const evidence = await adapter.identityEvidence?.(data.payload);
    if (
      !(await store.claimAttempt(
        tenant,
        id,
        lease,
        now,
        evidence,
        adapter.reservationId?.(data.payload),
      ))
    )
      return { state: "skipped", reason: "attempt_not_claimable" };
    const result = await adapter.dispatch({
      store,
      tenant,
      id,
      data,
      lease,
      gates,
      deps,
      beforeWrite,
      hasStarted: () => mutationStarted,
    });
    if (result.state === "retry_scheduled") return result;
    const remoteId = result.remoteId ?? null;
    await store.resolve(
      tenant,
      id,
      lease,
      result.state,
      remoteId,
      deps.now ?? Date.now(),
      evidence,
      result.reason,
    );
    await adapter.afterResolved?.(
      { store, tenant, data, deps },
      result.state,
      remoteId,
    );
    return {
      state: result.state,
      attemptId: id,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  } catch (error) {
    if (!(error instanceof VendorDeferredError)) throw error;
    // Admission can deny a request after authorization but before transport.
    if (!mutationStarted || !error.requestSent) {
      await store.retryUnsent(
        tenant,
        id,
        lease,
        "vendor_request_deferred",
        deps.now ?? Date.now(),
        error.retryAt,
      );
      return {
        state: "retry_scheduled",
        attemptId: id,
        reason: "vendor_request_deferred",
      };
    }
    await store.resolve(
      tenant,
      id,
      lease,
      "uncertain",
      null,
      deps.now ?? Date.now(),
      await adapter.identityEvidence?.(data.payload),
    );
    return { state: "uncertain", attemptId: id };
  } finally {
    await store.release(lease);
  }
}

export async function reconcileAttempt(
  store: Store,
  tenant: string,
  id: string,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  const now = deps.now ?? Date.now();
  const data = await attemptData(store, tenant, id);
  if (!data)
    return {
      state: "unresolved",
      reason: "artifact_expired_or_connection_disabled",
    };
  const adapter = deliveryAdapters[data.payload.kind];
  const lease = await store.claim(
    tenant,
    `reconcile:${data.attempt.destination}`,
    now,
    120000,
  );
  if (!lease) return { state: "skipped", reason: "reconciliation_lease_busy" };
  try {
    const result = await adapter.observe({ store, tenant, data, deps });
    if (result.state !== "observed") return result;
    const applied = await store.resolveReconciled(
      tenant,
      id,
      lease,
      result.remoteId,
      deps.now ?? Date.now(),
      result.observation,
    );
    if (applied)
      await adapter.afterResolved?.(
        { store, tenant, data, deps },
        "observed",
        result.remoteId,
      );
    return {
      state: applied ? "observed" : "unresolved",
      reason: applied ? undefined : "reconciliation_state_or_lease_changed",
    };
  } finally {
    await store.release(lease);
  }
}
