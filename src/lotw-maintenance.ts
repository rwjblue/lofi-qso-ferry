import { LotwClient } from "./lotw.ts";
import { lotwTrustRoots } from "./lotw-trust.ts";
import {
  type CertificateStatus,
  type SigningCredential,
  verifySigningCredentialTrust,
} from "./signing.ts";
import type { Connection, Store } from "./store.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

const STATUS_TTL = 12 * 60 * 60 * 1000;
const UNKNOWN_TTL = 5 * 60 * 1000;

interface PublicCertificate {
  callsign: string;
  dxcc: number;
  serial: string;
  validFrom: string;
  validTo: string;
  qsoFrom: string;
  qsoTo: string | null;
  trusted: boolean;
  trustCheckedAt: string;
  status: CertificateStatus;
  statusCheckedAt: string | null;
}

function checkedTime(value: unknown, now: number): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now ? time : null;
}

/** Refresh only public evidence. Keys and credential versions remain unchanged. */
export async function refreshLotwCertificates(
  store: Store,
  trustRootsJson: string,
  options: { fetcher?: typeof fetch; now?: number; limit?: number } = {},
) {
  const roots = lotwTrustRoots(trustRootsJson);
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(20, options.limit ?? 20));
  const connections = (
    await store
      .statement(
        "SELECT c.* FROM connections c JOIN private_data p ON p.tenant=c.tenant AND p.connection=c.id AND p.id=c.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) WHERE c.kind='lotw' AND c.status IN('active','needs_verification','disabled','paused') ORDER BY COALESCE(json_extract(c.config,'$.trustCheckedAt'),0),c.tenant,c.id LIMIT ?",
        now,
        limit,
      )
      .all<Connection>()
  ).results;
  const result = { checked: 0, updated: 0, errors: 0, deferred: 0 };
  let statusRequests = 2;
  const client = new LotwClient(null, {
    fetcher: vendorFetch(store, "lotw", options.fetcher, {
      priority: "background",
      ...(options.now === undefined ? {} : { now }),
    }),
  });
  for (const connection of connections) {
    const version = connection.credential_version;
    if (!version) continue;
    const lease = await store.claim(
      connection.tenant,
      `lotw-certificates:${connection.id}`,
      now,
      60_000,
    );
    if (!lease) continue;
    try {
      const credential = await store.private<{
        signingCredentials?: SigningCredential[];
        signing?: SigningCredential;
      }>(connection.tenant, connection.id, version, "credential");
      if (!credential) continue;
      const signing =
        credential.signingCredentials ??
        (credential.signing ? [credential.signing] : []);
      if (!Array.isArray(signing) || signing.length > 8)
        throw new Error("Invalid saved certificate list");
      const config = JSON.parse(connection.config) as {
        certificates?: PublicCertificate[];
      };
      const certificates: PublicCertificate[] = [];
      for (const certificate of signing) {
        const previous = config.certificates?.find(
          (item) =>
            item.serial === certificate.serial &&
            item.callsign === certificate.callsign &&
            item.dxcc === certificate.dxcc,
        );
        const previousTime = checkedTime(previous?.statusCheckedAt, now);
        const originalTime = checkedTime(certificate.statusCheckedAt, now);
        const cached =
          previous &&
          previousTime !== null &&
          (originalTime === null || previousTime >= originalTime)
            ? previous
            : certificate;
        let status = cached.status;
        let statusCheckedAt = cached.statusCheckedAt;
        const statusTime = checkedTime(statusCheckedAt, now);
        if (
          statusRequests > 0 &&
          (statusTime === null ||
            now - statusTime >=
              (status === "unknown" ? UNKNOWN_TTL : STATUS_TTL))
        ) {
          statusRequests--;
          try {
            const current = await client.certificateStatus(certificate.serial);
            // A transport failure must not erase an authoritative revocation.
            if (
              current !== "unknown" ||
              (status !== "revoked" && status !== "superseded")
            ) {
              status = current;
              statusCheckedAt = new Date(now).toISOString();
            }
          } catch (error) {
            if (!(error instanceof VendorDeferredError)) throw error;
            result.deferred++;
            statusRequests = 0;
          }
        }
        certificates.push({
          callsign: certificate.callsign,
          dxcc: certificate.dxcc,
          serial: certificate.serial,
          validFrom: certificate.validFrom,
          validTo: certificate.validTo,
          qsoFrom: certificate.qsoFrom,
          qsoTo: certificate.qsoTo,
          trusted: await verifySigningCredentialTrust(
            certificate,
            roots,
            new Date(now),
          ),
          trustCheckedAt: new Date(now).toISOString(),
          status,
          statusCheckedAt,
        });
      }
      result.checked++;
      const commitTime = options.now ?? Date.now();
      const valid =
        certificates.length > 0 &&
        certificates.every((certificate) => {
          const statusTime = checkedTime(
            certificate.statusCheckedAt,
            commitTime,
          );
          return (
            certificate.trusted &&
            Date.parse(certificate.validFrom) <= commitTime &&
            Date.parse(certificate.validTo) > commitTime &&
            certificate.status === "unrevoked" &&
            statusTime !== null &&
            commitTime - statusTime < 24 * 60 * 60 * 1000
          );
        });
      const updated = await store
        .statement(
          "UPDATE connections SET config=json_set(config,'$.certificates',json(?),'$.trustCheckedAt',?),status=CASE WHEN status IN('disabled','paused') THEN status WHEN ?=1 AND COALESCE(json_extract(config,'$.loginVerification.status'),'')!='rejected' THEN 'active' ELSE 'needs_verification' END WHERE tenant=? AND id=? AND kind='lotw' AND status IN('active','needs_verification','disabled','paused') AND credential_version=? AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=connections.tenant AND p.connection=connections.id AND p.id=connections.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)) AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?)",
          JSON.stringify(certificates),
          commitTime,
          valid ? 1 : 0,
          connection.tenant,
          connection.id,
          version,
          commitTime,
          lease.tenant,
          lease.scope,
          lease.token,
          lease.fence,
          commitTime,
        )
        .run();
      result.updated += updated.meta.changes;
    } catch {
      result.errors++;
      const failedAt = options.now ?? Date.now();
      await store
        .statement(
          "UPDATE connections SET config=json_set(config,'$.trustCheckedAt',?),status=CASE WHEN status IN('disabled','paused') THEN status ELSE 'needs_verification' END WHERE tenant=? AND id=? AND credential_version=? AND status IN('active','needs_verification','disabled','paused') AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=connections.tenant AND p.connection=connections.id AND p.id=connections.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)) AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?)",
          now,
          connection.tenant,
          connection.id,
          version,
          failedAt,
          lease.tenant,
          lease.scope,
          lease.token,
          lease.fence,
          failedAt,
        )
        .run();
    } finally {
      await store.release(lease);
    }
  }
  return result;
}
