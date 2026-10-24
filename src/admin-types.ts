export type AdminPriority = "live" | "background";

export interface AdminWorkCounts {
  /** No known metadata hold; the worker must still validate before sending. */
  ready: number;
  held: number;
  blocked: number;
}

export interface AdminWorkload {
  source: (AdminWorkCounts & {
    priority: AdminPriority;
    expired: number;
    oldestRetainedAt: number | null;
  })[];
  heldReasons: AdminWorkReason[];
  blockedReasons: AdminWorkReason[];
  trend: {
    windowMs: number;
    firstAt: number | null;
    lastAt: number | null;
    sampleCount: number;
    truncated: boolean;
    expectedSamples: number;
    stale: boolean;
    maxGapMs: number | null;
    /** Latest snapshot per hour; absent/legacy breakdowns stay unknown. */
    points: {
      at: number;
      live: AdminWorkCounts | null;
      background: AdminWorkCounts | null;
    }[];
  };
  deliveries: {
    windowMs: number;
    /** Completed destination-contact versions, including corrections. */
    total: number;
    qrz: number;
    lotw: number;
    lastCompletedAt: number | null;
    buckets: { at: number; total: number; qrz: number; lotw: number }[];
    submittedOutstanding: number;
    /** Current adopted-history mappings; never counted as deliveries. */
    adoptedExisting: number;
  };
}

export interface AdminWorkReason {
  priority: AdminPriority;
  reason: string;
  label: string;
  count: number;
}

export interface AdminBacklogSample {
  sourceLive: number;
  sourceBackground: number;
  attemptsDueLive: number;
  attemptsDueBackground: number;
  workLive: AdminWorkCounts | null;
  workBackground: AdminWorkCounts | null;
}

export interface AdminSchedulerRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: "running" | "completed" | "failed";
  rounds: number | null;
  stopReason: "idle" | "deadline" | "database_budget" | null;
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
  workload: AdminWorkload;
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
    qrzFreshInsertsEnabled: boolean;
    exportMode: "source_boundary" | "qrz_fresh_insert" | null;
    rolloutScopeConfigured: boolean;
    rolloutScope: "none" | "limited" | "all";
    destinationScopeConfigured: boolean;
    destinationScope: "none" | "limited" | "all";
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
