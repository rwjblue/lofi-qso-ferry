import assert from "node:assert/strict";
import { observeContact, pollSource, rereadOperation } from "../src/intake.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { backfillLotwOwnership } from "../src/lotw-ownership.ts";
import { canonical } from "../src/security.ts";
import {
  loadCurrentSourcePresenceScope,
  loadSourceExportSnapshots,
  mintSourceExportProofs,
  type SourceExportAuthorization,
} from "../src/source-export-proofs.ts";
import { loadSourcePresence } from "../src/source-presence-store.ts";
import { sourceReadPolicy } from "../src/source-read-policy.ts";
import type { Connection, Store } from "../src/store.ts";

let budgetWindow = 10_000;
/**
 * Genuine canonical observations and a final drain, using only synthetic HTTP.
 * Arrays in the return value align with input qsos. Optional observedAt permits
 * OLD positive observations for expiry tests; it cannot be future-dated. Vendor
 * budget clocks are separate so fixture setup does not consume test-run quotas.
 */
export async function mintFixtureSourceProofs(
  store: Store,
  input: {
    source: Connection;
    qsos: SourceRecord[];
    operations: SourceRecord[];
    events?: SourceRecord[];
    destinations?: Connection[];
    observedAt?: number;
  },
) {
  const { source } = input;
  const accountId = JSON.parse(source.config).accountId as string;
  const records = [...input.qsos, ...(input.events ?? [])];
  const reply = (qsos: SourceRecord[], operations: SourceRecord[]) =>
    Response.json({
      account: { uuid: accountId },
      qsos,
      operations,
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    });
  const poll = (
    qsos: SourceRecord[],
    operations: SourceRecord[],
    now = Date.now(),
  ) =>
    pollSource(
      store,
      source,
      async () => reply(qsos, operations),
      now,
      "sync",
      ++budgetWindow * 300_000,
    );
  // Establish, rather than manufacture, each baseline/drain/quarantine phase.
  await poll(records, input.operations, input.observedAt ?? Date.now());
  for (
    let turn = 0;
    turn < 3 &&
    (await sourceReadPolicy(store, source.tenant, source.id))?.phase !==
      "ready";
    turn++
  )
    await poll([], []);
  assert.equal(
    (await sourceReadPolicy(store, source.tenant, source.id))?.phase,
    "ready",
  );
  for (let turn = 0; turn < input.operations.length; turn++) {
    await rereadOperation(
      store,
      source,
      async (url) => {
        const operationId = decodeURIComponent(
          new URL(String(url)).pathname.split("/").at(-2)!,
        );
        return reply(
          records.filter((record) => record.operation === operationId),
          [],
        );
      },
      Date.now(),
      undefined,
      ++budgetWindow * 300_000,
    );
  }
  const observedAt = input.observedAt ?? Date.now();
  assert.ok(
    observedAt <= Date.now(),
    "fixture cannot invent a future positive",
  );
  await poll(records, input.operations, observedAt);
  const scope = await loadCurrentSourcePresenceScope(store, source);
  assert.ok(scope);
  const ids = input.qsos.map((record) => {
    assert.equal(typeof record.uuid, "string");
    return record.uuid as string;
  });
  const before = await loadSourceExportSnapshots(store, scope, ids);
  assert.equal(
    before.length,
    ids.length,
    "actual baseline/context must project every fixture contact",
  );
  const targets = [
    ...new Map(
      before.flatMap((snapshot) =>
        snapshot.targets.map(
          (target) => [canonical([target.kind, target.id]), target] as const,
        ),
      ),
    ).values(),
  ];
  const witnesses = (await loadSourcePresence(store, scope, targets)).map(
    (witness) => {
      assert.ok(witness);
      return witness;
    },
  );
  const collectionFinishedAt = Date.now();
  await poll([], []);
  const snapshots = await loadSourceExportSnapshots(store, scope, ids);
  assert.equal(snapshots.length, ids.length);
  for (const snapshot of snapshots)
    await observeContact(
      store,
      source,
      snapshot.contact,
      Date.now(),
      input.destinations,
    );
  // Current delivery callers normally receive this bounded maintenance after
  // observation from the scheduler. Historical migration fixtures keep their
  // original schema and behavior; no proof or registry fact is fabricated here.
  if (
    await store
      .statement(
        "SELECT 1 present FROM sqlite_master WHERE type='table' AND name='lotw_ownership_write_guards'",
      )
      .first()
  ) {
    for (let pass = 0; pass < 10; pass++) {
      const ownership = await backfillLotwOwnership(store, source.tenant, {
        limit: 100,
      });
      if (
        ownership.reason !== "examined" ||
        !(ownership.advanced || ownership.covered || ownership.ownersHashed)
      )
        break;
    }
  }
  const lease = await store.claim(
    source.tenant,
    `cycle:${source.id}`,
    Date.now(),
    90_000,
  );
  assert.ok(lease);
  try {
    const proofs = await mintSourceExportProofs(
      store,
      snapshots.map((snapshot) => ({
        snapshot,
        witnesses,
        collectionFinishedAt,
      })),
      lease,
    );
    const authorizations: SourceExportAuthorization[] = proofs.map((proof) => ({
      proofId: proof.id,
      scope: proof.scope,
      reconciliationVersion: proof.reconciliationVersion,
    }));
    return { scope, snapshots, proofs, authorizations };
  } finally {
    await store.release(lease);
  }
}
