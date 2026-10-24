import type { LoFiCredentials } from "./lofi.ts";
import { type Envelope, open, seal } from "./security.ts";
import type { Connection, Store } from "./store.ts";

export interface SourceCredentialsSession {
  credentials: LoFiCredentials;
  /** Only a same-client bearer renewal may update the originally opened row. */
  persistRenewal(renewed: LoFiCredentials): Promise<void>;
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
  const credentials = await open<LoFiCredentials>(
    JSON.parse(saved.envelope) as Envelope,
    identity,
    store.keys,
  );
  return {
    credentials: { ...credentials },
    async persistRenewal(renewed) {
      // LoFiClient preserves these fields; enforce that invariant for the new
      // shared API rather than permitting accidental credential replacement.
      if (
        renewed.key !== credentials.key ||
        renewed.secret !== credentials.secret
      )
        throw new Error("source_client_identity_changed");
      if (!renewed.token || renewed.token === credentials.token) return;
      const envelope = await seal(
        { ...credentials, token: renewed.token },
        identity,
        store.keys,
      );
      // A concurrent renewal, credential replacement, account change, expiry or
      // revocation wins. Never overwrite a newer envelope or change its identity.
      await store
        .statement(
          "UPDATE private_data SET envelope=? WHERE tenant=? AND connection=? AND id=? AND kind='credential' AND envelope=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND EXISTS(SELECT 1 FROM connections c WHERE c.tenant=private_data.tenant AND c.id=private_data.connection AND c.kind='lofi' AND c.status='active' AND c.credential_version=private_data.id AND c.remote_identity=?)",
          JSON.stringify(envelope),
          identity.tenant,
          identity.connection,
          identity.id,
          saved.envelope,
          Date.now(),
          remoteIdentity,
        )
        .run();
    },
  };
}
