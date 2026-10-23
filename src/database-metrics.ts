const regions = ["WNAM", "ENAM", "WEUR", "EEUR", "APAC", "OC"] as const;
type DatabaseRegion = (typeof regions)[number];

/** Request-local counters; no query text, parameters or result values are retained. */
export interface DatabaseMetrics {
  calls: number;
  statements: number;
  durationMs: number;
  /** Wall time with at least one database RPC in flight. */
  wallMs: number;
  /** Statement results exposing metadata; first/raw and rejected calls do not. */
  metadataStatements: number;
  /** Reported SQL execution only, excluding network and earlier retry attempts. */
  sqlDurationMs: number;
  sqlTimingStatements: number;
  rowsRead: number;
  rowsReadStatements: number;
  rowsWritten: number;
  rowsWrittenStatements: number;
  /** Extra statement attempts, not a count of distinct retried RPCs. */
  retryAttempts: number;
  retryStatements: number;
  /** Statement counts by database region, not Worker execution location. */
  servedByRegions: Partial<Record<DatabaseRegion, number>>;
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function numeric(value: unknown, integer = false): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER &&
    (!integer || Number.isSafeInteger(value))
  );
}

function add(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

export function measuredDatabase(database: D1Database): {
  database: D1Database;
  metrics: DatabaseMetrics;
} {
  const metrics: DatabaseMetrics = {
    calls: 0,
    statements: 0,
    durationMs: 0,
    wallMs: 0,
    metadataStatements: 0,
    sqlDurationMs: 0,
    sqlTimingStatements: 0,
    rowsRead: 0,
    rowsReadStatements: 0,
    rowsWritten: 0,
    rowsWrittenStatements: 0,
    retryAttempts: 0,
    retryStatements: 0,
    servedByRegions: {},
  };
  let active = 0;
  let activeSince = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const metadata = (result: unknown) => {
    const meta = own(result, "meta");
    try {
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
    } catch {
      return;
    }
    metrics.metadataStatements = add(metrics.metadataStatements, 1);
    const timing = own(own(meta, "timings"), "sql_duration_ms");
    const duration = numeric(timing) ? timing : own(meta, "duration");
    if (numeric(duration)) {
      metrics.sqlDurationMs = add(metrics.sqlDurationMs, duration);
      metrics.sqlTimingStatements = add(metrics.sqlTimingStatements, 1);
    }
    const rowsRead = own(meta, "rows_read");
    if (numeric(rowsRead, true)) {
      metrics.rowsRead = add(metrics.rowsRead, rowsRead);
      metrics.rowsReadStatements = add(metrics.rowsReadStatements, 1);
    }
    const rowsWritten = own(meta, "rows_written");
    if (numeric(rowsWritten, true)) {
      metrics.rowsWritten = add(metrics.rowsWritten, rowsWritten);
      metrics.rowsWrittenStatements = add(metrics.rowsWrittenStatements, 1);
    }
    const attempts = own(meta, "total_attempts");
    if (numeric(attempts, true) && attempts >= 1) {
      metrics.retryAttempts = add(metrics.retryAttempts, attempts - 1);
      metrics.retryStatements = add(metrics.retryStatements, 1);
    }
    const region = own(meta, "served_by_region");
    if (regions.some((allowed) => allowed === region)) {
      const key = region as DatabaseRegion;
      metrics.servedByRegions[key] = add(metrics.servedByRegions[key] ?? 0, 1);
    }
  };
  const measured = async <T>(
    count: number,
    work: () => Promise<T>,
    resultKind?: "single" | "batch",
  ): Promise<T> => {
    metrics.calls++;
    metrics.statements += count;
    const started = Date.now();
    if (active++ === 0) activeSince = started;
    let result: T;
    try {
      result = await work();
    } finally {
      const finished = Date.now();
      metrics.durationMs += Math.max(0, finished - started);
      if (--active === 0) metrics.wallMs += Math.max(0, finished - activeSince);
    }
    // Telemetry must neither inspect row values nor change successful query behavior.
    try {
      if (resultKind === "single") metadata(result);
      else if (resultKind === "batch" && Array.isArray(result))
        for (let index = 0; index < Math.min(count, result.length); index++)
          metadata(own(result, String(index)));
    } catch {
      // Ignore malformed metadata, including throwing proxies/accessors.
    }
    return result;
  };
  const statement = (original: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(original, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => statement(target.bind(...values));
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (["all", "first", "run", "raw"].includes(String(property)))
          return (...args: unknown[]) =>
            measured(
              1,
              () => Reflect.apply(value, target, args),
              property === "all" || property === "run" ? "single" : undefined,
            );
        return value.bind(target);
      },
    });
    originals.set(wrapped, original);
    return wrapped;
  };
  return {
    metrics,
    database: new Proxy(database, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => statement(target.prepare(sql));
        if (property === "batch")
          return (statements: D1PreparedStatement[]) =>
            measured(
              statements.length,
              () =>
                target.batch(
                  statements.map((item) => originals.get(item) ?? item),
                ),
              "batch",
            );
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
