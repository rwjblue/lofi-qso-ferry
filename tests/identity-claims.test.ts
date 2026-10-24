import assert from "node:assert/strict";
import test from "node:test";
import {
  type DeliveryGates,
  dispatchAttempt,
  type PreparedPayload,
  prepareDue as prepareDueRuntime,
  reconcileAttempt,
} from "../src/delivery.ts";
import {
  claimedAttemptCurrent,
  destinationIdentityClaim,
} from "../src/identity-claims.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { sameQrzIdentity } from "../src/qrz.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import { canonical, sha256 } from "../src/security.ts";
import type { SourceExportAuthorization } from "../src/source-export-proofs.ts";
import type { LedgerKey, Store } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  schedulerFixture,
} from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const gates: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: true,
};
const record = {
  STATION_CALLSIGN: "W1AW",
  CALL: "K1ABC",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "SSB",
  SUBMODE: "USB",
  MY_GRIDSQUARE: "FN31AA12",
};

const sourceAuthorizations = new WeakMap<
  Store,
  Map<string, SourceExportAuthorization>
>();
const proofKey = (key: Pick<LedgerKey, "tenant" | "source" | "qso">) =>
  JSON.stringify([key.tenant, key.source, key.qso]);
async function prepareDue(...args: Parameters<typeof prepareDueRuntime>) {
  const [store, key, contact, gates, deps] = args;
  return prepareDueRuntime(store, key, contact, gates, {
    sourceProof: sourceAuthorizations.get(store)?.get(proofKey(key)),
    ...deps,
  });
}

