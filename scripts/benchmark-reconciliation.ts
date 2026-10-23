import assert from "node:assert/strict";
import { database, keys, seed } from "../tests/helpers.ts";
import { applyAdditionalMigrations } from "../tests/runtime-fixtures.ts";
import { selectReconciliationWork } from "../src/reconciliation-work.ts";
import { Store } from "../src/store.ts";

// Synthetic local D1 only. No credentials, remote databases, or vendor requests.
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(4_000, 200_000);
if (
  sizes.some(
    (size) => !Number.isSafeInteger(size) || size < 1 || size > 200_000,
  )
)
  throw new Error("Sizes must be whole contact counts between 1 and 200000");
for (const contacts of sizes) {
  const { mf, db, store } = await database();
  try {
    await applyAdditionalMigrations(db);
    await seed(store);
    const now = Date.now();
    const seededAt = performance.now();
    await store
      .statement(
        "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at,priority) SELECT 'a','source',printf('q%06d',n),'qso','p'||n,'r1',?,CASE WHEN n%20=0 THEN 'live' ELSE 'background' END FROM seq",
        contacts,
        now + 86_400_000,
      )
      .run();
    const seedMs = performance.now() - seededAt;
    const reads: number[] = [];
    const measured = new Store(db, keys);
    const statement = measured.statement.bind(measured);
    measured.statement = (sql, ...params) =>
      new Proxy(statement(sql, ...params), {
        get(target, property) {
          if (property === "all")
            return async () => {
              const result = await target.all();
              reads.push(result.meta.rows_read);
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const startedAt = performance.now();
    const selected = await selectReconciliationWork(
      measured,
      { tenant: "a", id: "source" },
      {
        limit: 100,
        now,
        priority: "background",
        processedBefore: now,
        readyContextOnly: true,
      },
    );
    const selectedMs = performance.now() - startedAt;
    const selectedRowsRead = reads.reduce((sum, value) => sum + value, 0);
    assert.equal(
      selected.length,
      Math.min(100, contacts - Math.floor(contacts / 20)),
    );
    assert(reads.reduce((sum, value) => sum + value, 0) < 800);
    // A parked review backlog must not add scan cost to the next ready batch.
    await store
      .statement(
        "UPDATE reconciliation_work SET next_due_at=? WHERE qso IN(SELECT qso FROM reconciliation_work WHERE priority='background' ORDER BY qso LIMIT ?)",
        now + 86_400_000,
        Math.max(0, contacts - Math.floor(contacts / 20) - 250),
      )
      .run();
    reads.length = 0;
    const heldStartedAt = performance.now();
    const afterHeld = await selectReconciliationWork(
      measured,
      { tenant: "a", id: "source" },
      { limit: 100, now, priority: "background", readyContextOnly: true },
    );
    const heldMs = performance.now() - heldStartedAt;
    assert(reads.reduce((sum, value) => sum + value, 0) < 800);
    console.log(
      JSON.stringify({
        contacts,
        seedMs,
        selected: selected.length,
        selectedMs,
        selectedRowsRead,
        afterHeld: afterHeld.length,
        heldMs,
        heldRowsRead: reads.reduce((sum, value) => sum + value, 0),
      }),
    );
  } finally {
    await mf.dispose();
  }
}
