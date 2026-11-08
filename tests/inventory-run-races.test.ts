import assert from "node:assert/strict";
import test from "node:test";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { canonical } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { inventoryRunFixture } from "./inventory-run-fixtures.ts";

type Fixture = Awaited<ReturnType<typeof inventoryRunFixture>>;
const TABLES = [
  "inventory_scopes",
  "inventory_streams",
  "inventory_records",
  "inventory_record_facets",
  "inventory_payloads",
  "inventory_births",
  "projection_domains",
  "inventory_work",
  "inventory_runs",
  "inventory_stream_jobs",
  "inventory_run_membership",
  "inventory_partition_membership",
  "inventory_coverage",
  "inventory_wakeups",
  "ingestion_pages",
  "ingestion_page_rows",
  "ingestion_page_guards",
  "ingestion_run_pages",
  "inventory_quarantine_rows",
] as const;

async function snapshot(f: Fixture) {
  return Promise.all(
    TABLES.map(async (table) => ({
      table,
      rows: (await f.db.prepare(`SELECT * FROM ${table}`).all()).results
        .map(canonical)
        .sort(),
    })),
  );
}

function loseOneAcknowledgement(f: Fixture) {
  let lost = false;
  return new InventoryIngestion(
    new Store(
      new Proxy(f.db, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              if (!lost) {
                lost = true;
                throw new Error("synthetic lost inventory acknowledgement");
              }
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      f.store.keys,
    ),
  );
}

async function reachPublishing(f: Fixture, id: string) {
  for (let turns = 0; turns < 20; turns++) {
    const context = await f.runs.context("a", id);
    if (context.run.phase === "publishing") return context;
    assert.equal(context.run.phase, "quarantining");
    await f.inventory.publish(
      await f.runs.prepareQuarantine(context, f.lease, { limit: 2 }),
    );
  }
  throw new Error("quarantine did not reach publication");
}

test("partial LoFi completion cannot publish a checkpoint or bypass catch-up", async () => {
  const f = await inventoryRunFixture();
  try {
    const run = await f.begin();
    const partial = await f.page(run.id, [f.qso("partial")], {
      observedComplete: true,
      completedStreams: ["operations"],
      proposedCheckpoint: { operations: 10, qsos: 20 },
    });
    const before = await snapshot(f);
    await assert.rejects(
      f.inventory.publish(partial),
      /inventory completion vector incomplete/,
    );
    assert.deepEqual(await snapshot(f), before);
    await f.inventory.publish(
      await f.page(run.id, [f.qso("partial")], {
        completedStreams: ["operations"],
      }),
    );
    assert.equal((await f.runs.load("a", run.id))?.phase, "collecting");
    assert.deepEqual(
      (await f.inventory.snapshot("a", f.scope, "sync"))?.checkpoint,
      {},
    );
    await f.observed(run.id, [], { vector: "collected" });
    const catchup = await f.runs.context("a", run.id);
    assert.equal(catchup.run.phase, "catchup");
    await assert.rejects(async () => {
      await f.runs.prepareComplete(catchup, f.lease);
    }, /inventory_run_not_publishable/);
    await f.observed(run.id, [], { vector: "caught-up" });
    await f.finish(run.id);
    assert.deepEqual(
      (await f.inventory.snapshot("a", f.scope, "sync"))?.checkpoint,
      { vector: "caught-up" },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native run guard rejects wrong request binding and a forged reading phase", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const run = await f.begin();
    const wrong = await f.page(run.id, [f.qso("wrong")], {
      requestBinding: "different-selection",
    });
    const before = await snapshot(f);
    await assert.rejects(f.inventory.publish(wrong), /inventory run changed/);
    assert.deepEqual(await snapshot(f), before);
    await f.observed(run.id, [f.qso("valid")]);
    const context = await f.runs.context("a", run.id);
    assert.equal(context.run.phase, "quarantining");
    const forged = structuredClone(context);
    forged.run.phase = "collecting";
    const page = await f.runs.preparePage(forged, f.lease, {
      observations: [f.qso("wrong-phase")],
      requestStartedAt: Date.now(),
      requestBinding: "collect-v1",
      nextResume: {},
      observedComplete: false,
      completedStreams: [],
      nextDueAt: Date.now(),
    });
    const quarantining = await snapshot(f);
    await assert.rejects(f.inventory.publish(page), /inventory run changed/);
    assert.deepEqual(await snapshot(f), quarantining);
  } finally {
    await f.mf.dispose();
  }
});

test("a managed stream cannot advance through a runless observation page", async () => {
  const f = await inventoryRunFixture();
  try {
    await f.begin();
    const stream = await f.inventory.snapshot("a", f.scope, "sync");
    assert.ok(stream);
    const page = await f.inventory.prepare({
      pageId: "runless-attempt",
      stream,
      lease: f.lease,
      facet: "source",
      requestStartedAt: Date.now(),
      origin: "historical",
      observations: [f.qso("runless")],
      nextResume: { unsafe: "advance" },
      nextCheckpoint: { unsafe: "checkpoint" },
    });
    const before = await snapshot(f);
    await assert.rejects(
      f.inventory.publish(page),
      /managed inventory stream requires run/,
    );
    assert.deepEqual(await snapshot(f), before);
  } finally {
    await f.mf.dispose();
  }
});

test("a page captured before another accepted page cannot restore the old run cursor", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const run = await f.begin();
    const older = await f.page(run.id, [f.qso("older")], {
      nextResume: { cursor: "older-position" },
    });
    const newer = await f.page(run.id, [f.qso("newer")], {
      nextResume: { cursor: "newer-position" },
    });
    await f.inventory.publish(newer);
    const before = await snapshot(f);
    await assert.rejects(f.inventory.publish(older), /inventory/);
    assert.deepEqual(await snapshot(f), before);
    assert.deepEqual(
      (await f.inventory.snapshot("a", f.scope, "sync"))?.resume,
      { cursor: "newer-position" },
    );
    assert.equal(
      await f.inventory.body("a", f.scope, "qso", "older", "receipt"),
      null,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("prepared run pages reject raced record, progress and current authority", async (t) => {
  const mutations = [
    "UPDATE inventory_records SET row_version=row_version+1 WHERE record_key='q'",
    "UPDATE inventory_record_facets SET row_version=row_version+1 WHERE record_key='q'",
    "UPDATE inventory_streams SET checkpoint_version=checkpoint_version+1",
    "UPDATE leases SET fence=fence+1",
    "UPDATE leases SET expires_at=0",
    "UPDATE connections SET credential_version='replacement' WHERE id='source'",
    "UPDATE private_data SET expires_at=1 WHERE connection='source' AND kind='credential'",
    "UPDATE connections SET config='{} ' WHERE id='source'",
    "UPDATE inventory_scopes SET config_version=config_version+1",
  ];
  for (const mutation of mutations)
    await t.test(mutation, async () => {
      const f = await inventoryRunFixture();
      try {
        const run = await f.begin();
        await f.inventory.publish(await f.page(run.id, [f.qso("q")]));
        const page = await f.page(run.id, [f.qso("q", 2)]);
        await f.db.prepare(mutation).run();
        const before = await snapshot(f);
        await assert.rejects(f.inventory.publish(page), /inventory/);
        assert.deepEqual(await snapshot(f), before);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("late quarantine failure rolls back membership, run cursor, checkpoint and wakeup", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const first = await f.begin();
    await f.observed(first.id, [f.qso("a"), f.qso("b")]);
    await f.finish(first.id);
    const next = await f.begin();
    await f.observed(next.id, [f.qso("a")]);
    const context = await f.runs.context("a", next.id);
    const page = await f.runs.prepareQuarantine(context, f.lease, { limit: 2 });
    await f.db
      .prepare(
        "CREATE TRIGGER reject_quarantine_cleanup BEFORE DELETE ON inventory_quarantine_rows BEGIN SELECT RAISE(ABORT,'quarantine tail rejected'); END",
      )
      .run();
    const before = await snapshot(f);
    await assert.rejects(f.inventory.publish(page), /quarantine tail rejected/);
    assert.deepEqual(await snapshot(f), before);
    await f.db.prepare("DROP TRIGGER reject_quarantine_cleanup").run();
    await f.inventory.publish(page);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT state FROM inventory_partition_membership WHERE record_key='b'",
          )
          .first<{ state: string }>()
      )?.state,
      "unresolved",
    );
    assert.deepEqual((await f.runs.load("a", next.id))?.cursor, {
      family: "qso",
      key: "b",
    });
  } finally {
    await f.mf.dispose();
  }
});

test("quarantine rejects changed member versions and insertions inside the prepared cursor range", async (t) => {
  for (const race of ["version", "insert"] as const)
    await t.test(race, async () => {
      const f = await inventoryRunFixture("qrz");
      try {
        const main = await f.begin();
        await f.observed(main.id, [f.qso("a"), f.qso("c")]);
        await f.finish(main.id);
        const other = await f.begin({
          partition: "other",
          partitionBinding: "other-selection",
        });
        await f.observed(other.id, [f.qso("b")]);
        await f.finish(other.id);
        const next = await f.begin();
        await f.observed(next.id, [f.qso("a")]);
        const context = await f.runs.context("a", next.id);
        const page = await f.runs.prepareQuarantine(context, f.lease, {
          limit: 2,
        });
        await f.db
          .prepare(
            race === "version"
              ? "UPDATE inventory_partition_membership SET row_version=row_version+1 WHERE partition_id='all' AND record_key='c'"
              : "INSERT INTO inventory_partition_membership SELECT tenant,scope_id,stream_id,facet,'all',entity_family,record_key,state,1,facet_version,last_accepted_sequence,last_observed_at,last_run_id FROM inventory_partition_membership WHERE partition_id='other' AND record_key='b'",
          )
          .run();
        const before = await snapshot(f);
        await assert.rejects(
          f.inventory.publish(page),
          /inventory quarantine (member|cursor) changed/,
        );
        assert.deepEqual(await snapshot(f), before);
        assert.equal((await f.runs.load("a", next.id))?.cursor, null);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("page and completion ACK recovery never duplicate membership, epochs or wakeups", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const run = await f.begin();
    const page = await f.page(run.id, [f.qso("q")], {
      pageId: "lost-page-ack",
      observedComplete: true,
      completedStreams: ["selection"],
      proposedCheckpoint: { completed: 7 },
    });
    const recovered = await loseOneAcknowledgement(f).publish(page);
    assert.equal(recovered.recovered, true);
    const afterPage = await snapshot(f);
    await f.inventory.publish(page);
    await f.inventory.publish(page);
    assert.deepEqual(await snapshot(f), afterPage);
    const context = await reachPublishing(f, run.id);
    const witness = (
      await f.db.prepare("SELECT * FROM inventory_record_facets").all()
    ).results;
    const complete = await f.runs.prepareComplete(context, f.lease);
    assert.equal(
      (await loseOneAcknowledgement(f).publish(complete)).recovered,
      true,
    );
    const afterComplete = await snapshot(f);
    await f.inventory.publish(complete);
    assert.deepEqual(await snapshot(f), afterComplete);
    const coverage = await f.runs.coverage(
      "a",
      f.scope,
      "sync",
      "receipt",
      "all",
    );
    assert.equal(coverage?.epoch, 1);
    assert.equal(coverage?.published_run_id, run.id);
    assert.equal((await f.runs.pendingWakeups()).length, 1);
    assert.deepEqual(
      (await f.db.prepare("SELECT * FROM inventory_record_facets").all())
        .results,
      witness,
    );
    const newer = await f.begin();
    const whileNewerRuns = await snapshot(f);
    assert.equal((await f.inventory.publish(complete)).recovered, true);
    assert.deepEqual(await snapshot(f), whileNewerRuns);
    assert.equal((await f.runs.load("a", newer.id))?.phase, "collecting");
  } finally {
    await f.mf.dispose();
  }
});

test("a late coverage publication error cannot leave completed run or checkpoint state", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const run = await f.begin();
    await f.observed(run.id, [f.qso("q")], { publish: "after-guard" });
    const context = await reachPublishing(f, run.id);
    const complete = await f.runs.prepareComplete(context, f.lease);
    await f.db
      .prepare(
        "CREATE TRIGGER corrupt_ready_coverage AFTER UPDATE ON inventory_coverage WHEN NEW.state='ready' BEGIN UPDATE inventory_coverage SET state='partial',version=version+1 WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND stream_id=NEW.stream_id AND facet=NEW.facet AND partition_id=NEW.partition_id; END",
      )
      .run();
    const before = await snapshot(f);
    await assert.rejects(f.inventory.publish(complete), /inventory/);
    assert.deepEqual(await snapshot(f), before);
    assert.equal((await f.runs.load("a", run.id))?.phase, "publishing");
    assert.deepEqual(
      (await f.inventory.snapshot("a", f.scope, "sync"))?.checkpoint,
      {},
    );
  } finally {
    await f.mf.dispose();
  }
});

test("selective verification leaves the other partition's membership and coverage untouched", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const east = await f.begin({
      partition: "east",
      partitionBinding: "east-selection",
    });
    await f.observed(east.id, [f.qso("east-record")]);
    await f.finish(east.id);
    const west = await f.begin({
      partition: "west",
      partitionBinding: "west-selection",
    });
    await f.observed(west.id, [f.qso("west-record")]);
    await f.finish(west.id);
    const westBefore = await f.runs.coverage(
      "a",
      f.scope,
      "sync",
      "receipt",
      "west",
    );
    const missingEast = await f.begin({
      partition: "east",
      partitionBinding: "east-selection",
    });
    await f.observed(missingEast.id);
    await f.finish(missingEast.id);
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT partition_id,record_key,state FROM inventory_partition_membership ORDER BY partition_id",
          )
          .all()
      ).results,
      [
        {
          partition_id: "east",
          record_key: "east-record",
          state: "unresolved",
        },
        { partition_id: "west", record_key: "west-record", state: "present" },
      ],
    );
    assert.deepEqual(
      await f.runs.coverage("a", f.scope, "sync", "receipt", "west"),
      westBefore,
    );
    assert.ok(
      await f.inventory.body("a", f.scope, "qso", "east-record", "receipt"),
    );
  } finally {
    await f.mf.dispose();
  }
});

