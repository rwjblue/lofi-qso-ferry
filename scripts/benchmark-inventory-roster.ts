import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type ComparisonQueueMessage,
  consumeComparisonWakeups,
  publishComparisonWakeups,
} from "../src/inventory-comparison-continuations.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { lofiPollSlot } from "../src/inventory-lofi-schedule.ts";
import type { InventoryScanPlan } from "../src/inventory-run-plans.ts";
import {
  InventoryRunner,
  type InventoryRunWakeup,
} from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { canonical } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { VENDOR_POLICIES } from "../src/vendor-requests.ts";
import { applyMigration, keys } from "../tests/helpers.ts";
import { applyAdditionalMigrations } from "../tests/runtime-fixtures.ts";
import {
  counters,
  difference,
  measureD1,
} from "./inventory-benchmark-metrics.ts";
import { openInventoryTrial } from "./inventory-run-trial.ts";

const { values } = parseArgs({
  options: {
    accounts: { type: "string", default: "100" },
    contacts: { type: "string", default: "100" },
  },
});
const accountCount = Number(values.accounts);
const contactCount = Number(values.contacts);
assert.ok(
  Number.isSafeInteger(accountCount) &&
    accountCount >= 4 &&
    accountCount <= 100,
);
assert.ok(
  Number.isSafeInteger(contactCount) &&
    contactCount >= 1 &&
    contactCount <= 100,
);
const tenants = Array.from(
  { length: accountCount },
  (_, index) => `tenant-${String(index).padStart(3, "0")}`,
);
const sourceStart = Date.UTC(2026, 0, 16, 12);
const operationStamp = Date.now() - 60_000;
const book = {
  bookId: "7",
  stationCallsign: "N1RWJ",
  startDate: "2026-01-15",
  endDate: "2026-01-17",
};
const plans = [
  { provider: "lofi", pageSize: 1000 },
  {
    provider: "qrz",
    book,
    between: [book.startDate, book.endDate],
    pageSize: 250,
  },
  {
    provider: "lotw",
    selection: { startDate: book.startDate, endDate: book.endDate },
  },
] satisfies InventoryScanPlan[];
type Provider = (typeof plans)[number]["provider"];
type Due = InventoryRunWakeup & { nextDueAt: number; state: string };
const requests = { lofi: 0, qrz: 0, lotw: 0 };
const budgetDeferrals = { lofi: 0, qrz: 0, lotw: 0 };
const dayReceived = new Set<string>();
let delta = false;
let outageSent = false;
let reopened = false;
const fetcher: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "lofi.ham2k.net") {
    assert.equal(url.pathname, "/v1/sync");
    assert.equal(request.method, "POST");
    const { meta } = (await request.json()) as {
      meta: {
        inboundSync: boolean;
        lastSyncAccountUUID: string;
        sync: { qsos: { limit: number } };
      };
    };
    assert.equal(meta.inboundSync, true);
    assert.equal(meta.sync.qsos.limit, 1000);
    const tenant = meta.lastSyncAccountUUID;
    assert.ok(tenants.includes(tenant));
    requests.lofi++;
    if (
      delta &&
      tenant === tenants[Math.floor(accountCount / 2)] &&
      !outageSent
    ) {
      outageSent = true;
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
    const qsos = delta
      ? Array.from({ length: contactCount }, (_, index) => ({
          uuid: `qso-${index}`,
          operation: "op",
          syncedAtMillis: operationStamp + 1000 + index,
          startAtMillis: sourceStart + 60_000 * index,
          their: {
            call: `K${index % 10}B${String.fromCharCode(65 + Math.floor(index / 10))}`,
          },
          our: { grid: "FN31" },
          band: "20m",
          mode: "CW",
          notes: `Synthetic roster contact for ${tenant}.`,
        }))
      : [];
    if (delta) {
      assert.ok(!dayReceived.has(tenant));
      dayReceived.add(tenant);
    }
    return Response.json({
      account: { uuid: tenant },
      operations: delta
        ? []
        : [
            {
              uuid: "op",
              stationCall: "N1RWJ",
              syncedAtMillis: operationStamp,
            },
          ],
      qsos,
      meta: {
        operations: { records_left: 0 },
        qsos: { records_left: 0 },
        suggestedSyncLoopDelay: 5000,
      },
    });
  }
  if (url.hostname === "logbook.qrz.com") {
    const action = (await request.formData()).get("ACTION");
    requests.qrz++;
    if (action === "STATUS")
      return new Response(
        `RESULT=OK&BOOKID=7&CALLSIGN=N1RWJ&STARTDATE=${book.startDate}&ENDDATE=${book.endDate}`,
      );
    assert.equal(action, "FETCH");
    return new Response("RESULT=OK&COUNT=0&ADIF=");
  }
  assert.equal(url.hostname, "lotw.arrl.org");
  assert.equal(request.method, "GET");
  assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
  requests.lotw++;
  return new Response(
    "<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH><APP_LOTW_EOF>",
  );
};

