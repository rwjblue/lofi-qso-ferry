import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonLookup } from "../src/inventory-comparison-lookup.ts";
import {
  InventoryProjectionWorkspace,
  inventoryProjectionDigest,
  type PreparedInventoryProjections,
} from "../src/inventory-projection-workspace.ts";
import { InventoryProjections } from "../src/inventory-projections.ts";
import { Store } from "../src/store.ts";
import { fixture, observation } from "./inventory-context-fixtures.ts";
import { receiptFixture } from "./inventory-receipt-fixtures.ts";

async function sourceFixture(count = 1, testOperation = false) {
  const f = await fixture();
  const op = observation("op", "operation");
  if (testOperation) op.body = { uuid: "op", stationCall: "T/N1RWJ" };
  const qsos = Array.from({ length: count }, (_, i) => observation(`q${i}`));
  await f.full([op, ...qsos]);
  await new InventoryComparisonBuilds(f.store).step(
    "a",
    f.generation,
    "source",
  );
  const lease = await f.store.claim(
    "a",
    `projection:${f.generation}:source`,
    Date.now(),
    60_000,
  );
  assert.ok(lease);
  return {
    ...f,
    projectionLease: lease,
    keys: qsos.map((row) => row.key),
    workspace: new InventoryProjectionWorkspace(f.store),
    projections: new InventoryProjections(f.store),
  };
}
async function prepare(f: Awaited<ReturnType<typeof sourceFixture>>) {
  return f.workspace.prepare("a", f.generation, "source", f.keys);
}
async function scratchEmpty(f: Awaited<ReturnType<typeof sourceFixture>>) {
  for (const table of [
    "comparison_projection_rows",
    "comparison_projection_dependencies",
    "comparison_projection_guards",
  ])
    assert.equal(
      (
        await f.db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
      table,
    );
}
async function uncommitted(f: Awaited<ReturnType<typeof sourceFixture>>) {
  for (const table of [
    "comparison_projections",
    "comparison_projection_payloads",
    "comparison_projection_pages",
  ])
    assert.equal(
      (
        await f.db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
      table,
    );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM comparison_work WHERE record_key LIKE 'q%' AND completed_version>0",
        )
        .first<{ n: number }>()
    )?.n,
    0,
  );
  await scratchEmpty(f);
}
async function resign(page: PreparedInventoryProjections) {
  const { digest: _digest, ...input } = page;
  page.digest = await inventoryProjectionDigest(input);
}

