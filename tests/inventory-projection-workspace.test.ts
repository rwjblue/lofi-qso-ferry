import assert from "node:assert/strict";
import test from "node:test";
import { measureD1 } from "../scripts/inventory-benchmark-metrics.ts";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import type { InventoryObservation } from "../src/inventory-ingestion.ts";
import {
  type InventoryProjectionBody,
  InventoryProjectionWorkspace,
  inventoryProjectionDigest,
  inventoryProjectionIdentity,
  type PreparedInventoryProjections,
} from "../src/inventory-projection-workspace.ts";
import { type Envelope, open } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { fixture, observation } from "./inventory-context-fixtures.ts";
import { receiptFixture } from "./inventory-receipt-fixtures.ts";

const at = Date.parse("2026-11-08T12:30:00Z");
async function decrypt(
  f: { store: { keys: Parameters<typeof open>[2] } },
  page: PreparedInventoryProjections,
  key: string,
) {
  const row = page.rows.find((row) => row.key === key);
  assert.ok(row);
  const payload = page.payloads.find((payload) => payload.id === row.payload);
  assert.ok(payload);
  return open<InventoryProjectionBody>(
    JSON.parse(payload.envelope) as Envelope,
    inventoryProjectionIdentity(page.tenant, page.connection, payload.id),
    f.store.keys,
  );
}
async function ready(
  f: Awaited<ReturnType<typeof fixture>>,
  rows: InventoryObservation[],
) {
  await f.full(rows);
  const builds = new InventoryComparisonBuilds(f.store);
  for (let pass = 0; pass < 10; pass++) {
    const result = await builds.step("a", f.generation, "source");
    if ("complete" in result && result.complete)
      return new InventoryProjectionWorkspace(f.store);
  }
  throw new Error("workspace fixture index did not complete");
}
test("a source cohort decrypts shared context once, preserves precision, and returns only encrypted projections", async (t) => {
  const f = await fixture();
  try {
    const op = observation("op", "operation");
    op.body = { ...(op.body as object), grid: "FN31" };
    const event = observation("event", "event");
    const qsos = Array.from({ length: 20 }, (_, i) => {
      const row = observation(`q${i}`);
      row.body = {
        ...(row.body as object),
        startAtMillis: at + 123,
        notes: "Private survey narrative",
      };
      return row;
    });
    const workspace = await ready(f, [op, event, ...qsos]);
    const before = await f.inventory.snapshot("a", "source", "sync");
    let calls = 0;
    const statement = f.store.statement.bind(f.store);
    f.store.statement = (...args) => {
      calls++;
      return statement(...args);
    };
    const page = await workspace.prepare(
      "a",
      f.generation,
      "source",
      qsos.map((row) => row.key),
    );
    assert.equal(page.rows.length, 20);
    assert.ok(page.rows.every((row) => row.state === "ready"));
    assert.equal(page.stats.dependencies, 22);
    assert.equal(page.stats.decryptedBodies, 22);
    assert.equal(calls, 2);
    t.diagnostic(
      `20 source contacts with shared operation/event: ${calls} D1 calls, ${page.stats.decryptedBodies} body decryptions`,
    );
    const body = await decrypt(f, page, "q0");
    assert.equal(body.record.STATION_CALLSIGN, "K1ABC");
    assert.equal(body.record.MY_GRIDSQUARE, "FN31");
    assert.equal(body.record.TIME_ON, "123000");
    assert.equal(body.source?.startAtMillis, at + 123);
    assert.equal(body.source?.timePrecision, "millisecond");
    assert.match(body.source?.qrz ?? "", /^[a-f0-9]{64}$/);
    assert.match(body.source?.lotw ?? "", /^[a-f0-9]{64}$/);
    assert.equal(
      JSON.stringify(page).includes("Private survey narrative"),
      false,
    );
    assert.equal(JSON.stringify(page).includes('"CALL"'), false);
    const { digest, ...input } = page;
    assert.equal(await inventoryProjectionDigest(input), digest);
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_work WHERE completed_version!=0",
          )
          .first<{ n: number }>()
      )?.n,
      1,
      "only the retired event work was completed; drafts publish no work",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("incomplete upstream context holds projections until the full collection and catch-up finish", async () => {
  const f = await fixture();
  try {
    const run = await f.begin();
    await f.observed(run.id, [
      observation("op", "operation"),
      observation("q"),
    ]);
    const workspace = new InventoryProjectionWorkspace(f.store);
    await assert.rejects(
      workspace.prepare("a", f.generation, "source", ["q"]),
      /index_incomplete/,
    );
    await new InventoryComparisonBuilds(f.store).step(
      "a",
      f.generation,
      "source",
    );
    const held = await workspace.prepare("a", f.generation, "source", ["q"]);
    assert.equal(held.rows[0].state, "held");
    assert.equal(held.rows[0].reason, "source_coverage_incomplete");
    assert.equal(
      (await decrypt(f, held, "q")).record.STATION_CALLSIGN,
      undefined,
    );
    await f.observed(run.id, []);
    await f.finish(run.id);
    const complete = await workspace.prepare("a", f.generation, "source", [
      "q",
    ]);
    assert.equal(complete.rows[0].state, "ready");
    assert.equal(
      (await decrypt(f, complete, "q")).record.STATION_CALLSIGN,
      "N1RWJ",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("an unresolved retained event cannot silently disappear from operation context", async () => {
  const f = await fixture();
  try {
    const rows = [
      observation("op", "operation"),
      observation("event", "event"),
      observation("q"),
    ];
    const workspace = await ready(f, rows);
    assert.equal(
      (await workspace.prepare("a", f.generation, "source", ["q"])).rows[0]
        .state,
      "ready",
    );
    await f.full([rows[0], rows[2]]);
    const held = await workspace.prepare("a", f.generation, "source", ["q"]);
    assert.equal(held.rows[0].state, "held");
    assert.equal(held.rows[0].reason, "operation_context_incomplete");
    assert.ok(
      held.dependencies.some(
        (ref) => ref.key === "event" && ref.member_state === "unresolved",
      ),
    );
    await f.full(rows);
    assert.equal(
      (await workspace.prepare("a", f.generation, "source", ["q"])).rows[0]
        .state,
      "ready",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("context-dependent test exclusion keeps its candidate hash and changes when the operation changes", async () => {
  const f = await fixture();
  try {
    const op = observation("op", "operation");
    op.body = { uuid: "op", stationCall: "T/N1RWJ" };
    const workspace = await ready(f, [op, observation("q")]);
    const excluded = await workspace.prepare("a", f.generation, "source", [
      "q",
    ]);
    assert.equal(excluded.rows[0].state, "excluded");
    assert.equal((await decrypt(f, excluded, "q")).state, "excluded");
    assert.equal(excluded.inputs[0].key_class, "call_and_time");
    assert.equal(
      (
        await f.db
          .prepare("SELECT state FROM comparison_index WHERE record_key='q'")
          .first<{ state: string }>()
      )?.state,
      "pending",
      "preparation is not publication or matching authority",
    );
    await f.full([
      {
        ...observation("op", "operation", 2),
        body: { uuid: "op", stationCall: "N1RWJ" },
      },
      observation("q"),
    ]);
    const changed = await workspace.prepare("a", f.generation, "source", ["q"]);
    assert.equal(changed.rows[0].state, "ready");
    assert.ok(
      changed.inputs[0].topology_version > excluded.inputs[0].topology_version,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("context admission uses a union bound and a smaller cohort can resolve an otherwise oversized shared operation", async () => {
  const f = await fixture();
  try {
    const events = Array.from({ length: 240 }, (_, i) => {
      const row = observation(`e${i}`, "event");
      row.body = { ...(row.body as object), startAtMillis: at - i * 60000 };
      return row;
    });
    const qsos = Array.from({ length: 20 }, (_, i) => observation(`q${i}`));
    const workspace = await ready(f, [
      observation("op", "operation"),
      ...events,
      ...qsos,
    ]);
    const held = await workspace.prepare(
      "a",
      f.generation,
      "source",
      qsos.map((row) => row.key),
    );
    assert.equal(held.contextComplete, false);
    assert.ok(
      held.rows.every(
        (row) =>
          row.state === "held" && row.reason === "projection_context_bound",
      ),
    );
    assert.equal(held.stats.decryptedBodies, 20);
    const one = await workspace.prepare("a", f.generation, "source", ["q0"]);
    assert.equal(one.contextComplete, true);
    assert.equal(one.stats.dependencies, 242);
    assert.equal(one.rows[0].state, "ready");
  } finally {
    await f.mf.dispose();
  }
});

test("ciphertext byte admission holds the entire cohort before loading or decrypting a partial union", async () => {
  const f = await fixture();
  try {
    const qsos = Array.from({ length: 20 }, (_, i) => {
      const row = observation(`q${i}`);
      delete row.parentKey;
      row.body = {
        ...(row.body as object),
        operation: null,
        our: { stationCall: "N1RWJ" },
        notes: "x".repeat(220000),
      };
      return row;
    });
    await ready(f, qsos);
    let ciphertextRows = 0;
    const meter = measureD1(f.db, (result) => {
      ciphertextRows += result.results.filter(
        (row) => (row as { row_type?: string }).row_type === "payload",
      ).length;
    });
    const workspace = new InventoryProjectionWorkspace(
      new Store(meter.database, f.store.keys),
    );
    const held = await workspace.prepare(
      "a",
      f.generation,
      "source",
      qsos.map((row) => row.key),
    );
    assert.ok(
      held.rows.every(
        (row) => row.state === "held" && row.reason === "projection_byte_bound",
      ),
    );
    assert.equal(held.stats.decryptedBodies, 0);
    assert.equal(held.stats.plaintextBytes, 0);
    assert.equal(ciphertextRows, 0);
    const one = await workspace.prepare("a", f.generation, "source", ["q0"]);
    assert.equal(one.rows[0].state, "ready");
    assert.equal(ciphertextRows, 1);
  } finally {
    await f.mf.dispose();
  }
});

for (const provider of ["qrz", "lotw"] as const)
  test(`${provider} projection retains original time/mode precision, drops narrative and holds unsupported evidence`, async () => {
    const f = await receiptFixture(provider);
    try {
      const page = await f.workspace.prepare("a", f.generation, "destination", [
        "1",
        "2",
      ]);
      assert.equal(page.rows.find((row) => row.key === "1")?.state, "ready");
      assert.equal(page.rows.find((row) => row.key === "2")?.state, "held");
      const body = await decrypt(f, page, "1");
      assert.equal(body.record.TIME_ON, "1230");
      assert.equal(body.record.NOTES, undefined);
      assert.equal(body.record.NAME, undefined);
      if (provider === "lotw") {
        assert.equal(body.record.APP_LOTW_MODE, "FT8");
        assert.equal(body.record.APP_LOTW_MODEGROUP, "DATA");
      }
      assert.equal(
        JSON.stringify(page).includes("Private remote narrative"),
        false,
      );
    } finally {
      await f.mf.dispose();
    }
  });

test("input ownership is captured before yielding and a mismatched source UUID cannot be projected", async () => {
  const f = await fixture();
  try {
    const qso = observation("q");
    qso.body = { ...(qso.body as object), uuid: "wrong-id" };
    const workspace = await ready(f, [observation("op", "operation"), qso]);
    const keys = ["q"];
    const pending = workspace.prepare("a", f.generation, "source", keys);
    keys[0] = "mutated";
    const page = await pending;
    assert.equal(page.rows[0].key, "q");
    assert.equal(page.rows[0].state, "held");
    assert.equal(page.rows[0].reason, "projection_identity_changed");
    await assert.rejects(
      workspace.prepare("a", f.generation, "source", []),
      /invalid/,
    );
    await assert.rejects(
      workspace.prepare("a", f.generation, "source", ["q", "q"]),
      /invalid/,
    );
  } finally {
    await f.mf.dispose();
  }
});
