import {
  HISTORICAL_TIME_WINDOW_MS,
  historicalCandidateKeys,
} from "./historical-matching.ts";
import { historicalOperatingDetails } from "./historical-operating-details.ts";
import {
  type InventoryComparisonCandidate,
  InventoryComparisonLookup,
  type InventoryComparisonProbe,
  type InventoryComparisonRequest,
} from "./inventory-comparison-lookup.ts";
import {
  type InventoryMatchingInput,
  type InventoryMatchingProbe,
  type InventoryMatchingReference,
  inventoryMatchingGraph,
} from "./inventory-matching-graph.ts";
import type { InventoryProjectionBody } from "./inventory-projection-workspace.ts";
import { InventoryProjections } from "./inventory-projections.ts";
import { inventoryRunQuery } from "./inventory-run-plans.ts";
import { canonical, sha256 } from "./security.ts";
import type { Store } from "./store.ts";

export interface InventoryMatchingScope {
  connection: string;
  kind: string;
  connectionState: string;
  logicalIdentity: string;
  configHash: string;
  scope: string | null;
  provider: string | null;
  scopeIdentity: string | null;
  configVersion: number | null;
  state: string | null;
  buildConfigVersion: number | null;
  buildComplete: number | null;
  unresolved: number;
  source: number;
}
interface ScopeRow extends Omit<InventoryMatchingScope, "configHash"> {
  config: string;
}
export interface InventoryMatchingCoverage {
  scope: string;
  stream: string;
  facet: string;
  partition: string;
  version: number;
  epoch: number;
  state: string;
  kind: string;
  configVersion: number | null;
  run: string | null;
  runConfigVersion: number | null;
  mode: string | null;
  catchup: number | null;
  phase: string | null;
  completedAt: number | null;
  requiredStreams: string | null;
  queryHash: string | null;
}
interface CoverageRow extends Omit<InventoryMatchingCoverage, "queryHash"> {
  query: string | null;
}
export interface InventoryMatchingRecordSnapshot {
  reference: InventoryMatchingReference;
  candidate: InventoryComparisonCandidate | null;
}
export interface InventoryMatchingLookupSnapshot {
  direction: "forward" | "reverse";
  subject: InventoryMatchingReference;
  probe: InventoryComparisonProbe;
}
export interface InventoryMatchingDecision {
  source: InventoryMatchingReference;
  state:
    | "matched_existing"
    | "absent_at_inventory"
    | "ambiguous"
    | "projection_mismatch"
    | "incomplete"
    | "excluded";
  reason: string | null;
  remote: InventoryMatchingReference | null;
  coverage: string[];
}
interface SelectedRow {
  ordinal: number;
  key: string | null;
  keyClass: InventoryComparisonCandidate["keyClass"];
  hash: string;
  semanticVersion: number;
  currentSemanticVersion: number | null;
  configVersion: number;
  parent: string | null;
  topologyVersion: number;
  currentTopologyVersion: number;
  projectionVersion: number;
  membershipVersion: number;
  projection: string | null;
}
const referenceKey = (row: InventoryMatchingReference) =>
  canonical([row.scope, row.key, row.facet]);
