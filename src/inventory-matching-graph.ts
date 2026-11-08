import type { AdifRecord } from "./adif.ts";
import {
  HISTORICAL_CANDIDATE_POLICY_VERSION,
  type HistoricalCandidate,
  type HistoricalVendor,
  historicalCandidates,
} from "./historical-matching.ts";
import { canonical } from "./security.ts";

export interface InventoryMatchingReference {
  scope: string;
  key: string;
  facet: "source" | "receipt";
}
export interface InventoryMatchingInput extends InventoryMatchingReference {
  state: "ready" | "held" | "excluded" | "pending";
  record: AdifRecord | null;
}
export interface InventoryMatchingProbe {
  subject: InventoryMatchingReference;
  candidates: InventoryMatchingReference[];
  complete: boolean;
}
export interface InventoryMatchingGraphInput {
  vendor: HistoricalVendor;
  selected: InventoryMatchingReference[];
  inputs: InventoryMatchingInput[];
  forward: InventoryMatchingProbe[];
  reverse: InventoryMatchingProbe[];
}
export interface InventoryMatchingRelation {
  source: InventoryMatchingReference;
  remote: InventoryMatchingReference;
  modeBasis: HistoricalCandidate["modeBasis"];
  entireIntervalWithinWindow: boolean;
}
export interface InventoryMatchingGraphResult {
  source: InventoryMatchingReference;
  state: "none" | "unique" | "ambiguous" | "incomplete" | "excluded";
  reason:
    | "source_unavailable"
    | "forward_incomplete"
    | "candidate_unavailable"
    | "multiple_remote_candidates"
    | "time_precision_boundary"
    | "reverse_incomplete"
    | "multiple_source_candidates"
    | null;
  remote: InventoryMatchingReference | null;
}
interface Comparison {
  possible: boolean;
  uncertain: boolean;
  edge: InventoryMatchingRelation | null;
}
const refKey = (row: InventoryMatchingReference) =>
  canonical([row.scope, row.key, row.facet]);
const ref = (row: InventoryMatchingReference): InventoryMatchingReference => ({
  scope: row.scope,
  key: row.key,
  facet: row.facet,
});
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** Pure candidate geometry over a supplied snapshot. `none` is not remote
 * absence; `unique` still requires operating-detail, coverage, ownership and
 * native dependency checks. The snapshot retains excluded/irrelevant inputs
 * for the caller's dependency manifest; this pass grants no adoption or writes. */
