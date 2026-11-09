import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const controls = {
  INVENTORY_RUNTIME_MODE: "read_only",
  EXPORTS_ENABLED: "false",
  ROLLOUT_CHECKS_PASSED: "false",
  QRZ_FRESH_INSERTS_ENABLED: "false",
  LOTW_FRESH_INSERTS_ENABLED: "false",
  LIVE_WRITE_AUTHORIZATION: "",
  ROLLOUT_QSO_IDS_JSON: "[]",
  ROLLOUT_DESTINATION_IDS_JSON: "[]",
};

interface Config {
  env?: {
    production?: {
      vars: Record<string, string | undefined>;
      workers_dev?: boolean;
      preview_urls?: boolean;
      d1_databases?: { binding: string; database_id: string }[];
    };
  };
}

type ReadWrangler = (args: string[]) => unknown;
const productionJson = [
  "--config",
  "wrangler.jsonc",
  "--env",
  "production",
  "--json",
];

function wranglerJson(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  // Wrangler can return connection and binding details. Keep its output private.
  if (result.error || result.status !== 0)
    throw new Error(
      `Production preflight could not run Wrangler ${args.slice(0, 2).join(" ")}. Check Cloudflare login, permissions and database setup.`,
    );
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Production preflight received invalid Wrangler JSON");
  }
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  );
}

function configuredDatabase(config: Config) {
  const production = config.env?.production;
  if (!production?.vars) throw new Error("Production Worker is not configured");
  for (const [name, value] of Object.entries(controls)) {
    if (production.vars[name] !== value)
      throw new Error(
        `Refusing read-only deployment: ${name} must equal ${JSON.stringify(value)}`,
      );
  }
  const origin = new URL(production.vars.ORIGIN ?? "");
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== production.vars.RP_ID ||
    origin.hostname.endsWith(".invalid")
  )
    throw new Error("Production passkey origin is not configured");
  if (production.workers_dev !== false || production.preview_urls !== false)
    throw new Error("Production must use its permanent custom hostname only");
  const bindings = production.d1_databases?.filter(
    (row) => row.binding === "DB",
  );
  const id = bindings?.[0]?.database_id;
  if (bindings?.length !== 1 || !uuid(id) || id.startsWith("00000000-"))
    throw new Error("Production D1 is not configured");
  return id.toLowerCase();
}

function servingDatabase(run: ReadWrangler) {
  const deployment = run(["deployments", "status", ...productionJson]) as {
    versions?: { version_id: unknown; percentage: number }[];
  } | null;
  if (
    !Array.isArray(deployment?.versions) ||
    deployment.versions.some(
      (version) =>
        !version ||
        !uuid(version.version_id) ||
        !Number.isFinite(version.percentage) ||
        version.percentage < 0 ||
        version.percentage > 100,
    )
  )
    throw new Error("Production serving versions could not be determined");
  const serving = deployment.versions.filter(
    ({ percentage }) => percentage > 0,
  );
  if (!serving.length)
    throw new Error("Production has no serving Worker version to check");

  const ids = new Set<string>();
  for (const { version_id } of serving) {
    const version = run([
      "versions",
      "view",
      String(version_id),
      ...productionJson,
    ]) as {
      resources?: { bindings?: { type: string; name: string; id: unknown }[] };
    } | null;
    const available = version?.resources?.bindings;
    const bindings = Array.isArray(available)
      ? available.filter((row) => row?.type === "d1" && row.name === "DB")
      : [];
    const id = bindings?.[0]?.id;
    if (bindings?.length !== 1 || !uuid(id))
      throw new Error(
        "A serving production version has no verifiable DB binding",
      );
    ids.add(id.toLowerCase());
  }
  if (ids.size !== 1)
    throw new Error("Serving production versions use different D1 databases");
  return ids.values().next().value;
}

