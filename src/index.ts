import { AuthError, authRoute, checkCsrf, session } from "./auth.ts";
import { connectionRoute } from "./connections.ts";
import { lotwVerification } from "./lotw-verification.ts";
import { reviewRoute } from "./review.ts";
import { boundedJson, keyring } from "./security.ts";
import { deliveryGates, exportsEffective, tick } from "./service.ts";
import {
  defaultTemplate,
  destinationTemplates,
  saveDefaultTemplate,
} from "./settings.ts";
import { Store } from "./store.ts";
import {
  POTA_TEMPLATE,
  TEMPLATE_PROFILE,
  validateTemplateVersion,
} from "./templates.ts";

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Permissions-Policy",
    "publickey-credentials-get=(self), publickey-credentials-create=(self)",
  );
  if (headers.get("content-type")?.includes("json"))
    headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health")
        return secured(
          Response.json({
            status: "ok",
            exportsEnabled: exportsEffective(deliveryGates(env)),
          }),
        );
      if (request.method === "GET" && url.pathname === "/join") {
        const asset = new URL("/", request.url);
        return secured(await env.ASSETS.fetch(new Request(asset, request)));
      }
      if (!url.pathname.startsWith("/api/"))
        return secured(await env.ASSETS.fetch(request));
      const authentication = await authRoute(request, env);
      if (authentication) return secured(authentication);
      const identity = await session(request, env);
      if (!identity)
        return secured(
          Response.json({ error: "Sign in with a passkey" }, { status: 401 }),
        );
      if (request.method !== "GET") await checkCsrf(request, env);
      const connection = await connectionRoute(request, env, identity);
      if (connection) return secured(connection);
      const store = new Store(env.DB, keyring(env));
      const review = await reviewRoute(request, store, identity.tenant, {
        trustRootsJson: env.LOTW_TRUST_ROOTS_JSON,
      });
      if (review) return secured(review);
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        const account = await store
          .statement(
            "SELECT email,quiet_minutes FROM accounts WHERE id=?",
            identity.tenant,
          )
          .first<{ email: string; quiet_minutes: number }>();
        const counts = (
          await store
            .statement(
              "SELECT state,count(*) AS count FROM ledger WHERE tenant=? GROUP BY state",
              identity.tenant,
            )
            .all<{ state: string; count: number }>()
        ).results;
        const activityRows = (
          await store
            .statement(
              "SELECT source,qso,destination,state,reason,confirmed FROM ledger WHERE tenant=? ORDER BY updated_at DESC LIMIT 50",
              identity.tenant,
            )
            .all<{
              source: string;
              qso: string;
              destination: string;
              state: string;
              reason: string | null;
              confirmed: number;
            }>()
        ).results;
        const connections = (
          await store
            .statement(
              "SELECT id,kind,label,status,last_poll_at,config,json_extract(config,'$.lastError') AS last_error FROM connections WHERE tenant=? ORDER BY created_at",
              identity.tenant,
            )
            .all<{
              id: string;
              kind: string;
              label: string;
              status: string;
              last_poll_at: number | null;
              config: string;
              last_error: string | null;
            }>()
        ).results.map(({ config, ...connection }) => {
          const parsed: unknown = JSON.parse(config);
          return {
            ...connection,
            ...(connection.kind === "lotw"
              ? {
                  lotwVerification: lotwVerification(
                    parsed &&
                      typeof parsed === "object" &&
                      !Array.isArray(parsed)
                      ? (parsed as Record<string, unknown>)
                      : {},
                    { trustRootsJson: env.LOTW_TRUST_ROOTS_JSON },
                  ),
                }
              : {}),
          };
        });
        const lotwDestinations = new Set(
          connections
            .filter((connection) => connection.kind === "lotw")
            .map((connection) => connection.id),
        );
        const activity: {
          qso: string;
          destination: string;
          state: string;
          reason: string | null;
          confirmed: number;
          priorIdentityCount?: number;
        }[] = await Promise.all(
          activityRows.map(async ({ source, ...row }) => ({
            ...row,
            priorIdentityCount: lotwDestinations.has(row.destination)
              ? await store.lotwPriorIdentityCount({
                  tenant: identity.tenant,
                  source,
                  qso: row.qso,
                  destination: row.destination,
                })
              : 0,
          })),
        );
        const sourceErrors = (
          await store
            .statement(
              "SELECT id AS qso,source AS destination,'source_blocked' AS state,reason,0 AS confirmed FROM source_work WHERE tenant=? AND state!='context' AND reason IS NOT NULL ORDER BY processed_at DESC LIMIT 20",
              identity.tenant,
            )
            .all()
        ).results;
        activity.push(
          ...sourceErrors.map((row) => ({
            qso: String(row.qso),
            destination: String(row.destination),
            state: String(row.state),
            reason: row.reason === null ? null : String(row.reason),
            confirmed: 0,
          })),
        );
        if (sourceErrors.length)
          counts.push({ state: "source_blocked", count: sourceErrors.length });
        const passkeys = (
          await store
            .statement(
              "SELECT id,label,last_used_at FROM passkeys WHERE tenant=? AND revoked_at IS NULL ORDER BY created_at",
              identity.tenant,
            )
            .all()
        ).results;
        const sessions = (
          await store
            .statement(
              "SELECT created_at,token_hash=? AS current FROM sessions WHERE tenant=? AND revoked_at IS NULL AND expires_at>?",
              identity.tokenHash,
              identity.tenant,
              Date.now(),
            )
            .all()
        ).results;
        const gates = deliveryGates(env);
        return secured(
          Response.json({
            email: account?.email,
            quietMinutes: account?.quiet_minutes,
            counts: Object.fromEntries(counts.map((c) => [c.state, c.count])),
            activity,
            connections,
            passkeys,
            sessions,
            exportsEnabled: exportsEffective(gates),
            potaExample: POTA_TEMPLATE,
            defaultTemplate: await defaultTemplate(store, identity.tenant),
            destinationTemplates: await destinationTemplates(
              store,
              identity.tenant,
            ),
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        const input = await boundedJson(request, 4096);
        const minutes = Number(input.quietMinutes);
        if (!Number.isInteger(minutes) || minutes < 20 || minutes > 60)
          return secured(
            Response.json(
              { error: "Choose a quiet period between 20 and 60 minutes" },
              { status: 400 },
            ),
          );
        await store
          .statement(
            "UPDATE accounts SET quiet_minutes=? WHERE id=?",
            minutes,
            identity.tenant,
          )
          .run();
        return secured(Response.json({ ok: true }));
      }
      if (request.method === "POST" && url.pathname === "/api/templates") {
        const input = await boundedJson(request, 32_000);
        const destination = String(input.destination ?? "");
        const connection = destination
          ? await store.connection(identity.tenant, destination)
          : null;
        if (destination && connection?.kind !== "qrz")
          return secured(
            Response.json(
              { error: "QRZ connection not found" },
              { status: 404 },
            ),
          );
        const version = {
          id: "pending",
          profile: TEMPLATE_PROFILE as typeof TEMPLATE_PROFILE,
          fields: input.fields as Record<string, string>,
          fallbackNotes: input.fallbackNotes === true,
        };
        validateTemplateVersion(version);
        const id = destination
          ? await store.saveTemplate(identity.tenant, destination, version)
          : await saveDefaultTemplate(store, identity.tenant, version);
        return secured(Response.json({ id }));
      }
      return secured(Response.json({ error: "Not found" }, { status: 404 }));
    } catch (error) {
      if (error instanceof AuthError)
        return secured(
          Response.json(
            {
              error: error.message,
              ...(error.code ? { code: error.code } : {}),
            },
            { status: error.status },
          ),
        );
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : 400;
      return secured(
        Response.json(
          {
            error:
              status >= 500
                ? "Service unavailable; retry later"
                : "Request could not be completed. Verify your passkey and check the supplied values.",
          },
          { status },
        ),
      );
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ) {
    context.waitUntil(
      tick(env).then((result) => {
        console.log(JSON.stringify({ event: "ferry_tick", ...result }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
