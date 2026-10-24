import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { observeContact, pollSource, rereadOperation } from "../src/intake.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { canonical } from "../src/security.ts";
import {
  loadCurrentSourceExportProof,
  loadSourceExportSnapshots,
  mintSourceExportProofs,
  purgeExpiredSourceExportProofs,
  type SourceExportProof,
  type SourceExportProofRequest,
  sourceExportProofGuard,
} from "../src/source-export-proofs.ts";
import {
  loadSourcePresence,
  type SourcePresenceScope,
} from "../src/source-presence-store.ts";
import { sourceReadPolicy } from "../src/source-read-policy.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const operation: SourceRecord = {
  uuid: "op",
  syncedAtMillis: 100,
  stationCall: "N0CALL",
  grid: "FN31AA",
};
const qso = (id = "q1"): SourceRecord => ({
  uuid: id,
  operation: "op",
  syncedAtMillis: 101,
  startAtMillis: 1_792_684_800_000,
  band: "20m",
  mode: "FT8",
  freq: 14074,
  their: { call: "W1AW" },
});
// A note event is not an effective segment, but it remains a required dependency.
const event: SourceRecord = {
  uuid: "event",
  operation: "op",
  syncedAtMillis: 102,
  band: "event",
  event: { event: "note", text: "fixture" },
};
const reply = (qsos: SourceRecord[] = [], operations: SourceRecord[] = []) =>
  Response.json({
    account: { uuid: "source" },
    operations,
    qsos,
    meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
  });
async function setup(t: TestContext, ids = ["q1"]) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET config=?,credential_version='source-v2' WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "source-v2", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    })
  ).run();
  const source = (await h.store.connection("a", "source"))!;
  const destination = (await h.store.connection("a", "destination"))!;
  let time = Date.now() + 10_000;
  let window = 0;
  const poll = async (
    qsos: SourceRecord[] = [],
    operations: SourceRecord[] = [],
  ) => {
    time = Math.max(time + 1000, Date.now() + 1000);
    const began = Date.now();
    try {
      return await pollSource(
        h.store,
        source,
        async () => reply(qsos, operations),
        time,
        "sync",
        ++window * 300_000,
      );
    } finally {
      time += Math.max(0, Date.now() - began);
    }
  };
  await poll([...ids.map(qso), event], [operation]);
  await poll();
  await poll();
  assert.equal(
    (await sourceReadPolicy(h.store, "a", "source"))!.phase,
    "ready",
  );
  time += 1000;
  await rereadOperation(
    h.store,
    source,
    async () => reply([...ids.map(qso), event]),
    time,
    undefined,
    ++window * 300_000,
  );
  const scope: SourcePresenceScope = {
    tenant: "a",
    source: "source",
    accountId: "source",
    readerPolicy: "all-clients-v1",
    policyEpoch: (await sourceReadPolicy(h.store, "a", "source"))!.epoch,
    credentialVersion: "source-v2",
  };
  const before = await loadSourceExportSnapshots(
    h.store,
    scope,
    ids,
    time + 100,
  );
  assert.equal(before.length, ids.length, "pre-drain projection is available");
  const witnesses = (
    await loadSourcePresence(
      h.store,
      scope,
      [
        ...new Map(
          before.flatMap((s) =>
            s.targets.map(
              (target) =>
                [canonical([target.kind, target.id]), target] as const,
            ),
          ),
        ).values(),
      ],
      time + 100,
    )
  ).map((w) => {
    assert.ok(w);
    return w;
  });
  const collectionFinishedAt = time + 200;
  await poll();
  const snapshots = await loadSourceExportSnapshots(
    h.store,
    scope,
    ids,
    time + 100,
  );
  assert.equal(snapshots.length, ids.length);
  for (const snapshot of snapshots)
    await observeContact(h.store, source, snapshot.contact, time + 200, [
      destination,
    ]);
  time += 300;
  const lease = (await h.store.claim("a", "cycle:source", time, 90_000))!;
  assert.ok(lease);
  const requests: SourceExportProofRequest[] = snapshots.map((snapshot) => ({
    snapshot,
    witnesses,
    collectionFinishedAt,
  }));
  const mint = () => mintSourceExportProofs(h.store, requests, lease, time);
  const current = (proof: SourceExportProof, at = time) =>
    loadCurrentSourceExportProof(
      h.store,
      scope,
      proof.id,
      {
        qso: proof.qso,
        generation: proof.generation,
        reconciliationVersion: proof.reconciliationVersion,
      },
      at,
    );
  return {
    ...h,
    scope,
    source,
    requests,
    lease,
    mint,
    current,
    poll,
    now: () => time,
  };
}