test("bulk publication stores encrypted bodies, advances versions/work together and preserves raw witnesses and credentials", async (t) => {
  const f = await sourceFixture(20);
  try {
    const before = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const witnesses = (
      await f.db
        .prepare(
          "SELECT record_key,first_observed_at,last_observed_at FROM inventory_record_facets ORDER BY record_key",
        )
        .all()
    ).results;
    const page = await prepare(f);
    const result = await f.projections.publish(
      page,
      f.projectionLease,
      "bulk-projection",
    );
    assert.equal(result.records, 20);
    assert.equal(result.ready, 20);
    assert.ok(result.statements < 20);
    t.diagnostic(
      `20 source projections: ${result.statements} publication statements, ${result.rowsRead} rows read, ${result.rowsWritten} rows written`,
    );
    const body = await f.projections.body(
      "a",
      f.generation,
      "source",
      "q0",
      "source",
    );
    assert.ok(body);
    assert.equal(body.version, 1);
    assert.equal(body.body.record.CALL, "W1AW");
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT record_key,first_observed_at,last_observed_at FROM inventory_record_facets ORDER BY record_key",
          )
          .all()
      ).results,
      witnesses,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_work WHERE record_key LIKE 'q%' AND work_version=completed_version",
          )
          .first<{ n: number }>()
      )?.n,
      20,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_projection_payloads WHERE envelope LIKE '%\"CALL\"%'",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("unchanged full verification keeps a ready projection current without reprojecting or renewing its derivation time", async () => {
  const f = await sourceFixture();
  try {
    await f.projections.publish(await prepare(f), f.projectionLease);
    const before = await f.db
      .prepare(
        "SELECT version,payload_id,derived_at,coverage_version FROM comparison_projections WHERE record_key='q0'",
      )
      .first();
    await f.full([observation("op", "operation"), observation("q0")]);
    const body = await f.projections.body(
      "a",
      f.generation,
      "source",
      "q0",
      "source",
    );
    assert.ok(body);
    assert.equal(body.version, 1);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT version,payload_id,derived_at,coverage_version FROM comparison_projections WHERE record_key='q0'",
        )
        .first(),
      before,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("test exclusions retain their hash and stale context cannot keep a formerly excluded source hidden", async () => {
  const f = await sourceFixture(1, true);
  try {
    const key = await f.db
      .prepare(
        "SELECT key_class,bucket_hash FROM comparison_index WHERE record_key='q0'",
      )
      .first();
    const result = await f.projections.publish(
      await prepare(f),
      f.projectionLease,
    );
    assert.equal(result.excluded, 1);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT key_class,bucket_hash FROM comparison_index WHERE record_key='q0'",
        )
        .first(),
      key,
    );
    assert.equal(
      (await f.projections.body("a", f.generation, "source", "q0", "source"))
        ?.body.state,
      "excluded",
    );
    const lookup = new InventoryComparisonLookup(f.store);
    const request = [
      {
        id: "selected",
        scope: "source",
        record: { CALL: "W1AW", QSO_DATE: "20261108", TIME_ON: "123000" },
      },
    ];
    const excluded = await lookup.probe("a", request, {
      generation: f.generation,
    });
    assert.equal(
      excluded.observations[0].candidates[0].projectionState,
      "excluded",
    );
    await f.full([
      {
        ...observation("op", "operation", 2),
        body: { uuid: "op", stationCall: "N1RWJ" },
      },
      observation("q0"),
    ]);
    assert.equal(
      await f.projections.body("a", f.generation, "source", "q0", "source"),
      null,
    );
    const pending = await lookup.probe("a", request, {
      generation: f.generation,
    });
    assert.equal(pending.observations[0].candidates.length, 1);
    assert.equal(pending.observations[0].candidates[0].state, "pending");
    assert.equal(pending.observations[0].candidates[0].projectionState, null);
    await f.projections.publish(await prepare(f), f.projectionLease);
    const body = await f.projections.body(
      "a",
      f.generation,
      "source",
      "q0",
      "source",
    );
    assert.equal(body?.body.state, "ready");
    assert.equal(body?.version, 2);
  } finally {
    await f.mf.dispose();
  }
});

