import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  cancellationEvidenceSql,
  knownUnsentQrzCancellation,
} from "../scripts/qrz-cancellation-evidence.ts";

const created = 1_793_155_333_655;
const cancelled = created + 252_125;
const evidence = () => ({
  stateReason: "source_export_proof_unavailable",
  eventCount: 2,
  proofPinCount: 1,
  linkedClaimCount: 1,
  events: [
    { id: 1, state: "prepared", at: created, reason: null },
    {
      id: 2,
      state: "cancelled",
      at: cancelled,
      reason: "source_export_proof_unavailable",
    },
  ],
});
const attempt = () => ({
  tenant: "tenant",
  attempt: "attempt",
  source: "source",
  qso: "contact",
  destination: "destination",
  generation: "generation",
  vendor: "qrz",
  authorization_mode: "qrz_fresh_insert",
  state: "cancelled",
  dispatched_at: null,
  remote_id: null,
  artifactRetained: 1,
  proof_id: "proof",
  created_at: created,
  updated_at: cancelled,
  cancellationEvidence: evidence(),
});

test("a complete scoped native history establishes an unsent source-proof cancellation", () => {
  assert.equal(knownUnsentQrzCancellation(attempt()), true);
  assert.equal(
    knownUnsentQrzCancellation({
      ...attempt(),
      cancellationEvidence: JSON.stringify(evidence()),
    }),
    true,
  );
});

test("unknown or previously dispatched outcomes never become safe cancellations", () => {
  for (const state of [
    "prepared",
    "dispatching",
    "uncertain",
    "reconciliation_required",
    "submitted",
    "rejected",
    "delivered",
    "observed",
  ])
    assert.equal(knownUnsentQrzCancellation({ ...attempt(), state }), false);
  for (const change of [
    { dispatched_at: created + 1 },
    { remote_id: "123" },
    { artifactRetained: 0 },
    { proof_id: null },
    { vendor: "lotw" },
    { authorization_mode: "source_boundary" },
    { updated_at: created - 1 },
    { cancellationEvidence: null },
    { cancellationEvidence: "{" },
  ])
    assert.equal(
      knownUnsentQrzCancellation({ ...attempt(), ...change }),
      false,
    );
});

test("missing, extra, altered or out-of-order audit evidence requires review", () => {
  for (const change of [
    { eventCount: 1 },
    { eventCount: 3 },
    { proofPinCount: 0 },
    { linkedClaimCount: 0 },
    { linkedClaimCount: 2 },
    { stateReason: "unexplained cancellation" },
    { events: evidence().events.slice(1) },
    { events: [...evidence().events, evidence().events[1]] },
    { events: evidence().events.toReversed() },
    {
      events: evidence().events.map((e) => ({ ...e, at: e.at + 1 })),
    },
    {
      events: [
        evidence().events[0],
        { ...evidence().events[1], reason: "unexplained cancellation" },
      ],
    },
    {
      events: [
        { ...evidence().events[0], state: "dispatching" },
        evidence().events[1],
      ],
    },
  ])
    assert.equal(
      knownUnsentQrzCancellation({
        ...attempt(),
        cancellationEvidence: { ...evidence(), ...change },
      }),
      false,
    );
});

test("native SQL retains the complete event count, scope and ownership bindings", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE attempt_state(tenant,attempt,reason);
      CREATE TABLE attempt_events(id INTEGER PRIMARY KEY,tenant,attempt,state,at,reason);
      CREATE TABLE attempt_source_export_proofs(tenant,attempt,proof_id,authorization_mode);
      CREATE TABLE source_export_proofs(tenant,id,source,qso,proof);
      CREATE TABLE attempt_identity_claims(tenant,attempt,destination,vendor,identity_hash,source,qso);
      CREATE TABLE destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso);
      INSERT INTO attempt_state VALUES('tenant','attempt','source_export_proof_unavailable');
      INSERT INTO attempt_source_export_proofs VALUES('tenant','attempt','proof','qrz_fresh_insert');
      INSERT INTO source_export_proofs VALUES('tenant','proof','source','contact','{"generation":"generation"}');
      INSERT INTO attempt_identity_claims VALUES('tenant','attempt','destination','qrz','identity','source','contact');
      INSERT INTO destination_identity_claims VALUES('tenant','destination','qrz','identity','source','contact');`);
    for (const event of evidence().events)
      db.prepare("INSERT INTO attempt_events VALUES(?,?,?,?,?,?)").run(
        event.id,
        "tenant",
        "attempt",
        event.state,
        event.at,
        event.reason,
      );
    const read = () => {
      const a = attempt();
      const fields = Object.entries(a)
        .filter(([name]) => name !== "cancellationEvidence")
        .map(([name, value]) => {
          assert(
            value === null ||
              typeof value === "string" ||
              typeof value === "number",
          );
          return [name, value] as const;
        });
      const row = db
        .prepare(
          `SELECT a.*,${cancellationEvidenceSql} AS cancellationEvidence FROM (SELECT ${fields.map(([name]) => `? AS ${name}`).join(",")}) a`,
        )
        .get(...fields.map(([, value]) => value));
      assert(row);
      return row;
    };
    assert.equal(knownUnsentQrzCancellation(read()), true);
    db.exec("UPDATE destination_identity_claims SET qso='another-contact'");
    assert.equal(knownUnsentQrzCancellation(read()), false);
    db.exec("UPDATE destination_identity_claims SET qso='contact'");
    db.prepare("INSERT INTO attempt_events VALUES(3,?,?,?,?,?)").run(
      "tenant",
      "attempt",
      "dispatching",
      created + 1,
      null,
    );
    assert.equal(knownUnsentQrzCancellation(read()), false);
  } finally {
    db.close();
  }
});
