import assert from "node:assert/strict";
import test from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { runScheduledTick } from "../src/scheduler-history.ts";
import { applyMigration } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

interface RunRow {
  status: string;
  finished_at: number | null;
  contact_turns: number;
  source_live: number | null;
  failure: string | null;
  errors: number;
  deferred: number;
  stop_reason: string | null;
}

const fakeResult = {
  sources: 2,
  contacts: 7,
  attempts: 0,
  errors: 3,
  deferred: 1,
  exportsEnabled: false,
  rounds: 2,
  elapsedMs: 123,
  stopReason: "deadline" as const,
};
const scenarios = [
  "sample_pending",
  "sample_reject",
  "sample_update_reject",
  "terminal_reject",
  "terminal_committed_ack_lost",
  "work_reject",
  "work_and_recording_reject",
  "success",
] as const;
test("scheduler preserves actual work and separate safe failure phases without replay", async (t) => {
  let logs: string[] = [];
  t.mock.method(console, "error", (message: string) => logs.push(message));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default {fetch(){return new Response("local")}}',
      compatibilityDate: "2026-10-22",
      d1Databases: ["DB"],
      outboundService: () => {
        throw new Error("outbound forbidden");
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await applyMigration(db, "0001_foundation.sql");
    await applyAdditionalMigrations(db);
    for (const mode of scenarios)
      await t.test(mode, async () => {
        logs = [];
        let sampleStarted!: () => void, sampleRelease!: () => void;
        const started = new Promise<void>((resolve) => {
          sampleStarted = resolve;
        });
        const release = new Promise<void>((resolve) => {
          sampleRelease = resolve;
        });
        let batchCalls = 0,
          workCalls = 0,
          terminalCalls = 0,
          sampleCalls = 0;
        const wrapped = new Proxy(db, {
          get(target, key) {
            if (key === "batch")
              return async (statements: D1PreparedStatement[]) => {
                batchCalls++;
                if (batchCalls === 2) {
                  sampleCalls++;
                  sampleStarted();
                  if (mode === "sample_pending") await release;
                  if (mode === "sample_reject")
                    throw new Error("private sample details");
                }
                return target.batch(statements);
              };
            if (key === "prepare")
              return (sql: string) => {
                const original = target.prepare(sql);
                const terminal = sql.startsWith(
                  "UPDATE scheduler_runs SET finished_at=?,duration_ms=?,status='completed'",
                );
                const telemetry = sql.startsWith(
                  "UPDATE scheduler_runs SET source_live=",
                );
                const failure = sql.includes("status='failed'");
                if (!terminal && !telemetry && !failure) return original;
                const wrap = (
                  statement: D1PreparedStatement,
                ): D1PreparedStatement =>
                  new Proxy(statement, {
                    get(object, property) {
                      if (property === "bind")
                        return (...args: unknown[]) =>
                          wrap(object.bind(...args));
                      if (property === "run")
                        return async () => {
                          if (failure && mode === "work_and_recording_reject")
                            throw new Error(
                              "D1_ERROR: private failed-recording SQL and credential",
                            );
                          if (terminal) {
                            terminalCalls++;
                            if (mode === "terminal_reject")
                              throw new Error("synthetic before-write failure");
                          }
                          if (telemetry && mode === "sample_update_reject")
                            throw new Error("synthetic optional-write failure");
                          const result = await object.run();
                          if (
                            terminal &&
                            mode === "terminal_committed_ack_lost"
                          )
                            throw new Error("synthetic lost acknowledgement");
                          return result;
                        };
                      const value = Reflect.get(object, property, object);
                      return typeof value === "function"
                        ? value.bind(object)
                        : value;
                    },
                  });
                return wrap(original);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        let now = 1000;
        const completion = runScheduledTick(fixtureEnvironment(wrapped), {
          now: () => now++,
          run: async () => {
            workCalls++;
            if (mode === "work_and_recording_reject")
              throw new Error(
                "D1_ERROR: too many SQL queries: https://vendor.example/?password=secret",
              );
            if (mode === "work_reject")
              throw new Error("private credential-bearing error");
            return fakeResult;
          },
        });
        // Install rejection handler immediately, including the intentional lost-ACK case.
        const settled = completion.then(
          (result) => ({ result, error: null }),
          (error: unknown) => ({ result: null, error }),
        );
        if (mode === "sample_pending") {
          await started;
          const pending = await db
            .prepare(
              "SELECT status,finished_at,contact_turns,source_live FROM scheduler_runs",
            )
            .first<RunRow>();
          assert(pending);
          assert.equal(pending.status, "completed");
          assert.equal(pending.finished_at, 1001);
          assert.equal(pending.contact_turns, 7);
          assert.equal(pending.source_live, null);
          sampleRelease();
        }
        const outcome = await settled;
        const row = await db
          .prepare("SELECT * FROM scheduler_runs")
          .first<RunRow>();
        assert(row);
        assert.equal(workCalls, 1);
        assert.equal(
          terminalCalls,
          ["work_reject", "work_and_recording_reject"].includes(mode) ? 0 : 1,
        );
        const failures = logs.map((line) => JSON.parse(line));
        assert(
          !logs
            .join(" ")
            .match(/password|private|credential|vendor.example|SQL/),
        );
        for (const failure of failures)
          assert.equal(failure.event, "ferry_scheduler_failure");
        if (mode === "work_and_recording_reject") {
          assert(outcome.error instanceof Error);
          assert.equal(
            outcome.error.message,
            "Scheduled failure recording failed",
          );
          assert.equal(row.status, "running");
          assert.equal(row.finished_at, null);
          assert.equal(row.contact_turns, 0);
          assert.equal(sampleCalls, 0);
          assert.deepEqual(
            failures.map((f) => f.phase),
            ["work", "failure_recording"],
          );
          assert.deepEqual(
            failures.map((f) => Object.keys(f.failures)),
            [["scheduler:none:db_query_limit"], ["scheduler:none:db_d1"]],
          );
        } else if (mode === "work_reject") {
          assert.deepEqual(
            failures.map((f) => f.phase),
            ["work"],
          );
        } else if (
          ["terminal_reject", "terminal_committed_ack_lost"].includes(mode)
        ) {
          assert.deepEqual(
            failures.map((f) => f.phase),
            ["completion_recording"],
          );
          assert(outcome.error instanceof Error);
          assert.equal(
            outcome.error.message,
            "Scheduled completion recording failed",
          );
        } else assert.deepEqual(failures, []);
        if (mode === "terminal_reject") {
          assert(outcome.error);
          assert.equal(row.status, "running");
          assert.equal(row.finished_at, null);
          assert.equal(row.contact_turns, 0);
          assert.equal(sampleCalls, 0);
        } else if (mode === "work_and_recording_reject") {
          assert.equal(row.status, "running");
        } else if (mode === "work_reject") {
          assert(outcome.error instanceof Error);
          assert.equal(outcome.error.message, "Scheduled processing failed");
          assert.equal(row.status, "failed");
          assert.equal(row.failure, "scheduled_processing_failed");
          assert.equal(row.finished_at, 1001);
          assert.equal(sampleCalls, 0);
        } else {
          assert.equal(row.status, "completed");
          assert.equal(row.finished_at, 1001);
          assert.equal(row.contact_turns, 7);
          assert.equal(row.errors, 3);
          assert.equal(row.deferred, 1);
          assert.equal(row.stop_reason, "deadline");
          assert.equal(
            Boolean(outcome.error),
            mode === "terminal_committed_ack_lost",
          );
          assert.equal(
            sampleCalls,
            mode === "terminal_committed_ack_lost" ? 0 : 1,
          );
          const sampled = ["success", "sample_pending"].includes(mode);
          assert.equal(row.source_live, sampled ? 0 : null);
        }
        await db.prepare("DELETE FROM scheduler_runs").run();
      });
  } finally {
    await mf.dispose();
  }
});
