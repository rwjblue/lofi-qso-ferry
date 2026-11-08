import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAttemptBatch, prepareDueBatch } from "../src/delivery.ts";
import { Store } from "../src/store.ts";
import {
  qrzDeliveryQueueFixture,
  qrzDeliveryQueueWorkload,
} from "./qrz-delivery-queue-workload.ts";

for (const count of [10, 20] as const)
  test(`a queue of ${count} uses fewer than five database calls per preparation/dispatch`, async (t) => {
    const run = await qrzDeliveryQueueWorkload(count);
    assert.equal(run.uploads, count);
    assert.equal(
      run.database.preparationCalls,
      2,
      "one bulk read and one native stage batch",
    );
    assert(run.database.callsPerContact < 5);
    t.diagnostic(JSON.stringify(run));
  });

test("bulk preparation retains the global two-attempt background outbox limit", async (t) => {
  const h = await qrzDeliveryQueueFixture(t, 10);
  const before = h.meter.metrics.calls;
  await assert.rejects(
    dispatchAttemptBatch(
      h.store,
      "a",
      Array.from({ length: 26 }, (_, index) => ({
        id: `unloaded-${index}`,
        deps: {},
      })),
      h.gates,
    ),
    /invalid dispatch cohort/,
  );
  assert.equal(
    h.meter.metrics.calls,
    before,
    "invalid cohorts cannot bypass the bound through individual recovery",
  );
  const outcomes = await prepareDueBatch(
    h.store,
    h.members.map((member) => ({
      ...member,
      deps: { ...member.deps, priority: "background" as const },
    })),
    h.gates,
  );
  assert(
    outcomes
      .slice(0, 2)
      .every(
        (row) => row.status === "fulfilled" && row.value.state === "prepared",
      ),
  );
  assert(
    outcomes
      .slice(2)
      .every(
        (row) =>
          row.status === "fulfilled" &&
          row.value.reason === "background_outbox_full",
      ),
  );
  assert.equal(
    await h.store.statement("SELECT count(*) n FROM attempts").first("n"),
    2,
  );
});

test("a raced preparation member rolls back the cohort and healthy members recover individually", async (t) => {
  let raced = false;
  const h = await qrzDeliveryQueueFixture(
    t,
    10,
    (db, original) =>
      new (class extends Store {
        override async stageBatch(inputs: Parameters<Store["stageBatch"]>[0]) {
          if (!raced) {
            raced = true;
            await original
              .statement(
                "UPDATE ledger SET due_at=? WHERE qso='queued-0'",
                Date.now() + 60_000,
              )
              .run();
          }
          return super.stageBatch(inputs);
        }
      })(db, original.keys),
  );
  const outcomes = await prepareDueBatch(h.store, h.members, h.gates);
  assert(raced);
  assert.deepEqual(outcomes[0], {
    status: "fulfilled",
    value: { state: "skipped", reason: "not_due_or_current" },
  });
  assert(
    outcomes
      .slice(1)
      .every(
        (row) => row.status === "fulfilled" && row.value.state === "prepared",
      ),
  );
  assert.equal(
    await h.store.statement("SELECT count(*) n FROM attempts").first("n"),
    9,
  );
  assert.equal(
    await h.store.statement("SELECT count(*) n FROM stage_guards").first("n"),
    0,
  );
});

test("a revoked source after final QRZ read prevents that write and all remaining queued writes", async (t) => {
  const h = await qrzDeliveryQueueFixture(t, 10);
  const prepared = await prepareDueBatch(h.store, h.members, h.gates);
  let revoked = false;
  const results = await dispatchAttemptBatch(
    h.store,
    "a",
    prepared.map((outcome, index) => {
      assert(outcome.status === "fulfilled" && outcome.value.attemptId);
      return {
        id: outcome.value.attemptId,
        deps: {
          sourceContact: h.members[index].contact,
          fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
            const result = await h.fetcher(input, init);
            if (!revoked) {
              revoked = true;
              await h.store
                .statement(
                  "UPDATE private_data SET revoked_at=? WHERE connection='source' AND kind='credential'",
                  Date.now(),
                )
                .run();
            }
            return result;
          },
        },
      };
    }),
    h.gates,
  );
  assert(revoked);
  assert.equal(h.calls.qrzWrites, 0);
  assert(
    results.every(
      (row) => row.status === "fulfilled" && row.value.state !== "delivered",
    ),
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) n FROM attempt_state WHERE state='dispatching'",
      )
      .first("n"),
    0,
  );
});

test("a shared lease and loaded connection cannot authorize later contacts after the destination pauses", async (t) => {
  const h = await qrzDeliveryQueueFixture(t, 10);
  const prepared = await prepareDueBatch(h.store, h.members, h.gates);
  const results = await dispatchAttemptBatch(
    h.store,
    "a",
    prepared.map((row, index) => {
      assert(row.status === "fulfilled" && row.value.attemptId);
      return {
        id: row.value.attemptId,
        deps: {
          sourceContact: h.members[index].contact,
          fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await h.fetcher(input, init);
            if (
              new URLSearchParams(String(init?.body)).get("ACTION") === "INSERT"
            )
              await h.store
                .statement(
                  "UPDATE connections SET status='paused' WHERE id='destination'",
                )
                .run();
            return response;
          },
        },
      };
    }),
    h.gates,
  );
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(
    h.calls.qrzReads,
    11,
    "ten planning reads and only the first final read",
  );
  assert(
    results[0].status === "fulfilled" && results[0].value.state === "delivered",
  );
  assert(
    results
      .slice(1)
      .every(
        (row) => row.status === "fulfilled" && row.value.state !== "delivered",
      ),
  );
});

test("a lost QRZ response stays uncertain and cannot be resent through the cohort loader", async (t) => {
  const h = await qrzDeliveryQueueFixture(t, 10);
  const prepared = await prepareDueBatch(h.store, h.members, h.gates);
  let lost = false;
  const queue = prepared.map((row, index) => {
    assert(row.status === "fulfilled" && row.value.attemptId);
    return {
      id: row.value.attemptId,
      deps: {
        sourceContact: h.members[index].contact,
        fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await h.fetcher(input, init);
          if (
            !lost &&
            new URLSearchParams(String(init?.body)).get("ACTION") === "INSERT"
          ) {
            lost = true;
            throw new Error("synthetic lost receipt");
          }
          return response;
        },
      },
    };
  });
  const first = await dispatchAttemptBatch(h.store, "a", queue, h.gates);
  assert(
    first[0].status === "fulfilled" && first[0].value.state === "uncertain",
  );
  assert(
    first
      .slice(1)
      .every(
        (row) => row.status === "fulfilled" && row.value.state === "delivered",
      ),
  );
  assert.equal(h.calls.qrzWrites, 10);
  await dispatchAttemptBatch(h.store, "a", queue, h.gates);
  assert.equal(h.calls.qrzWrites, 10);
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM private_data WHERE kind='outbox'")
      .first("n"),
    1,
  );
});
