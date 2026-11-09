import assert from "node:assert/strict";
import test from "node:test";
import { measureD1 } from "../scripts/inventory-benchmark-metrics.ts";
import type { AdifRecord } from "../src/adif.ts";
import {
  InventoryAssociations,
  type PreparedInventoryAdoption,
} from "../src/inventory-associations.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import { InventoryOwnership } from "../src/inventory-ownership.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { database, keys, seed } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import {
  matchingFixture,
  receipt,
  sourceContact,
} from "./inventory-matching-fixtures.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

async function ready(options: Parameters<typeof matchingFixture>[0] = {}) {
  const f = await matchingFixture(options);
  const selected = f.sources.map((row) => ({ scope: "source", key: row.key }));
  await new InventoryMatchingResults(f.store).match(
    "a",
    "destination",
    selected,
  );
  return {
    ...f,
    selected,
    associations: new InventoryAssociations(f.store),
    ownership: new InventoryOwnership(f.store),
  };
}

test("adoption reads stay bounded as unrelated matches and publication history accumulate", async (t) => {
  const runtime = await database();
  try {
    await applyAdditionalMigrations(runtime.db);
    const f = await matchingFixture(
      {
        sources: Array.from({ length: 123 }, (_, i) =>
          sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
        ),
        receipts: Array.from({ length: 123 }, (_, i) =>
          receipt(String(i + 1), "130000", `W${i}AW`),
        ),
      },
      runtime,
      "current",
    );
    const matching = new InventoryMatchingResults(f.store);
    const associations = new InventoryAssociations(f.store);
    const selected = f.sources.map(({ key }) => ({ scope: "source", key }));
    for (const row of selected.slice(0, 3))
      await matching.match("a", "destination", [row]);
    assert.equal(
      (await associations.adopt("a", "destination", selected.slice(0, 1)))
        .records,
      1,
    );
    const readCost = async (index: number) => {
      const reads: number[] = [];
      const meter = measureD1(f.db, (row) => reads.push(row.meta.rows_read));
      const publisher = new InventoryAssociations(
        new Store(meter.database, f.store.keys),
      );
      const result = await publisher.adopt(
        "a",
        "destination",
        selected.slice(index, index + 1),
      );
      assert.equal(result.records, 1);
      return { total: meter.totals.rowsRead, reads };
    };
    const early = await readCost(1);
    for (let offset = 3; offset < selected.length; offset += 20) {
      const cohort = selected.slice(offset, offset + 20);
      await matching.match("a", "destination", cohort);
      assert.equal(
        (await associations.adopt("a", "destination", cohort)).records,
        20,
      );
    }
    const late = await readCost(2);
    assert.ok(late.total <= early.total + 40, JSON.stringify({ early, late }));
    t.diagnostic(
      `native adoption reads before/after 120 unrelated matches and associations: ${early.total}/${late.total}`,
    );
  } finally {
    await runtime.mf.dispose();
  }
});

test("twenty matched records become immutable historical associations in one native cohort", async (t) => {
  const f = await ready({
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
    const page = await f.associations.prepare("a", "destination", f.selected);
    assert.equal(page.rows.length, 20);
    assert.ok(!canonical(page).includes("Private matching"));
    assert.ok(!canonical(page).includes('"CALL"'));
    const lease = await f.store.claim(
      "a",
      "inventory-ownership:qrz",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const result = await f.associations.publish(page, lease, "twenty");
    assert.equal(result.records, 20);
    assert.equal(result.statements, 6);
    assert.ok(
      result.rowsRead < 6000,
      "shared snapshots must not be rechecked per contact",
    );
    assert.equal(
      (await f.associations.publish(page, lease, "twenty")).recovered,
      true,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_historical_associations",
          )
          .first<{ n: number }>()
      )?.n,
      20,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_historical_write_blocks",
          )
          .first<{ n: number }>()
      )?.n,
      20,
    );
    const again = await f.associations.prepare("a", "destination", f.selected);
    assert.equal(again.rows.length, 0);
    assert.ok(
      again.skipped.every(
        (row) => row.reason === "historical_mapping_preserved",
      ),
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    for (const table of ["ledger", "attempts", "attempt_events"])
      assert.equal(
        (
          await f.db
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
      );
    t.diagnostic(
      `20 historical associations: ${result.statements} statements, ${result.rowsRead} rows read, ${result.rowsWritten} rows written`,
    );
  } finally {
    await f.mf.dispose();
  }
});

