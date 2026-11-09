import {
  HISTORICAL_TIME_WINDOW_MS,
  historicalCandidateKeys,
} from "./historical-matching.ts";
import { historicalOperatingDetails } from "./historical-operating-details.ts";
import {
  type InventoryComparisonCandidate,
  InventoryComparisonLookup,
  type InventoryComparisonProbe,
} from "./inventory-comparison-lookup.ts";
import {
  type InventoryMatchingInput,
  type InventoryMatchingProbe,
  type InventoryMatchingReference,
  inventoryMatchingGraph,
} from "./inventory-matching-graph.ts";
import type { InventoryProjectionBody } from "./inventory-projection-workspace.ts";
import {
  InventoryProjections,
  openInventoryProjectionBody,
} from "./inventory-projections.ts";
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
  coverageClock?: number;
}
interface ScopeRow
  extends Omit<InventoryMatchingScope, "configHash" | "coverageClock"> {
  config: string;
  coverageClock: number | null;
  syncScopeVersion: number;
  syncScopeMode: "all" | "since" | "forward";
  syncSince: string | null;
  syncChangedAt: number | null;
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
  scopeExcluded?: true;
}
export interface InventoryMatchingRecovery {
  scope: string;
  facet: "source" | "receipt";
  subject: InventoryMatchingReference;
  nodes: string[];
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
  encryptedBytes: number;
  envelope: string | null;
}
const referenceKey = (row: InventoryMatchingReference) =>
  canonical([row.scope, row.key, row.facet]);
