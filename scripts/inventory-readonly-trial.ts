import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  InventoryIngestion,
  type InventoryObservation,
  type InventoryScope,
} from "../src/inventory-ingestion.ts";
import {
  lofiInventoryObservations,
  lotwInventoryObservations,
  qrzInventoryObservations,
} from "../src/inventory-observations.ts";
import {
  LoFiClient,
  type LoFiCredentials,
  type SyncState,
} from "../src/lofi.ts";
import { LotwClient } from "../src/lotw.ts";
import { QrzClient } from "../src/qrz.ts";
import { sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration } from "../tests/helpers.ts";
import { createInventoryTrialTransport } from "./inventory-trial-transport.ts";
import { keychainCredentials } from "./vendor-readonly.ts";

/** Auto-select only when unambiguous. This file contains metadata, not secrets. */
async function uniquePersona() {
  const metadata = JSON.parse(
    await readFile(join(homedir(), ".config/adif-mcp/personas.json"), "utf8"),
  ) as {
    personas?: Record<
      string,
      { providers?: { qrz_logbook?: unknown; lotw?: unknown } }
    >;
  };
  const candidates = Object.entries(metadata.personas ?? {}).filter(
    ([, value]) => value.providers?.qrz_logbook && value.providers?.lotw,
  );
  if (candidates.length !== 1) throw new Error("Select a persona explicitly");
  return candidates[0][0];
}

