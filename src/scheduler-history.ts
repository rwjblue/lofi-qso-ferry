import { sampleAdminBacklog } from "./admin-metrics.ts";
import { createFailureDiagnostics } from "./failure-diagnostics.ts";
import { tick } from "./service.ts";

interface RunMetadata {
  runId: string;
  startedAt: number;
  scheduledTime: number | null;
}

function reportLifecycle(
  metadata: RunMetadata,
  phase: "started" | "heartbeat_recorded" | "completed",
) {
  try {
    console.log(
      JSON.stringify({
        event: "ferry_scheduler_lifecycle",
        phase,
        ...metadata,
      }),
    );
  } catch {
    // Diagnostic delivery must not change work or its recorded outcome.
  }
}

function reportFailure(
  metadata: RunMetadata,
  phase:
    | "heartbeat_recording"
    | "work"
    | "failure_recording"
    | "completion_recording",
  error: unknown,
) {
  try {
    const diagnostics = createFailureDiagnostics();
    diagnostics.record(error, "scheduler");
    console.error(
      JSON.stringify({
        event: "ferry_scheduler_failure",
        phase,
        ...metadata,
        failures: diagnostics.counts,
      }),
    );
  } catch {
    // Reporting must not change work or hide the original failure boundary.
  }
}

/** Persist the heartbeat before work, so interrupted runs remain visible. */
export async function runScheduledTick(
  env: Env,
  options: {
    run?: typeof tick;
    now?: () => number;
    scheduledTime?: number;
  } = {},
) {
  const clock = options.now ?? Date.now;
  const startedAt = clock();
  const id = crypto.randomUUID();
  const metadata: RunMetadata = {
    runId: id,
    startedAt,
    // This is diagnostic correlation, never a scheduling or authority input.
    scheduledTime:
      typeof options.scheduledTime === "number" &&
      Number.isSafeInteger(options.scheduledTime) &&
      options.scheduledTime >= 0
        ? options.scheduledTime
        : null,
  };
  reportLifecycle(metadata, "started");
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM scheduler_runs WHERE started_at<?").bind(
        startedAt - 7 * 86_400_000,
      ),
      env.DB.prepare(
        "INSERT INTO scheduler_runs(id,started_at,status) VALUES(?,?,'running')",
      ).bind(id, startedAt),
    ]);
  } catch (error) {
    reportFailure(metadata, "heartbeat_recording", error);
    // A lost acknowledgement may leave a running row. Do not fabricate its
    // terminal status or start/retry work when heartbeat admission is unknown.
    throw new Error("Scheduled heartbeat recording failed");
  }
  reportLifecycle(metadata, "heartbeat_recorded");
  let result: Awaited<ReturnType<typeof tick>>;
  try {
    result = await (options.run ?? tick)(env);
  } catch (error) {
    reportFailure(metadata, "work", error);
    const finishedAt = clock();
    try {
      await env.DB.prepare(
        "UPDATE scheduler_runs SET finished_at=?,duration_ms=?,status='failed',failure='scheduled_processing_failed' WHERE id=?",
      )
        .bind(finishedAt, Math.max(0, finishedAt - startedAt), id)
        .run();
    } catch (recordingError) {
      reportFailure(metadata, "failure_recording", recordingError);
      throw new Error("Scheduled failure recording failed");
    }
    // A vendor exception can contain a credential-bearing URL or raw payload.
    throw new Error("Scheduled processing failed");
  }
  const finishedAt = clock();
  // Persist actual work before optional sampling. Sampling may never return if
  // the invocation is interrupted; it must not erase an already finished tick.
  try {
    await env.DB.prepare(
      "UPDATE scheduler_runs SET finished_at=?,duration_ms=?,status='completed',rounds=?,stop_reason=?,source_pages=?,contact_turns=?,attempt_turns=?,errors=?,deferred=?,throughput_json=? WHERE id=?",
    )
      .bind(
        finishedAt,
        Math.max(0, finishedAt - startedAt),
        result.rounds,
        result.stopReason,
        result.sources,
        result.contacts,
        result.attempts,
        result.errors,
        result.deferred,
        JSON.stringify(result.throughput ?? {}),
        id,
      )
      .run();
  } catch (error) {
    reportFailure(metadata, "completion_recording", error);
    throw new Error("Scheduled completion recording failed");
  }
  reportLifecycle(metadata, "completed");
  try {
    const backlog = await sampleAdminBacklog(env.DB, finishedAt, env);
    await env.DB.prepare(
      "UPDATE scheduler_runs SET source_live=?,source_background=?,attempts_due_live=?,attempts_due_background=?,work_live_ready=?,work_live_held=?,work_live_blocked=?,work_background_ready=?,work_background_held=?,work_background_blocked=? WHERE id=? AND status='completed'",
    )
      .bind(
        backlog.sourceLive,
        backlog.sourceBackground,
        backlog.attemptsDueLive,
        backlog.attemptsDueBackground,
        backlog.workLive?.ready ?? null,
        backlog.workLive?.held ?? null,
        backlog.workLive?.blocked ?? null,
        backlog.workBackground?.ready ?? null,
        backlog.workBackground?.held ?? null,
        backlog.workBackground?.blocked ?? null,
        id,
      )
      .run();
  } catch {
    // Missing optional telemetry does not change persisted work or retry it.
  }
  return result;
}
