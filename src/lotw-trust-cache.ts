import forge from "node-forge";
import {
  downloadLotwTrustRoots,
  normalizeLotwTrustRoots,
} from "./lotw-root-download.ts";
import { lotwTrustRoots } from "./lotw-trust.ts";
import { randomToken } from "./security.ts";
import type { Connection, Store } from "./store.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

const DAY = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF = 60 * 60 * 1000;
const FORCED_INTERVAL = 5 * 60 * 1000;
const LEASE_TTL = 60_000;

type RefreshStatus =
  | "updated"
  | "cached"
  | "unavailable"
  | "deferred"
  | "unconfigured";

interface TrustCache {
  roots_json: string;
  last_success_at: number | null;
  last_attempt_at: number | null;
  next_attempt_at: number;
  last_status: RefreshStatus;
}

interface Credentials {
  username: string;
  password: string;
}

/** Bundled legacy anchors need not be self-signed; downloaded roots must be. */
function unionRoots(bundled: string[], downloaded: string[]): string[] {
  const unique = new Map<string, string>();
  for (const pem of [...bundled, ...downloaded]) {
    const certificate = forge.pki.certificateFromPem(pem);
    const der = forge.asn1
      .toDer(forge.pki.certificateToAsn1(certificate))
      .getBytes();
    unique.set(
      der,
      forge.pki.certificateToPem(certificate).replaceAll("\r\n", "\n"),
    );
  }
  if (unique.size > 8) throw new Error("LoTW trust root limit exceeded");
  return [...unique.values()];
}

async function cachedRoots(value: string): Promise<string[]> {
  try {
    if (value.length > 8 * 16_384) return [];
    const roots: unknown = JSON.parse(value);
    if (
      !Array.isArray(roots) ||
      roots.length > 8 ||
      roots.some((root) => typeof root !== "string")
    )
      return [];
    return await normalizeLotwTrustRoots(roots as string[]);
  } catch {
    return [];
  }
}

/** Explicit deployment overrides never read this cache or discover new roots. */
export async function effectiveLotwTrustRoots(
  store: Store,
  policy: string,
): Promise<string[]> {
  const bundled = lotwTrustRoots(policy);
  if (policy !== "bundled") return bundled;
  try {
    const row = await store
      .statement("SELECT roots_json FROM lotw_trust_cache WHERE id='arrl'")
      .first<{ roots_json: string }>();
    return row
      ? unionRoots(bundled, await cachedRoots(row.roots_json))
      : bundled;
  } catch {
    // A bad cache or temporary storage failure does not erase release anchors.
    return bundled;
  }
}

async function savedCredentials(
  store: Store,
  token: string,
  now: number,
): Promise<Credentials | undefined> {
  const source = await store
    .statement(
      "SELECT c.* FROM connections c JOIN private_data p ON p.tenant=c.tenant AND p.connection=c.id AND p.id=c.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) WHERE c.kind='lotw' AND c.status IN('active','needs_verification') AND json_extract(c.config,'$.readAccess')=1 AND COALESCE(json_extract(c.config,'$.loginVerification.status'),'')!='rejected' ORDER BY COALESCE(json_extract(c.config,'$.trustSourceAttemptedAt'),0),c.tenant,c.id LIMIT 1",
      now,
    )
    .first<Connection>();
  if (!source?.credential_version) return;
  const marked = await store
    .statement(
      "UPDATE connections SET config=json_set(config,'$.trustSourceAttemptedAt',?) WHERE tenant=? AND id=? AND kind='lotw' AND credential_version=? AND status IN('active','needs_verification') AND json_extract(config,'$.readAccess')=1 AND COALESCE(json_extract(config,'$.loginVerification.status'),'')!='rejected' AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=connections.tenant AND p.connection=connections.id AND p.id=connections.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)) AND EXISTS(SELECT 1 FROM lotw_trust_cache WHERE id='arrl' AND lease_token=? AND lease_until>?)",
      now,
      source.tenant,
      source.id,
      source.credential_version,
      now,
      token,
      now,
    )
    .run();
  if (marked.meta.changes !== 1) return;
  const credential = await store.private<{ query?: Credentials }>(
    source.tenant,
    source.id,
    source.credential_version,
    "credential",
  );
  const query = credential?.query;
  if (
    !query ||
    typeof query.username !== "string" ||
    typeof query.password !== "string"
  )
    return;
  const current = await store
    .statement(
      "SELECT 1 n FROM connections c JOIN private_data p ON p.tenant=c.tenant AND p.connection=c.id AND p.id=c.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) WHERE c.tenant=? AND c.id=? AND c.credential_version=? AND c.kind='lotw' AND c.status IN('active','needs_verification') AND json_extract(c.config,'$.readAccess')=1 AND COALESCE(json_extract(c.config,'$.loginVerification.status'),'')!='rejected' AND EXISTS(SELECT 1 FROM lotw_trust_cache WHERE id='arrl' AND lease_token=? AND lease_until>?)",
      now,
      source.tenant,
      source.id,
      source.credential_version,
      token,
      now,
    )
    .first();
  return current ? query : undefined;
}

