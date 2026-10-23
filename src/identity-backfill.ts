import { bindLegacyQrzIdentity } from "./identity-claims.ts";
import { QrzClient, QrzError } from "./qrz.ts";
import type { LedgerKey, Lease, Store } from "./store.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

const RETRY_MS = 5 * 60_000;
interface LegacyReservation extends LedgerKey {
  remote_id: string;
  generation: string;
  credential_version: string;
  remote_identity: string;
  config: string;
}
export interface IdentityBackfillResult {
  checked: number;
  bound: number;
  retained: number;
  errors: number;
  deferred: number;
}

/** One exact mapped-record read per invocation; never infer from edited source. */
export async function backfillLegacyQrzIdentity(
  store: Store,
  options: {
    fetcher?: typeof fetch;
    now?: number;
    shouldContinue?: () => boolean;
    onFailure?: (error: unknown) => void;
  } = {},
): Promise<IdentityBackfillResult> {
  const currentTime = () => options.now ?? Date.now();
  const result = { checked: 0, bound: 0, retained: 0, errors: 0, deferred: 0 };
  let lease: Lease | null = null;
  const failed = (error: unknown) => {
    if (error instanceof VendorDeferredError) result.deferred++;
    else result.errors++;
    try {
      options.onFailure?.(error);
    } catch {
      // Diagnostics must not abort maintenance or expose a vendor error.
    }
  };
  try {
    if (options.shouldContinue?.() === false) return result;
    const now = currentTime();
    const reservation = await store
      .statement(
        `SELECT r.tenant,r.destination,r.source,r.qso,r.remote_id,l.generation,d.credential_version,d.remote_identity,d.config FROM legacy_qrz_identity_reservations r INDEXED BY legacy_qrz_identity_due JOIN ledger l ON l.tenant=r.tenant AND l.destination=r.destination AND l.source=r.source AND l.qso=r.qso AND l.remote_id=r.remote_id JOIN connections d ON d.tenant=r.tenant AND d.id=r.destination JOIN accounts a ON a.id=r.tenant JOIN private_data p ON p.tenant=d.tenant AND p.connection=d.id AND p.id=d.credential_version AND p.kind='credential' WHERE r.next_check_at<=? AND d.kind='qrz' AND d.status='active' AND a.status='active' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) ORDER BY r.next_check_at,r.checked_at LIMIT 1`,
        now,
        now,
      )
      .first<LegacyReservation>();
    if (!reservation || options.shouldContinue?.() === false) return result;
    lease = await store.claim(
      reservation.tenant,
      `qrz-identity-backfill:${reservation.destination}`,
      currentTime(),
      RETRY_MS,
    );
    if (!lease) return result;
    const checkedAt = currentTime();
    const claimed = await store
      .statement(
        `UPDATE legacy_qrz_identity_reservations SET checked_at=?,next_check_at=? WHERE tenant=? AND destination=? AND source=? AND qso=? AND remote_id=? AND next_check_at<=? AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?) AND EXISTS(SELECT 1 FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination JOIN accounts a ON a.id=l.tenant WHERE l.tenant=? AND l.destination=? AND l.source=? AND l.qso=? AND l.remote_id=? AND l.generation=? AND d.kind='qrz' AND d.status='active' AND d.credential_version=? AND d.config=? AND a.status='active') RETURNING qso`,
        checkedAt,
        checkedAt + RETRY_MS,
        reservation.tenant,
        reservation.destination,
        reservation.source,
        reservation.qso,
        reservation.remote_id,
        checkedAt,
        lease.tenant,
        lease.scope,
        lease.token,
        lease.fence,
        checkedAt,
        reservation.tenant,
        reservation.destination,
        reservation.source,
        reservation.qso,
        reservation.remote_id,
        reservation.generation,
        reservation.credential_version,
        reservation.config,
      )
      .all();
    if (claimed.results.length !== 1) return result;
    result.checked = 1;
    if (options.shouldContinue?.() === false) return result;
    const credential = await store.private<{ apiKey?: unknown }>(
      reservation.tenant,
      reservation.destination,
      reservation.credential_version,
      "credential",
    );
    if (typeof credential?.apiKey !== "string" || !credential.apiKey)
      throw new QrzError("blocked", "Legacy QRZ credentials are unavailable");
    const config = JSON.parse(reservation.config) as {
      stationCallsign?: unknown;
    };
    if (typeof config.stationCallsign !== "string" || !config.stationCallsign)
      throw new QrzError("blocked", "Legacy QRZ book identity is unavailable");
    if (options.shouldContinue?.() === false) return result;
    const remote = await new QrzClient(credential.apiKey, {
      fetch: vendorFetch(store, "qrz", options.fetcher, {
        priority: "background",
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      writesEnabled: false,
    }).fetchLogId(reservation.remote_id);
    if (!remote) return result;
    if (
      remote.APP_QRZLOG_LOGID !== reservation.remote_id ||
      remote.STATION_CALLSIGN?.toUpperCase() !==
        config.stationCallsign.toUpperCase()
    )
      throw new QrzError("protocol", "Legacy QRZ mapped record scope changed");
    const bound = await bindLegacyQrzIdentity(
      store,
      reservation,
      remote,
      reservation.generation,
      reservation.credential_version,
      currentTime(),
      {
        sql: "EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?) AND EXISTS(SELECT 1 FROM connections WHERE tenant=? AND id=? AND config=? AND remote_identity=?)",
        params: [
          lease.tenant,
          lease.scope,
          lease.token,
          lease.fence,
          currentTime(),
          reservation.tenant,
          reservation.destination,
          reservation.config,
          reservation.remote_identity,
        ],
      },
    );
    if (bound) result.bound = 1;
  } catch (error) {
    failed(error);
  } finally {
    result.retained = result.checked - result.bound;
    if (lease)
      try {
        await store.release(lease);
      } catch (error) {
        failed(error);
      }
  }
  return result;
}