test("bulk lookup keeps a published projection available across unchanged verification without hiding collecting context", async () => {
  const f = await sourceFixture();
  try {
    await f.projections.publish(await prepare(f), f.projectionLease);
    await new InventoryComparisonBuilds(f.store).activate("a", f.generation);
    const lookup = new InventoryComparisonLookup(f.store),
      request = [
        {
          id: "selected",
          scope: "source",
          record: { CALL: "W1AW", QSO_DATE: "20261108", TIME_ON: "123000" },
        },
      ];
    const before = await lookup.probe("a", request);
    assert.equal(before.observations[0].state, "observed");
    assert.equal(
      before.observations[0].candidates[0].currentProjectionVersion,
      1,
    );
    const run = await f.begin();
    const collecting = await lookup.probe("a", request);
    assert.equal(collecting.observations[0].state, "pending");
    assert.equal(collecting.observations[0].candidates.length, 1);
    assert.equal(collecting.observations[0].candidates[0].payload, null);
    await f.observed(run.id, [
      observation("op", "operation"),
      observation("q0"),
    ]);
    await f.observed(run.id, []);
    await f.finish(run.id);
    const after = await lookup.probe("a", request);
    assert.equal(after.observations[0].state, "observed");
    assert.equal(
      after.observations[0].candidates[0].currentProjectionVersion,
      1,
    );
    assert.equal(
      after.observations[0].candidates[0].payload,
      before.observations[0].candidates[0].payload,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native authority and work races roll the whole projection cohort back", async (t) => {
  for (const sql of [
    "UPDATE leases SET expires_at=0 WHERE scope LIKE 'projection:%'",
    "UPDATE accounts SET status='locked' WHERE id='a'",
    "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source'",
    "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant='a'",
    "UPDATE comparison_work SET work_version=work_version+1 WHERE record_key='q1'",
    "UPDATE comparison_index SET projection_version=projection_version+1 WHERE record_key='q1'",
  ])
    await t.test(sql, async () => {
      const f = await sourceFixture(2);
      try {
        const page = await prepare(f);
        await f.db.prepare(sql).run();
        await assert.rejects(
          f.projections.publish(page, f.projectionLease),
          /changed/,
        );
        await uncommitted(f);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("native event-closure checks reject omitted dependencies even after the application manifest is recomputed", async () => {
  const f = await sourceFixture();
  try {
    await f.full([
      observation("op", "operation"),
      observation("event", "event"),
      observation("q0"),
    ]);
    const page = await prepare(f);
    page.dependencies = page.dependencies.filter((row) => row.key !== "event");
    await resign(page);
    await assert.rejects(
      f.projections.publish(page, f.projectionLease),
      /event closure incomplete/,
    );
    await uncommitted(f);
  } finally {
    await f.mf.dispose();
  }
});

test("raced source dependencies and coverage are independent native barriers", async () => {
  const f = await sourceFixture();
  try {
    const page = await prepare(f);
    await f.full([
      {
        ...observation("op", "operation", 2),
        body: { uuid: "op", stationCall: "K1ABC" },
      },
      observation("q0"),
    ]);
    await assert.rejects(
      f.projections.publish(page, f.projectionLease),
      /coverage changed/,
    );
    const fresh = await prepare(f);
    page.coverage = fresh.coverage;
    await resign(page);
    await assert.rejects(
      f.projections.publish(page, f.projectionLease),
      /dependency changed|input changed/,
    );
    await uncommitted(f);
  } finally {
    await f.mf.dispose();
  }
});

test("an event added after preparation cannot be omitted by copying newer coverage and topology into the manifest", async () => {
  const f = await sourceFixture();
  try {
    const page = await prepare(f);
    await f.full([
      observation("op", "operation"),
      observation("event", "event"),
      observation("q0"),
    ]);
    const fresh = await prepare(f);
    page.coverage = fresh.coverage;
    page.inputs[0].topology_version = fresh.inputs[0].topology_version;
    await resign(page);
    await assert.rejects(
      f.projections.publish(page, f.projectionLease),
      /event closure incomplete/,
    );
    await uncommitted(f);
  } finally {
    await f.mf.dispose();
  }
});

test("a held projection requires an explicit fixed reason and a late constraint failure rolls its body back", async () => {
  const f = await sourceFixture();
  try {
    const page = await prepare(f);
    page.rows[0].state = "held";
    page.rows[0].reason = null;
    await resign(page);
    await assert.rejects(
      f.projections.publish(page, f.projectionLease),
      /CHECK constraint/,
    );
    await uncommitted(f);
  } finally {
    await f.mf.dispose();
  }
});

test("a preparation cannot claim ready operation context before upstream coverage completes", async () => {
  const f = await sourceFixture();
  try {
    const run = await f.begin();
    await f.observed(run.id, [
      observation("op", "operation"),
      observation("q0"),
    ]);
    const page = await prepare(f);
    assert.equal(page.rows[0].state, "held");
    page.rows[0].state = "ready";
    page.rows[0].reason = null;
    await resign(page);
    await assert.rejects(
      f.projections.publish(page, f.projectionLease),
      /source context incomplete/,
    );
    await uncommitted(f);
  } finally {
    await f.mf.dispose();
  }
});

test("multi-contact capacity holds require splitting and cannot complete otherwise projectable work", async () => {
  const f = await sourceFixture(2);
  try {
    const page = await prepare(f);
    page.rows.forEach((row) => {
      row.state = "held";
      row.reason = "projection_context_bound";
    });
    await resign(page);
    await assert.rejects(
      f.projections.publish(page, f.projectionLease),
      /split_required/,
    );
    await uncommitted(f);
  } finally {
    await f.mf.dispose();
  }
});

test("late SQL failure rolls encrypted output back and replay recovers without duplicate versions", async () => {
  const f = await sourceFixture();
  try {
    const page = await prepare(f);
    await f.db
      .prepare(
        "CREATE TRIGGER fail_projection BEFORE UPDATE ON comparison_projection_pages WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'injected projection failure'); END;",
      )
      .run();
    await assert.rejects(
      f.projections.publish(page, f.projectionLease, "failure-page"),
      /injected projection failure/,
    );
    await uncommitted(f);
    await f.db.prepare("DROP TRIGGER fail_projection").run();
    await f.projections.publish(page, f.projectionLease, "failure-page");
    assert.equal(
      (await f.projections.publish(page, f.projectionLease, "failure-page"))
        .recovered,
      true,
    );
    assert.equal(
      (await f.projections.body("a", f.generation, "source", "q0", "source"))
        ?.version,
      1,
    );
    await assert.rejects(
      f.projections.publish(page, f.projectionLease, "new-page-same-old-input"),
      /input changed/,
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("publication rechecks authority after admission instead of trusting a staged guard row", async () => {
  const f = await sourceFixture();
  try {
    const page = await prepare(f);
    await f.db
      .prepare(
        "CREATE TRIGGER change_projection_authority AFTER INSERT ON comparison_projections BEGIN UPDATE accounts SET status='locked' WHERE id=NEW.tenant; END;",
      )
      .run();
    await assert.rejects(
      f.projections.publish(page, f.projectionLease),
      /publication guard missing/,
    );
    await uncommitted(f);
    assert.equal(
      (
        await f.db
          .prepare("SELECT status FROM accounts WHERE id='a'")
          .first<{ status: string }>()
      )?.status,
      "active",
      "the authority mutation rolled back too",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("lost acknowledgements recover a receipt while a newer semantic invalidation remains pending", async () => {
  const f = await sourceFixture();
  try {
    const page = await prepare(f);
    const uncertain = new InventoryProjections(
      new Store(
        new Proxy(f.db, {
          get(target, property) {
            if (property === "batch")
              return async (statements: D1PreparedStatement[]) => {
                await target.batch(statements);
                throw new Error("lost acknowledgement");
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
        f.store.keys,
      ),
    );
    assert.equal(
      (await uncertain.publish(page, f.projectionLease, "uncertain")).recovered,
      true,
    );
    const changed = observation("q0", "qso", 2);
    changed.body = {
      ...(changed.body as object),
      notes: "changed source content",
    };
    await f.full([observation("op", "operation"), changed]);
    assert.equal(
      (await f.projections.publish(page, f.projectionLease, "uncertain"))
        .recovered,
      true,
    );
    assert.equal(
      await f.projections.body("a", f.generation, "source", "q0", "source"),
      null,
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q0'",
        )
        .first(),
      { work_version: 2, completed_version: 1 },
    );
  } finally {
    await f.mf.dispose();
  }
});

for (const provider of ["qrz", "lotw"] as const)
  test(`${provider} publication retains precision and makes unsupported receipts held`, async () => {
    const f = await receiptFixture(provider);
    try {
      const publisher = new InventoryProjections(f.store);
      const result = await publisher.project("a", f.generation, "destination", [
        "1",
        "2",
      ]);
      assert.ok("records" in result);
      assert.equal(result.records, 2);
      assert.equal(result.ready, 1);
      assert.equal(result.held, 1);
      const one = await publisher.body(
        "a",
        f.generation,
        "destination",
        "1",
        "receipt",
      );
      assert.ok(one);
      assert.equal(one.body.record.TIME_ON, "1230");
      const two = await publisher.body(
        "a",
        f.generation,
        "destination",
        "2",
        "receipt",
      );
      assert.equal(two?.body.state, "held");
      if (provider === "lotw")
        assert.equal(one.body.record.APP_LOTW_MODE, "FT8");
    } finally {
      await f.mf.dispose();
    }
  });

test("a source membership change makes stored output unavailable while an individual hard capacity hold is persistable", async () => {
  const f = await sourceFixture();
  try {
    await f.projections.publish(await prepare(f), f.projectionLease);
    await f.full([observation("op", "operation")]);
    assert.equal(
      await f.projections.body("a", f.generation, "source", "q0", "source"),
      null,
    );
    const held = await prepare(f);
    assert.equal(held.rows[0].state, "held");
    assert.equal(held.rows[0].reason, "source_membership_unresolved");
    await f.projections.publish(held, f.projectionLease);
    assert.equal(
      (await f.projections.body("a", f.generation, "source", "q0", "source"))
        ?.body.state,
      "held",
    );
    await f.full([
      observation("op", "operation"),
      observation("q0"),
      ...Array.from({ length: 256 }, (_, i) => {
        const row = observation(`event${i}`, "event");
        row.body = {
          ...(row.body as object),
          startAtMillis: Date.parse("2026-11-08T12:30:00Z") - i * 60000,
        };
        return row;
      }),
    ]);
    const bounded = await prepare(f);
    assert.equal(bounded.rows[0].reason, "projection_context_bound");
    const result = await f.projections.publish(bounded, f.projectionLease);
    assert.equal(result.held, 1);
    assert.equal(
      (await f.projections.body("a", f.generation, "source", "q0", "source"))
        ?.body.state,
      "held",
    );
  } finally {
    await f.mf.dispose();
  }
});