test("proofs share bounded exact projection, include non-effective events, and retain original expiry", async (t) => {
  const h = await setup(t, ["q1", "q2"]);
  assert.deepEqual(
    h.requests[0].snapshot.targets.map((target) => target.id).sort(),
    ["event", "op", "q1"],
  );
  const proofs = await h.mint();
  assert.equal(proofs.length, 2);
  assert.notEqual(proofs[0].id, proofs[1].id);
  for (const proof of proofs) {
    assert.deepEqual(await h.current(proof), proof);
    for (const changed of [
      { policyEpoch: "other" },
      { accountId: "other" },
      { credentialVersion: "other" },
      { tenant: "other" },
    ])
      assert.equal(
        await loadCurrentSourceExportProof(
          h.store,
          { ...h.scope, ...changed },
          proof.id,
          {
            qso: proof.qso,
            generation: proof.generation,
            reconciliationVersion: proof.reconciliationVersion,
          },
          h.now(),
        ),
        null,
      );
    assert.equal(
      proof.expiresAt,
      Math.min(...proof.dependencies.map((d) => d.requestStartedAt)) + 300_000,
    );
    assert.ok(proof.completeReadStartedAt >= proof.collectionFinishedAt);
    assert.equal(await h.current(proof, proof.expiresAt), null);
  }
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_export_proof_batch_guards")
      .first("count(*)"),
    0,
  );
  assert.equal(
    await h.store.statement("SELECT count(*) FROM attempts").first("count(*)"),
    0,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE source_export_proofs SET expires_at=expires_at+1 WHERE tenant='a'",
      )
      .run(),
    /immutable/,
  );
  await purgeExpiredSourceExportProofs(
    h.store,
    Math.max(...proofs.map((p) => p.expiresAt)),
    1,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_export_proofs")
      .first("count(*)"),
    1,
  );
});

test("freshness rejects future positives, clock rollback, stale drain, and five-minute boundary", async (t) => {
  const h = await setup(t);
  const original = h.requests[0];
  for (const request of [
    { ...original, collectionFinishedAt: h.now() + 1 },
    {
      ...original,
      collectionFinishedAt: original.snapshot.completeReadStartedAt! + 1,
    },
    {
      ...original,
      witnesses: original.witnesses.map((w) => ({
        ...w,
        requestStartedAt: original.collectionFinishedAt + 1,
      })),
    },
    {
      ...original,
      snapshot: { ...original.snapshot, completeReadStartedAt: null },
    },
    {
      ...original,
      snapshot: { ...original.snapshot, completeReadStartedAt: h.now() + 1 },
    },
  ])
    await assert.rejects(
      mintSourceExportProofs(h.store, [request], h.lease, h.now()),
      /source_export/,
    );
  await assert.rejects(
    mintSourceExportProofs(
      h.store,
      h.requests,
      h.lease,
      original.snapshot.loadedAt - 1,
    ),
    /snapshot_unavailable/,
  );
  await assert.rejects(
    mintSourceExportProofs(
      h.store,
      [
        {
          ...original,
          snapshot: { ...original.snapshot, loadedAt: Date.now() + 600_000 },
        },
      ],
      h.lease,
    ),
    /snapshot_unavailable/,
    "the default production clock does not accept a future snapshot",
  );
  const oldest = Math.min(...original.witnesses.map((w) => w.requestStartedAt));
  await assert.rejects(
    mintSourceExportProofs(h.store, h.requests, h.lease, oldest + 300_000),
    /positive_unavailable/,
  );
  const [proof] = await h.mint();
  assert.equal(await h.current(proof, proof.createdAt - 1), null);
});

