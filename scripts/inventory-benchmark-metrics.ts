import assert from "node:assert/strict";

export interface Counters {
  calls: number;
  statements: number;
  metadataStatements: number;
  rowsRead: number;
  rowsWritten: number;
  sqlMs: number;
}
export function counters(): Counters {
  return {
    calls: 0,
    statements: 0,
    metadataStatements: 0,
    rowsRead: 0,
    rowsWritten: 0,
    sqlMs: 0,
  };
}

/** Route first() through all() so its D1 row metadata is counted as well. */
export function measureD1(
  database: D1Database,
  observe?: (result: D1Result) => void,
) {
  const totals = counters();
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const record = (results: D1Result[]) => {
    for (const result of results) {
      totals.metadataStatements++;
      totals.rowsRead += result.meta.rows_read;
      totals.rowsWritten += result.meta.rows_written;
      totals.sqlMs += result.meta.duration;
      observe?.(result);
    }
  };
  const wrap = (original: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(original, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "first")
          return async (column?: string) => {
            totals.calls++;
            totals.statements++;
            const result = await target.all<Record<string, unknown>>();
            record([result]);
            const row = result.results[0];
            if (!row) return null;
            if (column === undefined) return row;
            assert.ok(Object.hasOwn(row, column));
            return row[column];
          };
        if (property === "all" || property === "run")
          return async () => {
            totals.calls++;
            totals.statements++;
            const result = await target[property]();
            record([result]);
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, original);
    return proxy;
  };
  return {
    totals,
    database: new Proxy(database, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => wrap(target.prepare(sql));
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            totals.calls++;
            totals.statements += statements.length;
            const result = await target.batch(
              statements.map(
                (statement) => originals.get(statement) ?? statement,
              ),
            );
            record(result);
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
export function difference(after: Counters, before: Counters): Counters {
  return {
    calls: after.calls - before.calls,
    statements: after.statements - before.statements,
    metadataStatements: after.metadataStatements - before.metadataStatements,
    rowsRead: after.rowsRead - before.rowsRead,
    rowsWritten: after.rowsWritten - before.rowsWritten,
    sqlMs: after.sqlMs - before.sqlMs,
  };
}
