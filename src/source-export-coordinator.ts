import { type IntakeContact, observeContacts, pollSource } from "./intake.ts";
import { canonical } from "./security.ts";
import { openSourceCredentials } from "./source-credentials.ts";
import {
  loadSourceExportSnapshots,
  mintSourceExportProofs,
} from "./source-export-proofs.ts";
import { sourcePresenceAnchors } from "./source-presence-anchors.ts";
import {
  collectSourcePresence,
  type SourcePresenceHold,
} from "./source-presence-collector.ts";
import {
  loadSourcePresence,
  type SourcePresenceScope,
  type SourcePresenceTarget,
} from "./source-presence-store.ts";
import type { Connection, Lease, Store } from "./store.ts";
import {
  VendorDeferredError,
  type VendorPriority,
  vendorFetch,
} from "./vendor-requests.ts";

type Hold =
  | SourcePresenceHold
  | "source_unavailable"
  | "drain_incomplete"
  | "source_changed"
  | "proof_unavailable";
export interface SourceExportCohortResult {
  ready: { contact: IntakeContact; proofId: string; expiresAt: number }[];
  held: Hold | null;
  actualAttempts: number;
  remainingRequests: number;
  retryAt?: number;
  sourceBoundaryVerified: false;
  writesAuthorized: false;
}

class CohortHeld extends Error {
  constructor(readonly reason: Hold) {
    super(reason);
  }
}

/**
 * Unused until normal delivery integrates immutable proof IDs. One source cohort
 * shares collection and the final drain across all its destination projections.
 * The supplied transport must be raw: this function and pollSource each reserve
 * their own ordinary vendor budget exactly once. No vendor mutation is made.
 */