test("missing, partial, continuation and changed-generation drains never qualify", async (t) => {
  const h = await setup(t);
  const [proof] = await h.mint();
  const saved = (await h.store
    .statement(
      "SELECT cursor,generation FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
    )
    .first<{ cursor: string; generation: number }>())!;
  const original = JSON.parse(saved.cursor);
  for (const cursor of [
    { ...original, completeReadStartedAt: undefined },
    {
      ...original,
      completeReadStartedAt: h.requests[0].collectionFinishedAt - 1,
    },
    { ...original, operations: { ...original.operations, complete: false } },
    { ...original, qsos: { ...original.qsos, cursor: "continuation" } },
  ]) {
    await h.store
      .statement(
        "UPDATE cursors SET cursor=? WHERE tenant='a' AND connection='source' AND stream='sync'",
        JSON.stringify(cursor),
      )
      .run();
    assert.equal(await h.current(proof), null);
    await assert.rejects(h.mint(), /CHECK constraint/);
  }
  await h.store
    .statement(
      "UPDATE cursors SET cursor=?,generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='sync'",
      saved.cursor,
    )
    .run();
  assert.equal(await h.current(proof), null);
});

test("dependency additions, removals, moved membership and stale revisions invalidate exact proof", async (t) => {
  const h = await setup(t);
  const [proof] = await h.mint();
  const eventRow = (await h.store
    .statement(
      "SELECT * FROM source_work WHERE tenant='a' AND source='source' AND id='event'",
    )
    .first<Record<string, string | number | null>>())!;
  // Same-op non-effective event arriving after collection must invalidate even
  // though no projected field changes. Direct insert models an overlapping read.
  await h.store
    .statement(
      "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,expires_at,synced_at,is_event,deleted,policy_seen_epoch) VALUES('a','source','new-event','qso','op',?,?,?,103,1,0,?)",
      eventRow.private_id,
      eventRow.revision,
      eventRow.expires_at,
      h.scope.policyEpoch,
    )
    .run();
  assert.equal(await h.current(proof), null);
  await assert.rejects(h.mint(), /CHECK constraint/);
  await h.store
    .statement(
      "DELETE FROM source_work WHERE tenant='a' AND source='source' AND id='new-event'",
    )
    .run();
  assert.ok(await h.current(proof));
  for (const [field, value] of [
    ["revision", "changed"],
    ["synced_at", 999],
    ["operation_id", "other"],
    ["deleted", 1],
    ["policy_seen_epoch", null],
  ] as const) {
    assert.ok(await h.current(proof), `proof current before ${field}`);
    await h.store
      .statement(
        `UPDATE source_work SET ${field}=? WHERE tenant='a' AND source='source' AND id='event'`,
        value,
      )
      .run();
    assert.equal(await h.current(proof), null, field);
    await h.store
      .statement(
        `UPDATE source_work SET ${field}=?,policy_seen_epoch=? WHERE tenant='a' AND source='source' AND id='event'`,
        eventRow[field],
        h.scope.policyEpoch,
      )
      .run();
    await h.store
      .statement(
        "UPDATE source_work SET policy_seen_epoch=? WHERE tenant='a' AND source='source' AND id='event'",
        h.scope.policyEpoch,
      )
      .run();
  }
  await h.store
    .statement(
      "DELETE FROM source_work WHERE tenant='a' AND source='source' AND id='event'",
    )
    .run();
  assert.equal(await h.current(proof), null);
});