const MAX_BYTES = 4 * 1024 * 1024;
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function ready(
  scope: InventoryMatchingScope | undefined,
  allowUnresolved = false,
): boolean {
  return (
    !!scope?.scope &&
    scope.state === "observing" &&
    scope.connectionState === "active" &&
    scope.provider === scope.kind &&
    scope.scopeIdentity === scope.logicalIdentity &&
    scope.buildComplete === 1 &&
    scope.configVersion === scope.buildConfigVersion &&
    (allowUnresolved || scope.unresolved === 0)
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
  window = interval(body),
): string[] | null {
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
        "kind" in query.query ||
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
  private readonly trackCoverageClocks: boolean;
  private readonly trackCoverageRecovery: boolean;
  constructor(
    readonly store: Store,
    options: {
      trackCoverageClocks?: boolean;
      trackCoverageRecovery?: boolean;
    } = {},
  ) {
    this.trackCoverageClocks = options.trackCoverageClocks !== false;
    this.trackCoverageRecovery =
      this.trackCoverageClocks && options.trackCoverageRecovery !== false;
  }

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
    const stats = {
      metadataQueries: 0,
      lookupQueries: 0,
      bodyQueries: 0,
      rowsRead: 0,
      decryptedBodies: 0,
      encryptedInputBytes: 0,
      plaintextBytes: 0,
    };
    const scopeStatement = this.store.statement(
      `SELECT c.id AS connection,c.kind,c.status AS connectionState,c.remote_identity AS logicalIdentity,c.config,
       s.scope_id AS scope,s.provider,s.logical_identity AS scopeIdentity,s.config_version AS configVersion,s.state,
       b.config_version AS buildConfigVersion,b.complete AS buildComplete,(c.kind='lofi' OR s.provider='lofi') AS source,
       coalesce(p.version,0) AS syncScopeVersion,coalesce(p.mode,'all') AS syncScopeMode,p.since AS syncSince,p.changed_at AS syncChangedAt,
       ${this.trackCoverageClocks ? "CASE WHEN s.scope_id IS NULL THEN NULL ELSE coalesce(cv.version,0) END" : "NULL"} AS coverageClock,
       EXISTS(SELECT 1 FROM inventory_partition_membership m INDEXED BY inventory_unresolved_members WHERE m.tenant=d.tenant AND m.scope_id=s.scope_id AND m.facet=CASE s.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END AND m.state='unresolved') AS unresolved
       FROM comparison_domains d JOIN accounts a ON a.id=d.tenant AND a.status='active' JOIN connections c ON c.tenant=d.tenant
       LEFT JOIN inventory_scopes s ON s.tenant=c.tenant AND s.connection_id=c.id
       LEFT JOIN inventory_sync_scopes p ON p.tenant=c.tenant AND p.destination=c.id AND s.scope_id=?2
       LEFT JOIN comparison_builds b ON b.tenant=s.tenant AND b.scope_id=s.scope_id AND b.generation_id=d.active_generation
       ${this.trackCoverageClocks ? "LEFT JOIN inventory_matching_coverage_clocks cv ON cv.tenant=s.tenant AND cv.scope_id=s.scope_id AND cv.facet=CASE s.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END" : ""}
       WHERE d.tenant=?1 AND d.active_generation IS NOT NULL AND (c.kind='lofi' OR s.provider='lofi' OR s.scope_id=?2) ORDER BY c.id,s.scope_id LIMIT 22`,
      tenant,
      destination,
    );
    const selectedStatement = this.store.statement(
      `WITH requested AS MATERIALIZED (
       SELECT CAST(j.key AS INTEGER) AS ordinal,i.record_key AS key,i.key_class AS keyClass,i.bucket_hash AS hash,
       i.semantic_version AS semanticVersion,f.semantic_version AS currentSemanticVersion,i.config_version AS configVersion,i.parent_key AS parent,
       i.topology_version AS topologyVersion,coalesce(pd.topology_version,0) AS currentTopologyVersion,i.projection_version AS projectionVersion,coalesce(mv.version,0) AS membershipVersion,
       (SELECT json_object('version',p.version,'state',p.state,'reason',p.reason,'payload',p.payload_id,'scope',p.scope_id,'connection_id',p.connection_id,'encrypted_bytes',p.encrypted_bytes) FROM comparison_projections_current p WHERE p.tenant=i.tenant AND p.generation_id=i.generation_id AND p.scope_id=i.scope_id AND p.record_key=i.record_key AND p.facet=i.facet) AS projection
       FROM json_each(?1) j CROSS JOIN comparison_domains d
       LEFT JOIN comparison_index i ON i.tenant=d.tenant AND i.generation_id=d.active_generation AND i.scope_id=json_extract(j.value,'$.scope') AND i.record_key=json_extract(j.value,'$.key') AND i.facet='source' AND i.state!='retired'
       LEFT JOIN inventory_record_facets f ON f.tenant=i.tenant AND f.scope_id=i.scope_id AND f.entity_family='qso' AND f.record_key=i.record_key AND f.facet=i.facet
       LEFT JOIN projection_domains pd ON pd.tenant=i.tenant AND pd.scope_id=i.scope_id AND pd.operation_key=i.parent_key
       LEFT JOIN inventory_membership_versions mv ON mv.tenant=i.tenant AND mv.scope_id=i.scope_id AND mv.entity_family='qso' AND mv.record_key=i.record_key AND mv.facet=i.facet
       WHERE d.tenant=?2 AND d.active_generation IS NOT NULL
       ), budget AS MATERIALIZED (
         SELECT coalesce(sum(json_extract(projection,'$.encrypted_bytes')),0) AS bytes FROM requested
       )
       SELECT r.*,b.bytes AS encryptedBytes,p.envelope FROM budget b CROSS JOIN requested r
       LEFT JOIN comparison_projection_payloads p ON b.bytes<=?3
        AND (p.tenant,p.scope_id,p.payload_id)=(?2,json_extract(r.projection,'$.scope'),json_extract(r.projection,'$.payload'))
       ORDER BY r.ordinal`,
      canonical(selected),
      tenant,
      MAX_BYTES,
    );
    const {
      session,
      results: [header, selection],
    } = await new InventoryComparisonLookup(this.store).openActiveSnapshot(
      tenant,
      [scopeStatement, selectedStatement],
    );
    stats.metadataQueries += 2;
    stats.rowsRead += header.meta.rows_read + selection.meta.rows_read;
    const scopeRows = header.results as ScopeRow[];
    if (scopeRows.length > 21)
      throw new Error("inventory_matching_scope_split_required");
    const policy = scopeRows.find((row) => row.scope === destination);
    const forwardOnly = policy?.syncScopeMode === "forward";
    const dateFloor = policy?.syncSince?.replaceAll("-", "") ?? null;
    const scopes = await Promise.all(
      scopeRows.map(
        async ({
          config,
          coverageClock,
          syncScopeVersion: _version,
          syncScopeMode: _mode,
          syncSince: _since,
          syncChangedAt: _changedAt,
          ...row
        }) => ({
          ...row,
          configHash: await sha256(config),
          ...(coverageClock !== null ? { coverageClock } : {}),
        }),
      ),
    );
    const target = scopes.find((row) => row.scope === destination);
    if (!target || !["qrz", "lotw"].includes(target.provider ?? ""))
      throw new Error("inventory_matching_destination_unavailable");
    const sourceScopes = scopes.filter((row) => row.source === 1);
    const byScope = new Map(
      scopes.filter((row) => row.scope).map((row) => [row.scope, row]),
    );
    const selectedRows = selection.results as SelectedRow[];
    if (selectedRows.length !== selected.length)
      throw new Error("inventory_matching_snapshot_changed");
    stats.encryptedInputBytes = selectedRows[0].encryptedBytes;
    if (stats.encryptedInputBytes > MAX_BYTES)
      throw new Error("inventory_projection_read_byte_bound");
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
    const bodies = new Map<string, InventoryProjectionBody | null>();
    for (const {
      ordinal,
      projection,
      key,
      encryptedBytes: _,
      envelope,
      ...metadata
    } of selectedRows) {
      const reference = selectedReferences[ordinal];
      const current = projection
        ? (JSON.parse(projection) as {
            version: number;
            state: "ready" | "held" | "excluded";
            reason: string | null;
            payload: string;
            connection_id: string;
            encrypted_bytes: number;
          })
        : null;
      add(
        reference,
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
      let body: InventoryProjectionBody | null = null;
      if (current && envelope !== null) {
        const opened = await openInventoryProjectionBody(
          tenant,
          current.payload,
          { ...current, envelope },
          this.store.keys,
          MAX_BYTES - stats.plaintextBytes,
        );
        stats.plaintextBytes += opened.plaintextBytes;
        stats.decryptedBodies++;
        body = opened.body;
      }
      bodies.set(referenceKey(reference), body);
    }
    const forwardBirths = new Map<string, string>();
    if (forwardOnly) {
      const births = await this.store
        .statement(
          `SELECT b.scope_id AS scope,b.record_key AS key,b.phase
         FROM json_each(?1) r CROSS JOIN inventory_forward_births b
         WHERE b.tenant=?2 AND b.scope_id=json_extract(r.value,'$.scope')
           AND b.record_key=json_extract(r.value,'$.key') AND b.started_at>=?3`,
          canonical(selected),
          tenant,
          policy.syncChangedAt,
        )
        .all<{ scope: string; key: string; phase: string }>();
      stats.metadataQueries++;
      stats.rowsRead += births.meta.rows_read;
      for (const { scope, key, phase } of births.results)
        forwardBirths.set(referenceKey({ scope, key, facet: "source" }), phase);
    }
    function inScope(reference: InventoryMatchingReference) {
      const key = referenceKey(reference);
      const record = bodies.get(key)?.record;
      if (forwardOnly) {
        const phase = forwardBirths.get(key);
        if (phase === "complete") return "eligible";
        return phase && phase !== "held" ? "pending" : "outside";
      }
      return dateFloor && record?.QSO_DATE && record.QSO_DATE < dateFloor
        ? "outside"
        : "eligible";
    }
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
    const windows = selectedReferences.flatMap((row) => {
      const body = bodies.get(referenceKey(row));
      const range =
        !forwardOnly && inScope(row) === "eligible" && body && interval(body);
      return range ? [range] : [];
    });
    const coverageStatement = this.store.statement(
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
    );
    const forwardRequests = selectedReferences.flatMap((reference, i) => {
      const body = bodies.get(referenceKey(reference));
      const keys = body && historicalCandidateKeys(body.record);
      return inScope(reference) === "eligible" &&
        body?.state === "ready" &&
        keys?.workedCall &&
        keys.time
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
    });
    const forwardSnapshot = forwardRequests.length
      ? await session.probeWith<CoverageRow>(
          forwardRequests.map((row) => row.request),
          coverageStatement,
        )
      : null;
    const coverageRows = forwardSnapshot
      ? forwardSnapshot.input
      : await coverageStatement.all<CoverageRow>();
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
    const recordProbes = (
      direction: "forward" | "reverse",
      batch: {
        subject: InventoryMatchingReference;
      }[],
      result: Awaited<ReturnType<typeof session.probe>>,
    ) => {
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
    };
    if (forwardSnapshot)
      recordProbes("forward", forwardRequests, forwardSnapshot.probes);
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
    for (let offset = 0; offset < reverseRequests.length; offset += 20) {
      const batch = reverseRequests.slice(offset, offset + 20);
      recordProbes(
        "reverse",
        batch,
        await session.probe(batch.map((row) => row.request)),
      );
    }
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
            ready(target, forwardOnly) &&
            (forwardOnly ||
              !!coveringCoverage(body, target, coverageRows.results)) &&
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
        const eligibility = inScope(row.source);
        if (eligibility === "pending")
          return {
            ...row,
            state: "incomplete",
            reason: "forward_birth_pending",
            remote: null,
          };
        if (eligibility === "outside" && row.state !== "excluded")
          return {
            ...row,
            state: "excluded",
            reason: null,
            remote: null,
            scopeExcluded: true,
          };
        if (row.state === "none")
          return { ...row, state: "absent_at_inventory" };
        if (
          forwardOnly &&
          (row.state === "unique" || row.state === "ambiguous")
        )
          return {
            ...row,
            state: "incomplete",
            reason: "forward_destination_candidate",
            remote: null,
          };
        if (forwardOnly && row.reason === "forward_incomplete")
          return {
            ...row,
            state: "incomplete",
            reason: "forward_baseline_pending",
            remote: null,
          };
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
        coverage:
          !forwardOnly && inScope(row.source) === "eligible" && body
            ? (coveringCoverage(body, target, coverageRows.results) ?? [])
            : [],
      };
    });
    const recovery: InventoryMatchingRecovery[] = [];
    if (this.trackCoverageRecovery) {
      const incomplete = results.find((row) => row.state === "incomplete");
      if (incomplete) {
        const missingFullSource = (scope: InventoryMatchingScope) =>
          !coverageRows.results.some((row) => fullSource(row, scope));
        const sourceRecoveries = new Set<string>();
        if (results.some((row) => row.reason === "reverse_incomplete"))
          for (const scope of sourceScopes)
            if (
              scope.scope &&
              scope.provider === "lofi" &&
              missingFullSource(scope)
            )
              sourceRecoveries.add(scope.scope);
        for (const { reference, candidate } of records.values()) {
          const scope = byScope.get(reference.scope);
          if (
            reference.facet === "source" &&
            candidate &&
            !candidate.currentProjectionVersion &&
            !bodies.get(referenceKey(reference)) &&
            scope?.provider === "lofi" &&
            (missingFullSource(scope) ||
              coverageRows.results.some(
                (row) =>
                  row.scope === scope.scope &&
                  row.facet === "source" &&
                  row.state !== "ready",
              ))
          )
            sourceRecoveries.add(reference.scope);
        }
        for (const scope of sourceRecoveries)
          recovery.push({
            scope,
            facet: "source",
            subject: incomplete.source,
            nodes: [""],
          });
        const days: { date: string; subject: InventoryMatchingReference }[] =
          [];
        for (const row of forwardOnly ? [] : results) {
          const body = bodies.get(referenceKey(row.source));
          const window = body && interval(body);
          if (
            row.state !== "incomplete" ||
            body?.state !== "ready" ||
            !window ||
            coveringCoverage(body, target, coverageRows.results)
          )
            continue;
          let date = window.start;
          for (let count = 0; ; count++) {
            if (count >= 2)
              throw new Error("inventory_matching_recovery_split_required");
            if (
              !coveringCoverage(body, target, coverageRows.results, {
                start: date,
                end: date,
              })
            ) {
              days.push({ date, subject: row.source });
              // One unmet day is a sufficient wait point: until it completes,
              // the full window cannot be covered. Then prepare again and
              // subscribe to any remaining gap instead of retaining both days.
              break;
            }
            if (date === window.end) break;
            date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000)
              .toISOString()
              .slice(0, 10);
          }
        }
        const tokens = await session.coverageDays(destination, [
          ...new Set(days.map((row) => row.date)),
        ]);
        const byDate = new Map(tokens.map((row) => [row.date, row.tags]));
        for (const { date, subject } of days) {
          const nodes = byDate.get(date);
          if (!nodes)
            throw new Error("inventory_matching_recovery_tokens_missing");
          recovery.push({
            scope: destination,
            facet: "receipt",
            subject,
            nodes,
          });
        }
      }
    }
    const snapshot = {
      formatVersion: 1 as const,
      coverageClocks: this.trackCoverageClocks ? (1 as const) : undefined,
      coverageRecovery: this.trackCoverageRecovery ? (1 as const) : undefined,
      recovery: this.trackCoverageRecovery ? recovery : undefined,
      tenant,
      destination,
      generation: session.generation,
      domainVersion: session.domainVersion,
      sourceSetVersion: session.sourceSetVersion,
      syncScopeVersion: policy?.syncScopeVersion ?? 0,
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
