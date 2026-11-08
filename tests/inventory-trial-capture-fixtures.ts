import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openInventoryTrial } from "../scripts/inventory-run-trial.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { applyMigration, keys } from "./helpers.ts";

export async function trialCapture(root: string, wrapped = true) {
  const directory = join(root, wrapped ? "wrapped-source" : "flat-source");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "keys.json"), JSON.stringify(keys), {
    mode: 0o600,
  });
  const f = await openInventoryTrial(directory);
  try {
    await applyMigration(f.db, "0001_foundation.sql");
    await applyMigration(f.db, "0039_inventory_ingestion.sql");
    await f.store
      .statement(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('trial','trial@example.invalid','trial',0)",
      )
      .run();
    for (const [kind, identity, config, credential] of [
      [
        "lofi",
        "source",
        { accountId: "source" },
        { key: "browser:synthetic", secret: "synthetic", token: "synthetic" },
      ],
      [
        "qrz",
        "book-7",
        {
          bookId: "7",
          stationCallsign: "N1RWJ",
          startDate: "2025-01-01",
          endDate: "2027-12-31",
        },
        { apiKey: "synthetic" },
      ],
      [
        "lotw",
        "synthetic-lotw",
        { readAccess: true },
        wrapped
          ? { query: { username: "synthetic", password: "synthetic" } }
          : { username: "synthetic", password: "synthetic" },
      ],
    ] as const) {
      await f.store
        .statement(
          "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('trial',?,?,?,'fixture','active','fixture',?,?)",
          kind,
          kind,
          identity,
          JSON.stringify(config),
          Date.now(),
        )
        .run();
      await (
        await f.store.putPrivate(
          "trial",
          kind,
          "fixture",
          "credential",
          credential,
        )
      ).run();
    }
    const inventory = new InventoryIngestion(f.store);
    const stream = await inventory.initialize(
      {
        tenant: "trial",
        scope: "lotw",
        connection: "lotw",
        provider: "lotw",
        logicalIdentity: "synthetic-lotw",
        adapterBinding: "fixture-v1",
        ordering: "serialized",
      },
      "capture",
      "fixture-v1",
    );
    const lease = await f.store.claim("trial", "inventory:lotw");
    assert.ok(lease);
    await inventory.publish(
      await inventory.prepare({
        stream,
        lease,
        pageId: "fixture-report",
        facet: "receipt",
        requestStartedAt: Date.now(),
        origin: "historical",
        observations: [
          {
            family: "qso",
            subtype: "qso",
            key: "sample",
            status: "active",
            order: null,
            revision: "r1",
            body: { QSO_DATE: "20261108", CALL: "W1AW" },
          },
        ],
        nextResume: {},
      }),
    );
    await f.store.release(lease);
  } finally {
    await f.mf.dispose();
  }
  return directory;
}
