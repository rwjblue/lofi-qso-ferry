import type { ComparisonPhase } from "./inventory-comparison-coordinator.ts";

export type ComparisonPublicationStage =
  | "comparison_wakeup_select"
  | "comparison_wakeup_send"
  | "comparison_wakeup_mark";

export type ComparisonFailureStage =
  | ComparisonPublicationStage
  | "comparison_step"
  | "inventory_wakeup_publish"
  | "acknowledge";

const guards = [
  "comparison coordinator lease missing",
  "comparison coordinator regressed",
  "comparison projection authority changed",
  "comparison projection coverage changed",
  "comparison projection dependency changed",
  "comparison projection input changed",
  "comparison wakeup publication changed",
  "comparison wakeup signal changed progress",
  "inventory adoption authority or inputs changed",
  "inventory adoption matching dependencies changed",
  "inventory adoption ownership conflict",
  "inventory delivery review publication incomplete",
  "inventory match authority or dependencies changed",
  "inventory match candidate closure incomplete",
  "inventory match commit authority changed",
  "inventory match publication guard missing",
  "inventory match result publication incomplete",
  "inventory match result version changed",
  "inventory match sync scope changed",
  "inventory matching coverage set changed",
] as const;
const applicationCodes = [
  "comparison_coordinator_unavailable",
  "inventory_comparison_generation_changed",
  "inventory_matching_destination_unavailable",
  "inventory_matching_snapshot_changed",
  "inventory_matching_work_generation_changed",
  "inventory_projection_inputs_changed",
  "inventory_projection_scope_changed",
] as const;
const sqliteSuffix =
  /: SQLITE_[A-Z0-9_]+(?: \(extended: SQLITE_[A-Z0-9_]+\))?$/;

// Database errors can contain SQL values, and other errors can contain URLs or
// private payloads. Only emit constants, including when inspecting a cause.
export function classifyComparisonFailure(error: unknown) {
  if (!(error instanceof Error)) return { code: "unknown" } as const;
  const messages = [
    error.message,
    error.cause instanceof Error ? error.cause.message : undefined,
  ].filter((message) => typeof message === "string");
  const code = applicationCodes.find((candidate) =>
    messages.includes(candidate),
  );
  if (code) return { code } as const;
  const details = messages.map((message) =>
    message.replace(/^D1_ERROR: */, "").replace(sqliteSuffix, ""),
  );
  const guard = guards.find((candidate) => details.includes(candidate));
  if (guard) return { code: "d1_guard", guard } as const;

  if (details.includes("D1 DB is overloaded. Requests queued for too long."))
    return { code: "d1_overloaded" } as const;
  if (
    details.includes(
      "D1 DB storage operation exceeded timeout which caused object to be reset.",
    )
  )
    return { code: "d1_timeout" } as const;
  if (details.includes("Network connection lost."))
    return { code: "d1_connection_lost" } as const;
  if (
    messages.some((message) =>
      /: SQLITE_CONSTRAINT(?:_[A-Z0-9_]+)?(?: \(extended: SQLITE_[A-Z0-9_]+\))?$/.test(
        message,
      ),
    )
  )
    return { code: "d1_constraint" } as const;
  if (messages.some((message) => /^D1_[A-Z_]+:/.test(message)))
    return { code: "d1_other" } as const;
  return { code: "unknown" } as const;
}

export type ComparisonFailure = ReturnType<typeof classifyComparisonFailure> & {
  stage: ComparisonFailureStage;
  phase?: ComparisonPhase;
  attempt: number;
  retryDelaySeconds: number;
  completedSteps: number;
  successorsSent: number;
  elapsedMs: number;
};