const directory = await mkdtemp(join(tmpdir(), "ferry-native-roster-"));
await writeFile(join(directory, "keys.json"), JSON.stringify(keys), {
  mode: 0o600,
});
let f = await openInventoryTrial(directory);
let meter = measureD1(f.db);
let store = new Store(meter.database, f.store.keys);
let runner = new InventoryRunner(
  new InventoryRuns(
    new InventoryIngestion(store, new InventoryComparisonPages(store)),
  ),
  fetcher,
  { scheduled: true },
);
const earlier = counters();
function totals() {
  const result = { ...earlier };
  for (const key of Object.keys(result) as (keyof typeof result)[])
    result[key] += meter.totals[key];
  return result;
}
const started = performance.now();
let previous = totals();
let before = started;
function checkpoint(stage: string) {
  const next = totals();
  console.log(
    JSON.stringify({
      stage,
      wallMs: performance.now() - before,
      database: difference(next, previous),
      requests,
      budgetDeferrals,
    }),
  );
  before = performance.now();
  previous = next;
}

async function current(tenant: string, provider: Provider): Promise<Due> {
  const row = await store
    .statement(
      `SELECT j.tenant,j.scope_id AS scope,j.stream_id AS stream,w.run_id AS run,
            j.work_version AS workVersion,j.next_due_at AS nextDueAt,j.state
     FROM inventory_stream_jobs j JOIN inventory_scopes s USING(tenant,scope_id)
     JOIN inventory_wakeups w USING(tenant,scope_id,stream_id,work_version)
     WHERE (j.tenant,s.provider)=(?,?)`,
      tenant,
      provider,
    )
    .first<Omit<Due, "version">>();
  assert.ok(row);
  return { version: 1, ...row };
}

// Advance fixture deadlines and quotas without waiting real five-minute windows.
// Page receipts, job fences, coverage and the runner's retry logic stay native.
async function due(job: Due) {
  const now = Date.now();
  if (job.nextDueAt <= now) return job;
  const version = job.workVersion + 1;
  await store.db.batch([
    store.statement(
      "UPDATE inventory_stream_jobs SET work_version=?,next_due_at=? WHERE (tenant,scope_id,stream_id,work_version)=(?,?,?,?)",
      version,
      now,
      job.tenant,
      job.scope,
      job.stream,
      job.workVersion,
    ),
    store.statement(
      "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) VALUES(?,?,?,?,?,?,?)",
      job.tenant,
      crypto.randomUUID(),
      job.scope,
      job.stream,
      job.run,
      version,
      now,
    ),
  ]);
  return { ...job, workVersion: version, nextDueAt: now };
}

async function restart() {
  Object.assign(earlier, totals());
  await f.mf.dispose();
  f = await openInventoryTrial(directory);
  meter = measureD1(f.db);
  store = new Store(meter.database, f.store.keys);
  runner = new InventoryRunner(
    new InventoryRuns(
      new InventoryIngestion(store, new InventoryComparisonPages(store)),
    ),
    fetcher,
    { scheduled: true },
  );
}

