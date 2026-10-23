import assert from "node:assert/strict";
import test from "node:test";
import {
  establishCutovers,
  proveNewAfterCutover,
  recordBirth,
} from "../src/cutover.ts";
import { classifyHistory } from "../src/reconcile.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations, FIXTURE_NOW } from "./runtime-fixtures.ts";
async function setup(kind = "lotw") {
  const h = await database();
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await h.store
    .statement("UPDATE connections SET kind=? WHERE id='destination'", kind)
    .run();
  const source = (await h.store.connection("a", "source"))!;
  const key = (qso: string, destination = "destination") => ({
    tenant: "a",
    source: "source",
    qso,
    destination,
  });
  async function page(
    mode: string,
    qsos: string[],
    complete = true,
    stream = "sync",
    now = FIXTURE_NOW,
  ) {
    const cursor = await h.store
      .statement(
        "SELECT generation FROM cursors WHERE tenant=? AND connection=? AND stream=?",
        "a",
        "source",
        stream,
      )
      .first<{ generation: number }>();
    const generation = (cursor?.generation ?? 0) + 1;
    const lease = (await h.store.claim("a", `page:${stream}`, now, 1000))!;
    assert(lease);
    const work = qsos.map((qso) =>
      recordBirth(h.store, "a", "source", qso, stream, mode, generation, now),
    );
    if (stream === "sync")
      work.push(
        h.store.statement(
          "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','context',?,1,?) ON CONFLICT(tenant,connection,stream) DO UPDATE SET cursor=excluded.cursor,generation=generation+1,updated_at=excluded.updated_at",
          JSON.stringify({ complete, syncComplete: complete }),
          now,
        ),
      );
    try {
      await h.store.checkpoint(
        lease,
        "source",
        stream,
        cursor?.generation ?? 0,
        {
          mode: complete ? "forward" : mode,
          operations: {},
          qsos: {},
          ...(stream === "sync" ? {} : { rescanComplete: complete }),
        },
        work,
        now,
      );
    } finally {
      await h.store.release(lease);
    }
  }
  return { ...h, source, key, page };
}
const verified = { sourceBoundaryVerified: true };
test("history remains unverified without query access and the unverified default creates no cutover", async () => {
  const h = await setup();
  try {
    await h.page("backfill", ["historical"]);
    assert.equal(
      await establishCutovers(
        h.store,
        h.source,
        { sourceBoundaryVerified: false },
        FIXTURE_NOW,
      ),
      0,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("historical")),
      false,
    );
    const outcome = classifyHistory(
      {
        STATION_CALLSIGN: "W1AW",
        CALL: "K1ABC",
        QSO_DATE: "20261022",
        TIME_ON: "120001",
        BAND: "20m",
        MODE: "FT8",
      },
      [],
      {
        destination: "lotw",
        capturedGeneration: "g1",
        currentGeneration: "g1",
        readAccess: false,
        inventoryComplete: false,
        catchupComplete: true,
        freshCheckComplete: false,
        provenNewAfterCutover: await proveNewAfterCutover(
          h.store,
          h.key("historical"),
        ),
      },
    );
    assert.equal(outcome.state, "historical_unverified");
    assert.equal(
      await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 1),
      1,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("historical")),
      false,
    );
    assert.equal(
      (await h.store
        .statement("SELECT phase FROM source_births WHERE qso='historical'")
        .first<{ phase: string }>())!.phase,
      "history",
    );
    await assert.rejects(
      h.store.statement("UPDATE source_births SET phase='forward_new'").run(),
      /immutable/,
    );
    await assert.rejects(
      h.store.statement("UPDATE source_cutovers SET source_generation=0").run(),
      /immutable/,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("only a first-seen forward UUID after the cursor cutover is live, independent of its old QSO date", async () => {
  const h = await setup();
  try {
    await h.page("backfill", ["old"]);
    await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 1);
    await h.page(
      "forward",
      ["offline-old-dated"],
      true,
      "sync",
      FIXTURE_NOW + 2,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("offline-old-dated")),
      true,
    );
    const outcome = classifyHistory(
      {
        STATION_CALLSIGN: "W1AW",
        CALL: "K1ABC",
        QSO_DATE: "20000101",
        TIME_ON: "120001",
        BAND: "20m",
        MODE: "FT8",
      },
      [],
      {
        destination: "lotw",
        capturedGeneration: "g2",
        currentGeneration: "g2",
        readAccess: false,
        inventoryComplete: false,
        catchupComplete: true,
        freshCheckComplete: false,
        provenNewAfterCutover: await proveNewAfterCutover(
          h.store,
          h.key("offline-old-dated"),
        ),
      },
    );
    assert.equal(outcome.state, "live_new");
    const row = (await h.store
      .statement(
        "SELECT first_cursor_generation FROM source_births WHERE qso='offline-old-dated'",
      )
      .first<{ first_cursor_generation: number }>())!;
    assert.equal(row.first_cursor_generation, 2);
    assert.equal(
      await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 3),
      0,
      "cutover cannot drift forward and strand already-new contacts",
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("offline-old-dated")),
      true,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("rescanned history, legacy metadata and restored UUIDs cannot become new on replay", async () => {
  const h = await setup();
  try {
    await h.page("backfill", ["old"]);
    await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 1);
    await h.page(
      "backfill",
      ["late-history"],
      true,
      "rescan:destination",
      FIXTURE_NOW + 2,
    );
    await h.store
      .statement(
        "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at) VALUES('a','source','legacy','qso',NULL,'purged','retained-hash','archived',0)",
      )
      .run();
    await h.page(
      "forward",
      ["old", "late-history", "legacy"],
      true,
      "sync",
      FIXTURE_NOW + 3,
    );
    for (const qso of ["old", "late-history", "legacy"])
      assert.equal(await proveNewAfterCutover(h.store, h.key(qso)), false);
    await h.store.statement("DELETE FROM source_work WHERE id='legacy'").run();
    await h.page("forward", ["legacy"], true, "sync", FIXTURE_NOW + 4);
    assert.equal(await proveNewAfterCutover(h.store, h.key("legacy")), false);
    assert.equal(
      (await h.store
        .statement("SELECT phase FROM source_births WHERE qso='legacy'")
        .first<{ phase: string }>())!.phase,
      "history",
    );
  } finally {
    await h.mf.dispose();
  }
});
test("partial source and destination inventories never establish a cutoff; destination epochs isolate births", async () => {
  const h = await setup();
  try {
    await h.page("backfill", ["old"], false);
    assert.equal(
      await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 1),
      0,
    );
    await h.page("backfill", [], true, "sync", FIXTURE_NOW + 2);
    assert.equal(
      await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 3),
      1,
    );
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','second','lotw','second-account','Second','active',?)",
        FIXTURE_NOW + 4,
      )
      .run();
    await h.page("backfill", ["old"], false, "rescan:second", FIXTURE_NOW + 5);
    await h.page(
      "forward",
      ["between-cutovers"],
      true,
      "sync",
      FIXTURE_NOW + 6,
    );
    assert.equal(
      await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 7),
      0,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("between-cutovers", "second")),
      false,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("between-cutovers")),
      true,
    );
    await h.page(
      "backfill",
      ["old", "between-cutovers"],
      true,
      "rescan:second",
      FIXTURE_NOW + 8,
    );
    assert.equal(
      await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 9),
      1,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("between-cutovers", "second")),
      false,
    );
    await h.page("forward", ["after-both"], true, "sync", FIXTURE_NOW + 10);
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("after-both")),
      true,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("after-both", "second")),
      true,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("tenant/source isolation and cursor rollback protect birth evidence", async () => {
  const h = await setup();
  try {
    await h.page("backfill", ["old"]);
    await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 1);
    await h.page("forward", ["new"], true, "sync", FIXTURE_NOW + 2);
    assert(await proveNewAfterCutover(h.store, h.key("new")));
    await seed(h.store, "b");
    assert.equal(
      await proveNewAfterCutover(h.store, { ...h.key("new"), tenant: "b" }),
      false,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, {
        ...h.key("new"),
        source: "another-source",
      }),
      false,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("new", "missing")),
      false,
    );
    const lease = (await h.store.claim(
      "a",
      "stale-page",
      FIXTURE_NOW + 3,
      1000,
    ))!;
    await assert.rejects(
      h.store.checkpoint(
        lease,
        "source",
        "sync",
        0,
        { mode: "forward" },
        [
          recordBirth(
            h.store,
            "a",
            "source",
            "rolled-back",
            "sync",
            "forward",
            3,
            FIXTURE_NOW + 3,
          ),
        ],
        FIXTURE_NOW + 3,
      ),
    );
    assert.equal(
      await h.store
        .statement("SELECT 1 n FROM source_births WHERE qso='rolled-back'")
        .first(),
      null,
    );
    await h.store
      .statement(
        "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source'",
      )
      .run();
    assert.equal(await proveNewAfterCutover(h.store, h.key("new")), false);
    assert.equal(
      await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 4),
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("registered Club Log destinations receive their own source cutover and new-contact proof", async () => {
  const h = await setup("clublog");
  try {
    await h.page("backfill", ["historical"]);
    assert.equal(
      await establishCutovers(h.store, h.source, verified, FIXTURE_NOW + 1),
      1,
    );
    assert.equal(
      await proveNewAfterCutover(h.store, h.key("historical")),
      false,
    );
    await h.page("forward", ["new"], true, "sync", FIXTURE_NOW + 2);
    assert.equal(await proveNewAfterCutover(h.store, h.key("new")), true);
    await h.store
      .statement(
        "UPDATE connections SET status='disabled' WHERE id='destination'",
      )
      .run();
    assert.equal(await proveNewAfterCutover(h.store, h.key("new")), false);
  } finally {
    await h.mf.dispose();
  }
});
