import type { AdminOverview, AdminPriority } from "./admin-types.ts";

type Trend = AdminOverview["workload"]["trend"];
export type WorkloadCounts = { ready: number; held: number; blocked: number };

export function workloadChange(trend: Trend, priority: AdminPriority) {
  const samples = trend.points.flatMap((point) =>
    point[priority] === null ? [] : [{ at: point.at, ...point[priority] }],
  );
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || first.at === last.at) return null;
  return {
    first,
    last,
    ready: last.ready - first.ready,
    held: last.held - first.held,
    blocked: last.blocked - first.blocked,
  };
}

export function workloadStatus(data: {
  scheduler: Pick<AdminOverview["scheduler"], "stale">;
  gates: Pick<AdminOverview["gates"], "effective">;
  workload: { trend: Trend };
}): {
  title: string;
  detail: string;
  warning: boolean;
} {
  if (data.scheduler.stale)
    return {
      title: "Scheduler completion is overdue",
      detail:
        "Work counts alone cannot show that processing is running. Check the scheduler history and source freshness below.",
      warning: true,
    };
  if (!data.gates.effective)
    return {
      title: "Exports are paused by rollout gates",
      detail:
        "Imports and reviews can continue while new writes are disabled. Held export work does not by itself indicate a processing capacity problem.",
      warning: false,
    };
  const changes = (["live", "background"] as const).map((priority) =>
    workloadChange(data.workload.trend, priority),
  );
  if (data.workload.trend.stale || !changes.some((change) => change !== null))
    return {
      title: "More recent samples are needed",
      detail:
        "Compare ready work over time with completed deliveries. A single snapshot cannot tell whether the service is keeping up.",
      warning: false,
    };
  if (changes.some((change) => change !== null && change.ready > 0))
    return {
      title: "Ready work increased in the sampled period",
      detail:
        "Compare each traffic class below. New arrivals or work released from a hold can increase the queue; this alone does not prove a capacity problem.",
      warning: true,
    };
  return {
    title: "Compare ready work with completed deliveries",
    detail:
      "Ready work has no known hold, but still needs worker validation. A flat or empty queue does not prove source polling is current; check source freshness too.",
    warning: false,
  };
}

/** Keep missing hourly samples as gaps instead of drawing through them. */
export function trendSegments(trend: Trend, priority: AdminPriority) {
  const segments: { at: number; counts: WorkloadCounts }[][] = [];
  let current: { at: number; counts: WorkloadCounts }[] = [];
  for (const point of trend.points) {
    const counts = point[priority];
    const previous = current.at(-1);
    if (counts === null || (previous && point.at - previous.at > 75 * 60_000)) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (counts !== null) current.push({ at: point.at, counts });
  }
  if (current.length) segments.push(current);
  return segments;
}