async function prepared(options: Parameters<typeof matchingFixture>[0] = {}) {
  const f = await ready(options);
  const page = await f.associations.prepare("a", "destination", f.selected);
  const lease = await f.store.claim(
    "a",
    `inventory-ownership:${page.provider}`,
    Date.now(),
    60000,
  );
  assert.ok(lease);
  return { ...f, page, lease };
}
async function empty(f: Awaited<ReturnType<typeof prepared>>) {
  for (const table of [
    "inventory_adoption_pages",
    "inventory_adoption_rows",
    "inventory_adoption_guards",
    "inventory_ownership_evidence",
    "inventory_historical_associations",
    "inventory_ownership_buckets",
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
function alteredStore(
  f: Awaited<ReturnType<typeof prepared>>,
  alter: (plan: D1PreparedStatement[]) => Promise<D1Result[]>,
) {
  return new Store(
    new Proxy(f.db, {
      get(target, property) {
        if (property === "batch") return alter;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    f.store.keys,
  );
}
async function resign(page: PreparedInventoryAdoption) {
  const { digest: _digest, ...manifest } = page;
  page.digest = await sha256(canonical(manifest));
}

test("QRZ ownership follows canonical book LOGID even after remote edits and tenant key rewrap", async () => {
  const f = await prepared({ receipts: [receipt("0007")] });
  try {
    await f.associations.publish(f.page, f.lease);
    const edited = {
      ...(receipt().body as AdifRecord),
      CALL: "K1ABC",
      TIME_ON: "010000",
    };
    const query = {
      id: "query",
      sourceIdentity: "source",
      key: "q0",
      book: "destination",
      remoteKey: "0000007",
      record: edited,
    };
    const before = await f.ownership.lookup("a", "qrz", [query]);
    assert.equal(before.observations[0].state, "owned");
    assert.equal(before.stats.decryptedBodies, 1);
    assert.equal(
      (await f.ownership.lookup("a", "qrz", [{ ...query, key: "different" }]))
        .observations[0].state,
      "conflict",
    );
    assert.equal(
      (
        await f.ownership.lookup("a", "qrz", [
          { ...query, book: "different-book" },
        ])
      ).observations[0].state,
      "clear",
    );
    const rotated = new Store(f.db, { ...keys, active: "2" });
    await new InventoryComparisonGenerations(rotated).rewrapKey("a");
    const after = await new InventoryOwnership(rotated).lookup("a", "qrz", [
      query,
    ]);
    assert.deepEqual(after.tokens, before.tokens);
    assert.equal(after.version, before.version);
    assert.equal(
      after.observations[0].evidenceId,
      before.observations[0].evidenceId,
    );
    await seed(f.store, "b");
    assert.equal(
      (await f.ownership.lookup("b", "qrz", [query])).observations[0].state,
      "clear",
    );
    const row = await f.db
      .prepare("SELECT remote_id,kind FROM inventory_ownership_evidence")
      .first();
    assert.deepEqual(row, { remote_id: "7", kind: "historical" });
  } finally {
    await f.mf.dispose();
  }
});

test("LoTW archives literal minute and mode-group evidence across inactive signing accounts", async () => {
  const source = sourceContact("q0");
  source.body = { ...(source.body as object), mode: "FT4" };
  const remote = receipt("opaque-observation", "1300");
  remote.body = {
    ...(remote.body as object),
    MODE: "DATA",
    APP_LOTW_MODE: "FT8",
    APP_LOTW_MODEGROUP: "DATA",
  };
  const f = await prepared({
    provider: "lotw",
    sources: [source],
    receipts: [remote],
  });
  try {
    assert.equal(f.page.rows.length, 1);
    await f.associations.publish(f.page, f.lease);
    await f.db
      .prepare(
        "UPDATE connections SET status='disabled' WHERE id='destination'",
      )
      .run();
    const record = {
      ...(remote.body as AdifRecord),
      TIME_ON: "132959",
      APP_LOTW_MODE: "FT4",
    };
    const query = {
      id: "query",
      sourceIdentity: "another-source",
      key: "another-qso",
      book: "another-signing-account",
      remoteKey: "different-observation",
      record,
    };
    const found = await f.ownership.lookup("a", "lotw", [query]);
    assert.equal(found.observations[0].state, "conflict");
    assert.equal(found.evidence[0].body.record.TIME_ON, "1300");
    assert.equal(found.evidence[0].body.record.APP_LOTW_MODE, "FT8");
    assert.equal(found.evidence[0].remote_id, null);
    assert.equal(
      (
        await f.ownership.lookup("a", "lotw", [
          { ...query, record: { ...record, TIME_ON: "140000" } },
        ])
      ).observations[0].state,
      "clear",
    );
    assert.equal(
      (
        await f.ownership.lookup("a", "lotw", [
          { ...query, record: { ...record, STATION_CALLSIGN: "K1ABC" } },
        ])
      ).observations[0].state,
      "clear",
    );
    const own = await f.ownership.lookup("a", "lotw", [
      {
        ...query,
        sourceIdentity: "source",
        key: "q0",
        record: remote.body as AdifRecord,
      },
    ]);
    assert.equal(own.observations[0].state, "owned");
    assert.equal(own.observations[0].evidenceId, f.page.rows[0].evidence_id);
  } finally {
    await f.mf.dispose();
  }
});

test("individually unique LoTW matches cannot claim competing historical tuples in the same cohort", async () => {
  const f = await ready({
    provider: "lotw",
    sources: [sourceContact("q0", "13:00:00"), sourceContact("q1", "14:00:00")],
    receipts: [receipt("a", "132900"), receipt("b", "133100")],
  });
  try {
    const current = await new InventoryMatchingResults(f.store).current(
      "a",
      "destination",
      f.selected,
    );
    assert.ok(current.results.every((row) => row.state === "matched_existing"));
    const page = await f.associations.prepare("a", "destination", f.selected);
    assert.equal(page.rows.length, 0);
    assert.deepEqual(
      page.skipped.map((row) => row.reason),
      ["ownership_conflict", "ownership_conflict"],
    );
  } finally {
    await f.mf.dispose();
  }
});

test("ownership lookup initializes a missing domain and leaves later reads read-only", async () => {
  const f = await ready();
  try {
    assert.equal(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_ownership_domains")
        .first("n"),
      0,
    );
    const query = {
      id: "query",
      sourceIdentity: "source",
      key: "q0",
      book: "destination",
      remoteKey: "1",
      record: receipt().body as AdifRecord,
    };
    const cold = measureD1(f.db);
    const first = await new InventoryOwnership(
      new Store(cold.database, f.store.keys),
    ).lookup("a", "qrz", [query]);
    assert.equal(first.observations[0].state, "clear");
    assert.equal(cold.totals.calls, 3);
    assert.ok(cold.totals.rowsWritten > 0);
    const warm = measureD1(f.db);
    const next = await new InventoryOwnership(
      new Store(warm.database, f.store.keys),
    ).lookup("a", "qrz", [query]);
    assert.deepEqual(next.observations, first.observations);
    assert.equal(next.keyId, first.keyId);
    assert.equal(next.version, first.version);
    assert.equal(warm.totals.calls, 2);
    assert.equal(warm.totals.statements, 3);
    assert.equal(warm.totals.rowsWritten, 0);
  } finally {
    await f.mf.dispose();
  }
});

test("ownership candidate and byte bounds hold without decrypting a truncated registry", async () => {
  const f = await prepared();
  try {
    await f.associations.publish(f.page, f.lease);
    const query = {
      id: "query",
      sourceIdentity: "source",
      key: "q0",
      book: "destination",
      remoteKey: "1",
      record: receipt().body as AdifRecord,
    };
    for (const [limits, reason] of [
      [{ maxRecords: 0 }, "ownership_record_bound"],
      [{ maxBytes: 1 }, "ownership_byte_bound"],
    ] as const) {
      let envelopes: unknown[] = [];
      const store = alteredStore(f, async (plan) => {
        const results = await f.db.batch(plan);
        envelopes = results[1].results.map(
          (row) => (row as { envelope: unknown }).envelope,
        );
        return results;
      });
      const found = await new InventoryOwnership(store).lookup(
        "a",
        "qrz",
        [query],
        limits,
      );
      assert.equal(found.state, "held");
      assert.equal(found.reason, reason);
      assert.equal(found.stats.decryptedBodies, 0);
      assert.equal(found.evidence.length, 0);
      assert.deepEqual(
        envelopes,
        [null],
        "overflow must not load encrypted bodies",
      );
    }
    await f.ownership.hold(
      "a",
      "qrz",
      "old-uncertain-attempt",
      "unresolved_delivery",
    );
    const held = await f.ownership.lookup("a", "qrz", [query]);
    assert.equal(held.reason, "ownership_incomplete");
    assert.equal(held.stats.decryptedBodies, 0);
    assert.equal(held.evidence.length, 0);
  } finally {
    await f.mf.dispose();
  }
});

test("original association and write block survive source edits and connection rebinding", async () => {
  const f = await prepared();
  try {
    await f.associations.publish(f.page, f.lease);
    const baseline = await f.db
      .prepare("SELECT * FROM inventory_historical_associations")
      .first();
    const edited = sourceContact("q0", "15:00:00", "K1ABC");
    edited.order = 2;
    edited.revision = "2";
    await f.full([observation("op", "operation"), edited]);
    const again = await f.associations.prepare("a", "destination", f.selected);
    assert.equal(again.rows.length, 0);
    assert.equal(again.skipped[0].reason, "historical_mapping_preserved");
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM inventory_historical_associations")
        .first(),
      baseline,
    );
    await f.db
      .prepare(
        "UPDATE connections SET remote_identity='retired-'||id,status='disabled'",
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','new-source','lofi','source','new','disabled','v1',0),('a','new-destination','qrz','destination','new','disabled','v1',0)",
      )
      .run();
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM inventory_historical_write_blocks")
        .first(),
      {
        tenant: "a",
        source: "new-source",
        qso: "q0",
        destination: "new-destination",
      },
    );
    await assert.rejects(
      f.db
        .prepare(
          "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','forbidden','new-source','q0','new-destination','g','p','h','v1',0,'h')",
        )
        .run(),
      /historical association is read only/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "INSERT INTO stage_guards(id,tenant,source,qso,destination) VALUES('forbidden','a','new-source','q0','new-destination')",
        )
        .run(),
      /historical association is read only/,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_historical_associations SET remote_record_key='2'",
        )
        .run(),
      /immutable/,
    );
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_ownership_evidence").run(),
      /retained/,
    );
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_match_records").run(),
      /historical association pins matching evidence/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native adoption rejects changed authority, inputs and ownership before publication", async (t) => {
  for (const sql of [
    "UPDATE leases SET expires_at=0 WHERE scope='inventory-ownership:qrz'",
    "UPDATE accounts SET status='locked' WHERE id='a'",
    "UPDATE private_data SET revoked_at=1 WHERE connection='source' AND kind='credential'",
    "UPDATE private_data SET expires_at=1 WHERE connection='destination' AND kind='credential'",
    "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant='a'",
    "UPDATE comparison_index SET projection_version=projection_version+1 WHERE scope_id='source'",
    "UPDATE inventory_membership_versions SET version=version+1 WHERE scope_id='source' AND record_key='q0'",
    "UPDATE inventory_ownership_domains SET version=version+1 WHERE tenant='a'",
    "INSERT INTO inventory_ownership_holds(tenant,provider,reference,reason,created_at) VALUES('a','qrz','uncertain','unresolved_delivery',1)",
  ])
    await t.test(sql, async () => {
      const f = await prepared();
      try {
        await f.db.prepare(sql).run();
        await assert.rejects(
          f.associations.publish(f.page, f.lease),
          /changed/,
        );
        await empty(f);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("native adoption checks manifest completeness, exact payloads and canonical QRZ identity", async (t) => {
  for (const change of [
    "remote-id",
    "payload",
    "missing-evidence",
    "existing-evidence",
    "match-version",
  ] as const)
    await t.test(change, async () => {
      const f = await prepared();
      try {
        const page = structuredClone(f.page);
        if (change === "remote-id") page.rows[0].remote_id = "2";
        else if (change === "payload")
          page.rows[0].source_payload = page.rows[0].remote_payload;
        else if (change === "missing-evidence") page.evidence = [];
        else if (change === "existing-evidence") {
          page.rows[0].existing_evidence = 1;
          page.evidence = [];
        } else page.rows[0].match_version++;
        await resign(page);
        await assert.rejects(f.associations.publish(page, f.lease));
        await empty(f);
      } finally {
        await f.mf.dispose();
      }
    });
});

test("late SQL and authority failures roll back evidence, associations and ownership clocks", async (t) => {
  for (const failure of ["sql", "authority", "ownership"] as const)
    await t.test(failure, async () => {
      const f = await prepared();
      try {
        const store = alteredStore(f, async (plan) => {
          const changed = [...plan];
          changed.splice(
            changed.length - 1,
            0,
            f.db.prepare(
              failure === "sql"
                ? "SELECT * FROM intentional_missing_adoption_table"
                : failure === "authority"
                  ? "UPDATE accounts SET status='locked' WHERE id='a'"
                  : "INSERT INTO inventory_ownership_holds(tenant,provider,reference,reason,created_at) VALUES('a','qrz','late','unresolved_delivery',1)",
            ),
          );
          return f.db.batch(changed);
        });
        await assert.rejects(
          new InventoryAssociations(store).publish(f.page, f.lease),
        );
        await empty(f);
        assert.equal(
          (
            await f.db
              .prepare("SELECT version FROM inventory_ownership_domains")
              .first<{ version: number }>()
          )?.version,
          1,
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT status FROM accounts WHERE id='a'")
              .first<{ status: string }>()
          )?.status,
          "active",
        );
        assert.equal(
          (
            await f.db
              .prepare("SELECT count(*) AS n FROM inventory_ownership_holds")
              .first<{ n: number }>()
          )?.n,
          0,
        );
      } finally {
        await f.mf.dispose();
      }
    });
});

test("lost acknowledgement recovery preserves original evidence and rejects competing prepared adoption", async () => {
  const f = await prepared();
  try {
    const competing = await f.associations.prepare(
      "a",
      "destination",
      f.selected,
    );
    const store = alteredStore(f, async (plan) => {
      await f.db.batch(plan);
      throw new Error("lost acknowledgement");
    });
    assert.equal(
      (await new InventoryAssociations(store).publish(f.page, f.lease, "lost"))
        .recovered,
      true,
    );
    await assert.rejects(
      f.associations.publish(competing, f.lease, "competitor"),
      /changed|conflict/,
    );
    await f.db
      .prepare(
        "UPDATE private_data SET revoked_at=1 WHERE connection='source' AND kind='credential'",
      )
      .run();
    assert.equal(
      (await f.associations.publish(f.page, f.lease, "lost")).recovered,
      true,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_historical_associations",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM inventory_ownership_domains")
          .first<{ version: number }>()
      )?.version,
      3,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("LoTW adoption reuses permanent evidence for the same QSO in another signing account", async () => {
  const f = await prepared({ provider: "lotw" });
  try {
    await f.associations.publish(f.page, f.lease);
    await f.store.release(f.lease);
    await f.db
      .prepare(
        "UPDATE connections SET remote_identity='another-account' WHERE id='destination'",
      )
      .run();
    await f.db
      .prepare(
        "UPDATE inventory_scopes SET logical_identity='another-account',config_version=config_version+1,state='observing' WHERE scope_id='destination'",
      )
      .run();
    await f.fullReceipt([receipt()], undefined, { replaceHeld: true });
    await f.project("destination");
    await new InventoryMatchingResults(f.store).match(
      "a",
      "destination",
      f.selected,
    );
    const page = await f.associations.prepare("a", "destination", f.selected);
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].existing_evidence, 1);
    assert.equal(page.rows[0].evidence_id, f.page.rows[0].evidence_id);
    assert.equal(page.evidence.length, 0);
    const result = await f.associations.adopt("a", "destination", f.selected);
    assert.equal(result.records, 1);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_ownership_evidence")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_historical_associations",
          )
          .first<{ n: number }>()
      )?.n,
      2,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM inventory_ownership_domains")
          .first<{ version: number }>()
      )?.version,
      4,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM leases WHERE scope='inventory-ownership:lotw' AND expires_at>0",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("existing delivery evidence prevents historical relabeling at preparation and native commit", async (t) => {
  for (const kind of ["mapping", "attempt"] as const)
    await t.test(kind, async () => {
      const f = await prepared();
      try {
        await f.db
          .prepare(
            "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('a','source','other-qso','destination','g','h',0,0)",
          )
          .run();
        if (kind === "mapping")
          await f.db.prepare("UPDATE ledger SET remote_id='999'").run();
        else
          await f.db
            .prepare(
              "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','uncertain','source','other-qso','destination','g','p','h','v1',0,'h')",
            )
            .run();
        await assert.rejects(
          f.associations.publish(f.page, f.lease),
          /changed/,
        );
        await empty(f);
        const page = await f.associations.prepare(
          "a",
          "destination",
          f.selected,
        );
        assert.equal(page.rows.length, 0);
        assert.equal(page.skipped[0].reason, "prior_delivery_evidence");
      } finally {
        await f.mf.dispose();
      }
    });
});

test("absence and incomplete comparisons cannot create historical ownership or claim an adoption lease", async () => {
  const f = await ready({ receipts: [] });
  try {
    const current = await new InventoryMatchingResults(f.store).current(
      "a",
      "destination",
      f.selected,
    );
    assert.equal(current.results[0].state, "absent_at_inventory");
    const result = await f.associations.adopt("a", "destination", f.selected);
    assert.equal(result.records, 0);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_ownership_domains")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM leases WHERE scope LIKE 'inventory-ownership:%'",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await f.db
      .prepare(
        "UPDATE inventory_membership_versions SET version=version+1 WHERE scope_id='source' AND record_key='q0'",
      )
      .run();
    assert.equal(
      (await f.associations.adopt("a", "destination", f.selected)).records,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});
