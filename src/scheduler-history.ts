import { sampleAdminBacklog } from "./admin-metrics.ts";
import type { AdminBacklogSample } from "./admin-types.ts";
import { tick } from "./service.ts";

/** Persist the heartbeat before work, so interrupted runs remain visible. */
export async function runScheduledTick(
  env: Env,
  options: { run?: typeof tick; now?: () => number } = {},
) {
  const clock = options.now ?? Date.now;
  const startedAt = clock();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scheduler_runs WHERE started_at<?").bind(
      startedAt - 7 * 86_400_000,
    ),
    env.DB.prepare(
      "INSERT INTO scheduler_runs(id,started_at,status) VALUES(?,?,'running')",
    ).bind(id, startedAt),
  ]);
  let result: Awaited<ReturnType<typeof tick>>;
  try {
    result = await (options.run ?? tick)(env);
  } catch {
    const finishedAt = clock();
    await env.DB.prepare(
      "UPDATE scheduler_runs SET finished_at=?,duration_ms=?,status='failed',failure='scheduled_processing_failed' WHERE id=?",
    )
      .bind(finishedAt, Math.max(0, finishedAt - startedAt), id)
      .run();
    // A vendor exception can contain a credential-bearing URL or raw payload.
    throw new Error("Scheduled processing failed");
  }
  const finishedAt = clock();
  let backlog: AdminBacklogSample | null = null;
  try {
    backlog = await sampleAdminBacklog(env.DB, finishedAt, env);
  } catch {
    // Missing telemetry must not misrepresent completed delivery work as failed.
  }
  await env.DB.prepare(
    "UPDATE scheduler_runs SET finished_at=?,duration_ms=?,status='completed',rounds=?,stop_reason=?,source_pages=?,contact_turns=?,attempt_turns=?,errors=?,deferred=?,source_live=?,source_background=?,attempts_due_live=?,attempts_due_background=?,work_live_ready=?,work_live_held=?,work_live_blocked=?,work_background_ready=?,work_background_held=?,work_background_blocked=?,throughput_json=? WHERE id=?",
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
      backlog?.sourceLive ?? null,
      backlog?.sourceBackground ?? null,
      backlog?.attemptsDueLive ?? null,
      backlog?.attemptsDueBackground ?? null,
      backlog?.workLive?.ready ?? null,
      backlog?.workLive?.held ?? null,
      backlog?.workLive?.blocked ?? null,
      backlog?.workBackground?.ready ?? null,
      backlog?.workBackground?.held ?? null,
      backlog?.workBackground?.blocked ?? null,
      JSON.stringify(result.throughput ?? {}),
      id,
    )
    .run();
  return result;
}
