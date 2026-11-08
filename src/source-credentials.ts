import type { LoFiCredentials } from "./lofi.ts";
import { type Envelope, open, seal } from "./security.ts";
import type { Connection, Store } from "./store.ts";

export interface SourceCredentialsSession {
  credentials: LoFiCredentials;
  /** Only a same-client bearer renewal may update the originally opened row. */
  persistRenewal(renewed: LoFiCredentials): Promise<void>;
  /** Persist a client snapshot, including a bearer cleared after HTTP 401. */
  persistTokenState(snapshot: LoFiCredentials): Promise<void>;
}

/**
 * Open the retained source credential and preserve its exact envelope CAS.
 * Callers still validate current source scope before reads/checkpoints. The
 * private-data clock is always real time, independent from simulated poll time.
 */
export async function openSourceCredentials(
  store: Store,
  connection: Connection,
): Promise<SourceCredentialsSession> {
  if (!connection.credential_version || connection.status !== "active")
    throw new Error("source_connection_unavailable");
  const identity = {
    tenant: connection.tenant,
    connection: connection.id,
    id: connection.credential_version,
    kind: "credential",
    purpose: "storage",
  };
  const remoteIdentity = connection.remote_identity;
  const saved = await store
    .statement(
      "SELECT envelope FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='credential' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",
      identity.tenant,
      identity.connection,
      identity.id,
      Date.now(),
    )
    .first<{ envelope: string }>();
  if (!saved) throw new Error("source_connection_unavailable");
  const originalEnvelope = saved.envelope;
  const credentials = await open<LoFiCredentials>(
    JSON.parse(saved.envelope) as Envelope,
    identity,
    store.keys,
  );
  async function persist(renewed: LoFiCredentials, allowRemoval: boolean) {
    // LoFiClient preserves these fields; enforce that invariant for the new
    // shared API rather than permitting accidental credential replacement.
    if (
      renewed.key !== credentials.key ||
      renewed.secret !== credentials.secret
    )
      throw new Error("source_client_identity_changed");
    if (
      renewed.token === credentials.token ||
      (!renewed.token && !allowRemoval)
    )
      return;
    if (
      renewed.token !== undefined &&
      (typeof renewed.token !== "string" || !renewed.token)
    )
      throw new Error("source_bearer_invalid");
    const next = { ...credentials };
    if (renewed.token) next.token = renewed.token;
    else delete next.token;
    const envelope = await seal(next, identity, store.keys);
    // A concurrent renewal, credential replacement, account change, expiry or
    // revocation wins. Never overwrite a newer envelope or change its identity.
    await store
      .statement(
        "UPDATE private_data SET envelope=? WHERE tenant=? AND connection=? AND id=? AND kind='credential' AND envelope=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND EXISTS(SELECT 1 FROM connections c WHERE c.tenant=private_data.tenant AND c.id=private_data.connection AND c.kind='lofi' AND c.status='active' AND c.credential_version=private_data.id AND c.remote_identity=?)",
        JSON.stringify(envelope),
        identity.tenant,
        identity.connection,
        identity.id,
        originalEnvelope,
        Date.now(),
        remoteIdentity,
      )
      .run();
  }
  return {
    credentials: { ...credentials },
    persistRenewal: (renewed) => persist(renewed, false),
    persistTokenState: (snapshot) => persist(snapshot, true),
  };
}
