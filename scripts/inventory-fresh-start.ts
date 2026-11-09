import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { inventoryJsonChunks } from "../src/inventory-ingestion.ts";
import {
  activateInventoryRuntime,
  inventoryRuntime,
} from "../src/inventory-runtime.ts";
import { LoFiClient, type LoFiCredentials } from "../src/lofi.ts";
import { canonical } from "../src/security.ts";
import { openSourceCredentials } from "../src/source-credentials.ts";
import type { Connection, Store } from "../src/store.ts";
import { applyMigration } from "../tests/helpers.ts";
import { applyAdditionalMigrations } from "../tests/runtime-fixtures.ts";
import { openInventoryTrial } from "./inventory-run-trial.ts";
import { createInventoryTrialTransport } from "./inventory-trial-transport.ts";

const MAX_ROWS = 4096;
const MAX_BYTES = 16 * 1024 * 1024;
// Explicit columns preserve identity/AAD and configuration. Contact state,
// sessions, cutover decisions and the previous poll clocks stay in the source.
const tables = [
  ["accounts", "id email user_handle verified_at status quiet_minutes", "id"],
  [
    "passkeys",
    "id tenant public_key counter metadata label created_at last_used_at revoked_at",
    "id",
  ],
  [
    "connections",
    "tenant id kind remote_identity label status credential_version config created_at",
    "tenant,id",
  ],
  [
    "private_data",
    "tenant connection id kind envelope created_at expires_at revoked_at",
    "tenant,connection,id",
    "kind='credential'",
  ],
  [
    "templates",
    "tenant destination id config created_at",
    "tenant,destination,id",
  ],
  ["active_templates", "tenant destination version", "tenant,destination"],
  ["account_templates", "tenant id config created_at", "tenant,id"],
  ["active_account_templates", "tenant version", "tenant"],
] as const;
const emptyTables = [
  "sessions",
  "cursors",
  "source_work",
  "ledger",
  "attempts",
  "inventory_scopes",
  "inventory_records",
  "inventory_historical_associations",
  "match_results",
  "inventory_qrz_attempts",
  "inventory_qrz_dispatches",
  "inventory_lotw_batches",
  "inventory_lotw_batch_members",
  "inventory_lotw_dispatches",
  "inventory_lotw_member_receipts",
];
type Row = Record<string, string | number | null>;
type Trial = Awaited<ReturnType<typeof openInventoryTrial>>;
const accountCopy = (store: Store) =>
  store.db.batch<Row>(
    tables.map(([table, columns, order, filter]) =>
      store.statement(
        `SELECT ${columns.split(" ").join(",")} FROM ${table}${filter ? ` WHERE ${filter}` : ""} ORDER BY ${order} LIMIT ${MAX_ROWS + 1}`,
      ),
    ),
  );

