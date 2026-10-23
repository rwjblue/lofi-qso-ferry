/** Request-local counters; no query text, parameters or result values are retained. */
export interface DatabaseMetrics {
  calls: number;
  statements: number;
  durationMs: number;
  /** Wall time with at least one database RPC in flight. */
  wallMs: number;
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
  };
  let active = 0;
  let activeSince = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const measured = async <T>(
    count: number,
    work: () => Promise<T>,
  ): Promise<T> => {
    metrics.calls++;
    metrics.statements += count;
    const started = Date.now();
    if (active++ === 0) activeSince = started;
    try {
      return await work();
    } finally {
      const finished = Date.now();
      metrics.durationMs += Math.max(0, finished - started);
      if (--active === 0) metrics.wallMs += Math.max(0, finished - activeSince);
    }
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
            measured(1, () => Reflect.apply(value, target, args));
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
            measured(statements.length, () =>
              target.batch(
                statements.map((item) => originals.get(item) ?? item),
              ),
            );
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
