import assert from "node:assert/strict";
import test from "node:test";
import type { AdminOverview } from "../src/admin-types.ts";
import {
  deliveryBreakdown,
  trendSegments,
  workloadChange,
  workloadStatus,
} from "../src/browser-admin-workload.ts";

const hour = 3_600_000;
function trend(
  points: AdminOverview["workload"]["trend"]["points"],
): AdminOverview["workload"]["trend"] {
  return {
    windowMs: 24 * hour,
    firstAt: points[0]?.at ?? null,
    lastAt: points.at(-1)?.at ?? null,
    sampleCount: points.filter((point) => point.live !== null).length,
    expectedSamples: 24,
    stale: false,
    truncated: false,
    maxGapMs: hour,
    points,
  };
}

const counts = (ready: number, held = 0, blocked = 0) => ({
  ready,
  held,
  blocked,
});

test("delivery breakdown includes Club Log counts and rates without counting pending submissions", () => {
  const rows = deliveryBreakdown({
    windowMs: 24 * hour,
    total: 36,
    qrz: 0,
    lotw: 12,
    clublog: 24,
    lastCompletedAt: hour,
    buckets: [],
    submittedOutstanding: 7,
    adoptedExisting: 10,
  });
  assert.deepEqual(rows, [
    { kind: "qrz", label: "QRZ Logbook", completed: 0, perHour: 0 },
    { kind: "lotw", label: "LoTW", completed: 12, perHour: 0.5 },
    { kind: "clublog", label: "Club Log", completed: 24, perHour: 1 },
  ]);
});

test("backlog deltas ignore missing samples instead of treating them as empty queues", () => {
  const history = trend([
    { at: 0, live: null, background: null },
    { at: hour, live: counts(10, 5, 2), background: null },
    { at: 2 * hour, live: null, background: null },
    { at: 3 * hour, live: counts(4, 7, 3), background: counts(20) },
    { at: 4 * hour, live: null, background: null },
  ]);
  const change = workloadChange(history, "live");
  assert.ok(change);
  assert.equal(change.first.at, hour);
  assert.equal(change.last.at, 3 * hour);
  assert.equal(change.ready, -6);
  assert.equal(change.held, 2);
  assert.equal(change.blocked, 1);
  assert.equal(workloadChange(history, "background"), null);
});

test("charts break across missing and overdue snapshots", () => {
  const history = trend([
    { at: hour, live: counts(10), background: null },
    { at: 2 * hour, live: counts(9), background: null },
    { at: 3 * hour, live: null, background: null },
    { at: 4 * hour, live: counts(5), background: null },
    { at: 6 * hour, live: counts(0), background: null },
  ]);
  assert.deepEqual(
    trendSegments(history, "live").map((segment) =>
      segment.map((point) => point.at),
    ),
    [[hour, 2 * hour], [4 * hour], [6 * hour]],
  );
  assert.deepEqual(trendSegments(history, "background"), []);
});

test("status explains paused exports and missing evidence instead of declaring an empty queue healthy", () => {
  const history = trend([
    { at: hour, live: counts(0), background: counts(0) },
    { at: 2 * hour, live: counts(0), background: counts(0) },
  ]);
  const data = {
    scheduler: { stale: false },
    gates: { effective: false },
    workload: { trend: history },
  };
  assert.match(workloadStatus(data).title, /paused by rollout gates/);
  data.scheduler.stale = true;
  assert.match(workloadStatus(data).title, /completion is overdue/);
  data.scheduler.stale = false;
  data.gates.effective = true;
  data.workload.trend.stale = true;
  assert.match(workloadStatus(data).title, /samples are needed/);
  data.workload.trend.stale = false;
  assert.match(workloadStatus(data).detail, /does not prove source polling/);
});

test("rising ready work in one traffic class stays visible even if the other drains", () => {
  const data = {
    scheduler: { stale: false },
    gates: { effective: true },
    workload: {
      trend: trend([
        { at: hour, live: counts(0), background: counts(100) },
        { at: 2 * hour, live: counts(3), background: counts(0) },
      ]),
    },
  };
  const status = workloadStatus(data);
  assert.match(status.title, /Ready work increased/);
  assert.equal(status.warning, true);
  assert.match(status.detail, /does not prove a capacity problem/);
});
