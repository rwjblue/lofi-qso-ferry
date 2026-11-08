import assert from "node:assert/strict";
import test from "node:test";
import {
  type InventoryProjectionBody,
  InventoryProjectionWorkspace,
  inventoryProjectionDigest,
  inventoryProjectionIdentity,
} from "../src/inventory-projection-workspace.ts";
import {
  canonical,
  type Envelope,
  open,
  seal,
  sha256,
} from "../src/security.ts";
import { observation } from "./inventory-context-fixtures.ts";
import {
  matchingFixture,
  receipt,
  sourceContact,
} from "./inventory-matching-fixtures.ts";

test("twenty source/receipt pairs share one bounded snapshot without plaintext or canonical writes", async (t) => {
  const f = await matchingFixture({
    sources: Array.from({ length: 20 }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: 20 }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    const before = await f.inventory.snapshot("a", "source", "sync");
    const credential = await f.store.private("a", "source", "v1", "credential");
    const original = f.store.statement.bind(f.store);
    let queries = 0;
    f.store.statement = (sql, ...params) => {
      assert.ok(sql.startsWith("SELECT"), sql);
      queries++;
      return original(sql, ...params);
    };
    const page = await f.workspace.prepare(
      "a",
      "destination",
      f.sources.map((row) => ({ scope: "source", key: row.key })),
    );
    assert.equal(page.graph.results.length, 20);
    assert.ok(page.graph.results.every((row) => row.state === "unique"));
    assert.equal(page.records.length, 40);
    assert.equal(page.stats.decryptedBodies, 40);
    assert.equal(page.stats.bodyQueries, 4);
    assert.equal(page.stats.lookupQueries, 2);
    assert.equal(page.graph.stats.predicateCalls, 20);
    const serialized = canonical(page);
    for (const text of [
      "Private matching",
      '"STATION_CALLSIGN"',
      '"CALL"',
      '"TIME_ON"',
    ])
      assert.equal(serialized.includes(text), false);
    const { digest, ...manifest } = page;
    assert.equal(digest, await sha256(canonical(manifest)));
    t.diagnostic(
      `20 matching pairs: ${queries} complete preparation SQL reads, ${page.stats.rowsRead} data rows read, ${page.stats.decryptedBodies} shared decryptions (data row count excludes key setup)`,
    );
    f.store.statement = original;
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("the collector probes reverse candidates around the remote time instead of the selected source", async () => {
  const f = await matchingFixture({
    sources: [sourceContact("q0"), sourceContact("q1", "14:00:00")],
    receipts: [receipt("1", "133000")],
  });
  try {
    const page = await f.workspace.prepare("a", "destination", [
      { scope: "source", key: "q0" },
    ]);
    assert.equal(page.graph.results[0].reason, "multiple_source_candidates");
    assert.equal(page.records.length, 3);
    assert.equal(page.stats.decryptedBodies, 3);
    assert.ok(
      page.lookups.some(
        (row) =>
          row.direction === "reverse" &&
          row.probe.candidates.some((candidate) => candidate.key === "q1"),
      ),
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a linked source without a scope blocks reverse census even when every known candidate is ready", async () => {
  const f = await matchingFixture();
  try {
    await f.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,config,created_at) VALUES('a','other','lofi','other','Other','active','{}',1)",
      )
      .run();
    const page = await f.workspace.prepare("a", "destination", [
      { scope: "source", key: "q0" },
    ]);
    assert.equal(page.graph.results[0].reason, "reverse_incomplete");
    assert.ok(
      page.scopes.some(
        (row) => row.connection === "other" && row.scope === null,
      ),
    );
  } finally {
    await f.mf.dispose();
  }
});

test("unresolved source membership outside every probed bucket remains a global uncertainty barrier", async () => {
  const f = await matchingFixture({
    sources: [sourceContact("q0"), sourceContact("ghost", "22:00:00", "W9ZZZ")],
  });
  try {
    await f.full([observation("op", "operation"), sourceContact("q0")]);
    const page = await f.workspace.prepare("a", "destination", [
      { scope: "source", key: "q0" },
    ]);
    assert.equal(page.graph.results[0].state, "incomplete");
    assert.equal(
      page.scopes.find((row) => row.scope === "source")?.unresolved,
      1,
    );
    assert.ok(!page.records.some((row) => row.reference.key === "ghost"));
  } finally {
    await f.mf.dispose();
  }
});

test("unresolved receipt membership outside the lookup prevents a new empty conclusion", async () => {
  const f = await matchingFixture({
    receipts: [receipt("ghost", "220000", "W9ZZZ")],
  });
  try {
    await f.fullReceipt([]);
    const page = await f.workspace.prepare("a", "destination", [
      { scope: "source", key: "q0" },
    ]);
    assert.equal(page.graph.results[0].state, "incomplete");
    assert.equal(
      page.scopes.find((row) => row.scope === "destination")?.unresolved,
      1,
    );
    assert.ok(page.lookups[0].probe.candidates.length === 0);
  } finally {
    await f.mf.dispose();
  }
});

test("LoTW date coverage must include both UTC days across a historical candidate window", async () => {
  const f = await matchingFixture({
    provider: "lotw",
    sources: [sourceContact("q0", "00:05:00")],
    receipts: [],
  });
  try {
    const selected = [{ scope: "source", key: "q0" }];
    assert.equal(
      (await f.workspace.prepare("a", "destination", selected)).graph.results[0]
        .state,
      "incomplete",
    );
    await f.fullReceipt([], ["2026-11-07", "2026-11-07"]);
    const page = await f.workspace.prepare("a", "destination", selected);
    assert.equal(page.graph.results[0].state, "none");
    assert.equal(
      page.coverage.filter((row) => row.facet === "receipt").length,
      2,
    );
    assert.equal(page.graph.authoritative, false);
  } finally {
    await f.mf.dispose();
  }
});

test("a completed LoTW selection for another worked call does not cover the source", async () => {
  const f = await matchingFixture({
    provider: "lotw",
    receipts: [],
    range: ["2026-11-09", "2026-11-09"],
  });
  try {
    await f.fullReceipt([], ["2026-11-08", "2026-11-08"], {
      workedCallsign: "K1ABC",
    });
    const page = await f.workspace.prepare("a", "destination", [
      { scope: "source", key: "q0" },
    ]);
    assert.equal(page.graph.results[0].state, "incomplete");
  } finally {
    await f.mf.dispose();
  }
});

test("an operation change keeps the selected source pending until its new context is projected", async () => {
  const f = await matchingFixture();
  try {
    const changed = observation("op", "operation", 2);
    changed.body = { uuid: "op", stationCall: "K1ABC" };
    await f.full([changed, sourceContact("q0")]);
    const page = await f.workspace.prepare("a", "destination", [
      { scope: "source", key: "q0" },
    ]);
    assert.equal(page.graph.results[0].reason, "source_unavailable");
    assert.equal(page.records[0].candidate?.state, "pending");
    assert.equal(page.stats.decryptedBodies, 0);
  } finally {
    await f.mf.dispose();
  }
});

test("dense candidate unions request a split rather than returning a truncated snapshot", async () => {
  const f = await matchingFixture({
    receipts: Array.from({ length: 128 }, (_, i) => receipt(String(i))),
  });
  try {
    const before = await f.inventory.snapshot("a", "source", "sync");
    await assert.rejects(
      f.workspace.prepare("a", "destination", [{ scope: "source", key: "q0" }]),
      /record_split_required/,
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  } finally {
    await f.mf.dispose();
  }
});

test("source and receipt loads consume one shared byte budget before later ciphertext is loaded", async () => {
  const f = await matchingFixture({
    sources: Array.from({ length: 7 }, (_, i) =>
      sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
    ),
    receipts: Array.from({ length: 7 }, (_, i) =>
      receipt(String(i), "130000", `W${i}AW`),
    ),
  });
  try {
    for (const [scope, padding] of [
      ["source", 350_000],
      ["destination", 150_000],
    ] as const) {
      const keys =
        scope === "source"
          ? f.sources.map((row) => row.key)
          : Array.from({ length: 7 }, (_, i) => String(i));
      const page = await new InventoryProjectionWorkspace(f.store).prepare(
        "a",
        f.generation,
        scope,
        keys,
      );
      for (const payload of page.payloads) {
        const identity = inventoryProjectionIdentity(
          "a",
          page.connection,
          payload.id,
        );
        const body = await open<InventoryProjectionBody>(
          JSON.parse(payload.envelope) as Envelope,
          identity,
          f.store.keys,
        );
        payload.envelope = JSON.stringify(
          await seal(
            { ...body, padding: "x".repeat(padding) },
            identity,
            f.store.keys,
          ),
        );
      }
      const { digest: _digest, ...manifest } = page;
      page.digest = await inventoryProjectionDigest(manifest);
      const lease = await f.store.claim(
        "a",
        `projection:${f.generation}:${scope}`,
        Date.now(),
        60_000,
      );
      assert.ok(lease);
      try {
        await f.projections.publish(page, lease);
      } finally {
        await f.store.release(lease);
      }
    }
    const original = f.store.statement.bind(f.store);
    let bodyReads = 0;
    f.store.statement = (sql, ...params) => {
      if (sql.includes("CROSS JOIN comparison_projection_payloads p"))
        bodyReads++;
      return original(sql, ...params);
    };
    await assert.rejects(
      f.workspace.prepare(
        "a",
        "destination",
        f.sources.map((row) => ({ scope: "source", key: row.key })),
      ),
      /inventory_projection_read_byte_bound/,
    );
    assert.equal(
      bodyReads,
      1,
      "only source ciphertext can be loaded before the remaining receipt budget is rejected",
    );
  } finally {
    await f.mf.dispose();
  }
});

test("membership barrier reads stay bounded as unrelated present memberships grow", async () => {
  const f = await matchingFixture();
  try {
    const selected = [{ scope: "source", key: "q0" }];
    const before = await f.workspace.prepare("a", "destination", selected);
    await f.db
      .prepare(`INSERT INTO inventory_partition_membership(tenant,scope_id,stream_id,facet,partition_id,entity_family,record_key,state,row_version,facet_version,last_accepted_sequence,last_observed_at,last_run_id)
      SELECT m.tenant,m.scope_id,m.stream_id,m.facet,j.value,m.entity_family,m.record_key,m.state,m.row_version,m.facet_version,m.last_accepted_sequence,m.last_observed_at,m.last_run_id
      FROM json_each(?) j CROSS JOIN inventory_partition_membership m WHERE m.tenant='a' AND m.scope_id='source' AND m.partition_id='all' AND m.entity_family='qso' AND m.record_key='q0'`)
      .bind(
        JSON.stringify(Array.from({ length: 5000 }, (_, i) => `unrelated${i}`)),
      )
      .run();
    const after = await f.workspace.prepare("a", "destination", selected);
    assert.equal(after.graph.results[0].state, "unique");
    assert.equal(after.stats.rowsRead, before.stats.rowsRead);
  } finally {
    await f.mf.dispose();
  }
});