/** Discover only ARRL HTTPS roots; uploaded certificates never reach this path. */
export async function refreshLotwTrustRoots(
  store: Store,
  policy: string,
  options: {
    credentials?: Credentials;
    fetcher?: typeof fetch;
    now?: number;
    force?: boolean;
  } = {},
): Promise<{ roots: string[]; status: RefreshStatus }> {
  const configured = lotwTrustRoots(policy);
  if (policy !== "bundled")
    return {
      roots: configured,
      status: configured.length ? "cached" : "unconfigured",
    };
  const fallback = await effectiveLotwTrustRoots(store, policy);
  const now = options.now ?? Date.now();
  const token = randomToken();
  let lease: TrustCache | null;
  try {
    lease = await store
      .statement(
        "INSERT INTO lotw_trust_cache(id,last_attempt_at,next_attempt_at,lease_token,lease_until) VALUES('arrl',?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,next_attempt_at=MAX(lotw_trust_cache.next_attempt_at,excluded.next_attempt_at),lease_token=excluded.lease_token,lease_until=excluded.lease_until WHERE lotw_trust_cache.lease_until<=? AND ((?=0 AND lotw_trust_cache.next_attempt_at<=?) OR (?=1 AND (lotw_trust_cache.last_attempt_at IS NULL OR lotw_trust_cache.last_attempt_at<=?) AND (lotw_trust_cache.last_status NOT IN('unavailable','deferred') OR lotw_trust_cache.next_attempt_at<=?))) RETURNING roots_json,last_success_at,last_attempt_at,next_attempt_at,last_status",
        now,
        now + FORCED_INTERVAL,
        token,
        now + LEASE_TTL,
        now,
        options.force ? 1 : 0,
        now,
        options.force ? 1 : 0,
        now - FORCED_INTERVAL,
        now,
      )
      .first<TrustCache>();
  } catch {
    return { roots: fallback, status: "unavailable" };
  }
  if (!lease) return { roots: fallback, status: "cached" };
  try {
    const credentials =
      options.credentials ?? (await savedCredentials(store, token, now));
    if (!credentials) {
      const finishedAt = options.now ?? Date.now();
      await store
        .statement(
          "UPDATE lotw_trust_cache SET last_status='unconfigured',last_attempt_at=NULL,next_attempt_at=0,lease_token=NULL,lease_until=0 WHERE id='arrl' AND lease_token=? AND lease_until>?",
          token,
          finishedAt,
        )
        .run();
      return { roots: fallback, status: "unconfigured" };
    }
    const downloaded = await downloadLotwTrustRoots(
      credentials,
      vendorFetch(store, "lotw", options.fetcher, {
        priority: "background",
        ...(options.now === undefined ? {} : { now }),
      }),
    );
    if (!downloaded.length) throw new Error("No downloaded LoTW roots");
    const retained = await cachedRoots(lease.roots_json);
    const roots = await normalizeLotwTrustRoots(
      unionRoots([], [...retained, ...downloaded]),
    );
    // No automatic eviction: a per-account download is not a removal manifest.
    const effective = unionRoots(configured, roots);
    const finishedAt = options.now ?? Date.now();
    const updated = await store
      .statement(
        "UPDATE lotw_trust_cache SET roots_json=?,last_success_at=?,next_attempt_at=?,last_status='updated',lease_token=NULL,lease_until=0 WHERE id='arrl' AND lease_token=? AND lease_until>?",
        JSON.stringify(roots),
        finishedAt,
        finishedAt + DAY,
        token,
        finishedAt,
      )
      .run();
    return {
      roots: updated.meta.changes === 1 ? effective : fallback,
      status: updated.meta.changes === 1 ? "updated" : "cached",
    };
  } catch (error) {
    const finishedAt = options.now ?? Date.now();
    const deferred = error instanceof VendorDeferredError;
    const status = deferred ? "deferred" : "unavailable";
    try {
      await store
        .statement(
          "UPDATE lotw_trust_cache SET last_status=?,next_attempt_at=?,lease_token=NULL,lease_until=0 WHERE id='arrl' AND lease_token=? AND lease_until>?",
          status,
          Math.max(finishedAt + FAILURE_BACKOFF, deferred ? error.retryAt : 0),
          token,
          finishedAt,
        )
        .run();
    } catch {
      // The last known good roots remain usable if storage is unavailable.
    }
    return {
      roots: fallback,
      status,
    };
  } finally {
    try {
      await store
        .statement(
          "UPDATE lotw_trust_cache SET lease_token=NULL,lease_until=0 WHERE id='arrl' AND lease_token=?",
          token,
        )
        .run();
    } catch {
      // A failed release leaves the bounded lease and retry gate in place.
    }
  }
}
