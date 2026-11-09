import { readdir } from "node:fs/promises";
import { applyMigration, keys, unusedInventoryQueue } from "./helpers.ts";
export async function applyAdditionalMigrations(db: D1Database) {
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql") && name !== "0001_foundation.sql")
    .sort()) {
    await applyMigration(db, name);
  }
}
export function fixtureEnvironment(db: D1Database): Env {
  return {
    DB: db,
    INVENTORY_QUEUE: unusedInventoryQueue,
    INVENTORY_RUNTIME_MODE: "off",
    ASSETS: {
      fetch: async () => new Response("fixture"),
      connect() {
        throw new Error("No raw sockets in fixtures");
      },
    },
    ENVIRONMENT: "local",
    RP_ID: "localhost",
    ORIGIN: "http://localhost:8787",
    EXPORTS_ENABLED: "false",
    LIVE_WRITE_AUTHORIZATION: "",
    MAIL_FROM: "ferry@example.test",
    ACTIVE_KEK_VERSION: "1",
    ROLLOUT_CHECKS_PASSED: "false",
    QRZ_FRESH_INSERTS_ENABLED: "false",
    LOTW_FRESH_INSERTS_ENABLED: "false",
    ROLLOUT_QSO_IDS_JSON: "[]",
    ROLLOUT_DESTINATION_IDS_JSON: "[]",
    KEK_V1: keys.keys["1"],
    AUTH_SECRET: "synthetic-auth-secret-32-characters",
    RESEND_API_KEY: "",
    EMAIL_CODE_SECRET: "synthetic-code-secret-32-characters",
  } as Env;
}