async function claimFixture(vendor: "qrz" | "lotw" = "qrz") {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    const key = await seed(h.store);
    await h.store
      .statement("UPDATE connections SET kind=? WHERE id='destination'", vendor)
      .run();
    const version =
      vendor === "qrz"
        ? await h.store.saveTemplate("a", "destination", {})
        : null;
    const claim = await destinationIdentityClaim(vendor, record);
    const groups = new Map<string, Map<string, SourceRecord>>();
    const current = new Map<
      string,
      {
        generation: string;
        authorization: SourceExportAuthorization;
      }
    >();
    let stamp = 100;
    const add = async (target: LedgerKey, generation = "g1") => {
      const groupKey = JSON.stringify([target.tenant, target.source]);
      const records = groups.get(groupKey) ?? new Map<string, SourceRecord>();
      groups.set(groupKey, records);
      let source = (await h.store.connection(target.tenant, target.source))!;
      if (!JSON.parse(source.config).accountId) {
        await h.store
          .statement(
            "UPDATE connections SET config=? WHERE tenant=? AND id=?",
            JSON.stringify({ accountId: source.remote_identity }),
            target.tenant,
            target.source,
          )
          .run();
        await h.store
          .statement(
            "DELETE FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='credential'",
            target.tenant,
            target.source,
            source.credential_version,
          )
          .run();
        await (
          await h.store.putPrivate(
            target.tenant,
            target.source,
            source.credential_version!,
            "credential",
            {
              key: "browser:identity-fixture",
              secret: "fixture",
              token: "fixture",
            },
          )
        ).run();
        source = (await h.store.connection(target.tenant, target.source))!;
      }
      records.set(target.qso, {
        uuid: target.qso,
        operation: null,
        syncedAtMillis: ++stamp,
        startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
        band: "20m",
        freq: 14200,
        mode: "SSB",
        submode: "USB",
        their: { call: "K1ABC" },
        our: { stationCall: "W1AW", grid: "FN31AA12", dxccCode: 291 },
        notes: generation,
      });
      const evidence = await mintFixtureSourceProofs(h.store, {
        source,
        qsos: [...records.values()],
        operations: [],
      });
      for (const [index, snapshot] of evidence.snapshots.entries()) {
        current.set(proofKey({ ...target, qso: snapshot.contact.id }), {
          generation: snapshot.contact.generation,
          authorization: evidence.authorizations[index],
        });
      }
      await h.store
        .statement(
          "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant=? AND source=? AND qso=? AND destination=?",
          target.tenant,
          target.source,
          target.qso,
          target.destination,
        )
        .run();
    };
    const stage = async (
      target: LedgerKey,
      _generation = "g1",
      chosen = claim,
    ) => {
      const { generation, authorization } = current.get(proofKey(target))!;
      const payload: PreparedPayload =
        vendor === "lotw"
          ? {
              kind: "lotw",
              tq8: "synthetic-signed-artifact",
              station: { callsign: record.STATION_CALLSIGN, dxcc: 291 },
              contact: {
                id: target.qso,
                generation,
                call: record.CALL,
                date: "2026-10-22",
                time: "12:00:01Z",
                band: record.BAND,
                mode: record.MODE,
                submode: record.SUBMODE,
              },
              certificateVersion: "v1",
              configurationVersion: "fixture",
              projectionHash: "hash",
              members: [{ id: target.qso, generation }],
              preparedAt: new Date().toISOString(),
            }
          : {
              kind: "qrz",
              record,
              operation: "insert",
              mappedLogId: null,
              narrative: "template_bound",
              projectionHash: "hash",
              members: [{ id: target.qso, generation }],
              preparedAt: new Date().toISOString(),
            };
      return h.store.stage(
        target,
        generation,
        payload,
        "v1",
        version,
        Date.now(),
        undefined,
        undefined,
        "live",
        { claim: chosen, sourceVersion: authorization.reconciliationVersion },
        authorization,
      );
    };
    await add(key);
    return { ...h, key, claim, version, add, stage, current };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("claim normalization matches existing vendor identity semantics without location or narrative collapse", async () => {
  const upper = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, value.toUpperCase()]),
  );
  assert(sameQrzIdentity(record, upper));
  assert.deepEqual(
    await destinationIdentityClaim("qrz", record),
    await destinationIdentityClaim("qrz", {
      ...upper,
      MY_GRIDSQUARE: "FN32",
      COMMENT: "unrelated",
    }),
  );
  assert.equal(
    (await destinationIdentityClaim("lotw", record)).hash,
    await lotwRemoteIdentity(record),
  );
  assert.equal(
    (await destinationIdentityClaim("lotw", record)).hash,
    await sha256(canonical(canonicalLotwIdentity(record))),
  );
  assert.notEqual(
    (await destinationIdentityClaim("qrz", record)).hash,
    (await destinationIdentityClaim("qrz", { ...record, TIME_ON: "120002" }))
      .hash,
  );
  await assert.rejects(
    destinationIdentityClaim("qrz", { ...record, TIME_ON: "1200" }),
    /Invalid outbound destination identity/,
  );
});

test("competing stages atomically elect one source UUID across both vendors", async (t) => {
  for (const vendor of ["qrz", "lotw"] as const)
    await t.test(vendor, async () => {
      const h = await claimFixture(vendor);
      try {
        const other = { ...h.key, qso: "q2" };
        await h.add(other);
        const raced = await Promise.allSettled([
          h.stage(h.key),
          h.stage(other),
        ]);
        assert.equal(
          raced.filter((item) => item.status === "fulfilled").length,
          1,
        );
        assert.match(
          String(
            (
              raced.find(
                (item) => item.status === "rejected",
              ) as PromiseRejectedResult
            ).reason,
          ),
          vendor === "lotw"
            ? /LoTW ownership unavailable|outbound identity claim conflict/
            : /outbound identity claim conflict/,
        );
        assert.equal(
          (
            await h.store
              .statement("SELECT COUNT(*) n FROM attempts")
              .first<{ n: number }>()
          )?.n,
          1,
        );
        assert.equal(
          (
            await h.store
              .statement("SELECT COUNT(*) n FROM destination_identity_claims")
              .first<{ n: number }>()
          )?.n,
          1,
        );
        assert.equal(
          (
            await h.store
              .statement(
                "SELECT COUNT(*) n FROM private_data WHERE kind='outbox'",
              )
              .first<{ n: number }>()
          )?.n,
          1,
        );
      } finally {
        await h.mf.dispose();
      }
    });
});