function continuitySql(now: number) {
  return `WITH active AS MATERIALIZED (
    SELECT id,email,user_handle FROM accounts WHERE status='active'
  )
  SELECT 'accounts' AS kind,json_array(a.id,a.email,a.user_handle) AS identity
  FROM active a
  UNION ALL
  SELECT 'passkeys',json_array(p.tenant,p.id,p.public_key)
  FROM active a JOIN passkeys p ON p.tenant=a.id
  WHERE p.revoked_at IS NULL AND length(p.id)>0 AND length(p.public_key)>0
    AND json_valid(p.metadata)
  UNION ALL
  SELECT 'links',json_array(c.tenant,c.id,c.kind,c.remote_identity,c.status,c.credential_version,
    EXISTS(SELECT 1 FROM private_data p
      WHERE (p.tenant,p.connection,p.id,p.kind)=(c.tenant,c.id,c.credential_version,'credential')
        AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>${now})
        AND CASE WHEN json_valid(p.envelope) THEN
          json_type(p.envelope,'$.v')='integer'
          AND json_extract(p.envelope,'$.v')=1
          AND json_extract(p.envelope,'$.algorithm')='AES-256-GCM'
          AND NOT EXISTS(
            SELECT 1 FROM json_each('["$.kek","$.nonce","$.ciphertext","$.wrapNonce","$.wrappedKey"]') f
            WHERE json_type(p.envelope,f.value) IS NOT 'text'
              OR length(json_extract(p.envelope,f.value))=0
          )
        END))
  FROM active a JOIN connections c ON c.tenant=a.id
  WHERE c.status!='revoked'`;
}

function readContinuity(run: ReadWrangler, database: string, sql: string) {
  const result = run([
    "d1",
    "execute",
    database,
    ...productionJson,
    "--remote",
    "--command",
    sql,
  ]);
  const output = Array.isArray(result) && result.length === 1 && result[0];
  if (output?.success !== true || !Array.isArray(output.results))
    throw new Error("Production preflight received an invalid D1 census");
  const identities = {
    accounts: new Set<string>(),
    passkeys: new Set<string>(),
    links: new Set<string>(),
  };
  for (const row of output.results) {
    if (
      !row ||
      typeof row.kind !== "string" ||
      !Object.hasOwn(identities, row.kind) ||
      typeof row.identity !== "string"
    )
      throw new Error("Production preflight received an invalid D1 census row");
    identities[row.kind as keyof typeof identities].add(row.identity);
  }
  return identities;
}

export function checkReadonlyDeploy(
  config: Config,
  run: ReadWrangler = wranglerJson,
) {
  const target = configuredDatabase(config);
  const live = servingDatabase(run);
  if (!live) throw new Error("Production serving D1 database is unavailable");
  if (target === live) return "same_database";

  const sql = continuitySql(Date.now());
  const source = readContinuity(run, live, sql);
  const destination = readContinuity(run, "DB", sql);
  const differences = [];
  for (const kind of ["accounts", "passkeys", "links"] as const) {
    const missing = [...source[kind]].filter(
      (identity) => !destination[kind].has(identity),
    ).length;
    const unexpected = [...destination[kind]].filter(
      (identity) => !source[kind].has(identity),
    ).length;
    if (missing || unexpected)
      differences.push(
        `${kind} (${missing} missing, ${unexpected} unexpected)`,
      );
  }
  if (differences.length)
    throw new Error(
      `Refusing production D1 switch because continuity checks differ: ${differences.join(", ")}. Prepare and verify the target database before rerunning.`,
    );
  return "continuity_verified";
}

export function runReadonlyDeployPreflight() {
  try {
    const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
    const result = checkReadonlyDeploy(config);
    console.log(
      result === "same_database"
        ? "Read-only gates verified. The production D1 binding is unchanged."
        : "Read-only gates verified. The new production D1 passed continuity checks.",
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Production preflight failed",
    );
    process.exitCode = 1;
  }
}