export async function inventoryReadonlyTrial(
  options: { persona?: string; pageSize?: number; lofiPages?: number } = {},
  dependencies: { lofiCredentials?: () => Promise<LoFiCredentials> } = {},
) {
  const pageSize = options.pageSize ?? 1000;
  const lofiPages = options.lofiPages ?? 2;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 1000 ||
    !Number.isSafeInteger(lofiPages) ||
    lofiPages < 1 ||
    lofiPages > 3
  )
    throw new Error("Invalid bounded trial options");
  const persona = options.persona ?? (await uniquePersona());
  const path = join(
    homedir(),
    "Library/Application Support/LoFi QSO Ferry/inventory-trials",
    crypto.randomUUID(),
  );
  const previousMask = process.umask(0o077);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const keys = {
    active: "trial",
    keys: { trial: randomBytes(32).toString("base64url") },
  };
  // Trial-only encryption material lives outside the repository. Original
  // Keychain and Sidecar credentials are read in memory and never rewritten.
  await writeFile(join(path, "keys.json"), JSON.stringify(keys), {
    mode: 0o600,
    flag: "wx",
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script:
        "export default {fetch(){return new Response('read-only inventory trial')}}",
      compatibilityDate: "2026-10-22",
      d1Databases: ["DB"],
      resourcePersistencePath: join(path, "database"),
    }),
  );
  const transport = createInventoryTrialTransport(fetch, { maxRequests: 8 });
  const phases: {
    provider: string;
    state: string;
    records: number;
    pages: number;
    statements: number;
    rowsRead: number;
    rowsWritten: number;
    preparationMs: number;
    publicationMs: number;
    plaintextBytes: number;
    encryptedBytes: number;
    complete: boolean;
  }[] = [];
  try {
    const db = await mf.getD1Database("DB");
    await applyMigration(db, "0001_foundation.sql");
    await applyMigration(db, "0039_inventory_ingestion.sql");
    const store = new Store(db, keys);
    const inventory = new InventoryIngestion(store);
    await store
      .statement(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('trial','trial@example.invalid','trial',0)",
      )
      .run();
    async function connect(
      provider: InventoryScope["provider"],
      credentials: unknown,
      remoteIdentity: string,
    ) {
      await store
        .statement(
          "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('trial',?,?,?,?,'active','trial-v1',?)",
          provider,
          provider,
          remoteIdentity,
          `Read-only ${provider} trial`,
          Date.now(),
        )
        .run();
      await (
        await store.putPrivate(
          "trial",
          provider,
          "trial-v1",
          "credential",
          credentials,
        )
      ).run();
      const stream = await inventory.initialize(
        {
          tenant: "trial",
          scope: provider,
          connection: provider,
          provider,
          logicalIdentity: remoteIdentity,
          adapterBinding: `${provider}-readonly-trial-v1`,
          ordering: provider === "lofi" ? "numeric" : "serialized",
        },
        "trial",
        `${provider}-bounded-read-v1`,
      );
      const lease = await store.claim(
        "trial",
        `inventory:${provider}`,
        Date.now(),
        240_000,
      );
      if (!lease) throw new Error("Trial lease unavailable");
      return { stream, lease };
    }
    function phase(provider: string) {
      const result = {
        provider,
        state: "read_failed",
        records: 0,
        pages: 0,
        statements: 0,
        rowsRead: 0,
        rowsWritten: 0,
        preparationMs: 0,
        publicationMs: 0,
        plaintextBytes: 0,
        encryptedBytes: 0,
        complete: false,
      };
      phases.push(result);
      return result;
    }
    async function ingest(
      context: Awaited<ReturnType<typeof connect>>,
      observations: InventoryObservation[],
      nextResume: unknown,
      requestStartedAt: number,
      result: ReturnType<typeof phase>,
    ) {
      // context.stream was captured before the original network request. Never
      // refresh it after a CAS failure and reuse that response/opaque cursor.
      const prepared = await inventory.prepare({
        pageId: crypto.randomUUID(),
        stream: context.stream,
        lease: context.lease,
        facet: context.stream.provider === "lofi" ? "source" : "receipt",
        requestStartedAt,
        origin: "historical",
        observations,
        nextResume,
      });
      const receipt = await inventory.publish(prepared);
      result.records += receipt.records;
      result.pages++;
      result.statements += receipt.statements;
      result.rowsRead += receipt.rowsRead;
      result.rowsWritten += receipt.rowsWritten;
      result.preparationMs += prepared.preparationMs;
      result.publicationMs += receipt.publicationMs;
      result.plaintextBytes += prepared.plaintextBytes;
      result.encryptedBytes += prepared.encryptedBytes;
      // One real-data lost-ACK replay verifies no new write or witness claim.
      const replay = await inventory.publish(prepared);
      if (!replay.recovered || replay.currentVersion !== receipt.currentVersion)
        throw new Error("Trial receipt recovery failed");
    }
    const source = phase("lofi");
    try {
      source.state = "credential_unavailable";
      const credentials = dependencies.lofiCredentials
        ? await dependencies.lofiCredentials()
        : (JSON.parse(
            await readFile(
              join(
                homedir(),
                "Library/Application Support/net.rwjblue.qso-sidecar/lofi-credentials.json",
              ),
              "utf8",
            ),
          ) as LoFiCredentials);
      if (!credentials.key || !credentials.secret || !credentials.token)
        throw new Error("Existing LoFi token required");
      const client = new LoFiClient(credentials, transport.fetch, {
        maxSyncRecords: 1000,
        maxResponseBytes: 8 * 1024 * 1024,
      });
      source.state = "account_read_failed";
      const account = await client.accounts();
      let nextReadAt = Date.now() + 20_000;
      if (typeof account.uuid !== "string")
        throw new Error("Account unavailable");
      source.state = "initialization_failed";
      const context = await connect("lofi", credentials, account.uuid);
      let state: SyncState = {
        mode: "backfill",
        accountId: account.uuid,
        readerPolicy: "all-clients-v1",
        policyEpoch: "readonly-trial-v1",
        operations: {},
        qsos: {},
      };
      const fixedUpperBound = Date.now();
      for (let index = 0; index < lofiPages; index++) {
        const waitMs = Math.max(0, nextReadAt - Date.now());
        if (waitMs > 60_000) {
          source.state = "server_deferred";
          break;
        }
        // Wait before LoFiClient constructs its 15-second request timeout.
        await delay(waitMs);
        if (index) {
          const snapshot = await inventory.snapshot("trial", "lofi", "trial");
          if (!snapshot) throw new Error("Trial stream unavailable");
          context.stream = snapshot;
        }
        const requestStartedAt = Date.now();
        source.state = "page_read_failed";
        const page = await client.syncPage(state, fixedUpperBound, pageSize);
        source.state = "normalization_failed";
        const observations = await lofiInventoryObservations(
          page.operations,
          page.qsos,
        );
        source.state = "publication_failed";
        await ingest(
          context,
          observations,
          page.next,
          requestStartedAt,
          source,
        );
        state = page.next;
        source.complete = page.complete;
        transport.setLoFiDelay(page.pacing?.loopDelayMs ?? 20_000);
        nextReadAt =
          Date.now() + Math.max(20_000, page.pacing?.loopDelayMs ?? 20_000);
        if (page.complete || (!page.operations.length && !page.qsos.length))
          break;
      }
      if (source.state !== "server_deferred") source.state = "observed";
    } catch {
      /* Fixed metadata only; raw errors can contain credentials. */
    }

    let reportDay: string | undefined;
    const qrz = phase("qrz");
    try {
      qrz.state = "credential_unavailable";
      const credentials = await keychainCredentials(persona, "qrz_logbook");
      if (!credentials.api_key) throw new Error("QRZ credential unavailable");
      qrz.state = "initialization_failed";
      const context = await connect(
        "qrz",
        { apiKey: credentials.api_key },
        await sha256(`qrz:${credentials.api_key}`),
      );
      const requestStartedAt = Date.now();
      qrz.state = "page_read_failed";
      const page = await new QrzClient(credentials.api_key, {
        fetch: transport.fetch,
      }).fetchPage({ max: 250 });
      qrz.state = "normalization_failed";
      const observations = await qrzInventoryObservations(page.records);
      qrz.state = "publication_failed";
      await ingest(
        context,
        observations,
        { afterLogId: page.nextAfterLogId },
        requestStartedAt,
        qrz,
      );
      qrz.complete = page.nextAfterLogId === null;
      qrz.state = "observed";
      const date = page.records.find((row) =>
        /^\d{8}$/.test(row.QSO_DATE ?? ""),
      )?.QSO_DATE;
      if (date)
        reportDay = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    } catch {
      /* No vendor URLs, response records, keychain errors or secrets. */
    }
    const lotw = phase("lotw");
    try {
      lotw.state = "credential_or_date_unavailable";
      const credentials = await keychainCredentials(persona, "lotw");
      if (!credentials.username || !credentials.password || !reportDay)
        throw new Error("LoTW bounded date/credential unavailable");
      lotw.state = "initialization_failed";
      const context = await connect(
        "lotw",
        credentials,
        await sha256(`lotw:${credentials.username}`),
      );
      const requestStartedAt = Date.now();
      lotw.state = "page_read_failed";
      const report = await new LotwClient(
        { username: credentials.username, password: credentials.password },
        { fetcher: transport.fetch },
      ).query({ startDate: reportDay, endDate: reportDay });
      lotw.state = "normalization_failed";
      const observations = await lotwInventoryObservations(report.records);
      lotw.state = "publication_failed";
      await ingest(
        context,
        observations,
        { boundedDayComplete: true },
        requestStartedAt,
        lotw,
      );
      lotw.complete = true;
      lotw.state = "observed";
    } catch {
      /* Incomplete providers remain explicit and cannot grant absence. */
    }
    const size = await db
      .prepare(
        "SELECT scope_id AS provider,count(*) AS records FROM inventory_records GROUP BY scope_id",
      )
      .all<{ provider: string; records: number }>();
    const report = {
      schema: 1,
      kind: "bounded-read-only-inventory-trial",
      pageSize,
      phases,
      requests: transport.metrics,
      databaseBytes: size.meta.size_after,
      storedRecords: size.results,
      coveragePublished: false,
      uploads: 0,
      directory: path,
    };
    await writeFile(
      join(path, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return report;
  } finally {
    await mf.dispose();
    process.umask(previousMask);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        persona: { type: "string" },
        "page-size": { type: "string", default: "1000" },
        pages: { type: "string", default: "2" },
      },
    });
    const report = await inventoryReadonlyTrial({
      persona: values.persona,
      pageSize: Number(values["page-size"]),
      lofiPages: Number(values.pages),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.phases.some((phase) => phase.state !== "observed"))
      process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Read-only inventory trial could not initialize; inspect local persona/credential configuration.\n",
    );
    process.exitCode = 1;
  }
}
