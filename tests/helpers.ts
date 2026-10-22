import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Store } from "../src/store.ts";
export const keys = {
  active: "1",
  keys: {
    "1": Buffer.alloc(32, 9).toString("base64url"),
    "2": Buffer.alloc(32, 8).toString("base64url"),
  },
};
export async function database() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      compatibilityDate: "2026-07-30",
      d1Databases: ["DB"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const schema = await readFile(
    new URL("../migrations/0001_foundation.sql", import.meta.url),
    "utf8",
  );
  // D1 exec splits on newlines; individual prepare supports multi-line triggers.
  const statements: string[] = [];
  let current = "";
  for (const line of schema.split("\n")) {
    current += line + "\n";
    const trigger = current.trimStart().startsWith("CREATE TRIGGER");
    if (
      line.trimEnd().endsWith(";") &&
      (!trigger ||
        line.trim() === "END;" ||
        line.trimStart().startsWith("CREATE TRIGGER"))
    ) {
      statements.push(current);
      current = "";
    }
  }
  try {
    for (const statement of statements)
      await db
        .prepare(statement)
        .run()
        .catch((error: unknown) => {
          throw new Error(statement, { cause: error });
        });
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  return { mf, db: db as D1Database, store: new Store(db as D1Database, keys) };
}
export async function seed(store: Store, tenant = "a") {
  await store
    .statement(
      "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES(?,?,?,0)",
      tenant,
      `${tenant}@example.test`,
      tenant,
    )
    .run();
  for (const [id, kind] of [
    ["source", "lofi"],
    ["destination", "qrz"],
  ]) {
    await store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES(?,?,?,?,?,'active','v1',0)",
        tenant,
        id,
        kind,
        id,
        id,
      )
      .run();
    await (
      await store.putPrivate(tenant, id, "v1", "credential", {
        secret: "private",
      })
    ).run();
  }
  return { tenant, source: "source", qso: "q1", destination: "destination" };
}