async function finish(tenant: string, provider: Provider) {
  for (let turn = 0; turn < 15; turn++) {
    const job = await due(await current(tenant, provider));
    // Simulate the sub-window pace separately from the native quota counter.
    if (provider === "lofi")
      await f.db.prepare("DELETE FROM inventory_read_pacing").run();
    const wasOutage = outageSent;
    const result = await runner.step(job);
    if (result.kind === "complete") return;
    if (result.kind === "deferred") {
      if (!wasOutage && outageSent) {
        const deferred = await current(tenant, provider);
        assert.ok(deferred.nextDueAt > Date.now());
        await restart();
        assert.deepEqual(await current(tenant, provider), deferred);
        assert.deepEqual(await runner.step(deferred), {
          kind: "skipped",
          reason: "not_due",
          retryAt: deferred.nextDueAt,
        });
        assert.ok(!dayReceived.has(tenant));
        reopened = true;
      } else budgetDeferrals[provider]++;
      await f.db
        .prepare("DELETE FROM vendor_requests WHERE vendor=?")
        .bind(provider)
        .run();
      if (provider === "lofi")
        await f.db.prepare("DELETE FROM inventory_vendor_bootstrap").run();
    } else
      assert.ok(
        result.kind === "advanced" || result.kind === "started",
        JSON.stringify(result),
      );
  }
  assert.fail(`run failed to finish for ${provider}`);
}

const messages: { body: ComparisonQueueMessage; dueAt: number }[] = [];
const queue: Pick<Queue<ComparisonQueueMessage>, "sendBatch"> = {
  async sendBatch(batch) {
    for (const { body, delaySeconds } of batch)
      messages.push({ body, dueAt: Date.now() + 1000 * (delaySeconds ?? 0) });
    return {
      metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    };
  },
};
let deliveries = 0;
let steps = 0;
let peakCalls = 0;
async function compare(limit: number) {
  await publishComparisonWakeups(store, queue);
  for (let turn = 0; turn < limit; turn++) {
    const index = messages.findIndex((message) => message.dueAt <= Date.now());
    if (index < 0) return;
    const [{ body }] = messages.splice(index, 1);
    let acknowledged = false;
    const before = totals().calls;
    const result = await consumeComparisonWakeups(
      store,
      {
        messages: [
          {
            body,
            id: String(deliveries),
            timestamp: new Date(),
            attempts: 1,
            ack() {
              acknowledged = true;
            },
            retry() {
              assert.fail("comparison delivery unexpectedly retried");
            },
          },
        ],
      },
      queue,
      { maxStepsPerWakeup: 4 },
    );
    assert.equal(result.failed, 0);
    assert.ok(acknowledged);
    deliveries++;
    steps += result.steps;
    peakCalls = Math.max(peakCalls, totals().calls - before);
    if (deliveries % 100 === 0)
      console.log(
        JSON.stringify({ stage: "comparison-progress", deliveries, steps }),
      );
  }
}

