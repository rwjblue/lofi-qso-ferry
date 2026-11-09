import type { AdminOverview } from "./admin-types.ts";
import { deliveryGates } from "./delivery-gates.ts";
import { inventoryDashboardSummary } from "./inventory-dashboard.ts";
import { inventoryWriteStatus } from "./inventory-delivery-send.ts";
import { readInventoryRetentionPolicy } from "./inventory-retention-policy.ts";
import { lofiAccountLabel } from "./lofi-identity.ts";
import { VENDOR_POLICIES } from "./vendor-requests.ts";

export type { AdminOverview } from "./admin-types.ts";

const listLimit = 100;
function gatesSummary(env: Env): AdminOverview["gates"] {
  const base = {
    exportsEnabled: String(env.EXPORTS_ENABLED) === "true",
    rolloutChecksPassed: String(env.ROLLOUT_CHECKS_PASSED) === "true",
    liveWriteAuthorized:
      String(env.LIVE_WRITE_AUTHORIZATION) === "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    qrzFreshInsertsEnabled: String(env.QRZ_FRESH_INSERTS_ENABLED) === "true",
    lotwFreshInsertsEnabled: String(env.LOTW_FRESH_INSERTS_ENABLED) === "true",
  };
  try {
    const gates = deliveryGates(env);
    const writes = inventoryWriteStatus(env);
    const configured =
      gates.allowedQsoIds === null || (gates.allowedQsoIds?.length ?? 0) > 0;
    const destinationsConfigured =
      gates.allowedDestinationIds === null ||
      (gates.allowedDestinationIds?.length ?? 0) > 0;
    return {
      ...base,
      rolloutScopeConfigured: configured,
      rolloutScope:
        gates.allowedQsoIds === null ? "all" : configured ? "limited" : "none",
      destinationScopeConfigured: destinationsConfigured,
      destinationScope:
        gates.allowedDestinationIds === null
          ? "all"
          : destinationsConfigured
            ? "limited"
            : "none",
      effective: writes.exportsEnabled,
      exportMode: writes.exportMode,
      configurationValid: true,
    };
  } catch {
    return {
      ...base,
      rolloutScopeConfigured: false,
      rolloutScope: "none",
      destinationScopeConfigured: false,
      destinationScope: "none",
      effective: false,
      exportMode: null,
      configurationValid: false,
    };
  }
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Global operational metadata. The caller must authorize the administrator. */
export async function getAdminOverview(
  env: Env,
  now = Date.now(),
): Promise<AdminOverview> {
  const db = env.DB;
  const [providers, retention, results] = await Promise.all([
    inventoryDashboardSummary(db),
    readInventoryRetentionPolicy(db),
    db.batch([
      db.prepare(
        "SELECT vendor,window_start,requests,background_requests,cooldown_until FROM vendor_requests",
      ),
      db.prepare("SELECT COUNT(*) AS total FROM accounts"),
      db
        .prepare(
          `SELECT a.id,a.email,a.status,a.verified_at AS verifiedAt,
          (SELECT COUNT(*) FROM passkeys p WHERE p.tenant=a.id AND p.revoked_at IS NULL) AS passkeys,
          (SELECT COUNT(*) FROM connections c WHERE c.tenant=a.id) AS connections
         FROM accounts a ORDER BY a.verified_at DESC,a.id LIMIT ?`,
        )
        .bind(listLimit),
      db.prepare("SELECT COUNT(*) AS total FROM connections"),
      db
        .prepare(
          `WITH recent AS MATERIALIZED (
           SELECT c.* FROM connections c ORDER BY c.created_at DESC,c.tenant,c.id LIMIT ?
         )
         SELECT c.tenant,a.email AS accountEmail,c.id,c.kind,c.label,c.status,c.last_poll_at AS lastAttemptAt,
           json_extract(c.config,'$.accountEmail') AS lofiAccountEmail,
           json_extract(c.config,'$.lastSuccessfulPollAt') AS lastSuccessAt,
           json_extract(c.config,'$.lastSyncFailureAt') AS lastFailureAt,
           json_extract(c.config,'$.lastError') IS NOT NULL AS hasError,
           (SELECT count(*) FROM inventory_scopes s JOIN inventory_coverage v USING(tenant,scope_id)
             WHERE s.tenant=c.tenant AND s.connection_id=c.id AND s.state='observing' AND s.logical_identity=c.remote_identity
               AND v.state='ready' AND v.published_config_version=s.config_version) AS coverageReady,
           (SELECT count(*) FROM inventory_scopes s JOIN inventory_coverage v USING(tenant,scope_id)
             WHERE s.tenant=c.tenant AND s.connection_id=c.id AND s.state='observing' AND s.logical_identity=c.remote_identity) AS coverageTotal
         FROM recent c JOIN accounts a ON a.id=c.tenant ORDER BY c.created_at DESC,c.tenant,c.id`,
        )
        .bind(listLimit),
    ]),
  ]);
  const [usage, accounts, people, links, connections] = results;
  const vendors = usage.results as {
    vendor: string;
    window_start: number;
    requests: number;
    background_requests: number;
    cooldown_until: number;
  }[];
  const accountTotal = (accounts.results[0] as { total: number }).total;
  const connectionTotal = (links.results[0] as { total: number }).total;
  const connectionRows = connections.results as (Omit<
    AdminOverview["connections"]["items"][number],
    "hasError"
  > & {
    lofiAccountEmail: unknown;
    hasError: number;
  })[];
  return {
    generatedAt: now,
    providers,
    retention,
    inventoryRuntime: env.INVENTORY_RUNTIME_MODE ?? "off",
    vendors: (["lofi", "qrz", "lotw"] as const).map((vendor) => {
      const policy = VENDOR_POLICIES[vendor];
      const row = vendors.find((entry) => entry.vendor === vendor);
      const window = Math.floor(now / policy.windowMs) * policy.windowMs;
      const current = row && row.window_start >= window;
      return {
        vendor,
        requests: current ? row.requests : 0,
        backgroundRequests: current ? row.background_requests : 0,
        totalLimit: policy.total,
        backgroundLimit: policy.background,
        windowEndsAt:
          Math.max(window, row?.window_start ?? window) + policy.windowMs,
        cooldownUntil:
          row && row.cooldown_until > now ? row.cooldown_until : null,
      };
    }),
    gates: gatesSummary(env),
    accounts: {
      total: accountTotal,
      truncated: accountTotal > listLimit,
      items: people.results as AdminOverview["accounts"]["items"],
    },
    connections: {
      total: connectionTotal,
      truncated: connectionTotal > listLimit,
      items: connectionRows.map(({ lofiAccountEmail, ...row }) => ({
        ...row,
        label:
          row.kind === "lofi" && row.status !== "approval_pending"
            ? lofiAccountLabel(lofiAccountEmail)
            : row.label,
        lastAttemptAt: timestamp(row.lastAttemptAt),
        lastSuccessAt: timestamp(row.lastSuccessAt),
        lastFailureAt: timestamp(row.lastFailureAt),
        hasError: row.hasError === 1,
      })),
    },
  };
}
