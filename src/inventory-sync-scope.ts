import { AuthError } from "./auth.ts";
import { boundedJson } from "./security.ts";

export interface InventorySyncScope {
  destination: string;
  mode: "all" | "since" | "forward";
  since: string | null;
}

function utcDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000")
  )
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function parseScope(input: Record<string, unknown>): InventorySyncScope {
  const { destination, mode, since } = input;
  if (
    typeof destination !== "string" ||
    !destination ||
    destination.length > 256
  )
    throw new AuthError(400, "Choose a connected destination.");
  if (mode !== "all" && mode !== "since" && mode !== "forward")
    throw new AuthError(400, "Choose a sync scope.");
  if (mode === "since") {
    if (!utcDate(since))
      throw new AuthError(400, "Enter a valid UTC QSO date.");
    return { destination, mode, since };
  }
  if (since !== undefined && since !== null)
    throw new AuthError(400, "A date applies only to the since-date scope.");
  return { destination, mode, since: null };
}

const owned =
  "FROM connections c JOIN accounts a ON a.id=c.tenant AND a.status='active'";
const active =
  "WHERE c.tenant=?1 AND c.kind IN('qrz','lotw') AND c.status='active'";
const withPolicy = `${owned}
  LEFT JOIN inventory_sync_scopes s ON (s.tenant,s.destination)=(c.tenant,c.id)
  ${active}`;

export async function inventorySyncScopeRoute(
  request: Request,
  db: D1Database,
  tenant: string,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/sync-scope") return null;
  if (request.method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT c.id AS destination,coalesce(s.mode,'all') AS mode,s.since
        ${withPolicy} ORDER BY c.created_at,c.id`,
      )
      .bind(tenant)
      .all<InventorySyncScope>();
    return Response.json({ scopes: results });
  }
  if (request.method !== "POST")
    return Response.json(
      { error: "Method not allowed" },
      {
        status: 405,
        headers: { Allow: "GET, POST" },
      },
    );
  let input: Record<string, unknown>;
  try {
    input = await boundedJson(request, 2048);
  } catch {
    throw new AuthError(400, "Enter sync scope settings as JSON.");
  }
  const { destination, mode, since } = parseScope(input);
  const [, saved] = await db.batch<InventorySyncScope>([
    db
      .prepare(
        `INSERT INTO inventory_sync_scopes(tenant,destination,mode,since,changed_at)
         SELECT c.tenant,c.id,?3,?4,?5 ${owned} ${active} AND c.id=?2
       ON CONFLICT(tenant,destination) DO UPDATE SET
         mode=excluded.mode,since=excluded.since,
         version=inventory_sync_scopes.version+1,
         changed_at=max(inventory_sync_scopes.changed_at,excluded.changed_at)
       WHERE inventory_sync_scopes.mode IS NOT excluded.mode OR inventory_sync_scopes.since IS NOT excluded.since`,
      )
      .bind(tenant, destination, mode, since, Date.now()),
    db
      .prepare(
        `SELECT c.id AS destination,s.mode,s.since ${withPolicy} AND c.id=?2`,
      )
      .bind(tenant, destination),
  ]);
  const scope = saved.results[0];
  if (!scope) throw new AuthError(404, "Connected destination not found.");
  return Response.json({ scope });
}