export async function ensureSourceExportProofs(
  store: Store,
  scope: SourcePresenceScope,
  qsos: readonly string[],
  cycleLease: Lease,
  options: {
    rawFetcher: typeof fetch;
    now?: () => number;
    deadline: number;
    remainingRequests: number;
    priority?: VendorPriority;
    /** The caller's ordinary unique-per-vendor route selection. */
    routedDestinations: (contact: IntakeContact) => readonly Connection[];
  },
): Promise<SourceExportCohortResult> {
  const clock = options.now ?? Date.now;
  const startedAt = clock();
  const deadline = Math.min(
    options.deadline,
    startedAt + 120_000,
    cycleLease.expires_at,
  );
  let lastTime = startedAt;
  let attempts = 0;
  let retryAt: number | undefined;
  let transportHold: Hold | undefined;
  const result = (
    held: Hold | null,
    ready: SourceExportCohortResult["ready"] = [],
  ): SourceExportCohortResult => ({
    ready,
    held,
    actualAttempts: attempts,
    remainingRequests: Math.max(0, options.remainingRequests - attempts),
    ...(retryAt === undefined ? {} : { retryAt }),
    sourceBoundaryVerified: false,
    writesAuthorized: false,
  });
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (
    !integer(startedAt) ||
    !integer(options.deadline) ||
    !integer(cycleLease.expires_at) ||
    deadline <= startedAt ||
    !Number.isSafeInteger(options.remainingRequests) ||
    options.remainingRequests < 1 ||
    options.remainingRequests > 4 ||
    qsos.length < 1 ||
    qsos.length > 20 ||
    new Set(qsos).size !== qsos.length ||
    qsos.some((id) => typeof id !== "string" || !id) ||
    cycleLease.tenant !== scope.tenant ||
    cycleLease.scope !== `cycle:${scope.source}`
  )
    return result("invalid_input");
  const time = () => {
    const at = clock();
    if (!integer(at) || at < lastTime || at >= deadline)
      throw new CohortHeld("deadline");
    lastTime = at;
    return at;
  };
  const currentScope = async (): Promise<SourcePresenceScope | null> => {
    const at = time();
    const current = await store
      .statement(
        `SELECT 1 AS current FROM source_read_policy_ready r
       JOIN source_read_policies p ON p.tenant=r.tenant AND p.source=r.source
       JOIN connections c ON c.tenant=r.tenant AND c.id=r.source
       JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
       JOIN leases lease ON lease.tenant=c.tenant AND lease.scope=?7 AND lease.token=?8 AND lease.fence=?9 AND lease.expires_at>?10
       WHERE r.tenant=?1 AND r.source=?2 AND r.epoch=?3 AND p.reader_policy=?4 AND p.account_id=?5
        AND c.credential_version=?6 AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>?10)`,
        scope.tenant,
        scope.source,
        scope.policyEpoch,
        scope.readerPolicy,
        scope.accountId,
        scope.credentialVersion,
        cycleLease.scope,
        cycleLease.token,
        cycleLease.fence,
        at,
      )
      .first();
    time();
    return current ? { ...scope } : null;
  };
  const transport: typeof fetch = async (url, init) => {
    const at = time();
    if (attempts >= options.remainingRequests) {
      transportHold = "request_budget";
      throw new CohortHeld("request_budget");
    }
    if (
      (url !== "https://lofi.ham2k.net/v1/sync" &&
        url !== "https://lofi.ham2k.net/v1/client") ||
      init?.method !== "POST" ||
      init.redirect !== "manual"
    )
      throw new CohortHeld("invalid_input");
    if (!(await currentScope())) throw new CohortHeld("scope_changed");
    const request = {
      ...init,
      signal: AbortSignal.any([
        ...(init.signal ? [init.signal] : []),
        AbortSignal.timeout(deadline - Math.max(at, time())),
      ]),
    };
    attempts++;
    return options.rawFetcher(url, request);
  };
  try {
    if (!(await currentScope())) return result("source_unavailable");
    const before = await loadSourceExportSnapshots(store, scope, qsos, time());
    if (before.length !== qsos.length) return result("source_unavailable");
    const targets = new Map<string, SourcePresenceTarget>();
    for (const snapshot of before)
      for (const target of snapshot.targets) {
        const key = canonical([target.kind, target.id]);
        const prior = targets.get(key);
        if (prior && canonical(prior) !== canonical(target))
          return result("source_changed");
        targets.set(key, target);
      }
    if (targets.size > 64) return result("invalid_input");
    const allTargets = [...targets.values()];
    const cached = await loadSourcePresence(store, scope, allTargets, time());
    const anchors = await sourcePresenceAnchors(
      store,
      scope,
      allTargets,
      time(),
    );
    const session = await openSourceCredentials(store, before[0].source);
    const collected = await collectSourcePresence(
      {
        scope,
        credentials: session.credentials,
        targets: allTargets,
        selectedContacts: qsos,
        cachedWitnesses: cached.filter((value) => value !== null),
        observedAnchors: anchors,
        remainingRequests: options.remainingRequests - attempts,
        collectionStartedAt: startedAt,
        collectionDeadline: deadline,
      },
      {
        fetcher: vendorFetch(store, "lofi", transport, {
          priority: options.priority ?? "background",
        }),
        currentScope,
        now: time,
      },
    );
    await session.persistRenewal(collected.credentials);
    if (collected.retryAt !== undefined) retryAt = collected.retryAt;
    if (collected.status !== "observed")
      return result(transportHold ?? collected.reason ?? "read_failed");
    const collectionFinishedAt = time();
    // This shared canonical read includes newly arrived/previously unknown
    // events. A terminal page that started from a continuation cannot qualify.
    const drained = await pollSource(
      store,
      before[0].source,
      transport,
      time(),
      "sync",
      null,
    );
    if (!drained.complete) return result("drain_incomplete");
    const after = await loadSourceExportSnapshots(store, scope, qsos, time());
    if (
      after.length !== qsos.length ||
      after.some(
        (snapshot) =>
          snapshot.completeReadStartedAt === null ||
          snapshot.completeReadStartedAt < collectionFinishedAt,
      )
    )
      return result("drain_incomplete");
    for (const snapshot of after) {
      if (
        snapshot.targets.some(
          (target) =>
            !collected.witnesses.some(
              (witness) =>
                canonical(witness.scope) === canonical(scope) &&
                canonical(witness.target) === canonical(target),
            ),
        )
      )
        return result("source_changed");
      const original = before.find(
        (item) => item.contact.id === snapshot.contact.id,
      );
      if (!original) return result("source_changed");
      const keys = (values: readonly SourcePresenceTarget[]) =>
        canonical(values.map((value) => canonical(value)).sort());
      if (keys(original.targets) !== keys(snapshot.targets))
        return result("source_changed");
    }
    // Refresh the normal ledger projection after the final drain. Proof creation
    // fences this exact ledger, dependency set and lease in one transaction.
    const observed = await observeContacts(
      store,
      after[0].source,
      after.map(({ contact }) => ({
        contact,
        routedDestinations: options.routedDestinations(contact),
      })),
      time(),
    );
    if (observed.some((item) => item.status === "rejected"))
      return result("source_changed");
    const proofs = await mintSourceExportProofs(
      store,
      after.map((snapshot) => ({
        snapshot,
        witnesses: collected.witnesses,
        collectionFinishedAt,
      })),
      cycleLease,
      time(),
    );
    time();
    const ready: SourceExportCohortResult["ready"] = [];
    for (const proof of proofs) {
      const snapshot = after.find((item) => item.contact.id === proof.qso);
      if (!snapshot) return result("proof_unavailable");
      ready.push({
        contact: snapshot.contact,
        proofId: proof.id,
        expiresAt: proof.expiresAt,
      });
    }
    return result(null, ready);
  } catch (error) {
    if (error instanceof VendorDeferredError) {
      retryAt = error.retryAt;
      return result("vendor_deferred");
    }
    return result(
      error instanceof CohortHeld ? error.reason : "proof_unavailable",
    );
  }
}