async function priorWork(store: Store) {
  const { results } = await store
    .statement(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN(
     'inventory_qrz_attempts','inventory_qrz_dispatch_receipts','inventory_lotw_batches','inventory_lotw_member_receipts')`,
    )
    .all<{ name: string }>();
  const names = new Set(results.map(({ name }) => name));
  const [legacy, qrz, lotw] = await store.db.batch<{ n: number }>([
    store.statement(
      "SELECT count(*) AS n FROM attempts a LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE s.state IS NULL OR s.state NOT IN('observed','delivered','rejected','cancelled')",
    ),
    store.statement(
      names.has("inventory_qrz_attempts")
        ? `SELECT count(*) AS n FROM inventory_qrz_attempts a WHERE a.cancelled_at IS NULL${names.has("inventory_qrz_dispatch_receipts") ? " AND NOT EXISTS(SELECT 1 FROM inventory_qrz_dispatch_receipts r WHERE r.tenant=a.tenant AND r.attempt_id=a.attempt_id)" : ""}`
        : "SELECT 0 AS n",
    ),
    store.statement(
      names.has("inventory_lotw_batches")
        ? `SELECT count(*) AS n FROM inventory_lotw_batches h WHERE h.committed_at IS NOT NULL AND h.cancelled_at IS NULL${names.has("inventory_lotw_member_receipts") ? " AND NOT EXISTS(SELECT 1 FROM inventory_lotw_dispatches d WHERE (d.tenant,d.batch_id)=(h.tenant,h.batch_id) AND d.settled_at IS NOT NULL)" : ""}`
        : "SELECT 0 AS n",
    ),
  ]);
  return {
    legacy: Number(legacy.results[0].n),
    qrz: Number(qrz.results[0].n),
    lotwBatches: Number(lotw.results[0].n),
  };
}

export async function privateSnapshot(directory: string) {
  const source = await realpath(directory);
  const keyFile = join(source, "keys.json");
  const [directoryInfo, keyInfo, databaseInfo] = await Promise.all([
    lstat(source),
    lstat(keyFile),
    lstat(join(source, "database")),
  ]);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.mode & 0o077 ||
    !keyInfo.isFile() ||
    keyInfo.mode & 0o077 ||
    !databaseInfo.isDirectory()
  )
    throw new Error("inventory_fresh_start_requires_private_snapshot");
  return source;
}

export async function requireFreshStartLock(store: Store) {
  const runtime = await inventoryRuntime(store);
  if (
    runtime.mode !== "inventory_read_only" ||
    !(await store
      .statement("SELECT id FROM inventory_fresh_start_lock WHERE id=1")
      .first())
  )
    throw new Error("inventory_fresh_start_write_lock_required");
  return runtime;
}

/** Copy from a closed, private local snapshot to a newly allocated rehearsal. */
export async function inventoryFreshStart(
  sourceDirectory: string,
  root = join(
    homedir(),
    "Library/Application Support/LoFi QSO Ferry/inventory-fresh-starts",
  ),
) {
  const source = await privateSnapshot(sourceDirectory);
  const keyFile = join(source, "keys.json");
  const previousMask = process.umask(0o077);
  let captured: Trial | undefined;
  let target: Trial | undefined;
  let created: string | undefined;
  let complete = false;
  try {
    captured = await openInventoryTrial(source);
    const [results, prior] = await Promise.all([
      accountCopy(captured.store),
      priorWork(captured.store),
    ]);
    const rows = results.map((result) => result.results);
    const fingerprint = canonical(rows);
    if (
      !rows[0].length ||
      rows.some((section) => section.length > MAX_ROWS) ||
      Buffer.byteLength(fingerprint) > MAX_BYTES
    )
      throw new Error("inventory_fresh_start_snapshot_bound");
    const originalKeys = await readFile(keyFile, "utf8");
    if (canonical(JSON.parse(originalKeys)) !== canonical(captured.store.keys))
      throw new Error("inventory_fresh_start_keyring_changed");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = join(root, crypto.randomUUID());
    await mkdir(directory, { mode: 0o700 });
    created = directory;
    await writeFile(join(directory, "keys.json"), originalKeys, {
      mode: 0o600,
      flag: "wx",
    });
    target = await openInventoryTrial(directory);
    await applyMigration(target.db, "0001_foundation.sql");
    await applyAdditionalMigrations(target.db);
    const { store } = target;
    await activateInventoryRuntime(store);
    await store.db.batch([
      store.statement(
        "INSERT INTO inventory_fresh_start_lock(id,locked_at,prior_legacy_unsettled,prior_qrz_unsettled,prior_lotw_unsettled) VALUES(1,?,?,?,?)",
        Date.now(),
        prior.legacy,
        prior.qrz,
        prior.lotwBatches,
      ),
      ...tables.flatMap(([table, columns], index) => {
        const names = columns.split(" ");
        return inventoryJsonChunks(rows[index]).map((chunk) =>
          store.statement(
            `INSERT INTO ${table}(${names.join(",")})
             SELECT ${names.map((name) => `json_extract(value,'$.${name}')`).join(",")} FROM json_each(?)`,
            chunk,
          ),
        );
      }),
    ]);
    // Read the persisted database through a new runtime and its copied keyring.
    await target.mf.dispose();
    target = await openInventoryTrial(directory);
    const reopened = target.store;
    const [copied, original, empty, links, originalWork] = await Promise.all([
      accountCopy(reopened),
      accountCopy(captured.store),
      reopened.db.batch<{ n: number }>(
        emptyTables.map((table) =>
          reopened.statement(`SELECT count(*) AS n FROM ${table}`),
        ),
      ),
      reopened
        .statement(
          "SELECT * FROM connections WHERE status='active' ORDER BY tenant,id",
        )
        .all<Connection>(),
      priorWork(captured.store),
    ]);
    if (
      canonical(copied.map((result) => result.results)) !== fingerprint ||
      canonical(original.map((result) => result.results)) !== fingerprint ||
      canonical(originalWork) !== canonical(prior) ||
      empty.some((result) => result.results[0].n !== 0)
    )
      throw new Error("inventory_fresh_start_verification_changed");
    const decrypted = { lofi: 0, qrz: 0, lotw: 0 };
    let unavailable = 0;
    for (const link of links.results) {
      const credential = link.credential_version
        ? await reopened.private(
            link.tenant,
            link.id,
            link.credential_version,
            "credential",
          )
        : null;
      if (credential) decrypted[link.kind]++;
      else unavailable++;
    }
    const report = {
      directory,
      accounts: rows[0].length,
      passkeys: rows[1].length,
      connections: rows[2].length,
      credentialEnvelopes: rows[3].length,
      decrypted,
      unavailable,
      priorUnsettled: prior,
      contactStateEmpty: true,
      writeLocked: true,
      requests: 0,
    };
    await writeFile(
      join(directory, "fresh-start-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    complete = true;
    return report;
  } finally {
    await target?.mf.dispose();
    await captured?.mf.dispose();
    if (created && !complete)
      await rm(created, { recursive: true, force: true });
    process.umask(previousMask);
  }
}

async function oneActiveLoFi(store: Store, identity: string | null) {
  const { results } = await store
    .statement(
      `SELECT c.* FROM connections c JOIN accounts a ON a.id=c.tenant
       WHERE c.kind='lofi' AND c.status='active' AND a.status='active'
       AND json_extract(c.config,'$.accountId')=c.remote_identity
       AND (?1 IS NULL OR c.remote_identity=?1) LIMIT 2`,
      identity,
    )
    .all<Connection>();
  if (results.length !== 1)
    throw new Error("inventory_fresh_start_lofi_link_required");
  return results[0];
}

/** Recover only the bearer of the retained client on a closed rehearsal. */
export async function refreshFreshStartLoFi(
  rehearsal: string,
  snapshot: string,
  fetcher: typeof fetch = fetch,
) {
  const [directory, source] = await Promise.all([
    privateSnapshot(rehearsal),
    privateSnapshot(snapshot),
  ]);
  if (directory === source)
    throw new Error("inventory_fresh_start_separate_snapshot_required");
  const target = await openInventoryTrial(directory);
  try {
    await requireFreshStartLock(target.store);
    const link = await oneActiveLoFi(target.store, null);
    const session = await openSourceCredentials(target.store, link);
    if (session.credentials.token)
      return { status: "bearer_present" as const, requests: 0 };
    const donor = await openInventoryTrial(source);
    let offered: LoFiCredentials;
    try {
      const donorLink = await oneActiveLoFi(donor.store, link.remote_identity);
      offered = (await openSourceCredentials(donor.store, donorLink))
        .credentials;
    } finally {
      await donor.mf.dispose();
    }
    if (
      !offered.key ||
      !offered.secret ||
      offered.key !== session.credentials.key ||
      offered.secret !== session.credentials.secret
    )
      throw new Error("inventory_fresh_start_lofi_client_changed");
    if (typeof offered.token !== "string" || !offered.token)
      throw new Error("inventory_fresh_start_lofi_bearer_unavailable");
    const transport = createInventoryTrialTransport(fetcher, {
      maxRequests: 1,
    });
    const account = await new LoFiClient(offered, transport.fetch)
      .accounts()
      .catch(() => {
        throw new Error("inventory_fresh_start_lofi_verification_failed");
      });
    if (account.uuid !== link.remote_identity)
      throw new Error("inventory_fresh_start_lofi_account_changed");
    await session.persistRenewal(offered);
    const current = await oneActiveLoFi(target.store, null);
    if (
      current.tenant !== link.tenant ||
      current.id !== link.id ||
      current.credential_version !== link.credential_version ||
      current.remote_identity !== link.remote_identity ||
      (await openSourceCredentials(target.store, current)).credentials.token !==
        offered.token
    )
      throw new Error("inventory_fresh_start_lofi_recovery_raced");
    return {
      status: "bearer_verified" as const,
      requests: transport.metrics.requests,
    };
  } finally {
    await target.mf.dispose();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        source: { type: "string" },
        rehearsal: { type: "string" },
        "lofi-bearer-from": { type: "string" },
      },
    });
    if (values.source && !values.rehearsal && !values["lofi-bearer-from"])
      console.log(JSON.stringify(await inventoryFreshStart(values.source)));
    else if (!values.source && values.rehearsal && values["lofi-bearer-from"])
      console.log(
        JSON.stringify(
          await refreshFreshStartLoFi(
            values.rehearsal,
            values["lofi-bearer-from"],
          ),
        ),
      );
    else throw new Error("inventory_fresh_start_invalid_arguments");
  } catch (error) {
    const reason =
      error instanceof Error &&
      /^inventory_fresh_start_[a-z_]+$/.test(error.message)
        ? error.message
        : "closed_private_snapshot_required";
    console.error(`Fresh-start rehearsal failed (${reason}).`);
    process.exitCode = 1;
  }
}
