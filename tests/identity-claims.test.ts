import assert from "node:assert/strict";
import test from "node:test";
import {
  type DeliveryGates,
  dispatchAttempt,
  type PreparedPayload,
  prepareDue,
  reconcileAttempt,
} from "../src/delivery.ts";
import {
  claimedAttemptCurrent,
  destinationIdentityClaim,
} from "../src/identity-claims.ts";
import {
  observeContact,
  pendingContacts,
  pollSource,
  rereadOperation,
} from "../src/intake.ts";
import { sameQrzIdentity } from "../src/qrz.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import { canonical, sha256 } from "../src/security.ts";
import type { LedgerKey } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  FIXTURE_NOW,
  schedulerFixture,
} from "./runtime-fixtures.ts";

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
const due = 31 * 60_000;

async function claimFixture(vendor: "qrz" | "lotw" = "qrz", stageAt = due) {
  const h = await database();
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
  const add = async (target: LedgerKey, generation = "g1") => {
    await h.store.observe(
      target,
      generation,
      `hash:${generation}`,
      30,
      false,
      0,
    );
    await h.store
      .statement(
        "UPDATE ledger SET state='missing_current_identity' WHERE tenant=? AND source=? AND qso=? AND destination=?",
        target.tenant,
        target.source,
        target.qso,
        target.destination,
      )
      .run();
  };
  const stage = async (target: LedgerKey, generation = "g1", chosen = claim) =>
    h.store.stage(
      target,
      generation,
      {
        kind: "qrz",
        record,
        operation: "insert",
        mappedLogId: null,
        narrative: "template_bound",
        projectionHash: "hash",
        members: [{ id: target.qso, generation }],
        preparedAt: new Date(stageAt).toISOString(),
      } satisfies PreparedPayload,
      "v1",
      version,
      stageAt,
      undefined,
      undefined,
      "live",
      { claim: chosen },
    );
  await add(key);
  return { ...h, key, claim, version, add, stage };
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
          /outbound identity claim conflict/,
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
    const lease = await h.store.claim("a", "delivery:destination", due, 60000);
    assert(lease);
    assert(await h.store.claimAttempt("a", next, lease, due));
    await h.store.resolve("a", next, lease, "uncertain", null, due + 1);
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
        "g1",
        {},
        "v1",
        tenantVersion,
        due,
        undefined,
        undefined,
        "live",
        { claim: h.claim },
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
        "g1",
        {},
        "v1",
        destVersion,
        due,
        undefined,
        undefined,
        "live",
        { claim: h.claim },
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
    await pollSource(h.store, source, fetcher, FIXTURE_NOW);
    // Complete the real all-client forward drain and quarantine before projection.
    await pollSource(h.store, source, fetcher, FIXTURE_NOW);
    await pollSource(h.store, source, fetcher, FIXTURE_NOW);
    await rereadOperation(h.store, source, fetcher, FIXTURE_NOW);
    const items = await pendingContacts(h.store, source, 10, FIXTURE_NOW);
    for (const item of items)
      await observeContact(h.store, source, item, FIXTURE_NOW);
    await h.store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    const item = items.find((item) => item.id === "q1");
    assert(item);
    return { ...h, fetcher, source, items, item, now: FIXTURE_NOW + due };
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
        assert.equal(result.state, "rejected");
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
    const [fresh] = await pendingContacts(
      h.store,
      h.source,
      1,
      h.now + 2,
      undefined,
      "q1",
    );
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

test("a source revision arriving during preparation rolls back the complete identity stage", async () => {
  const h = await retainedFixture();
  try {
    let changed = false;
    await assert.rejects(
      prepareDue(
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
      /source read policy unavailable before stage/,
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
  const now = FIXTURE_NOW + due;
  const h = await claimFixture("qrz", now);
  try {
    const payload: PreparedPayload = {
      kind: "qrz",
      record,
      operation: "insert",
      mappedLogId: null,
      narrative: "template_bound",
      projectionHash: "hash",
      members: [{ id: "q1", generation: "g1" }],
      preparedAt: new Date(now).toISOString(),
    };
    const legacy = await h.store.stage(
      h.key,
      "g1",
      payload,
      "v1",
      h.version,
      now,
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
      "g1",
      payload,
      "v1",
      h.version,
      now,
      undefined,
      undefined,
      "live",
      { claim: wrong },
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
    const lease = await h.store.claim("a", "delivery:destination", now, 100);
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
        now + 100,
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