test("credential, account, policy, ledger, reconciliation and context races fail atomically", async (t) => {
  const h = await setup(t, ["q1", "q2"]);
  await h.store
    .statement(
      "UPDATE reconciliation_work SET version=version+1 WHERE tenant='a' AND source='source' AND qso='q2'",
    )
    .run();
  await assert.rejects(h.mint(), /CHECK constraint/);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_export_proofs")
      .first("count(*)"),
    0,
    "first valid member rolls back with second stale member",
  );
  await h.store
    .statement(
      "UPDATE reconciliation_work SET version=version-1 WHERE tenant='a' AND source='source' AND qso='q2'",
    )
    .run();
  const [proof] = await h.mint();
  for (const [change, restore] of [
    [
      "UPDATE connections SET credential_version='other' WHERE tenant='a' AND id='source'",
      "UPDATE connections SET credential_version='source-v2' WHERE tenant='a' AND id='source'",
    ],
    [
      "UPDATE private_data SET revoked_at=1 WHERE tenant='a' AND connection='source' AND id='source-v2' AND kind='credential'",
      "UPDATE private_data SET revoked_at=NULL WHERE tenant='a' AND connection='source' AND id='source-v2' AND kind='credential'",
    ],
    [
      "UPDATE private_data SET expires_at=0 WHERE tenant='a' AND connection='source' AND id='source-v2' AND kind='credential'",
      "UPDATE private_data SET expires_at=NULL WHERE tenant='a' AND connection='source' AND id='source-v2' AND kind='credential'",
    ],
    [
      "UPDATE connections SET remote_identity='relinked' WHERE tenant='a' AND id='source'",
      "UPDATE connections SET remote_identity='source' WHERE tenant='a' AND id='source'",
    ],
    [
      "UPDATE connections SET config='{}' WHERE tenant='a' AND id='source'",
      "UPDATE connections SET config='{\"accountId\":\"source\"}' WHERE tenant='a' AND id='source'",
    ],
    [
      "UPDATE accounts SET status='revoked' WHERE id='a'",
      "UPDATE accounts SET status='active' WHERE id='a'",
    ],
    [
      "UPDATE cursors SET generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='context'",
      "UPDATE cursors SET generation=generation-1 WHERE tenant='a' AND connection='source' AND stream='context'",
    ],
  ]) {
    assert.ok(
      await h.current(proof),
      "each independent race starts from a current proof",
    );
    await h.store.statement(change).run();
    assert.equal(await h.current(proof), null);
    await assert.rejects(h.mint(), /CHECK constraint/);
    await h.store.statement(restore).run();
    // Restore only fixture metadata so later assertions cannot be masked by
    // the connection trigger's independent reconciliation-version invalidation.
    for (const request of h.requests)
      await h.store
        .statement(
          "UPDATE reconciliation_work SET version=? WHERE tenant='a' AND source='source' AND qso=?",
          request.snapshot.contact.reconciliationVersion,
          request.snapshot.contact.id,
        )
        .run();
  }
  assert.ok(await h.current(proof));
  await h.store
    .statement(
      "UPDATE ledger SET generation='changed' WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .run();
  assert.equal(await h.current(proof), null);
  await h.store
    .statement(
      "UPDATE ledger SET generation=? WHERE tenant='a' AND source='source' AND qso='q1'",
      proof.generation,
    )
    .run();
  assert.ok(await h.current(proof));
  await h.store
    .statement(
      "UPDATE source_read_policies SET phase='drain',completed_at=NULL,completed_sync_generation=NULL WHERE tenant='a' AND source='source'",
    )
    .run();
  assert.equal(await h.current(proof), null);
});

test("ciphertext renewal, delete/reinsert ABA and unavailable source bodies cannot reuse proofs", async (t) => {
  const h = await setup(t);
  const [proof] = await h.mint();
  const dependency = proof.dependencies.find((d) => d.target.id === "event")!;
  const body = (await h.store
    .statement(
      "SELECT * FROM private_data WHERE tenant='a' AND connection='source' AND id=? AND kind='source'",
      dependency.privateId,
    )
    .first<{
      envelope: string;
      created_at: number;
      expires_at: number;
      source_proof_version: string;
    }>())!;
  await h.store
    .statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND id=? AND kind='source'",
      dependency.privateId,
    )
    .run();
  assert.equal(await h.current(proof), null);
  await h.store
    .statement(
      "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at,source_proof_version) VALUES('a','source',?,'source',?,?,?,?)",
      dependency.privateId,
      body.envelope,
      body.created_at,
      body.expires_at,
      body.source_proof_version,
    )
    .run();
  const token = await h.store
    .statement(
      "SELECT source_proof_version FROM private_data WHERE tenant='a' AND connection='source' AND id=? AND kind='source'",
      dependency.privateId,
    )
    .first("source_proof_version");
  assert.notEqual(token, body.source_proof_version);
  assert.equal(await h.current(proof), null);
  await assert.rejects(h.mint(), /CHECK constraint/);
  for (const mutation of [
    "revoked_at=1",
    "revoked_at=NULL,expires_at=0",
    "expires_at=9999999999999,envelope='{}'",
  ]) {
    await h.store
      .statement(
        `UPDATE private_data SET ${mutation} WHERE tenant='a' AND connection='source' AND id=? AND kind='source'`,
        dependency.privateId,
      )
      .run();
    assert.deepEqual(
      await loadSourceExportSnapshots(h.store, h.scope, ["q1"], h.now()),
      [],
    );
  }
  await h.store.db.batch([
    h.store.statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND id=? AND kind='source'",
      dependency.privateId,
    ),
    await h.store.putPrivate(
      "a",
      "source",
      dependency.privateId,
      "source",
      { ...event, event: { event: "note", text: "changed encrypted body" } },
      h.now() + 300_000,
    ),
  ]);
  assert.deepEqual(
    await loadSourceExportSnapshots(h.store, h.scope, ["q1"], h.now()),
    [],
    "valid encryption with a mismatched semantic revision is unavailable",
  );
});