test("a later stage failure rolls back claim, artifact and attempt together", async () => {
  const h = await claimFixture();
  try {
    await h.store
      .statement(
        "CREATE TRIGGER forced_stage_failure BEFORE INSERT ON attempt_state BEGIN SELECT RAISE(ABORT,'forced fixture rollback'); END",
      )
      .run();
    await assert.rejects(h.stage(h.key), /forced fixture rollback/);
    for (const table of [
      "destination_identity_claims",
      "attempt_identity_claims",
      "attempts",
    ])
      assert.equal(
        (
          await h.store
            .statement(`SELECT COUNT(*) n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
      );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM private_data WHERE kind='outbox'")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await h.store.statement("DROP TRIGGER forced_stage_failure").run();
    const other = { ...h.key, qso: "q2" };
    await h.add(other);
    assert(await h.stage(other));
  } finally {
    await h.mf.dispose();
  }
});

test("claims survive cancellation, uncertainty, expiry and identity edits without crossing tenant or destination scope", async () => {
  const h = await claimFixture();
  try {
    const attempt = await h.stage(h.key);
    await h.store
      .statement(
        "UPDATE attempt_state SET state='cancelled' WHERE attempt=?",
        attempt,
      )
      .run();
    const edited = await destinationIdentityClaim("qrz", {
      ...record,
      TIME_ON: "120002",
    });
    await h.add(h.key, "g2");
    const next = await h.stage(h.key, "g2", edited);
    const lease = await h.store.claim(
      "a",
      "delivery:destination",
      Date.now(),
      60000,
    );
    assert(lease);
    assert(await h.store.claimAttempt("a", next, lease, Date.now()));
    await h.store.resolve("a", next, lease, "uncertain", null, Date.now());
    await h.store
      .statement("DELETE FROM private_data WHERE kind='outbox'")
      .run();
    const other = { ...h.key, qso: "q2" };
    await h.add(other);
    await assert.rejects(h.stage(other), /outbound identity claim conflict/);
    await assert.rejects(
      h.stage(other, "g1", edited),
      /outbound identity claim conflict/,
    );
    await assert.rejects(
      h.store.statement("DELETE FROM destination_identity_claims").run(),
      /requires explicit review/,
    );
    const tenantKey = await seed(h.store, "b");
    await h.add(tenantKey);
    const tenantVersion = await h.store.saveTemplate("b", "destination", {});
    assert(
      await h.store.stage(
        tenantKey,
        h.current.get(proofKey(tenantKey))!.generation,
        {},
        "v1",
        tenantVersion,
        Date.now(),
        undefined,
        undefined,
        "live",
        {
          claim: h.claim,
          sourceVersion: h.current.get(proofKey(tenantKey))!.authorization
            .reconciliationVersion,
        },
        h.current.get(proofKey(tenantKey))!.authorization,
      ),
    );
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','destination2','qrz','book2','other','active','v1',0)",
      )
      .run();
    await (
      await h.store.putPrivate("a", "destination2", "v1", "credential", {})
    ).run();
    const destKey = { ...h.key, destination: "destination2" };
    await h.add(destKey);
    const destVersion = await h.store.saveTemplate("a", "destination2", {});
    assert(
      await h.store.stage(
        destKey,
        h.current.get(proofKey(destKey))!.generation,
        {},
        "v1",
        destVersion,
        Date.now(),
        undefined,
        undefined,
        "live",
        {
          claim: h.claim,
          sourceVersion: h.current.get(proofKey(destKey))!.authorization
            .reconciliationVersion,
        },
        h.current.get(proofKey(destKey))!.authorization,
      ),
    );
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','source2','lofi','source2','other','active','v1',0)",
      )
      .run();
    await (
      await h.store.putPrivate("a", "source2", "v1", "credential", {})
    ).run();
    const sourceKey = { ...h.key, source: "source2" };
    await h.add(sourceKey);
    await assert.rejects(
      h.stage(sourceKey),
      /outbound identity claim conflict/,
    );
  } finally {
    await h.mf.dispose();
  }
});

async function retainedFixture(withSecond = false, withEvent = false) {
  const h = await schedulerFixture();
  try {
    h.qso.startAtMillis = Number(h.qso.startAtMillis) + 123;
    h.operation.grid = "FN31AA12";
    h.qrzRecords.splice(0);
    h.lotwRecords.splice(0);
    if (withSecond)
      h.changes.qsos.push({
        ...h.qso,
        uuid: "q2",
        startAtMillis: Number(h.qso.startAtMillis) + 666,
        syncedAtMillis: 102,
      });
    if (withEvent)
      h.changes.qsos.push({
        uuid: "event1",
        operation: h.operation.uuid,
        band: "event",
        event: { event: "start" },
        startAtMillis: Number(h.qso.startAtMillis) - 1000,
        syncedAtMillis: 103,
      });
    const sourceQsos = [...h.changes.qsos];
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/operations/op-fixture/qsos")
        return Response.json({
          qsos: sourceQsos,
          meta: { qsos: { records_left: 0 } },
        });
      return h.fetcher(input, init);
    };
    const source = await h.store.connection("a", "source");
    assert(source);
    const refreshProofs = async () => {
      const evidence = await mintFixtureSourceProofs(h.store, {
        source,
        qsos: sourceQsos.filter((qso) => qso.band !== "event"),
        operations: [h.operation],
        events: sourceQsos.filter((qso) => qso.band === "event"),
      });
      sourceAuthorizations.set(
        h.store,
        new Map(
          evidence.snapshots.map((snapshot, index) => [
            proofKey({
              tenant: "a",
              source: "source",
              qso: snapshot.contact.id,
            }),
            evidence.authorizations[index],
          ]),
        ),
      );
      return evidence.snapshots.map((snapshot) => snapshot.contact);
    };
    const items = await refreshProofs();
    h.changes.operations.splice(0);
    h.changes.qsos.splice(0);
    await h.store
      .statement("UPDATE ledger SET state='missing_current_identity',due_at=0")
      .run();
    const item = items.find((item) => item.id === "q1");
    assert(item);
    return {
      ...h,
      fetcher,
      source,
      items,
      item,
      refreshProofs,
      get now() {
        return Date.now();
      },
    };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("fractional contacts with full eight-character grids stage, dispatch and reconcile under both durable claims", async () => {
  const h = await retainedFixture(true);
  try {
    const before = structuredClone(h.item);
    const second = h.items.find((item) => item.id === "q2");
    assert(second);
    for (const destination of ["destination", "lotw"]) {
      const key = { tenant: "a", source: "source", qso: "q1", destination };
      const prepared = await prepareDue(h.store, key, h.item, gates, {
        fetcher: h.fetcher,
        now: h.now,
      });
      assert(prepared.attemptId);
      const payload = await h.store.private<PreparedPayload>(
        "a",
        destination,
        prepared.attemptId,
        "outbox",
      );
      assert(payload);
      if (payload.kind === "qrz") {
        assert.equal(payload.record.TIME_ON, "120001");
        assert.equal(payload.record.MY_GRIDSQUARE, "FN31AA12");
      } else {
        assert.equal(payload.contact.time, "12:00:01Z");
        assert.equal(payload.station.grid, "FN31AA12");
      }
      const sent = await dispatchAttempt(
        h.store,
        "a",
        prepared.attemptId,
        gates,
        {
          now: h.now + 1,
          fetcher: async (input, init) => {
            const result = await h.fetcher(input, init);
            const url = new URL(String(input));
            const form = new URLSearchParams(String(init?.body));
            if (
              form.get("ACTION") === "INSERT" ||
              url.pathname === "/lotw/upload"
            )
              throw new Error("synthetic lost mutation response");
            return result;
          },
        },
      );
      assert.equal(sent.state, "uncertain");
      const records =
        destination === "destination" ? h.qrzRecords : h.lotwRecords;
      const hidden = records.splice(0);
      assert.deepEqual(
        await prepareDue(h.store, { ...key, qso: "q2" }, second, gates, {
          now: h.now + 2,
          fetcher: async () => assert.fail("competing UUID read a vendor"),
          sign: async () => assert.fail("competing UUID signed"),
        }),
        { state: "blocked", reason: "outbound_identity_claim_conflict" },
      );
      records.push(...hidden);
      assert.equal(
        (
          await reconcileAttempt(h.store, "a", prepared.attemptId, {
            now: h.now + 3,
            fetcher: h.fetcher,
          })
        ).state,
        "observed",
      );
    }
    assert.deepEqual(h.item, before);
    assert.equal(h.item.startAtMillis % 1000, 123);
    assert.equal(h.item.grid, "FN31AA12");
    assert.equal(h.calls.qrzWrites, 1);
    assert.equal(h.calls.lotwUploads, 1);
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM destination_identity_claims")
          .first<{ n: number }>()
      )?.n,
      2,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("source dependency loss during final vendor reads prevents QRZ writes and LoTW uploads", async (t) => {
  for (const [destination, change] of [
    ["destination", "event"],
    ["lotw", "operation"],
    ["destination", "source_credential"],
  ] as const)
    await t.test(`${destination}:${change}`, async () => {
      const h = await retainedFixture(false, true);
      try {
        const key = { tenant: "a", source: "source", qso: "q1", destination };
        const prepared = await prepareDue(h.store, key, h.item, gates, {
          now: h.now,
          fetcher: h.fetcher,
        });
        assert(prepared.attemptId);
        let changed = false;
        const result = await dispatchAttempt(
          h.store,
          "a",
          prepared.attemptId,
          gates,
          {
            now: h.now + 1,
            fetcher: async (input, init) => {
              if (!changed) {
                changed = true;
                if (change === "event")
                  await h.store
                    .statement(
                      "UPDATE private_data SET revoked_at=? WHERE kind='source' AND id IN(SELECT private_id FROM source_work WHERE id='event1')",
                      h.now + 1,
                    )
                    .run();
                else if (change === "operation")
                  await h.store
                    .statement(
                      "UPDATE source_work SET expires_at=? WHERE kind='operation'",
                      h.now + 1,
                    )
                    .run();
                else
                  await h.store
                    .statement(
                      "UPDATE private_data SET revoked_at=? WHERE connection='source' AND kind='credential'",
                      h.now + 1,
                    )
                    .run();
              }
              return h.fetcher(input, init);
            },
          },
        );
        assert(changed);
        assert.equal(result.state, "blocked");
        assert.equal(
          await h.store
            .statement(
              "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
              prepared.attemptId,
            )
            .first("state"),
          "cancelled",
        );
        assert.equal(h.calls.qrzWrites, 0);
        assert.equal(h.calls.lotwUploads, 0);
        assert.equal(
          (
            await h.store
              .statement("SELECT COUNT(*) n FROM destination_identity_claims")
              .first<{ n: number }>()
          )?.n,
          1,
        );
      } finally {
        await h.mf.dispose();
      }
    });
});

test("changed proof cancels only a known-unsent attempt and permits same-owner regeneration", async () => {
  const h = await retainedFixture();
  try {
    const key = {
      tenant: "a",
      source: "source",
      qso: "q1",
      destination: "destination",
    };
    const prepared = await prepareDue(h.store, key, h.item, gates, {
      now: h.now,
      fetcher: h.fetcher,
    });
    assert(prepared.attemptId);
    await h.store
      .statement(
        "UPDATE reconciliation_work SET version=version+1 WHERE qso='q1'",
      )
      .run();
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          now: h.now + 1,
          fetcher: async () => assert.fail("stale evidence dispatched"),
        })
      ).state,
      "blocked",
    );
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT state FROM attempt_state WHERE attempt=?",
            prepared.attemptId,
          )
          .first<{ state: string }>()
      )?.state,
      "cancelled",
    );
    const [fresh] = await h.refreshProofs();
    assert(fresh);
    assert.equal(fresh.generation, h.item.generation);
    const next = await prepareDue(h.store, key, fresh, gates, {
      now: h.now + 2,
      fetcher: h.fetcher,
    });
    assert(next.attemptId);
    assert.notEqual(next.attemptId, prepared.attemptId);
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM destination_identity_claims")
          .first<{ n: number }>()
      )?.n,
      1,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("a source revision arriving during preparation prevents the complete identity stage", async () => {
  const h = await retainedFixture();
  try {
    let changed = false;
    assert.deepEqual(
      await prepareDue(
        h.store,
        {
          tenant: "a",
          source: "source",
          qso: "q1",
          destination: "destination",
        },
        h.item,
        gates,
        {
          now: h.now,
          fetcher: async (input, init) => {
            if (!changed) {
              changed = true;
              await h.store
                .statement(
                  "UPDATE source_work SET revision='new-source-revision' WHERE kind='qso' AND id='q1'",
                )
                .run();
            }
            return h.fetcher(input, init);
          },
        },
      ),
      { state: "blocked", reason: "source_export_proof_unavailable" },
    );
    assert(changed);
    assert.equal(
      (
        await h.store.ledger({
          tenant: "a",
          source: "source",
          qso: "q1",
          destination: "destination",
        })
      )?.generation,
      h.item.generation,
    );
    for (const table of [
      "destination_identity_claims",
      "attempt_identity_claims",
      "attempts",
    ])
      assert.equal(
        (
          await h.store
            .statement(`SELECT COUNT(*) n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
      );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM private_data WHERE kind='outbox'")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("legacy unlinked and payload-mismatched attempts cannot dispatch, and final checks require the live lease", async () => {
  const h = await claimFixture("qrz");
  let now = Date.now();
  try {
    const payload: PreparedPayload = {
      kind: "qrz",
      record,
      operation: "insert",
      mappedLogId: null,
      narrative: "template_bound",
      projectionHash: "hash",
      members: [
        { id: "q1", generation: h.current.get(proofKey(h.key))!.generation },
      ],
      preparedAt: new Date(now).toISOString(),
    };
    const legacy = await h.store.stage(
      h.key,
      h.current.get(proofKey(h.key))!.generation,
      payload,
      "v1",
      h.version,
      now,
      undefined,
      undefined,
      "live",
      undefined,
      h.current.get(proofKey(h.key))!.authorization,
    );
    assert.deepEqual(
      await dispatchAttempt(h.store, "a", legacy, gates, {
        now,
        fetcher: async () => assert.fail("legacy dispatch"),
      }),
      { state: "blocked", reason: "outbound_identity_claim_unavailable" },
    );
    await h.store
      .statement(
        "UPDATE attempt_state SET state='cancelled' WHERE attempt=?",
        legacy,
      )
      .run();
    const wrong = await destinationIdentityClaim("qrz", {
      ...record,
      TIME_ON: "120002",
    });
    const mismatch = await h.store.stage(
      h.key,
      h.current.get(proofKey(h.key))!.generation,
      payload,
      "v1",
      h.version,
      now,
      undefined,
      undefined,
      "live",
      {
        claim: wrong,
        sourceVersion: h.current.get(proofKey(h.key))!.authorization
          .reconciliationVersion,
      },
      h.current.get(proofKey(h.key))!.authorization,
    );
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", mismatch, gates, {
          now,
          fetcher: async () => assert.fail("mismatched dispatch"),
        })
      ).state,
      "blocked",
    );
    const good = await h.stage(h.key);
    now = Date.now();
    const lease = await h.store.claim("a", "delivery:destination", now, 60_000);
    assert(lease);
    assert(await h.store.claimAttempt("a", good, lease, now));
    assert(
      await claimedAttemptCurrent(h.store, "a", good, h.claim, now, lease),
    );
    assert.equal(
      await claimedAttemptCurrent(
        h.store,
        "a",
        good,
        h.claim,
        now + 60_000,
        lease,
      ),
      false,
    );
    assert.equal(
      await claimedAttemptCurrent(h.store, "a", good, h.claim, now, {
        ...lease,
        fence: lease.fence + 1,
      }),
      false,
    );
  } finally {
    await h.mf.dispose();
  }
});