export function inventoryMatchingGraph(input: InventoryMatchingGraphInput) {
  if (
    !["qrz", "lotw"].includes(input.vendor) ||
    input.selected.length < 1 ||
    input.selected.length > 20 ||
    input.inputs.length > 128 ||
    input.forward.length > 20 ||
    input.reverse.length > 128 ||
    new TextEncoder().encode(canonical(input)).byteLength > 4 * 1024 * 1024
  )
    throw new Error("inventory_matching_graph_split_required");
  const inputs = new Map(input.inputs.map((row) => [refKey(row), row]));
  const selected = new Set(input.selected.map(refKey));
  if (
    inputs.size !== input.inputs.length ||
    selected.size !== input.selected.length ||
    input.inputs.some(
      (row) =>
        !identifier(row.scope) ||
        !identifier(row.key) ||
        !["source", "receipt"].includes(row.facet) ||
        !["ready", "held", "excluded", "pending"].includes(row.state) ||
        (row.state === "excluded" && row.facet !== "source"),
    ) ||
    input.selected.some(
      (row) => row.facet !== "source" || !inputs.has(refKey(row)),
    )
  )
    throw new Error("invalid_inventory_matching_graph");
  const probes = (
    rows: InventoryMatchingProbe[],
    subjectFacet: "source" | "receipt",
  ) => {
    const map = new Map<string, InventoryMatchingProbe>();
    for (const row of rows) {
      const key = refKey(row.subject);
      if (
        row.subject.facet !== subjectFacet ||
        !inputs.has(key) ||
        map.has(key) ||
        row.candidates.length > 128 ||
        row.candidates.some(
          (candidate) =>
            candidate.facet === subjectFacet || !inputs.has(refKey(candidate)),
        )
      )
        throw new Error("invalid_inventory_matching_graph");
      map.set(key, row);
    }
    return map;
  };
  const forward = probes(input.forward, "source");
  const reverse = probes(input.reverse, "receipt");
  const get = (key: string) => {
    const row = inputs.get(key);
    if (!row) throw new Error("invalid_inventory_matching_graph");
    return row;
  };
  const relations = new Map<string, InventoryMatchingRelation>();
  const comparisons = new Map<string, Comparison>();
  let predicateCalls = 0;
  const compare = (
    source: InventoryMatchingInput,
    remote: InventoryMatchingInput,
  ): Comparison => {
    const key = canonical([refKey(source), refKey(remote)]);
    const previous = comparisons.get(key);
    if (previous) return previous;
    if (
      source.state === "pending" ||
      remote.state === "pending" ||
      !source.record ||
      !remote.record
    ) {
      const result = { possible: false, uncertain: true, edge: null };
      comparisons.set(key, result);
      return result;
    }
    // Keep the source and receipt roles when reversing. LoTW's reported mode
    // groups and source individual modes are deliberately asymmetric inputs.
    const result = historicalCandidates(input.vendor, source.record, [
      remote.record,
    ]);
    predicateCalls++;
    const candidate = result.candidates[0];
    const edge: InventoryMatchingRelation | null = candidate
      ? {
          source: ref(source),
          remote: ref(remote),
          modeBasis: candidate.modeBasis,
          entireIntervalWithinWindow: candidate.time.entireIntervalWithinWindow,
        }
      : null;
    if (edge) relations.set(key, edge);
    const comparison = {
      possible: !!candidate,
      uncertain:
        result.issues.length > 0 ||
        (!!candidate && (source.state !== "ready" || remote.state !== "ready")),
      edge,
    };
    comparisons.set(key, comparison);
    return comparison;
  };
  const results: InventoryMatchingGraphResult[] = input.selected.map(
    (selected) => {
      const source = get(refKey(selected));
      const result = (
        state: InventoryMatchingGraphResult["state"],
        reason: InventoryMatchingGraphResult["reason"] = null,
        remote: InventoryMatchingReference | null = null,
      ): InventoryMatchingGraphResult => ({
        source: ref(source),
        state,
        reason,
        remote,
      });
      if (source.state === "excluded") return result("excluded");
      if (source.state !== "ready" || !source.record)
        return result("incomplete", "source_unavailable");
      const probe = forward.get(refKey(source));
      if (probe?.complete !== true)
        return result("incomplete", "forward_incomplete");
      const candidates: {
        remote: InventoryMatchingInput;
        edge: InventoryMatchingRelation;
      }[] = [];
      let uncertain =
        historicalCandidates(input.vendor, source.record, []).issues.length > 0;
      for (const key of new Set(probe.candidates.map(refKey))) {
        const remote = get(key);
        const comparison = compare(source, remote);
        uncertain ||= comparison.uncertain;
        if (comparison.edge) candidates.push({ remote, edge: comparison.edge });
      }
      if (uncertain) return result("incomplete", "candidate_unavailable");
      if (candidates.length > 1)
        return result("ambiguous", "multiple_remote_candidates");
      if (!candidates.length) return result("none");
      const { remote, edge } = candidates[0];
      if (!edge.entireIntervalWithinWindow)
        return result("ambiguous", "time_precision_boundary", ref(remote));
      const back = reverse.get(refKey(remote));
      if (
        back?.complete !== true ||
        !back.candidates.some((row) => refKey(row) === refKey(source))
      )
        return result("incomplete", "reverse_incomplete", ref(remote));
      let competing = 0;
      uncertain = false;
      for (const key of new Set(back.candidates.map(refKey))) {
        const other = get(key);
        if (other.state === "excluded") continue;
        const comparison = compare(other, remote);
        uncertain ||= comparison.uncertain;
        if (comparison.possible) competing++;
      }
      if (uncertain)
        return result("incomplete", "candidate_unavailable", ref(remote));
      if (competing > 1)
        return result("ambiguous", "multiple_source_candidates", ref(remote));
      if (competing !== 1)
        return result("incomplete", "reverse_incomplete", ref(remote));
      return result("unique", null, ref(remote));
    },
  );
  return {
    policyVersion: HISTORICAL_CANDIDATE_POLICY_VERSION,
    authoritative: false as const,
    results,
    relations: [...relations.values()],
    stats: { distinctPairs: comparisons.size, predicateCalls },
  };
}
