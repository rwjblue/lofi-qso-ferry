import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { serializeAdifRecord } from "../src/adif.ts";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryLotwDispatch } from "../src/inventory-lotw-dispatch.ts";
import { InventoryLotwPreparation } from "../src/inventory-lotw-preparation.ts";
import { InventoryLotwReadback } from "../src/inventory-lotw-readback.ts";
import {
  configuredInventoryShadow,
  InventoryPreparationShadow,
} from "../src/inventory-preparation-shadow.ts";
import { InventoryRunner } from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { InventorySourceProofJobs } from "../src/inventory-source-proof-jobs.ts";
import { importPkcs12 } from "../src/signing.ts";
import { database } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

test("the native sender stages 100 members, sends once, and settles partial LoTW receipts", async (t) => {
  const { db, mf, store } = await database();
  t.after(() => mf.dispose());
  await applyAdditionalMigrations(db);
  const signing = await importPkcs12(
    await readFile(new URL("../fixtures/signing/current.p12", import.meta.url)),
    "ferry-fixture",
    { version: "fixture-batch" },
  );
  await store.db.batch([
    store.statement(
      "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('a','a@example.test','a',1)",
    ),
    store.statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','source','lofi','a','Source','active','v1',?,1),('a','lotw','lotw','a','LoTW','active','v1',?,1)",
      JSON.stringify({ accountId: "a" }),
      JSON.stringify({
        readAccess: true,
        station: { callsign: "W1AW", dxcc: 291 },
      }),
    ),
    await store.putPrivate("a", "source", "v1", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    }),
    await store.putPrivate("a", "lotw", "v1", "credential", {
      query: { username: "fixture", password: "fixture" },
      signing,
    }),
  ]);
  const operation = {
    uuid: "op",
    stationCall: "W1AW",
    syncedAtMillis: Date.now() - 60_000,
  };
  const contacts = Array.from({ length: 100 }, (_, index) => ({
    uuid: `qso-${String(index).padStart(3, "0")}`,
    operation: operation.uuid,
    syncedAtMillis: operation.syncedAtMillis + index + 1,
    startAtMillis: Date.parse("2026-11-08T12:00:01Z") + 60_000 * index,
    their: {
      call: `K${index % 10}B${String.fromCharCode(65 + Math.floor(index / 10))}`,
    },
    our: { grid: "FN31", dxccCode: 291 },
    band: "20m",
    mode: "CW",
  }));
  const recordKeys = contacts.map(({ uuid }) => uuid);
  let uploadRequests = 0;
  let witnessed = 0;
  let receiptRecords: string[] = [];
  let expectedTq8: Uint8Array | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "lofi.ham2k.net") {
      assert.equal(url.pathname, "/v1/sync");
      const body = (await request.json()) as {
        meta: {
          sync: {
            operations: { syncedUntilMillis?: number };
            qsos: { syncedUntilMillis?: number; limit: number };
          };
        };
      };
      assert.deepEqual(Object.keys(body), ["meta"]);
      const { operations, qsos } = body.meta.sync;
      if (qsos.limit === 100) witnessed++;
      return Response.json({
        account: { uuid: "a" },
        operations:
          (operations.syncedUntilMillis ?? 0) > operation.syncedAtMillis
            ? [operation]
            : [],
        qsos: contacts
          .filter((qso) => qso.syncedAtMillis < (qsos.syncedUntilMillis ?? 0))
          .toReversed(),
        meta: {
          operations: { records_left: 0 },
          qsos: { records_left: 0 },
          suggestedSyncLoopDelay: 5000,
        },
      });
    }
    assert.equal(url.hostname, "lotw.arrl.org");
    if (url.pathname === "/lotw/crl")
      return new Response("<Status>Unrevoked</Status>");
    if (url.pathname === "/lotw/upload") {
      uploadRequests++;
      assert.equal(request.method, "POST");
      const payload = (await request.formData()).get("upfile");
      assert.ok(payload instanceof File);
      assert.deepEqual(
        new Uint8Array(await payload.arrayBuffer()),
        expectedTq8,
      );
      return new Response("<!-- .UPL. accepted -->");
    }
    assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
    const count = String(receiptRecords.length);
    return new Response(
      `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${count.length}>${count}<EOH>${receiptRecords.join("")}<APP_LOTW_EOF>`,
    );
  };
  const runtime = await activateInventoryRuntime(store);
  const source = await store.connection("a", "source");
  const lotw = await store.connection("a", "lotw");
  assert.ok(source && lotw);
  await registerInventorySelection(store, runtime, source, {
    provider: "lofi",
  });
  await registerInventorySelection(store, runtime, lotw, {
    provider: "lotw",
    selection: { startDate: "2026-11-07", endDate: "2026-11-09" },
  });
  assert.equal((await startInventorySelections(store)).started, 2);
  const runs = new InventoryRuns(
    new InventoryIngestion(store, new InventoryComparisonPages(store)),
  );
  const runner = new InventoryRunner(runs, fetcher, { scheduled: true });
  const proofJobs = new InventorySourceProofJobs(runs, fetcher);
  const scope = (provider: string) =>
    store
      .statement(
        "SELECT scope_id FROM inventory_scopes WHERE tenant='a' AND provider=?",
        provider,
      )
      .first<string>("scope_id");
  const sourceScope = await scope("lofi");
  const destinationScope = await scope("lotw");
  assert.ok(sourceScope && destinationScope);

  async function finish(scopeId: string) {
    for (let step = 0; step < 15; step++) {
      const job = await store
        .statement(
          "SELECT j.stream_id AS stream,j.active_run_id AS run,j.work_version AS workVersion FROM inventory_stream_jobs j WHERE tenant='a' AND scope_id=?",
          scopeId,
        )
        .first<{ stream: string; run: string; workVersion: number }>();
      assert.ok(job);
      await store.statement("DELETE FROM inventory_read_pacing").run();
      const result = await runner.step({
        version: 1,
        tenant: "a",
        scope: scopeId,
        ...job,
      });
      if (result.kind === "complete") return;
      if (result.kind === "skipped" && result.reason === "not_due") {
        const due = Date.now();
        const version = job.workVersion + 1;
        await db.batch([
          store.statement(
            "UPDATE inventory_stream_jobs SET work_version=?,next_due_at=? WHERE tenant='a' AND scope_id=?",
            version,
            due,
            scopeId,
          ),
          store.statement(
            "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) VALUES('a',?,?,?,?,?,?)",
            crypto.randomUUID(),
            scopeId,
            job.stream,
            job.run,
            version,
            due,
          ),
        ]);
      } else
        assert.ok(
          result.kind === "advanced" || result.kind === "started",
          JSON.stringify(result),
        );
    }
    assert.fail("reader did not settle");
  }
  await finish(sourceScope);
  await finish(destinationScope);
  const coordinator = new InventoryComparisonCoordinator(store);
  for (let step = 0; step < 100; step++) {
    const outcome = await coordinator.step("a");
    if (outcome.kind === "idle") break;
    assert.ok(step < 99, JSON.stringify(outcome));
  }
  // Advance only the fixture's quiet clocks, then restore the native guards.
  for (const [triggers, sql] of [
    [
      [
        "comparison_projection_version",
        "inventory_matching_source_projection_update",
      ],
      "UPDATE comparison_projections SET derived_at=? WHERE facet='source'",
    ],
    [
      [
        "inventory_match_result_update",
        "inventory_delivery_review_result_update",
      ],
      "UPDATE match_results SET next_eligible_at=? WHERE state='absent_at_inventory'",
    ],
  ] as const) {
    const ddl = await Promise.all(
      triggers.map((name) =>
        store
          .statement("SELECT sql FROM sqlite_master WHERE name=?", name)
          .first<string>("sql"),
      ),
    );
    await db.batch([
      ...triggers.map((name) => db.prepare(`DROP TRIGGER ${name}`)),
      db.prepare(sql).bind(Date.now() - 3_600_000),
      ...ddl.map((sql) => {
        assert.ok(sql);
        return db.prepare(sql);
      }),
    ]);
  }
  const selection = { tenant: "a", sourceScope, destinationScope, recordKeys };
  const env = {
    ...fixtureEnvironment(db),
    INVENTORY_LOTW_SHADOW_JSON: JSON.stringify(selection),
  };
  const configured = configuredInventoryShadow(env, "lotw");
  assert.equal(configured.kind, "configured");
  assert.deepEqual(
    configuredInventoryShadow(
      {
        ...env,
        INVENTORY_LOTW_SHADOW_JSON: JSON.stringify({
          ...selection,
          recordKeys: [...recordKeys, "extra"],
        }),
      },
      "lotw",
    ),
    { kind: "invalid" },
  );
  const shadow = new InventoryPreparationShadow(proofJobs, selection, "lotw");
  const job = await shadow.enroll();
  assert.equal(job.kind, "queued", JSON.stringify(job));
  // Skip the optional cached witnesses to exercise one larger LoFi read.
  await store
    .statement(
      "UPDATE inventory_source_proof_jobs SET witnesses='[]' WHERE tenant='a'",
    )
    .run();
  await store.statement("DELETE FROM inventory_read_pacing").run();
  assert.equal(
    (await proofJobs.step("a", sourceScope, job.id)).kind,
    "draining",
  );
  assert.equal(witnessed, 1);
  assert.equal(
    (await proofJobs.step("a", sourceScope, job.id)).kind,
    "deferred",
  );
  await finish(sourceScope);
  await store
    .statement(
      "UPDATE inventory_source_proof_jobs SET due_at=? WHERE tenant='a'",
      Date.now(),
    )
    .run();
  assert.equal(
    (await proofJobs.step("a", sourceScope, job.id)).kind,
    "complete",
  );
  const prepared = await shadow.stage(job.id);
  assert.equal(prepared.kind, "prepared", JSON.stringify(prepared));
  assert.ok("batchId" in prepared);
  assert.equal(prepared.members.length, 100);
  const artifact = await new InventoryLotwPreparation(store).artifact(
    "a",
    prepared.batchId,
  );
  assert.ok(artifact);
  expectedTq8 = artifact.bytes;
  assert.equal(
    gunzipSync(artifact.bytes)
      .toString()
      .match(/<REC_TYPE:8>tCONTACT/g)?.length,
    100,
  );
  const dispatch = new InventoryLotwDispatch(store, fetcher);
  const gates = () => ({
    exportsEnabled: true,
    liveWriteAuthorized: true,
    lotwFreshInsertsEnabled: true,
    sourceBoundaryVerified: false,
    allowedQsoIds: recordKeys,
    allowedDestinationIds: ["lotw"],
  });
  assert.deepEqual(
    await dispatch.send("a", prepared.batchId, () => ({
      ...gates(),
      allowedQsoIds: recordKeys.slice(0, 99),
    })),
    { kind: "held", reason: "lotw_exports_disabled" },
  );
  assert.equal(uploadRequests, 0);
  assert.equal(
    (await dispatch.send("a", prepared.batchId, gates)).kind,
    "submitted",
  );
  await dispatch.send("a", prepared.batchId, gates);
  assert.equal(uploadRequests, 1);
  const claimedAt = await store
    .statement(
      "SELECT claimed_at FROM inventory_lotw_dispatches WHERE tenant='a' AND batch_id=?",
      prepared.batchId,
    )
    .first<number>("claimed_at");
  assert.ok(claimedAt);
  const stamp = new Date(claimedAt)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const observations = artifact.members.map(({ qso }) =>
    serializeAdifRecord({
      STATION_CALLSIGN: artifact.station.callsign,
      CALL: qso.call,
      BAND: qso.band,
      MODE: qso.mode,
      QSO_DATE: qso.date.replaceAll("-", ""),
      TIME_ON: qso.time.replaceAll(":", "").replace("Z", ""),
      MY_DXCC: String(artifact.station.dxcc),
      MY_GRIDSQUARE: artifact.station.grid ?? "",
      APP_LOTW_RXQSO: stamp,
      QSL_RCVD: "N",
    }),
  );
  const readback = new InventoryLotwReadback(store, fetcher);
  receiptRecords = observations.slice(0, 61);
  assert.deepEqual(await readback.reconcile("a", prepared.batchId), {
    kind: "partial",
    members: 100,
    observed: 61,
  });
  receiptRecords = observations;
  assert.deepEqual(await readback.reconcile("a", prepared.batchId), {
    kind: "observed",
    members: 100,
    observed: 100,
  });
  assert.equal(uploadRequests, 1);
});
