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
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import { canonical } from "../src/security.ts";
import type { Connection, Store } from "../src/store.ts";
import { applyMigration } from "../tests/helpers.ts";
import { applyAdditionalMigrations } from "../tests/runtime-fixtures.ts";
import { openInventoryTrial } from "./inventory-run-trial.ts";

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
  const native = await store
    .statement(
      "SELECT 1 FROM sqlite_master WHERE name='inventory_qrz_attempts'",
    )
    .first();
  const dispatched =
    native &&
    (await store
      .statement(
        "SELECT 1 FROM sqlite_master WHERE name='inventory_qrz_dispatch_receipts'",
      )
      .first());
  const [legacy, qrz] = await store.db.batch<{ n: number }>([
    store.statement(
      "SELECT count(*) AS n FROM attempts a LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE s.state IS NULL OR s.state NOT IN('observed','delivered','rejected','cancelled')",
    ),
    store.statement(
      native
        ? `SELECT count(*) AS n FROM inventory_qrz_attempts a WHERE a.cancelled_at IS NULL${dispatched ? " AND NOT EXISTS(SELECT 1 FROM inventory_qrz_dispatch_receipts r WHERE r.tenant=a.tenant AND r.attempt_id=a.attempt_id)" : ""}`
        : "SELECT 0 AS n",
    ),
  ]);
  return {
    legacy: Number(legacy.results[0].n),
    qrz: Number(qrz.results[0].n),
  };
}

/** Copy from a closed, private local snapshot to a newly allocated rehearsal. */
export async function inventoryFreshStart(
  sourceDirectory: string,
  root = join(
    homedir(),
    "Library/Application Support/LoFi QSO Ferry/inventory-fresh-starts",
  ),
) {
  const source = await realpath(sourceDirectory);
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
        "INSERT INTO inventory_fresh_start_lock(id,locked_at,prior_legacy_unsettled,prior_qrz_unsettled) VALUES(1,?,?,?)",
        Date.now(),
        prior.legacy,
        prior.qrz,
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({ options: { source: { type: "string" } } });
    if (!values.source) throw new Error("inventory_fresh_start_source_missing");
    console.log(JSON.stringify(await inventoryFreshStart(values.source)));
  } catch {
    console.error(
      "Fresh-start rehearsal failed. Supply a closed private local snapshot.",
    );
    process.exitCode = 1;
  }
}
