import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  type InventoryMatchingGraphInput,
  type InventoryMatchingInput,
  inventoryMatchingGraph,
} from "../src/inventory-matching-graph.ts";

function contact(
  key: string,
  facet: "source" | "receipt",
  changes: AdifRecord = {},
): InventoryMatchingInput {
  return {
    scope: facet === "source" ? "lofi" : "qrz",
    key,
    facet,
    state: "ready",
    record: {
      STATION_CALLSIGN: "N1RWJ",
      CALL: "W1AW",
      BAND: "20m",
      MODE: "CW",
      QSO_DATE: "20261108",
      TIME_ON: "130000",
      ...changes,
    },
  };
}
function fixture() {
  const source = contact("s1", "source");
  const remote = contact("r1", "receipt");
  const input: InventoryMatchingGraphInput = {
    vendor: "qrz",
    selected: [source],
    inputs: [source, remote],
    forward: [{ subject: source, candidates: [remote], complete: true }],
    reverse: [{ subject: remote, candidates: [source], complete: true }],
  };
  return { source, remote, input };
}

test("a unique relation requires both directed candidate sets and grants no authority", () => {
  const { input } = fixture();
  const graph = inventoryMatchingGraph(input);
  assert.equal(graph.authoritative, false);
  assert.equal(graph.results[0].state, "unique");
  assert.equal(graph.results[0].remote?.key, "r1");
  input.reverse = [];
  assert.equal(
    inventoryMatchingGraph(input).results[0].reason,
    "reverse_incomplete",
  );
  input.forward[0].candidates = [];
  assert.equal(inventoryMatchingGraph(input).results[0].state, "none");
  input.forward[0].complete = false;
  assert.equal(inventoryMatchingGraph(input).results[0].state, "incomplete");
});

test("a reverse competitor outside the selected source window prevents uniqueness", () => {
  const { source, remote, input } = fixture();
  remote.record = { ...remote.record, TIME_ON: "133000" };
  const competing = contact("s2", "source", { TIME_ON: "140000" });
  input.inputs.push(competing);
  input.reverse[0].candidates = [source, competing];
  const graph = inventoryMatchingGraph(input);
  assert.equal(graph.results[0].state, "ambiguous");
  assert.equal(graph.results[0].reason, "multiple_source_candidates");
  assert.equal(graph.relations.length, 2);
  competing.state = "excluded";
  assert.equal(inventoryMatchingGraph(input).results[0].state, "unique");
  // Excluded input remains in the supplied snapshot for native dependencies.
  assert.equal(input.reverse[0].candidates.length, 2);
});

test("LoTW reverse comparison preserves source and receipt mode roles", () => {
  const { source, remote, input } = fixture();
  input.vendor = "lotw";
  source.record = { ...source.record, MODE: "MFSK", SUBMODE: "FT4" };
  remote.record = {
    ...remote.record,
    MODE: "DATA",
    APP_LOTW_MODE: "FT8",
    APP_LOTW_MODEGROUP: "DATA",
  };
  const graph = inventoryMatchingGraph(input);
  assert.equal(graph.results[0].state, "unique");
  assert.equal(graph.relations[0].modeBasis, "group");
});

test("minute precision crossing the tolerance boundary cannot become a unique relation", () => {
  const { source, remote, input } = fixture();
  source.record = { ...source.record, TIME_ON: "1300" };
  remote.record = { ...remote.record, TIME_ON: "133030" };
  const graph = inventoryMatchingGraph(input);
  assert.equal(graph.relations[0].entireIntervalWithinWindow, false);
  assert.equal(graph.results[0].state, "ambiguous");
  assert.equal(graph.results[0].reason, "time_precision_boundary");
});

test("missing and relevant unsupported forward evidence stays incomplete while provably unrelated evidence is ignored", () => {
  const { remote, input } = fixture();
  remote.state = "pending";
  remote.record = null;
  assert.equal(inventoryMatchingGraph(input).results[0].state, "incomplete");
  remote.record = { ...contact("unused", "receipt").record, CALL: "K1ABC" };
  assert.equal(inventoryMatchingGraph(input).results[0].state, "incomplete");
  remote.state = "held";
  remote.record = { ...contact("unused", "receipt").record, MODE: "ALIEN" };
  assert.equal(
    inventoryMatchingGraph(input).results[0].reason,
    "candidate_unavailable",
  );
  remote.record.CALL = "K1ABC";
  assert.equal(inventoryMatchingGraph(input).results[0].state, "none");
  assert.equal(input.inputs.length, 2);
});

test("unavailable reverse candidates and a reverse scan missing its selected source cannot establish uniqueness", () => {
  const { source, input } = fixture();
  const unknown = contact("unknown", "source");
  unknown.state = "pending";
  unknown.record = null;
  input.inputs.push(unknown);
  input.reverse[0].candidates = [source, unknown];
  assert.equal(inventoryMatchingGraph(input).results[0].state, "incomplete");
  input.reverse[0].candidates = [];
  assert.equal(
    inventoryMatchingGraph(input).results[0].reason,
    "reverse_incomplete",
  );
});

test("distinct remote identities stay ambiguous even when their record objects are identical", () => {
  const { remote, input } = fixture();
  const duplicate = { ...remote, key: "r2" };
  input.inputs.push(duplicate);
  input.forward[0].candidates = [remote, duplicate];
  assert.equal(
    inventoryMatchingGraph(input).results[0].reason,
    "multiple_remote_candidates",
  );
  input.forward[0].candidates = [remote, remote];
  assert.equal(inventoryMatchingGraph(input).results[0].state, "unique");
});

test("union overflow and omitted input references are rejected instead of silently truncated", () => {
  const { input } = fixture();
  input.inputs.push(
    ...Array.from({ length: 127 }, (_, i) => contact(`extra${i}`, "source")),
  );
  assert.throws(() => inventoryMatchingGraph(input), /split_required/);
  const { input: missing } = fixture();
  missing.inputs.pop();
  assert.throws(
    () => inventoryMatchingGraph(missing),
    /invalid_inventory_matching_graph/,
  );
});

test("twenty selected sources share a candidate and all retain reverse ambiguity", () => {
  const { remote, input } = fixture();
  const sources = Array.from({ length: 20 }, (_, i) =>
    contact(`s${i}`, "source"),
  );
  input.selected = sources;
  input.inputs = [...sources, remote];
  input.forward = sources.map((source) => ({
    subject: source,
    candidates: [remote],
    complete: true,
  }));
  input.reverse = [{ subject: remote, candidates: sources, complete: true }];
  const graph = inventoryMatchingGraph(input);
  assert.equal(graph.results.length, 20);
  assert.ok(
    graph.results.every((row) => row.reason === "multiple_source_candidates"),
  );
  assert.equal(graph.relations.length, 20);
  assert.equal(graph.stats.distinctPairs, 20);
  assert.equal(graph.stats.predicateCalls, 20);
});