const MAX_BYTES = 4 * 1024 * 1024;
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function ready(scope: InventoryMatchingScope | undefined): boolean {
  return (
    !!scope?.scope &&
    scope.state === "observing" &&
    scope.connectionState === "active" &&
    scope.provider === scope.kind &&
    scope.scopeIdentity === scope.logicalIdentity &&
    scope.buildComplete === 1 &&
    scope.configVersion === scope.buildConfigVersion &&
    scope.unresolved === 0
  );
}
function fullSource(row: CoverageRow, scope: InventoryMatchingScope): boolean {
  const streams = JSON.parse(row.requiredStreams ?? "[]") as string[];
  return (
    row.scope === scope.scope &&
    row.facet === "source" &&
    row.state === "ready" &&
    row.kind === "observed_selection" &&
    row.configVersion === scope.configVersion &&
    row.runConfigVersion === scope.configVersion &&
    row.mode === "full" &&
    row.phase === "complete" &&
    row.catchup === 1 &&
    streams.length === 2 &&
    streams.includes("operations") &&
    streams.includes("qsos")
  );
}
function interval(body: InventoryProjectionBody) {
  const time = historicalCandidateKeys(body.record).time;
  if (!time) return null;
  return {
    start: new Date(time.startMs - HISTORICAL_TIME_WINDOW_MS)
      .toISOString()
      .slice(0, 10),
    end: new Date(time.endMs + HISTORICAL_TIME_WINDOW_MS)
      .toISOString()
      .slice(0, 10),
  };
}
function coveringCoverage(
  body: InventoryProjectionBody,
  scope: InventoryMatchingScope,
  rows: CoverageRow[],
): string[] | null {
  const window = interval(body);
  if (!window) return null;
  const ranges: { start: string; end: string; key: string }[] = [];
  for (const row of rows) {
    if (
      row.scope !== scope.scope ||
      row.facet !== "receipt" ||
      row.state !== "ready" ||
      row.kind !== "observed_selection" ||
      row.configVersion !== scope.configVersion ||
      row.runConfigVersion !== scope.configVersion ||
      row.mode !== "full" ||
      row.phase !== "complete" ||
      !row.query
    )
      continue;
    const streams = JSON.parse(row.requiredStreams ?? "[]") as string[];
    if (streams.length !== 1 || streams[0] !== "selection") continue;
    let query: ReturnType<typeof inventoryRunQuery>;
    try {
      query = inventoryRunQuery(JSON.parse(row.query));
    } catch {
      continue;
    }
    if (query.provider !== scope.provider) continue;
    if (query.provider === "qrz") {
      if (
        row.catchup !== 1 ||
        query.selection.modifiedSince !== undefined ||
        query.book.stationCallsign.toUpperCase() !==
          body.record.STATION_CALLSIGN?.toUpperCase()
      )
        continue;
      ranges.push({
        start: query.selection.between[0],
        end: query.selection.between[1],
        key: canonical([row.scope, row.stream, row.facet, row.partition]),
      });
    } else if (query.provider === "lotw") {
      if (
        query.query.receivedSince !== undefined ||
        (query.query.stationCallsign !== undefined &&
          query.query.stationCallsign.toUpperCase() !==
            body.record.STATION_CALLSIGN?.toUpperCase()) ||
        (query.query.workedCallsign !== undefined &&
          query.query.workedCallsign.toUpperCase() !==
            body.record.CALL?.toUpperCase())
      )
        continue;
      ranges.push({
        start: query.query.startDate,
        end: query.query.endDate,
        key: canonical([row.scope, row.stream, row.facet, row.partition]),
      });
    }
  }
  let next = window.start;
  const used: string[] = [];
  for (const range of ranges.sort((a, b) => a.start.localeCompare(b.start))) {
    if (range.start > next) return null;
    if (range.end < next) continue;
    used.push(range.key);
    if (range.end >= window.end) return used;
    next = new Date(Date.parse(`${range.end}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
  }
  return null;
}

/** Collects immutable, bounded matching inputs. The encrypted projection bodies
 * are used only in memory; the returned manifest contains opaque references and
 * candidate relations. A future native publication must validate the manifest's
 * complete dependencies; this class never publishes match/adoption/write state. */
export class InventoryMatchingWorkspace {
  constructor(readonly store: Store) {}

  async prepare(
    tenant: string,
    destination: string,
    selected: readonly { scope: string; key: string }[],
  ) {
    selected = structuredClone(selected);
    if (
      !identifier(tenant) ||
      !identifier(destination) ||
      selected.length < 1 ||
      selected.length > 20 ||
      selected.some((row) => !identifier(row.scope) || !identifier(row.key)) ||
      new Set(selected.map((row) => canonical([row.scope, row.key]))).size !==
        selected.length
    )
      throw new Error("invalid_inventory_matching_selection");
    const session = await new InventoryComparisonLookup(this.store).open(
      tenant,
    );
    if (!session.active)
      throw new Error("inventory_matching_active_generation_required");
    const stats = {
      metadataQueries: 0,
      lookupQueries: 0,
      bodyQueries: 0,
      rowsRead: 0,
      decryptedBodies: 0,
      encryptedInputBytes: 0,
      plaintextBytes: 0,
    };
    const header = await this.store
      .statement(
        `SELECT c.id AS connection,c.kind,c.status AS connectionState,c.remote_identity AS logicalIdentity,c.config,
       s.scope_id AS scope,s.provider,s.logical_identity AS scopeIdentity,s.config_version AS configVersion,s.state,
       b.config_version AS buildConfigVersion,b.complete AS buildComplete,(c.kind='lofi' OR s.provider='lofi') AS source,
       EXISTS(SELECT 1 FROM inventory_partition_membership m INDEXED BY inventory_unresolved_members WHERE m.tenant=d.tenant AND m.scope_id=s.scope_id AND m.facet=CASE s.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END AND m.state='unresolved') AS unresolved
       FROM comparison_domains d JOIN accounts a ON a.id=d.tenant AND a.status='active' JOIN connections c ON c.tenant=d.tenant
       LEFT JOIN inventory_scopes s ON s.tenant=c.tenant AND s.connection_id=c.id
       LEFT JOIN comparison_builds b ON b.tenant=s.tenant AND b.scope_id=s.scope_id AND b.generation_id=?3
       WHERE d.tenant=?1 AND d.version=?2 AND (c.kind='lofi' OR s.provider='lofi' OR s.scope_id=?4) ORDER BY c.id,s.scope_id LIMIT 22`,
        tenant,
        session.domainVersion,
        session.generation,
        destination,
      )
      .all<ScopeRow>();
    stats.metadataQueries++;
    stats.rowsRead += header.meta.rows_read;
    if (header.results.length > 21)
      throw new Error("inventory_matching_scope_split_required");
    const scopes = await Promise.all(
      header.results.map(async ({ config, ...row }) => ({
        ...row,
        configHash: await sha256(config),
      })),
    );
    const target = scopes.find((row) => row.scope === destination);
    if (!target || !["qrz", "lotw"].includes(target.provider ?? ""))
      throw new Error("inventory_matching_destination_unavailable");
    const sourceScopes = scopes.filter((row) => row.source === 1);
    const byScope = new Map(
      scopes.filter((row) => row.scope).map((row) => [row.scope, row]),
    );
    const selectedRows = await this.store
      .statement(
        `SELECT CAST(j.key AS INTEGER) AS ordinal,i.record_key AS key,i.key_class AS keyClass,i.bucket_hash AS hash,
       i.semantic_version AS semanticVersion,f.semantic_version AS currentSemanticVersion,i.config_version AS configVersion,i.parent_key AS parent,
       i.topology_version AS topologyVersion,coalesce(pd.topology_version,0) AS currentTopologyVersion,i.projection_version AS projectionVersion,coalesce(mv.version,0) AS membershipVersion,
       (SELECT json_object('version',p.version,'state',p.state,'reason',p.reason,'payload',p.payload_id) FROM comparison_projections_current p WHERE p.tenant=i.tenant AND p.generation_id=i.generation_id AND p.scope_id=i.scope_id AND p.record_key=i.record_key AND p.facet=i.facet) AS projection
       FROM json_each(?1) j CROSS JOIN comparison_domains d
       LEFT JOIN comparison_index i ON i.tenant=d.tenant AND i.generation_id=?4 AND i.scope_id=json_extract(j.value,'$.scope') AND i.record_key=json_extract(j.value,'$.key') AND i.facet='source' AND i.state!='retired'
       LEFT JOIN inventory_record_facets f ON f.tenant=i.tenant AND f.scope_id=i.scope_id AND f.entity_family='qso' AND f.record_key=i.record_key AND f.facet=i.facet
       LEFT JOIN projection_domains pd ON pd.tenant=i.tenant AND pd.scope_id=i.scope_id AND pd.operation_key=i.parent_key
       LEFT JOIN inventory_membership_versions mv ON mv.tenant=i.tenant AND mv.scope_id=i.scope_id AND mv.entity_family='qso' AND mv.record_key=i.record_key AND mv.facet=i.facet
       WHERE d.tenant=?2 AND d.version=?3 ORDER BY ordinal`,
        canonical(selected),
        tenant,
        session.domainVersion,
        session.generation,
      )
      .all<SelectedRow>();
    stats.metadataQueries++;
    stats.rowsRead += selectedRows.meta.rows_read;
    if (selectedRows.results.length !== selected.length)
      throw new Error("inventory_matching_snapshot_changed");
    const records = new Map<string, InventoryMatchingRecordSnapshot>();
    const add = (
      reference: InventoryMatchingReference,
      candidate: InventoryComparisonCandidate | null,
    ) => {
      const key = referenceKey(reference),
        previous = records.get(key);
      const row = { reference, candidate };
      if (previous && canonical(previous) !== canonical(row))
        throw new Error("inventory_matching_snapshot_changed");
      records.set(key, row);
      if (records.size > 128)
        throw new Error("inventory_matching_record_split_required");
    };
    const selectedReferences = selected.map((row) => ({
      scope: row.scope,
      key: row.key,
      facet: "source" as const,
    }));
    for (const row of selectedRows.results) {
      const { ordinal, projection, key, ...metadata } = row;
      const current = projection
        ? (JSON.parse(projection) as {
            version: number;
            state: "ready" | "held" | "excluded";
            reason: string | null;
            payload: string;
          })
        : null;
      add(
        selectedReferences[ordinal],
        key
          ? {
              key,
              facet: "source",
              ...metadata,
              state: current
                ? current.state === "held"
                  ? "held"
                  : "ready"
                : "pending",
              currentProjectionVersion: current?.version ?? null,
              projectionState: current?.state ?? null,
              projectionReason: current?.reason ?? null,
              payload: current?.payload ?? null,
            }
          : null,
      );
    }
    const bodies = new Map<string, InventoryProjectionBody | null>();
    const load = async () => {
      const references = [...records.values()].filter(
        (row) => !bodies.has(referenceKey(row.reference)),
      );
      const loaded = await new InventoryProjections(this.store).bodies(
        tenant,
        session.generation,
        references.flatMap(({ reference, candidate }) =>
          candidate?.payload && candidate.currentProjectionVersion
            ? [
                {
                  ...reference,
                  version: candidate.currentProjectionVersion,
                  payload: candidate.payload,
                },
              ]
            : [],
        ),
        {
          maxBytes:
            MAX_BYTES -
            Math.max(stats.encryptedInputBytes, stats.plaintextBytes),
        },
      );
      stats.bodyQueries += loaded.stats.queries;
      stats.rowsRead += loaded.stats.rowsRead;
      stats.decryptedBodies += loaded.stats.decryptedBodies;
      stats.encryptedInputBytes += loaded.stats.encryptedInputBytes;
      stats.plaintextBytes += loaded.stats.plaintextBytes;
      for (const row of references)
        bodies.set(referenceKey(row.reference), null);
      for (const row of loaded.items) bodies.set(referenceKey(row), row.body);
    };
    await load();
    const windows = selectedReferences.flatMap((row) => {
      const body = bodies.get(referenceKey(row));
      const range = body && interval(body);
      return range ? [range] : [];
    });
    const coverageRows = await this.store
      .statement(
        `SELECT cv.scope_id AS scope,cv.stream_id AS stream,cv.facet,cv.partition_id AS partition,cv.version,cv.epoch,cv.state,cv.kind,cv.published_config_version AS configVersion,
       r.run_id AS run,r.config_version AS runConfigVersion,r.mode,r.requires_catchup AS catchup,r.phase,cv.completed_at AS completedAt,r.required_streams AS requiredStreams,r.fixed_query AS query
       FROM comparison_domains d CROSS JOIN inventory_coverage cv JOIN inventory_scopes s ON s.tenant=cv.tenant AND s.scope_id=cv.scope_id
       LEFT JOIN inventory_runs r ON r.tenant=cv.tenant AND r.run_id=cv.published_run_id
       WHERE d.tenant=?1 AND d.version=?2 AND cv.tenant=d.tenant AND ((s.provider='lofi' AND cv.facet='source') OR (cv.scope_id=?3 AND cv.facet='receipt' AND EXISTS(SELECT 1 FROM json_each(?4) w WHERE coalesce(json_extract(r.fixed_query,'$.selection.between[0]'),json_extract(r.fixed_query,'$.query.startDate'))<=json_extract(w.value,'$.end') AND coalesce(json_extract(r.fixed_query,'$.selection.between[1]'),json_extract(r.fixed_query,'$.query.endDate'))>=json_extract(w.value,'$.start'))))
       ORDER BY cv.scope_id,cv.stream_id,cv.partition_id LIMIT 257`,
        tenant,
        session.domainVersion,
        destination,
        canonical(windows),
      )
      .all<CoverageRow>();
    stats.metadataQueries++;
    stats.rowsRead += coverageRows.meta.rows_read;
    if (coverageRows.results.length > 256)
      throw new Error("inventory_matching_coverage_split_required");
    const coverage = await Promise.all(
      coverageRows.results.map(async ({ query, ...row }) => ({
        ...row,
        queryHash: query ? await sha256(query) : null,
      })),
    );
    const sourceReady = (scope: InventoryMatchingScope | undefined) =>
      ready(scope) &&
      !!scope &&
      coverageRows.results.some((row) => fullSource(row, scope));
    const lookups: InventoryMatchingLookupSnapshot[] = [];
    const runProbes = async (
      direction: "forward" | "reverse",
      requests: {
        subject: InventoryMatchingReference;
        request: InventoryComparisonRequest;
      }[],
    ) => {
      for (let offset = 0; offset < requests.length; offset += 20) {
        const batch = requests.slice(offset, offset + 20);
        const result = await session.probe(batch.map((row) => row.request));
        stats.lookupQueries++;
        stats.rowsRead += result.rowsRead;
        for (let i = 0; i < batch.length; i++) {
          const probe = result.observations[i];
          if (probe.state === "overflow")
            throw new Error("inventory_matching_candidate_split_required");
          lookups.push({ direction, subject: batch[i].subject, probe });
          for (const candidate of probe.candidates)
            add(
              {
                scope: probe.scope,
                key: candidate.key,
                facet: candidate.facet,
              },
              candidate,
            );
        }
      }
    };
    await runProbes(
      "forward",
      selectedReferences.flatMap((reference, i) => {
        const body = bodies.get(referenceKey(reference));
        const keys = body && historicalCandidateKeys(body.record);
        return body?.state === "ready" && keys?.workedCall && keys.time
          ? [
              {
                subject: reference,
                request: {
                  id: `forward:${i}`,
                  scope: destination,
                  record: body.record,
                },
              },
            ]
          : [];
      }),
    );
    await load();
    const remoteReferences = [...records.values()]
      .filter((row) => row.reference.facet === "receipt")
      .map((row) => row.reference);
    const reverseRequests = remoteReferences.flatMap((reference, i) => {
      const body = bodies.get(referenceKey(reference));
      const keys = body && historicalCandidateKeys(body.record);
      return body && keys?.workedCall && keys.time
        ? sourceScopes.flatMap((scope, j) =>
            scope.scope
              ? [
                  {
                    subject: reference,
                    request: {
                      id: `reverse:${i}:${j}`,
                      scope: scope.scope,
                      record: body.record,
                    },
                  },
                ]
              : [],
          )
        : [];
    });
    if (reverseRequests.length > 128)
      throw new Error("inventory_matching_probe_split_required");
    await runProbes("reverse", reverseRequests);
    await load();
    const inputs: InventoryMatchingInput[] = [...records.values()].map(
      ({ reference }) => {
        const body = bodies.get(referenceKey(reference));
        return {
          ...reference,
          state: body?.state ?? "pending",
          record: body?.record ?? null,
        };
      },
    );
    const forward: InventoryMatchingProbe[] = selectedReferences.map(
      (subject) => {
        const body = bodies.get(referenceKey(subject));
        const lookup = lookups.find(
          (row) =>
            row.direction === "forward" &&
            referenceKey(row.subject) === referenceKey(subject),
        );
        return {
          subject,
          candidates:
            lookup?.probe.candidates.map((row) => ({
              scope: lookup.probe.scope,
              key: row.key,
              facet: row.facet,
            })) ?? [],
          complete:
            !!body &&
            sourceReady(byScope.get(subject.scope)) &&
            ready(target) &&
            !!coveringCoverage(body, target, coverageRows.results) &&
            !!lookup?.probe.indexReady,
        };
      },
    );
    const reverse: InventoryMatchingProbe[] = remoteReferences.map(
      (subject) => {
        const probes = lookups.filter(
          (row) =>
            row.direction === "reverse" &&
            referenceKey(row.subject) === referenceKey(subject),
        );
        return {
          subject,
          candidates: probes.flatMap((row) =>
            row.probe.candidates.map((candidate) => ({
              scope: row.probe.scope,
              key: candidate.key,
              facet: candidate.facet,
            })),
          ),
          complete:
            sourceScopes.length > 0 &&
            sourceScopes.every(sourceReady) &&
            probes.length === sourceScopes.length &&
            probes.every((row) => row.probe.indexReady),
        };
      },
    );
    const graph = inventoryMatchingGraph({
      vendor: target.provider as "qrz" | "lotw",
      selected: selectedReferences,
      inputs,
      forward,
      reverse,
    });
    const classified = graph.results.map(
      (row): Omit<InventoryMatchingDecision, "coverage"> => {
        if (row.state === "none")
          return { ...row, state: "absent_at_inventory" };
        if (row.state !== "unique") return { ...row, state: row.state };
        const source = bodies.get(referenceKey(row.source));
        const remote = row.remote && bodies.get(referenceKey(row.remote));
        if (
          !source ||
          !remote ||
          (target.provider === "qrz" &&
            !/^[0-9]{1,64}$/.test(row.remote?.key ?? ""))
        )
          return {
            ...row,
            state: "incomplete",
            reason: "remote_identity_unavailable",
          };
        const details = historicalOperatingDetails(
          target.provider as "qrz" | "lotw",
          source.record,
          remote.record,
        );
        return {
          ...row,
          state:
            details.state === "adopted_existing"
              ? "matched_existing"
              : details.state === "history_mismatch"
                ? "projection_mismatch"
                : "incomplete",
          reason:
            details.state === "adopted_existing"
              ? null
              : details.state === "history_mismatch"
                ? "operating_details_differ"
                : "operating_details_unavailable",
        };
      },
    );
    const results = classified.map((row) => {
      const body = bodies.get(referenceKey(row.source));
      return {
        ...row,
        coverage: body
          ? (coveringCoverage(body, target, coverageRows.results) ?? [])
          : [],
      };
    });
    const snapshot = {
      formatVersion: 1 as const,
      tenant,
      destination,
      generation: session.generation,
      domainVersion: session.domainVersion,
      sourceSetVersion: session.sourceSetVersion,
      selected: selectedReferences,
      scopes,
      coverage,
      records: [...records.values()],
      lookups,
      forward,
      reverse,
      graph,
      results,
      preparedAt: Date.now(),
      stats,
    };
    return { ...snapshot, digest: await sha256(canonical(snapshot)) };
  }
}

export type PreparedInventoryMatchingSnapshot = Awaited<
  ReturnType<InventoryMatchingWorkspace["prepare"]>
>;
