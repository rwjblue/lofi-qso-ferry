import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import {
  type InventoryScanPlan,
  planInventoryRun,
} from "../src/inventory-run-plans.ts";
import { InventoryRunner } from "../src/inventory-runner.ts";
import { type InventoryRun, InventoryRuns } from "../src/inventory-runs.ts";
import type { LoFiCredentials } from "../src/lofi.ts";
import { type QrzBook, QrzClient } from "../src/qrz.ts";
import type { Keyring } from "../src/security.ts";
import { type Connection, Store } from "../src/store.ts";
import { vendorFetch } from "../src/vendor-requests.ts";
import { applyMigration } from "../tests/helpers.ts";
import { createInventoryTrialTransport } from "./inventory-trial-transport.ts";

async function openTrial(directory: string) {
  const keys = JSON.parse(
    await readFile(join(directory, "keys.json"), "utf8"),
  ) as Keyring;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script:
        "export default {fetch(){return new Response('isolated inventory run trial')}}",
      compatibilityDate: "2026-10-22",
      d1Databases: ["DB"],
      resourcePersistencePath: join(directory, "database"),
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    const store = new Store(db, keys);
    return { mf, db, store };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

/** Uses an existing encrypted trial's connections; original rows are SELECT-only. */
export async function inventoryRunTrial(
  captureDirectory: string,
  dependencies: { lofiCredentials?: () => Promise<LoFiCredentials> } = {},
) {
  const captured = await openTrial(captureDirectory);
  let source: Connection | null;
  let qrz: Connection | null;
  let lotw: Connection | null;
  let sourceCredential: LoFiCredentials | null;
  let qrzCredential: { apiKey: string } | null;
  let lotwCredential: { username: string; password: string } | null;
  let reportDay: string;
  try {
    [source, qrz, lotw] = await Promise.all([
      captured.store.connection("trial", "lofi"),
      captured.store.connection("trial", "qrz"),
      captured.store.connection("trial", "lotw"),
    ]);
    if (
      !source?.credential_version ||
      !qrz?.credential_version ||
      !lotw?.credential_version
    )
      throw new Error("trial_capture_incomplete");
    [sourceCredential, qrzCredential, lotwCredential] = await Promise.all([
      dependencies.lofiCredentials
        ? dependencies.lofiCredentials()
        : captured.store.private<LoFiCredentials>(
            "trial",
            "lofi",
            source.credential_version,
            "credential",
          ),
      captured.store.private<{ apiKey: string }>(
        "trial",
        "qrz",
        qrz.credential_version,
        "credential",
      ),
      captured.store.private<{ username: string; password: string }>(
        "trial",
        "lotw",
        lotw.credential_version,
        "credential",
      ),
    ]);
    const sample = await captured.db
      .prepare(
        "SELECT record_key FROM inventory_records WHERE tenant='trial' AND scope_id='lotw' LIMIT 1",
      )
      .first<{ record_key: string }>();
    const record = sample
      ? await new InventoryIngestion(captured.store).body<{
          QSO_DATE?: string;
        }>("trial", "lotw", "qso", sample.record_key, "receipt")
      : null;
    const day = record?.QSO_DATE;
    if (!day || !/^\d{8}$/.test(day))
      throw new Error("trial_capture_date_unavailable");
    reportDay = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  } finally {
    await captured.mf.dispose();
  }
  if (
    !sourceCredential?.token ||
    !qrzCredential?.apiKey ||
    !lotwCredential?.username ||
    !lotwCredential.password
  )
    throw new Error("trial_capture_credentials_unavailable");
  const directory = join(
    homedir(),
    "Library/Application Support/LoFi QSO Ferry/inventory-run-trials",
    crypto.randomUUID(),
  );
  const previousMask = process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keys: Keyring = {
    active: "trial",
    keys: { trial: randomBytes(32).toString("base64url") },
  };
  await writeFile(join(directory, "keys.json"), JSON.stringify(keys), {
    mode: 0o600,
    flag: "wx",
  });
  const f = await openTrial(directory);
  const transport = createInventoryTrialTransport(fetch, { maxRequests: 8 });
  try {
    for (const name of [
      "0001_foundation.sql",
      "0009_vendor_requests.sql",
      "0039_inventory_ingestion.sql",
      "0040_inventory_runs.sql",
      "0041_inventory_vendor_admission.sql",
    ])
      await applyMigration(f.db, name);
    await f.store
      .statement(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('trial','trial@example.invalid','trial',0)",
      )
      .run();
    const inventory = new InventoryIngestion(f.store);
    const runs = new InventoryRuns(inventory);
    const runner = new InventoryRunner(runs, transport.fetch);
    const phases: {
      provider: string;
      state: string;
      phase?: string;
      pages: number;
      observations: number;
      statements: number;
      rowsRead: number;
      rowsWritten: number;
      publishedSelection: boolean;
    }[] = [];
    async function run(
      provider: "lofi" | "qrz" | "lotw",
      connection: Connection,
      credential: unknown,
      config: unknown,
      plan: InventoryScanPlan,
      maxPages: number,
    ) {
      const result = {
        provider,
        state: "initialization_failed",
        phase: "",
        pages: 0,
        observations: 0,
        statements: 0,
        rowsRead: 0,
        rowsWritten: 0,
        publishedSelection: false,
      };
      phases.push(result);
      try {
        await f.store
          .statement(
            "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('trial',?,?,?,?,'active','trial-run-v1',?,?)",
            provider,
            provider,
            connection.remote_identity,
            `Read-only ${provider} run trial`,
            JSON.stringify(config),
            Date.now(),
          )
          .run();
        await (
          await f.store.putPrivate(
            "trial",
            provider,
            "trial-run-v1",
            "credential",
            credential,
          )
        ).run();
        const stream = await inventory.initialize(
          {
            tenant: "trial",
            scope: provider,
            connection: provider,
            provider,
            logicalIdentity: connection.remote_identity,
            adapterBinding: "inventory-run-trial-v1",
            ordering: provider === "lofi" ? "numeric" : "serialized",
          },
          "scan",
          "bounded-trial-v1",
        );
        const lease = await f.store.claim("trial", `inventory:${provider}`);
        if (!lease) throw new Error("trial_lease_unavailable");
        let current: InventoryRun;
        try {
          current = await runs.begin({
            stream,
            lease,
            definition: await planInventoryRun(stream, plan),
          });
        } finally {
          await f.store.release(lease);
        }
        for (
          let turn = 0;
          turn < 12 &&
          result.pages < maxPages &&
          !["complete", "held"].includes(current.phase);
          turn++
        ) {
          const waitMs = Math.max(0, current.nextDueAt - Date.now());
          if (waitMs > 60_000) {
            result.state = "deferred";
            break;
          }
          // CLI pacing waits happen before the Worker's per-turn request timeout.
          if (waitMs) await delay(waitMs);
          result.state = "turn_failed";
          const step = await runner.step({
            version: 1,
            tenant: "trial",
            scope: provider,
            stream: "scan",
            run: current.id,
            workVersion: current.jobVersion,
          });
          if (step.kind === "skipped") {
            result.state = step.reason;
            break;
          }
          if (step.kind !== "started") {
            result.observations += step.receipt.records;
            result.statements += step.receipt.statements;
            result.rowsRead += step.receipt.rowsRead;
            result.rowsWritten += step.receipt.rowsWritten;
            if (step.kind === "advanced" && step.usage) result.pages++;
          }
          const loaded = await runs.load("trial", current.id);
          if (!loaded) throw new Error("trial_run_unavailable");
          current = loaded;
          result.phase = current.phase;
          result.state = step.kind;
          if (step.kind === "deferred" || step.kind === "held") break;
        }
        // The final report's bounded receipt selection can finish using local
        // control steps. No extra provider reads are permitted by this loop.
        for (
          let turn = 0;
          turn < 12 && ["quarantining", "publishing"].includes(current.phase);
          turn++
        ) {
          const step = await runner.step({
            version: 1,
            tenant: "trial",
            scope: provider,
            stream: "scan",
            run: current.id,
            workVersion: current.jobVersion,
          });
          if (step.kind === "skipped" || step.kind === "started") break;
          result.statements += step.receipt.statements;
          result.rowsRead += step.receipt.rowsRead;
          result.rowsWritten += step.receipt.rowsWritten;
          const loaded = await runs.load("trial", current.id);
          if (!loaded) throw new Error("trial_run_unavailable");
          current = loaded;
          result.phase = current.phase;
          result.state = step.kind;
        }
        result.publishedSelection =
          (
            await runs.coverage(
              "trial",
              provider,
              "scan",
              provider === "lofi" ? "source" : "receipt",
              current.partition,
            )
          )?.state === "ready";
      } catch {
        /* Fixed diagnostics only; never expose credentials or report bodies. */
      }
    }
    await run(
      "lofi",
      source,
      sourceCredential,
      { accountId: source.remote_identity },
      { provider: "lofi", pageSize: 1000 },
      2,
    );
    const qrzState = {
      provider: "qrz",
      state: "book_unavailable",
      pages: 0,
      observations: 0,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
      publishedSelection: false,
    };
    try {
      const status = await new QrzClient(qrzCredential.apiKey, {
        fetch: vendorFetch(f.store, "qrz", transport.fetch, {
          priority: "background",
        }),
      }).status();
      const fields = {
        ...status,
        ...Object.fromEntries(new URLSearchParams(status.DATA ?? "")),
      };
      const book: QrzBook = {
        bookId: fields.BOOKID,
        stationCallsign: fields.CALLSIGN ?? fields.CALL,
        startDate: fields.START_DATE ?? fields.STARTDATE,
        endDate: fields.END_DATE ?? fields.ENDDATE,
      };
      if (
        Object.values(book).some((value) => typeof value !== "string" || !value)
      )
        throw new Error("trial_book_unavailable");
      await run(
        "qrz",
        qrz,
        qrzCredential,
        book,
        {
          provider: "qrz",
          book,
          between: [book.startDate, book.endDate],
          pageSize: 250,
        },
        1,
      );
    } catch {
      phases.push(qrzState);
    }
    await run(
      "lotw",
      lotw,
      { query: lotwCredential },
      { readAccess: true },
      {
        provider: "lotw",
        selection: { startDate: reportDay, endDate: reportDay },
      },
      1,
    );
    const size = await f.db
      .prepare("SELECT count(*) records FROM inventory_records")
      .first<{ records: number }>();
    const measured = await f.db
      .prepare(
        "SELECT scope_id,count(*) records FROM inventory_records GROUP BY scope_id",
      )
      .all();
    const report = {
      schema: 1,
      kind: "bounded-read-only-inventory-run-trial",
      phases,
      requests: transport.metrics,
      storedRecords: measured.results,
      records: size?.records,
      databaseBytes: measured.meta.size_after,
      uploads: 0,
      accountWideCoverage: false,
      directory,
    };
    await writeFile(
      join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return report;
  } finally {
    await f.mf.dispose();
    process.umask(previousMask);
  }
}

export async function inspectInventoryRunTrial(directory: string) {
  const f = await openTrial(directory);
  try {
    const runs = await f.db
      .prepare(
        "SELECT s.provider,r.phase,r.version,r.expected_stream_version,j.work_version,j.state FROM inventory_runs r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id JOIN inventory_stream_jobs j ON j.tenant=r.tenant AND j.scope_id=r.scope_id AND j.stream_id=r.stream_id ORDER BY s.provider",
      )
      .all();
    const sample = await f.db
      .prepare(
        "SELECT scope_id,entity_family,record_key,facet FROM inventory_record_facets LIMIT 1",
      )
      .first<{
        scope_id: string;
        entity_family: string;
        record_key: string;
        facet: string;
      }>();
    const body = sample
      ? await new InventoryIngestion(f.store).body(
          "trial",
          sample.scope_id,
          sample.entity_family,
          sample.record_key,
          sample.facet,
        )
      : null;
    return {
      state: "reopened",
      runs: runs.results,
      sampleDecrypted: body !== null,
      requests: 0,
    };
  } finally {
    await f.mf.dispose();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: { capture: { type: "string" }, reopen: { type: "string" } },
    });
    if (Boolean(values.capture) === Boolean(values.reopen))
      throw new Error("trial_path_required");
    const report = values.reopen
      ? await inspectInventoryRunTrial(values.reopen)
      : await inventoryRunTrial(values.capture ?? "");
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (
      "phases" in report &&
      report.phases.some(
        (phase) => phase.state !== "advanced" && phase.state !== "complete",
      )
    )
      process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Bounded inventory run trial failed; inspect the encrypted capture and fixed trial report.\n",
    );
    process.exitCode = 1;
  }
}