try {
  await applyMigration(f.db, "0001_foundation.sql");
  await applyAdditionalMigrations(f.db);
  const runtime = await activateInventoryRuntime(store);
  for (const tenant of tenants) {
    await store
      .statement(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES(?,?,?,1)",
        tenant,
        `${tenant}@example.test`,
        tenant,
      )
      .run();
    for (const plan of plans) {
      const { provider } = plan;
      const config =
        provider === "lofi"
          ? { accountId: tenant }
          : provider === "qrz"
            ? book
            : { readAccess: true };
      const identity =
        provider === "lofi"
          ? tenant
          : provider === "qrz"
            ? book.bookId
            : tenant;
      const credential =
        provider === "lofi"
          ? { key: "browser:roster", secret: "fixture", token: "fixture" }
          : provider === "qrz"
            ? { apiKey: "fixture" }
            : { query: { username: tenant, password: "fixture" } };
      await store.db.batch([
        store.statement(
          "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES(?,?,?,?,?,'active','v1',?,1)",
          tenant,
          provider,
          provider,
          identity,
          provider,
          canonical(config),
        ),
        await store.putPrivate(
          tenant,
          provider,
          "v1",
          "credential",
          credential,
        ),
      ]);
      const link = await store.connection(tenant, provider);
      assert.ok(link);
      await registerInventorySelection(store, runtime, link, plan);
    }
  }
  for (let remaining = 3 * accountCount; remaining > 0; remaining -= 16)
    assert.deepEqual(await startInventorySelections(store), {
      started: Math.min(remaining, 16),
      deferred: 0,
      failed: 0,
    });
  checkpoint("enrollment");
  for (const [index, tenant] of tenants.entries()) {
    for (const { provider } of plans) await finish(tenant, provider);
    if (index === 0) {
      // An established link polls while the other baselines are still queued.
      const before = requests.lofi;
      await finish(tenant, "lofi");
      assert.equal(requests.lofi, before + 1);
    }
    if ((index + 1) % 25 === 0)
      console.log(
        JSON.stringify({ stage: "baseline-progress", accounts: index + 1 }),
      );
  }
  await compare(100_000);
  assert.equal(messages.length, 0);
  const baselineBytes = (await f.db.prepare("SELECT 1").run()).meta.size_after;
  checkpoint("ready-baselines");
  delta = true;
  for (const [index, tenant] of tenants.entries()) {
    await finish(tenant, "lofi");
    if ((index + 1) % 10 === 0) {
      await compare(10);
      console.log(
        JSON.stringify({ stage: "progress", deltas: index + 1, deliveries }),
      );
    }
  }
  assert.equal(dayReceived.size, accountCount);
  assert.ok(outageSent && reopened);
  checkpoint("delta-burst");
  await compare(100_000);
  assert.equal(messages.length, 0);
  checkpoint("classification");
  const audit = await f.db
    .prepare(
      `WITH sets AS MATERIALIZED(SELECT DISTINCT tenant,set_id FROM match_results),
     valid AS MATERIALIZED(SELECT h.tenant,h.set_id FROM sets c CROSS JOIN inventory_match_sets h
       WHERE (h.tenant,h.set_id)=(c.tenant,c.set_id) AND h.state='committed'
       AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE (x.tenant,x.set_id)=(h.tenant,h.set_id)))
     SELECT r.tenant,d.provider,r.state,count(*) AS records
     FROM valid v CROSS JOIN match_results r INDEXED BY match_result_set JOIN inventory_scopes d
       ON (d.tenant,d.scope_id)=(r.tenant,r.destination)
     WHERE (r.tenant,r.set_id)=(v.tenant,v.set_id)
     GROUP BY r.tenant,d.provider,r.state ORDER BY r.tenant,d.provider`,
    )
    .all();
  assert.deepEqual(
    audit.results,
    tenants.flatMap((tenant) =>
      ["lotw", "qrz"].map((provider) => ({
        tenant,
        provider,
        state: "absent_at_inventory",
        records: contactCount,
      })),
    ),
  );
  const health = await f.db
    .prepare(
      `SELECT (SELECT count(*) FROM inventory_coverage WHERE state='ready') AS ready,
       (SELECT count(*) FROM inventory_records WHERE subtype='qso' AND status='active') AS contacts,
       (SELECT count(*) FROM inventory_qrz_dispatches)+(SELECT count(*) FROM inventory_lotw_dispatches) AS dispatches,
       (SELECT count(*) FROM matching_work WHERE completed_version<work_version) AS pending`,
    )
    .first();
  assert.deepEqual(health, {
    ready: accountCount * 3,
    contacts: accountCount * contactCount,
    dispatches: 0,
    pending: 0,
  });
  const polls = await f.db
    .prepare(
      `SELECT j.tenant,j.next_due_at AS due FROM inventory_stream_jobs j
     JOIN inventory_scopes s USING(tenant,scope_id)
     JOIN inventory_wakeups w USING(tenant,scope_id,stream_id,work_version)
     WHERE s.provider='lofi' AND j.state='idle' AND w.not_before=j.next_due_at
     ORDER BY j.tenant`,
    )
    .all<{ tenant: string; due: number }>();
  assert.deepEqual(
    polls.results.map((poll) => poll.tenant),
    tenants,
  );
  const policy = VENDOR_POLICIES.lofi;
  const cycle =
    Math.ceil(accountCount / (policy.background - 1)) * policy.windowMs;
  for (const [position, poll] of polls.results.entries())
    assert.equal(poll.due % cycle, lofiPollSlot(0, accountCount, position));
  console.log(
    JSON.stringify({
      stage: "complete",
      accounts: accountCount,
      contactsPerAccount: contactCount,
      health,
      classifications: 2 * contactCount * accountCount,
      deliveries,
      steps,
      peakCalls,
      databaseBytes: audit.meta.size_after,
      growthBytes: audit.meta.size_after - baselineBytes,
      nextPollWindows: new Set(
        polls.results.map(
          (poll) =>
            Math.floor(poll.due / policy.windowMs) % (cycle / policy.windowMs),
        ),
      ).size,
      externalRequests: 0,
      elapsedMs: performance.now() - started,
    }),
  );
} finally {
  await f.mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