test("an empty delta is positive-only without baseline and cannot enter quarantine", async () => {
  const f = await inventoryRunFixture("qrz");
  try {
    const delta = await f.begin({ mode: "delta" });
    await f.observed(delta.id, [f.qso("q")]);
    const context = await f.runs.context("a", delta.id);
    await assert.rejects(
      f.runs.prepareQuarantine(context, f.lease),
      /inventory_run_not_quarantining/,
    );
    await f.finish(delta.id);
    const witness = (
      await f.db.prepare("SELECT * FROM inventory_record_facets").all()
    ).results;
    const empty = await f.begin({ mode: "delta" });
    await f.observed(empty.id);
    await f.finish(empty.id);
    const coverage = await f.runs.coverage(
      "a",
      f.scope,
      "sync",
      "receipt",
      "all",
    );
    assert.equal(coverage?.state, "partial");
    assert.equal(coverage?.kind, "positive_only");
    assert.equal(coverage?.published_run_id, null);
    assert.equal(coverage?.epoch, 0);
    assert.deepEqual(
      (await f.db.prepare("SELECT * FROM inventory_record_facets").all())
        .results,
      witness,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT state FROM inventory_partition_membership")
          .first<{ state: string }>()
      )?.state,
      "present",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("newer same-facet observations survive quarantine without a stale run refreshing their witness", async () => {
  const f = await inventoryRunFixture();
  try {
    const first = await f.begin();
    await f.observed(first.id, [f.qso("q", 1)]);
    await f.observed(first.id);
    await f.finish(first.id);
    const next = await f.begin();
    await f.observed(next.id);
    await f.observed(next.id, [f.qso("q", 0)]);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_run_membership WHERE run_id=? AND record_key='q'",
          )
          .bind(next.id)
          .first<{ n: number }>()
      )?.n,
      0,
      "the stale response contributes no current-version witness",
    );
    const stream = await f.inventory.initialize(
      f.initial,
      "forward-observation",
      "forward-observation-v1",
    );
    await f.inventory.publish(
      await f.inventory.prepare({
        pageId: "newer-forward-witness",
        stream,
        lease: f.lease,
        facet: "source",
        origin: "forward",
        requestStartedAt: Date.now(),
        observations: [f.qso("q", 2)],
        nextResume: {},
      }),
    );
    const witness = await f.db
      .prepare("SELECT * FROM inventory_record_facets WHERE record_key='q'")
      .first<{
        row_version: number;
        revision: string;
        body_hash: string;
        last_accepted_sequence: number;
        last_observed_at: number;
        last_page_id: string;
      }>();
    assert.ok(witness);
    await f.finish(next.id);
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM inventory_record_facets WHERE record_key='q'")
        .first(),
      witness,
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT facet_version,revision,body_hash,accepted_sequence,observed_at,last_page_id FROM inventory_run_membership WHERE run_id=? AND record_key='q'",
        )
        .bind(next.id)
        .first(),
      {
        facet_version: witness.row_version,
        revision: witness.revision,
        body_hash: witness.body_hash,
        accepted_sequence: witness.last_accepted_sequence,
        observed_at: witness.last_observed_at,
        last_page_id: witness.last_page_id,
      },
      "quarantine preserves the actual newer observation instead of renewing it",
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT state FROM inventory_partition_membership WHERE record_key='q'",
          )
          .first<{ state: string }>()
      )?.state,
      "present",
    );
  } finally {
    await f.mf.dispose();
  }
});
