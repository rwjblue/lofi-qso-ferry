export type AdminPriority = "live" | "background";

export interface AdminBacklogSample {
  sourceLive: number;
  sourceBackground: number;
  attemptsDueLive: number;
  attemptsDueBackground: number;
}

export interface AdminSchedulerRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: "running" | "completed" | "failed";
  rounds: number | null;
  stopReason: "idle" | "deadline" | null;
  /** Successful canonical source pages, not unique sources or QSO records. */
  sourcePages: number;
  /** Includes reconsideration of retained contacts on subsequent cron runs. */
  contactTurns: number;
  /** Includes dispatch/readback calls that were blocked, skipped or unresolved. */
  attemptTurns: number;
  errors: number;
  deferred: number;
  failure: "scheduled_processing_failed" | null;
  backlog: AdminBacklogSample | null;
}

export interface AdminOverview {
  generatedAt: number;
  scheduler: {
    intervalMs: number;
    staleAfterMs: number;
    retentionDays: number;
    lastStartedAt: number | null;
    lastCompletedAt: number | null;
    stale: boolean;
    /** Started runs without a finish checkpoint; some may be interrupted. */
    running: number;
    totals24h: {
      runs: number;
      failed: number;
      deadlineRuns: number;
      sourcePages: number;
      contactTurns: number;
      attemptTurns: number;
      errors: number;
      deferred: number;
    };
    recentRuns: AdminSchedulerRun[];
  };
  backlog: {
    source: {
      priority: AdminPriority;
      pending: number;
      blocked: number;
      expired: number;
      expiring24h: number;
      /** Local creation of the oldest retained pending input, not QSO date. */
      oldestRetainedAt: number | null;
    }[];
    attempts: {
      priority: AdminPriority;
      state: string;
      count: number;
      due: number;
      oldestCreatedAt: number | null;
      oldestDueAt: number | null;
    }[];
    deliveryCandidates: {
      due: number;
      quiet: number;
      oldestDueAt: number | null;
    };
  };
  attention: {
    area: "source" | "attempt" | "history";
    state: string;
    count: number;
  }[];
  vendors: {
    vendor: "lofi" | "qrz" | "lotw";
    requests: number;
    backgroundRequests: number;
    totalLimit: number;
    backgroundLimit: number;
    windowEndsAt: number;
    cooldownUntil: number | null;
  }[];
  gates: {
    exportsEnabled: boolean;
    rolloutChecksPassed: boolean;
    liveWriteAuthorized: boolean;
    sourceBoundaryVerified: boolean;
    rolloutScopeConfigured: boolean;
    rolloutScope: "none" | "limited" | "all";
    effective: boolean;
    configurationValid: boolean;
  };
  accounts: {
    total: number;
    truncated: boolean;
    items: {
      id: string;
      email: string;
      status: string;
      verifiedAt: number;
      passkeys: number;
      connections: number;
    }[];
  };
  connections: {
    total: number;
    truncated: boolean;
    items: {
      tenant: string;
      accountEmail: string;
      id: string;
      kind: "lofi" | "qrz" | "lotw";
      label: string;
      status: string;
      lastAttemptAt: number | null;
      lastSuccessAt: number | null;
      lastFailureAt: number | null;
      hasError: boolean;
      syncMode: "forward" | "backfill" | "unknown";
      contextComplete: boolean;
    }[];
  };
}