test("cycle lease loss blocks mint, and malformed proof dependency/header rows fail closed", async (t) => {
  const h = await setup(t);
  const [proof] = await h.mint();
  await assert.rejects(
    mintSourceExportProofs(h.store, h.requests, h.lease, h.lease.expires_at),
    /CHECK constraint/,
  );
  await h.store
    .statement(
      "UPDATE leases SET fence=fence+1 WHERE tenant='a' AND scope='cycle:source'",
    )
    .run();
  await assert.rejects(h.mint(), /CHECK constraint/);
  for (const dependencies of [
    [],
    proof.dependencies.filter((d) => d.target.kind !== "operation"),
    proof.dependencies.filter((d) => d.target.id !== "q1"),
    [...proof.dependencies, proof.dependencies[0]],
  ]) {
    const malformed = {
      ...proof,
      id: `malformed-${dependencies.length}-${dependencies.some((d) => d.target.kind === "operation")}`,
      dependencies,
    };
    await h.store
      .statement(
        "INSERT INTO source_export_proofs(tenant,id,source,qso,created_at,expires_at,proof) VALUES('a',?,'source','q1',?,?,?)",
        malformed.id,
        proof.createdAt,
        proof.expiresAt,
        canonical(malformed),
      )
      .run();
    assert.equal(await h.current(malformed), null);
  }
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO source_export_proofs(tenant,id,source,qso,created_at,expires_at,proof) VALUES('a','wrong-header','source','q1',?,?,?)",
        proof.createdAt,
        proof.expiresAt,
        canonical({ ...proof, id: "wrong-json" }),
      )
      .run(),
    /CHECK constraint/,
  );
});

test("bounded snapshot and proof plans use identity and operation probes", async (t) => {
  const h = await setup(t);
  const captured: { sql: string; params: (string | number | null)[] }[] = [];
  const store = new Proxy(h.store, {
    get(target, property, receiver) {
      if (property === "statement")
        return (sql: string, ...params: (string | number | null)[]) => {
          captured.push({ sql, params });
          return target.statement(sql, ...params);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(
    (await loadSourceExportSnapshots(store, h.scope, ["q1"], h.now())).length,
    1,
  );
  const context = captured.find((query) => query.sql.includes("UNION ALL"))!;
  const plan = await h.store
    .statement(`EXPLAIN QUERY PLAN ${context.sql}`, ...context.params)
    .all<{ detail: string }>();
  assert.ok(
    plan.results.some(
      (row) =>
        row.detail.includes("source_context_members") &&
        row.detail.includes("operation_id=?"),
    ),
  );
  const [proof] = await h.mint();
  const guard = sourceExportProofGuard(
    h.scope,
    proof.id,
    {
      qso: proof.qso,
      generation: proof.generation,
      reconciliationVersion: proof.reconciliationVersion,
    },
    h.now(),
  );
  const proofPlan = await h.store
    .statement(`EXPLAIN QUERY PLAN SELECT ${guard.sql}`, ...guard.bindings)
    .all<{ detail: string }>();
  assert.ok(
    proofPlan.results.some(
      (row) =>
        row.detail.includes("source_context_members") &&
        row.detail.includes("operation_id=?"),
    ),
  );
  assert.ok(
    proofPlan.results.some(
      (row) =>
        row.detail.startsWith("SEARCH w ") && row.detail.includes("id=?"),
    ),
  );
  await assert.rejects(
    loadSourceExportSnapshots(
      h.store,
      h.scope,
      Array.from({ length: 21 }, (_, i) => String(i)),
      h.now(),
    ),
    /invalid_source_export_snapshot_request/,
  );
});
