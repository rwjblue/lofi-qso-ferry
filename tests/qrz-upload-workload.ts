import assert from "node:assert/strict";
import type { DatabaseMetrics } from "../src/database-metrics.ts";
import { tick } from "../src/service.ts";
import { sourceExportFixture } from "./source-export-fixtures.ts";

// Real local D1/workerd, synthetic HTTP only. The existing tick Store meter
// excludes auth cleanup and outer scheduler bookkeeping. Local elapsed time
// is not a deployed throughput measurement.
export const QRZ_UPLOAD_SCENARIOS = [
  "direct",
  "direct-six",
  "fallback",
  "fallback-six",
] as const;
export interface QrzUploadMeasurement {
  scenario: string;
  uploads: number;
  contacts: number;
  attempts: number;
  rounds: number;
  sourceRequests: number;
  proofs: number;
  elapsedMs: number;
  stopReason: string;
  requests: Record<string, number>;
  database: DatabaseMetrics;
}
export async function qrzUploadWorkload(
  scenario: (typeof QRZ_UPLOAD_SCENARIOS)[number],
  report: (row: QrzUploadMeasurement) => void = () => {},
): Promise<QrzUploadMeasurement[]> {
  const measurements: QrzUploadMeasurement[] = [];
  const cleanup: (() => unknown)[] = [];
  const context = { after: (fn: () => unknown) => cleanup.push(fn) };
  try {
    const h = await sourceExportFixture(
      context,
      async (state, qsos) => {
        const destination = await state.store.connection("a", "destination");
        assert(destination);
        await state.store
          .statement(
            "UPDATE connections SET config=? WHERE tenant='a' AND id='destination'",
            JSON.stringify({
              ...JSON.parse(destination.config),
              bookId: "synthetic-book",
              readAccess: true,
            }),
          )
          .run();
        state.qrzRecords.length = 0;
        if (scenario.startsWith("fallback"))
          state.qrzRecords.push({
            ...state.initial,
            CALL: "K9OTHER",
            TIME_ON: "110000",
            APP_QRZLOG_LOGID: "500",
          });
        if (scenario.endsWith("six"))
          for (let i = 2; i <= 6; i++)
            qsos.push({
              ...structuredClone(state.qso),
              uuid: `q${i}`,
              their: { call: `K${i}FIT` },
              syncedAtMillis: 100 + i,
              startAtMillis: Number(state.qso.startAtMillis) + i * 120_000,
            });
      },
      40,
      "inventory_pending",
    );
    h.enable();
    h.env.SOURCE_BOUNDARY_VERIFIED = "false";
    h.env.QRZ_FRESH_INSERTS_ENABLED = "true";
    h.env.LOTW_FRESH_INSERTS_ENABLED = "false";
    h.env.ROLLOUT_QSO_IDS_JSON = JSON.stringify(h.qsos.map((qso) => qso.uuid));
    h.env.ROLLOUT_DESTINATION_IDS_JSON = '["destination"]';
    const requests = { target: 0, status: 0, cover: 0, insert: 0 };
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).hostname === "logbook.qrz.com") {
        const form = new URLSearchParams(String(init?.body));
        const action = form.get("ACTION");
        if (action === "STATUS") {
          requests.status++;
          return new Response(
            new URLSearchParams({
              RESULT: "OK",
              BOOKID: "synthetic-book",
              CALLSIGN: "W1AW",
              START_DATE: "2020-01-01",
              END_DATE: "2030-12-31",
            }).toString(),
          );
        }
        if (action === "INSERT") requests.insert++;
        if (action === "FETCH") {
          if (
            (form.get("OPTION") ?? "")
              .split(",")
              .some((field) => field.startsWith("CALL:"))
          ) {
            requests.target++;
            if (scenario.startsWith("fallback"))
              return new Response("RESULT=FAIL&COUNT=0");
          } else requests.cover++;
        }
      }
      return h.fetcher(input, init);
    };
    const run = async (label: string) => {
      const before = { ...requests };
      const sourceBefore = h.calls.sourceSync;
      const result = await tick(h.env, fetcher);
      assert.equal(result.errors, 0);
      assert(result.throughput);
      const vendor = Object.fromEntries(
        Object.entries(requests).map(([key, value]) => [
          key,
          value - before[key as keyof typeof before],
        ]),
      );
      const proofs = await h.store
        .statement("SELECT count(*) n FROM source_export_proofs")
        .first<number>("n");
      assert(proofs !== null);
      const measurement: QrzUploadMeasurement = {
        scenario: label,
        uploads: vendor.insert,
        contacts: result.contacts,
        attempts: result.attempts,
        rounds: result.rounds,
        sourceRequests: h.calls.sourceSync - sourceBefore,
        proofs,
        elapsedMs: result.elapsedMs,
        stopReason: result.stopReason,
        requests: vendor,
        database: result.throughput.database,
      };
      measurements.push(measurement);
      report(measurement);
      return vendor.insert;
    };
    const uploads = await run(scenario);
    if (scenario.endsWith("six")) {
      assert(
        uploads >= 4,
        "shared planning must deliver at least four contacts within the unchanged quota",
      );
      assert(uploads <= 6);
      assert(
        Object.values(requests).reduce((sum, count) => sum + count, 0) <= 24,
      );
    } else assert.equal(uploads, 1);
    if (scenario === "direct") assert.equal(await run("idle"), 0);
    return measurements;
  } finally {
    for (const close of cleanup) await close();
  }
}
