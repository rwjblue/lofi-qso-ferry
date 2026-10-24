import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sourcePresenceAnchors } from "../src/source-presence-anchors.ts";
import type {
  SourcePresenceScope,
  SourcePresenceTarget,
} from "../src/source-presence-store.ts";
import type { Store } from "../src/store.ts";

const scope: SourcePresenceScope = {
  tenant: "a",
  source: "s",
  accountId: "account",
  readerPolicy: "all-clients-v1",
  policyEpoch: "current",
  credentialVersion: "credential",
};
const target = (
  kind: "operation" | "qso",
  syncedAtMillis: number,
): SourcePresenceTarget => ({
  kind,
  id: "target",
  operationId: kind === "operation" ? "target" : null,
  revision: "revision",
  syncedAtMillis,
  deleted: false,
  isEvent: false,
});

test("source seeks use only greater canonical stamps and indexed bounded probes", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  // This test exercises the actual lookup and query plan. The ready-policy view
  // and its underlying source/account/cursor fences have their own D1 tests.
  db.exec(`CREATE TABLE source_work(tenant TEXT,source TEXT,policy_seen_epoch TEXT,kind TEXT,synced_at INTEGER);
    CREATE TABLE source_read_policy_ready(tenant TEXT,source TEXT,epoch TEXT);
    CREATE TABLE source_read_policies(tenant TEXT,source TEXT,reader_policy TEXT,account_id TEXT,source_remote TEXT);
    CREATE TABLE connections(tenant TEXT,id TEXT,credential_version TEXT);
    CREATE TABLE private_data(tenant TEXT,connection TEXT,id TEXT,kind TEXT,revoked_at INTEGER,expires_at INTEGER);
    INSERT INTO source_read_policy_ready VALUES('a','s','current');
    INSERT INTO source_read_policies VALUES('a','s','all-clients-v1','account','account');
    INSERT INTO connections VALUES('a','s','credential');
    INSERT INTO private_data VALUES('a','s','credential','credential',NULL,NULL);
    INSERT INTO source_work VALUES
      ('a','s','current','qso',100),('a','s','current','qso',100),
      ('a','s','current','qso',110),('a','s','current','qso',120),
      ('a','s','current','operation',105),('a','s','current','operation',200),
      ('a','s','old','qso',101),('a','s',NULL,'qso',102),
      ('other','s','current','qso',103),('a','other','current','qso',104);`);
  db.exec(
    readFileSync(
      new URL(
        "../migrations/0029_source_presence_anchors.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  let calls = 0;
  let plan: string[] = [];
  const store = {
    statement(sql: string, ...params: (string | number | null)[]) {
      calls++;
      plan = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => String(row.detail));
      return { all: async () => ({ results: db.prepare(sql).all(...params) }) };
    },
  } as unknown as Store;
  const result = await sourcePresenceAnchors(
    store,
    scope,
    [
      target("qso", 100),
      target("qso", 100),
      target("operation", 100),
      target("qso", 999),
    ],
    1000,
  );
  assert.deepEqual(result, [
    { kind: "qso", syncedAtMillis: 110 },
    { kind: "operation", syncedAtMillis: 105 },
  ]);
  assert.equal(calls, 1);
  assert(
    plan.some(
      (detail) =>
        /SEARCH w USING COVERING INDEX source_presence_anchor/.test(detail) &&
        /kind=\? AND synced_at>\?/.test(detail),
    ),
    plan.join("\n"),
  );
  assert(!plan.some((detail) => /SCAN w\b/.test(detail)), plan.join("\n"));
  for (const changed of [
    { ...scope, policyEpoch: "old" },
    { ...scope, credentialVersion: "replaced" },
    { ...scope, accountId: "another" },
  ])
    assert.deepEqual(
      await sourcePresenceAnchors(store, changed, [target("qso", 100)], 1000),
      [],
    );
  db.exec("UPDATE private_data SET revoked_at=999");
  assert.deepEqual(
    await sourcePresenceAnchors(store, scope, [target("qso", 100)], 1000),
    [],
  );
  const before = calls;
  await assert.rejects(
    sourcePresenceAnchors(
      store,
      scope,
      Array.from({ length: 65 }, () => target("qso", 100)),
      1000,
    ),
    /invalid_source_presence_anchor_request/,
  );
  assert.equal(calls, before);
});
