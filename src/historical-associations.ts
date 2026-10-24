import type { IdentityGuard } from "./identity-claims.ts";
import type { LedgerKey, Store } from "./store.ts";

export interface HistoricalAssociationIdentity {
  vendor: "qrz";
  bookIdentity: string;
  remoteId: string;
}

export function historicalQrzLogId(value: string): string {
  if (!value || value.length > 64 || /[^0-9]/.test(value))
    throw new Error("Invalid historical QRZ LOGID");
  return value.replace(/^0+(?=[0-9])/, "");
}

/** Availability is not evidence of a match; callers supply complete source and inventory proof. */
export function historicalAssociationAvailable(
  key: LedgerKey,
  remoteId: string,
  bookIdentity?: string,
): IdentityGuard {
  const id = historicalQrzLogId(remoteId);
  return {
    sql: `EXISTS(SELECT 1 FROM connections d WHERE d.tenant=? AND d.id=? AND d.kind='qrz' ${bookIdentity === undefined ? "" : "AND d.remote_identity=?"} AND NOT EXISTS(SELECT 1 FROM historical_remote_owners h WHERE h.tenant=d.tenant AND h.vendor='qrz' AND h.book_identity=d.remote_identity AND h.remote_id=? AND (h.source!=? OR h.qso!=?)))`,
    params: [
      key.tenant,
      key.destination,
      ...(bookIdentity === undefined ? [] : [bookIdentity]),
      id,
      key.source,
      key.qso,
    ],
  };
}

/** Compose AFTER the guarded ledger adoption in the same atomic batch. */
export function historicalAssociationStatements(
  store: Store,
  key: LedgerKey,
  identity: HistoricalAssociationIdentity,
  now: number,
  guard: IdentityGuard,
): D1PreparedStatement[] {
  const id = historicalQrzLogId(identity.remoteId);
  const available = historicalAssociationAvailable(
    key,
    id,
    identity.bookIdentity,
  );
  const params = [
    key.tenant,
    identity.vendor,
    identity.bookIdentity,
    id,
    key.source,
    key.qso,
    key.destination,
    now,
  ];
  return [
    store.statement(
      `INSERT INTO historical_remote_owners(tenant,vendor,book_identity,remote_id,source,qso,destination,created_at) SELECT ?,?,?,?,?,?,?,? WHERE (${guard.sql}) AND (${available.sql}) ON CONFLICT(tenant,vendor,book_identity,remote_id) DO NOTHING`,
      ...params,
      ...guard.params,
      ...available.params,
    ),
    store.statement(
      `INSERT INTO historical_associations(tenant,vendor,book_identity,remote_id,source,qso,destination,created_at) SELECT ?,?,?,?,?,?,?,? WHERE (${guard.sql}) AND (${available.sql}) ON CONFLICT(tenant,vendor,book_identity,remote_id) DO NOTHING`,
      ...params,
      ...guard.params,
      ...available.params,
    ),
  ];
}

/** A time-precision-independent reservation replaces only its exact legacy hold. */
export function clearHistoricalAssociationLegacyReservation(
  store: Store,
  key: LedgerKey,
  identity: HistoricalAssociationIdentity,
  guard: IdentityGuard,
): D1PreparedStatement {
  const id = historicalQrzLogId(identity.remoteId);
  return store.statement(
    `DELETE FROM legacy_qrz_identity_reservations WHERE tenant=? AND destination=? AND source=? AND qso=? AND remote_id=? AND (${guard.sql}) AND EXISTS(SELECT 1 FROM ledger l JOIN historical_associations h ON h.tenant=l.tenant AND h.source=l.source AND h.qso=l.qso AND h.destination=l.destination JOIN historical_remote_owners o ON o.tenant=h.tenant AND o.vendor=h.vendor AND o.book_identity=h.book_identity AND o.remote_id=h.remote_id AND o.source=h.source AND o.qso=h.qso JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=? AND l.remote_id=? AND l.state='adopted_existing' AND l.provenance='adopted' AND h.vendor='qrz' AND h.book_identity=? AND h.remote_id=? AND d.kind='qrz' AND d.remote_identity=h.book_identity)`,
    key.tenant,
    key.destination,
    key.source,
    key.qso,
    identity.remoteId,
    ...guard.params,
    key.tenant,
    key.source,
    key.qso,
    key.destination,
    identity.remoteId,
    identity.bookIdentity,
    id,
  );
}
