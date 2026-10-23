import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

// Keep these predicates aligned with operationContext and the projection/adoption
// event fences: the regression is that filtering followed a scan of every QSO.
const contextSql =
  "SELECT w.*,p.envelope,p.expires_at AS payload_expires_at FROM source_work w LEFT JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source' AND p.revoked_at IS NULL WHERE w.tenant=?1 AND w.source=?2 AND w.operation_id=?3 AND (w.kind='operation' OR w.is_event=1)";
const eventFenceSql =
  "SELECT NOT EXISTS(SELECT 1 FROM source_work e LEFT JOIN private_data ep ON ep.tenant=e.tenant AND ep.connection=e.source AND ep.id=e.private_id AND ep.kind='source' WHERE e.tenant=?1 AND e.source=?2 AND e.operation_id=?3 AND e.kind='qso' AND e.is_event=1 AND e.deleted=0 AND (e.expires_at<=?4 OR ep.id IS NULL OR ep.revoked_at IS NOT NULL OR (ep.expires_at IS NOT NULL AND ep.expires_at<=?4))) ok";

test("operation context and event fences skip 4,000 ordinary contacts without changing results", async () => {
  const fixture = await database();
  try {
    await applyAdditionalMigrations(fixture.db);
    await seed(fixture.store);
    await fixture.db.batch([
      fixture.db.prepare(
        "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at) VALUES('a','source','context-payload','source','{}',0,1000)",
      ),
      fixture.db.prepare(
        "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,expires_at,is_event,deleted) VALUES('a','source','general','operation','general','context-payload','r',1000,0,0),('a','source','event','qso','general','context-payload','r',1000,1,0),('a','source','deleted-event','qso','general','missing','r',0,1,1)",
      ),
      fixture.db.prepare(
        "WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4000) INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,expires_at,is_event) SELECT 'a','source','q'||x,'qso','general','missing','r',0,0 FROM n",
      ),
    ]);
    const context = () =>
      fixture.db.prepare(contextSql).bind("a", "source", "general");
    const fence = () =>
      fixture.db.prepare(eventFenceSql).bind("a", "source", "general", 100);
    await fixture.db.prepare("DROP INDEX source_context_members").run();
    const before = await fixture.db.batch([context(), fence()]);
    assert.ok(before.every((result) => result.meta.rows_read >= 4000));
    const migration = await readFile(
      new URL("../migrations/0022_source_context_members.sql", import.meta.url),
      "utf8",
    );
    await fixture.db.prepare(migration).run();
    const after = await fixture.db.batch([context(), fence()]);
    const ids = (result: D1Result) =>
      result.results.map((row) => (row as { id: string }).id).sort();
    const sortedRows = (result: D1Result) =>
      result.results.toSorted((left, right) =>
        (left as { id: string }).id.localeCompare((right as { id: string }).id),
      );
    assert.deepEqual(ids(after[0]), ["deleted-event", "event", "general"]);
    assert.deepEqual(sortedRows(after[0]), sortedRows(before[0]));
    assert.deepEqual(after[1].results, before[1].results);
    assert.deepEqual(after[1].results, [{ ok: 1 }]);
    assert.ok(after.every((result) => result.meta.rows_read <= 6));
    for (const [sql, args] of [
      [contextSql, ["a", "source", "general"]],
      [eventFenceSql, ["a", "source", "general", 100]],
    ] as const) {
      const plan = await fixture.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...args)
        .all<{ detail: string }>();
      assert.ok(
        plan.results.some((row) =>
          row.detail.includes("USING INDEX source_context_members"),
        ),
      );
      assert.ok(
        plan.results.every(
          (row) => !row.detail.includes("USING INDEX source_operation "),
        ),
      );
    }

    // Ordinary contacts and deleted events may lack ciphertext; a current event
    // may not. Index maintenance must retain each guard's filtering behavior.
    await fixture.db
      .prepare("UPDATE source_work SET deleted=0 WHERE id='deleted-event'")
      .run();
    assert.deepEqual((await fence().all()).results, [{ ok: 0 }]);
    await fixture.db
      .prepare("UPDATE source_work SET is_event=0 WHERE id='deleted-event'")
      .run();
    assert.deepEqual((await fence().all()).results, [{ ok: 1 }]);
    assert.deepEqual(ids(await context().all()), ["event", "general"]);
    await fixture.db
      .prepare(
        "UPDATE private_data SET revoked_at=100 WHERE id='context-payload'",
      )
      .run();
    assert.deepEqual((await fence().all()).results, [{ ok: 0 }]);
    await fixture.db
      .prepare(
        "UPDATE private_data SET revoked_at=NULL,expires_at=100 WHERE id='context-payload'",
      )
      .run();
    assert.deepEqual((await fence().all()).results, [{ ok: 0 }]);
    await fixture.db
      .prepare(
        "UPDATE private_data SET expires_at=1000 WHERE id='context-payload'",
      )
      .run();
    await fixture.db
      .prepare("UPDATE source_work SET expires_at=100 WHERE id='event'")
      .run();
    assert.deepEqual((await fence().all()).results, [{ ok: 0 }]);
    await fixture.db
      .prepare("UPDATE source_work SET expires_at=1000 WHERE id='event'")
      .run();
    assert.deepEqual((await fence().all()).results, [{ ok: 1 }]);
  } finally {
    await fixture.mf.dispose();
  }
});
