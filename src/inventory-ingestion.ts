import type {
  InventoryComparisonPages,
  PreparedComparisonPage,
} from "./inventory-comparison-pages.ts";
import {
  type InventoryRunPublication,
  inventoryRunCleanup,
  inventoryRunEffects,
  inventoryRunPrelude,
} from "./inventory-run-publication.ts";
import {
  canonical,
  type Envelope,
  open,
  randomToken,
  seal,
  sha256,
} from "./security.ts";
import type { Lease, Store } from "./store.ts";

/** This foundation publishes observations only, never coverage or write proofs. */
export interface InventoryScope {
  tenant: string;
  scope: string;
  connection: string;
  provider: "lofi" | "qrz" | "lotw";
  logicalIdentity: string;
  adapterBinding: string;
  ordering: "numeric" | "serialized";
}
export interface InventoryStream extends InventoryScope {
  stream: string;
  queryBinding: string;
  configVersion: number;
  sequence: number;
  version: number;
  resume: unknown;
  checkpoint: unknown;
  credentialVersion: string;
  connectionConfig: string;
  remoteIdentity: string;
}
export interface InventoryObservation {
  family: "operation" | "qso";
  key: string;
  subtype: "operation" | "event" | "qso";
  parentKey?: string;
  status: "active" | "deleted";
  revision: string;
  order: number | null;
  body: unknown;
  /** The adapter's comparison-relevant view, excluding transport metadata. */
  semantic?: unknown;
}
export interface InventoryPageInput {
  pageId: string;
  stream: InventoryStream;
  lease: Lease;
  facet: "source" | "receipt";
  requestStartedAt: number;
  origin: "historical" | "forward";
  observations: InventoryObservation[];
  nextResume: unknown;
  /** Absent until the adapter's incremental run, not merely this page, ends. */
  nextCheckpoint?: unknown;
  run?: InventoryRunPublication;
}
interface CurrentRow {
  family: string;
  key: string;
  record_version: number;
  facet_version: number;
  subtype: string | null;
  parent_key: string | null;
  status: string | null;
  revision: string | null;
  revision_order: number | null;
  body_hash: string | null;
  semantic_hash: string | null;
  payload_id: string | null;
  last_observed_at: number | null;
}
interface PreparedRow {
  family: string;
  key: string;
  facet: string;
  subtype: string;
  parent: string | null;
  status: string;
  revision: string;
  order: number | null;
  bodyHash: string;
  semanticHash: string;
  payload: string;
  recordVersion: number;
  facetVersion: number;
  accepted: number;
  changed: number;
  semanticChanged: number;
  domains: string[];
}
export interface PreparedInventoryPage {
  readonly input: InventoryPageInput;
  readonly digest: string;
  readonly manifest: string;
  readonly preparedAt: number;
  readonly rows: readonly PreparedRow[];
  readonly payloads: readonly { id: string; envelope: string }[];
  readonly comparison?: PreparedComparisonPage | null;
  readonly preparationMs: number;
  readonly plaintextBytes: number;
  readonly encryptedBytes: number;
}
export interface InventoryReceipt {
  pageId: string;
  recovered: boolean;
  committedVersion: number;
  currentVersion: number;
  resume: unknown;
  checkpoint: unknown;
  records: number;
  accepted: number;
  changed: number;
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  publicationMs: number;
}

const encoder = new TextEncoder();
const MAX_JSON_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_ENCRYPTED_BYTES = 12 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const VERSION = "inventory-page-v1";
const relation = `FROM ingestion_page_rows r JOIN ingestion_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id WHERE p.tenant=? AND p.page_id=?`;
const accepted = `${relation} AND r.accepted=1`;

function inputDigest(input: InventoryPageInput) {
  // A replacement lease may recover the same original request after restart.
  // Lease authority is revalidated natively, separately from page identity.
  const { lease: _lease, ...request } = input;
  return sha256(canonical([VERSION, request]));
}

export class InventoryIngestionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InventoryIngestionError";
  }
}
function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new InventoryIngestionError(code);
}
function identifier(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
/** Bound actual UTF-8 binding bytes; a single oversized row is never truncated. */
export function inventoryJsonChunks(
  values: readonly unknown[],
  limit = MAX_JSON_BYTES,
): string[] {
  const chunks: string[] = [];
  let rows: string[] = [];
  let bytes = 2;
  for (const value of values) {
    const text = JSON.stringify(value);
    const size = encoder.encode(text).byteLength;
    requireValue(size + 2 <= limit, "inventory_row_too_large");
    if (bytes + size + (rows.length ? 1 : 0) > limit) {
      chunks.push(`[${rows.join(",")}]`);
      rows = [];
      bytes = 2;
    }
    bytes += size + (rows.length ? 1 : 0);
    rows.push(text);
  }
  if (rows.length) chunks.push(`[${rows.join(",")}]`);
  return chunks;
}

export class InventoryIngestion {
  constructor(
    readonly store: Store,
    readonly comparisons?: InventoryComparisonPages,
  ) {}

  async initialize(
    scope: InventoryScope,
    stream: string,
    queryBinding: string,
  ) {
    requireValue(
      [
        scope.tenant,
        scope.scope,
        scope.connection,
        scope.logicalIdentity,
        scope.adapterBinding,
        stream,
        queryBinding,
      ].every(identifier),
      "invalid_inventory_scope",
    );
    await this.store.db.batch([
      this.store.statement(
        `INSERT INTO inventory_scopes(tenant,scope_id,connection_id,provider,logical_identity,adapter_binding,ordering) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant,scope_id) DO NOTHING`,
        scope.tenant,
        scope.scope,
        scope.connection,
        scope.provider,
        scope.logicalIdentity,
        scope.adapterBinding,
        scope.ordering,
      ),
      this.store.statement(
        `INSERT INTO inventory_streams(tenant,scope_id,stream_id,query_binding) VALUES(?,?,?,?) ON CONFLICT(tenant,scope_id,stream_id) DO NOTHING`,
        scope.tenant,
        scope.scope,
        stream,
        queryBinding,
      ),
    ]);
    const current = await this.snapshot(scope.tenant, scope.scope, stream);
    requireValue(
      current &&
        current.connection === scope.connection &&
        current.provider === scope.provider &&
        current.logicalIdentity === scope.logicalIdentity &&
        current.adapterBinding === scope.adapterBinding &&
        current.ordering === scope.ordering &&
        current.queryBinding === queryBinding,
      "inventory_binding_changed",
    );
    return current;
  }

  async snapshot(
    tenant: string,
    scope: string,
    stream: string,
  ): Promise<InventoryStream | null> {
    const row = await this.store
      .statement(
        `SELECT s.*,t.*,c.credential_version,c.config AS connection_config,c.remote_identity FROM inventory_scopes s JOIN inventory_streams t ON t.tenant=s.tenant AND t.scope_id=s.scope_id JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id WHERE s.tenant=? AND s.scope_id=? AND t.stream_id=?`,
        tenant,
        scope,
        stream,
      )
      .first<{
        tenant: string;
        scope_id: string;
        connection_id: string;
        provider: InventoryScope["provider"];
        logical_identity: string;
        adapter_binding: string;
        ordering: InventoryScope["ordering"];
        config_version: number;
        accepted_sequence: number;
        stream_id: string;
        query_binding: string;
        checkpoint_version: number;
        resume_state: string;
        committed_checkpoint: string;
        credential_version: string | null;
        connection_config: string;
        remote_identity: string;
      }>();
    if (!row) return null;
    requireValue(row.credential_version, "inventory_credential_unavailable");
    return {
      tenant: row.tenant,
      scope: row.scope_id,
      connection: row.connection_id,
      provider: row.provider,
      logicalIdentity: row.logical_identity,
      adapterBinding: row.adapter_binding,
      ordering: row.ordering,
      configVersion: row.config_version,
      sequence: row.accepted_sequence,
      stream: row.stream_id,
      queryBinding: row.query_binding,
      version: row.checkpoint_version,
      resume: JSON.parse(row.resume_state),
      checkpoint: JSON.parse(row.committed_checkpoint),
      credentialVersion: row.credential_version,
      connectionConfig: row.connection_config,
      remoteIdentity: row.remote_identity,
    };
  }

  async prepare(input: InventoryPageInput): Promise<PreparedInventoryPage> {
    const started = performance.now();
    input = structuredClone(input);
    const { stream: s, lease } = input;
    requireValue(
      identifier(input.pageId) &&
        lease.tenant === s.tenant &&
        lease.scope === `inventory:${s.scope}`,
      "invalid_inventory_page_binding",
    );
    requireValue(
      Number.isSafeInteger(input.requestStartedAt) &&
        input.requestStartedAt > 0 &&
        input.requestStartedAt <= Date.now(),
      "invalid_inventory_observation_time",
    );
    requireValue(
      input.observations.length <= MAX_RECORDS,
      "inventory_page_too_large",
    );
    requireValue(
      (s.provider === "lofi") === (input.facet === "source"),
      "invalid_inventory_facet",
    );
    // Capture caller-owned data before the first await so later mutation cannot
    // change a prepared manifest, checkpoint or encrypted payload.
    const digest = await inputDigest(input);
    const grouped = new Map<
      string,
      {
        value: InventoryObservation;
        bodyHash: string;
        semanticHash: string;
        domains: Set<string>;
        variants: Map<number | null, string>;
      }
    >();
    let plaintextBytes = 0;
    for (const row of input.observations) {
      requireValue(
        identifier(row.key) &&
          identifier(row.revision) &&
          (!row.parentKey || identifier(row.parentKey)),
        "invalid_inventory_record",
      );
      requireValue(
        (row.family === "operation" &&
          row.subtype === "operation" &&
          !row.parentKey) ||
          (row.family === "qso" && ["qso", "event"].includes(row.subtype)),
        "invalid_inventory_entity",
      );
      requireValue(
        (s.ordering === "numeric" &&
          Number.isSafeInteger(row.order) &&
          row.order !== null &&
          row.order >= 0) ||
          (s.ordering === "serialized" && row.order === null),
        "invalid_inventory_revision_order",
      );
      const body = canonical(row.body);
      plaintextBytes += encoder.encode(body).byteLength;
      requireValue(
        plaintextBytes <= MAX_PAGE_BYTES,
        "inventory_page_too_large",
      );
      const bodyHash = await sha256(body);
      const semanticHash = await sha256(
        canonical([
          row.subtype,
          row.parentKey ?? null,
          row.status,
          row.semantic ?? row.body,
        ]),
      );
      const key = canonical([row.family, row.key]);
      const previous = grouped.get(key);
      const variant = canonical([bodyHash, semanticHash, row.revision]);
      // Every equal-order variant matters, including one superseded later in
      // this same page. Unordered duplicates must agree, never pick last-wins.
      requireValue(
        !previous?.variants.has(row.order) ||
          previous.variants.get(row.order) === variant,
        "inventory_equal_revision_conflict",
      );
      const domains = previous?.domains ?? new Set<string>();
      if (row.family === "operation") domains.add(row.key);
      else if (row.subtype === "event" && row.parentKey)
        domains.add(row.parentKey);
      const variants = previous?.variants ?? new Map<number | null, string>();
      variants.set(row.order, variant);
      if (
        !previous ||
        (row.order !== null &&
          previous.value.order !== null &&
          row.order > previous.value.order)
      ) {
        grouped.set(key, {
          value: row,
          bodyHash,
          semanticHash,
          domains,
          variants,
        });
      }
    }
    const unique = [...grouped.values()];
    const current = new Map<string, CurrentRow>();
    for (const chunk of inventoryJsonChunks(
      unique.map(({ value }) => ({ family: value.family, key: value.key })),
    )) {
      const result = await this.store
        .statement(
          `SELECT json_extract(j.value,'$.family') AS family,json_extract(j.value,'$.key') AS key,coalesce(e.row_version,0) AS record_version,coalesce(f.row_version,0) AS facet_version,e.subtype,e.parent_key,e.status,f.revision,f.revision_order,f.body_hash,f.semantic_hash,f.payload_id,f.last_observed_at
         FROM json_each(?) j LEFT JOIN inventory_records e ON e.tenant=? AND e.scope_id=? AND e.entity_family=json_extract(j.value,'$.family') AND e.record_key=json_extract(j.value,'$.key')
         LEFT JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet=?`,
          chunk,
          s.tenant,
          s.scope,
          input.facet,
        )
        .all<CurrentRow>();
      for (const row of result.results)
        current.set(canonical([row.family, row.key]), row);
    }
    const rows: PreparedRow[] = [];
    const payloads: { id: string; envelope: string }[] = [];
    let encryptedBytes = 0;
    const kind =
      input.facet === "source" ? "inventory_source" : "inventory_receipt";
    for (const { value, bodyHash, semanticHash, domains } of unique) {
      const old = current.get(canonical([value.family, value.key]));
      requireValue(old, "inventory_snapshot_incomplete");
      if (old.facet_version && s.ordering === "numeric") {
        requireValue(
          old.revision_order !== null,
          "inventory_revision_policy_changed",
        );
        requireValue(
          value.order !== old.revision_order ||
            (bodyHash === old.body_hash && semanticHash === old.semantic_hash),
          "inventory_equal_revision_conflict",
        );
      }
      const stale =
        old.facet_version > 0 &&
        (s.ordering === "numeric"
          ? (value.order as number) < (old.revision_order as number)
          : input.requestStartedAt < (old.last_observed_at ?? 0));
      const changed = !stale && bodyHash !== old.body_hash;
      const semanticChanged =
        !stale &&
        (semanticHash !== old.semantic_hash ||
          value.subtype !== old.subtype ||
          (value.parentKey ?? null) !== old.parent_key ||
          value.status !== old.status);
      let payload = old.payload_id ?? "";
      if (changed) {
        payload = randomToken();
        const envelope = JSON.stringify(
          await seal(
            value.body,
            {
              tenant: s.tenant,
              connection: s.connection,
              id: payload,
              kind,
              purpose: "storage",
            },
            this.store.keys,
          ),
        );
        encryptedBytes += encoder.encode(envelope).byteLength;
        requireValue(
          encryptedBytes <= MAX_ENCRYPTED_BYTES,
          "inventory_page_too_large",
        );
        payloads.push({ id: payload, envelope });
      }
      // Old domains are derived from native current metadata, never a vendor
      // declaration. The version CAS below protects this classification.
      if (old.subtype === "event" && old.parent_key)
        domains.add(old.parent_key);
      rows.push({
        family: value.family,
        key: value.key,
        facet: input.facet,
        subtype: value.subtype,
        parent: value.parentKey ?? null,
        status: value.status,
        revision: value.revision,
        order: value.order,
        bodyHash,
        semanticHash,
        payload,
        recordVersion: old.record_version,
        facetVersion: old.facet_version,
        accepted: Number(!stale),
        changed: Number(changed),
        semanticChanged: Number(semanticChanged),
        domains: [...domains].sort(),
      });
    }
    // Validate chunk bounds now, before publication can perform any writes.
    inventoryJsonChunks(rows);
    inventoryJsonChunks(payloads);
    const comparison = this.comparisons
      ? await this.comparisons.prepare(
          input,
          rows.map((row) => ({
            ...row,
            body: grouped.get(canonical([row.family, row.key]))?.value.body,
          })),
        )
      : null;
    const manifest = await sha256(
      canonical([VERSION, digest, rows, payloads, comparison]),
    );
    return {
      input,
      digest,
      manifest,
      preparedAt: Date.now(),
      rows,
      payloads,
      comparison,
      preparationMs: performance.now() - started,
      plaintextBytes,
      encryptedBytes,
    };
  }

  async recover(page: PreparedInventoryPage): Promise<InventoryReceipt | null> {
    const { stream: s, pageId } = page.input;
    const row = await this.store
      .statement(
        `SELECT p.*,t.checkpoint_version AS current_version,t.resume_state,t.committed_checkpoint FROM ingestion_pages p JOIN inventory_streams t ON t.tenant=p.tenant AND t.scope_id=p.scope_id AND t.stream_id=p.stream_id WHERE p.tenant=? AND p.page_id=? AND p.state='committed'`,
        s.tenant,
        pageId,
      )
      .first<{
        input_digest: string;
        expected_stream_version: number;
        current_version: number;
        resume_state: string;
        committed_checkpoint: string;
        distinct_count: number;
        accepted_count: number;
        changed_count: number;
      }>();
    if (!row) return null;
    requireValue(row.input_digest === page.digest, "inventory_page_id_reused");
    return {
      pageId,
      recovered: true,
      committedVersion: row.expected_stream_version + 1,
      currentVersion: row.current_version,
      resume: JSON.parse(row.resume_state),
      checkpoint: JSON.parse(row.committed_checkpoint),
      records: row.distinct_count,
      accepted: row.accepted_count,
      changed: row.changed_count,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
      publicationMs: 0,
    };
  }

  async publish(page: PreparedInventoryPage): Promise<InventoryReceipt> {
    page = structuredClone(page);
    requireValue(
      (await inputDigest(page.input)) === page.digest &&
        (await sha256(
          canonical([
            VERSION,
            page.digest,
            page.rows,
            page.payloads,
            page.comparison ?? null,
          ]),
        )) === page.manifest,
      "inventory_prepared_page_changed",
    );
    const existing = await this.recover(page);
    if (existing) return existing;
    requireValue(
      !page.comparison || this.comparisons,
      "inventory_comparison_publisher_missing",
    );
    const { input, rows, payloads } = page;
    const { stream: s, lease } = input;
    const count = (key: "accepted" | "changed") =>
      rows.reduce((n, row) => n + row[key], 0);
    const acceptedCount = count("accepted");
    const changedCount = count("changed");
    const statement = (sql: string, ...params: (string | number | null)[]) =>
      this.store.statement(sql, ...params);
    const bound = (sql: string) => statement(sql, s.tenant, input.pageId);
    const plan: D1PreparedStatement[] = [
      statement(
        `INSERT INTO ingestion_pages(tenant,page_id,scope_id,stream_id,input_digest,manifest_digest,adapter_binding,query_binding,expected_config_version,expected_sequence,expected_stream_version,credential_version,connection_config,remote_identity,lease_scope,lease_token,lease_fence,request_started_at,prepared_at,raw_count,distinct_count,accepted_count,changed_count,next_resume,next_checkpoint,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.tenant,
        input.pageId,
        s.scope,
        s.stream,
        page.digest,
        page.manifest,
        s.adapterBinding,
        s.queryBinding,
        s.configVersion,
        s.sequence,
        s.version,
        s.credentialVersion,
        s.connectionConfig,
        s.remoteIdentity,
        lease.scope,
        lease.token,
        lease.fence,
        input.requestStartedAt,
        page.preparedAt,
        input.observations.length,
        rows.length,
        acceptedCount,
        changedCount,
        canonical(input.nextResume),
        input.nextCheckpoint === undefined
          ? null
          : canonical(input.nextCheckpoint),
        input.origin,
      ),
    ];
    plan.push(...inventoryRunPrelude(this.store, input));
    for (const chunk of inventoryJsonChunks(rows)) {
      plan.push(
        statement(
          `INSERT INTO ingestion_page_rows(tenant,page_id,entity_family,record_key,facet,subtype,parent_key,status,revision,revision_order,body_hash,semantic_hash,payload_id,expected_record_version,expected_facet_version,accepted,changed,semantic_changed)
         SELECT ?,?,json_extract(value,'$.family'),json_extract(value,'$.key'),json_extract(value,'$.facet'),json_extract(value,'$.subtype'),json_extract(value,'$.parent'),json_extract(value,'$.status'),json_extract(value,'$.revision'),json_extract(value,'$.order'),json_extract(value,'$.bodyHash'),json_extract(value,'$.semanticHash'),json_extract(value,'$.payload'),json_extract(value,'$.recordVersion'),json_extract(value,'$.facetVersion'),json_extract(value,'$.accepted'),json_extract(value,'$.changed'),json_extract(value,'$.semanticChanged') FROM json_each(?)`,
          s.tenant,
          input.pageId,
          chunk,
        ),
      );
    }
    plan.push(
      ...(this.comparisons?.prelude(input, page.comparison ?? null) ?? []),
    );
    plan.push(
      bound("INSERT INTO ingestion_page_guards(tenant,page_id) VALUES(?,?)"),
    );
    for (const chunk of inventoryJsonChunks(payloads)) {
      plan.push(
        statement(
          `INSERT INTO inventory_payloads(tenant,scope_id,payload_id,connection_id,kind,envelope,created_at) SELECT ?,?,json_extract(value,'$.id'),?,?,json_extract(value,'$.envelope'),? FROM json_each(?)`,
          s.tenant,
          s.scope,
          s.connection,
          input.facet === "source" ? "inventory_source" : "inventory_receipt",
          page.preparedAt,
          chunk,
        ),
      );
    }
    plan.push(
      bound(
        `INSERT INTO inventory_births(tenant,scope_id,entity_family,record_key,facet,first_page_id,first_observed_at,origin) SELECT p.tenant,p.scope_id,r.entity_family,r.record_key,r.facet,p.page_id,p.request_started_at,p.origin ${accepted} ON CONFLICT DO NOTHING`,
      ),
      // Distinct domains coalesce operation/event fan-out. Ordinary contact
      // edits enqueue per-record work but do not dirty every operation child.
      ...inventoryJsonChunks([
        ...new Set(
          rows
            .filter((row) => row.semanticChanged)
            .flatMap((row) => row.domains),
        ),
      ]).map((chunk) =>
        statement(
          `INSERT INTO projection_domains(tenant,scope_id,operation_key,topology_version,ready_version) SELECT ?,?,value,1,0 FROM json_each(?) WHERE 1 GROUP BY value ON CONFLICT(tenant,scope_id,operation_key) DO UPDATE SET topology_version=projection_domains.topology_version+1`,
          s.tenant,
          s.scope,
          chunk,
        ),
      ),
      bound(`INSERT INTO inventory_records(tenant,scope_id,entity_family,record_key,subtype,parent_key,row_version,status,last_accepted_sequence,last_observed_at,last_page_id)
        SELECT p.tenant,p.scope_id,r.entity_family,r.record_key,r.subtype,r.parent_key,1,r.status,p.expected_sequence+1,p.request_started_at,p.page_id ${accepted}
        ON CONFLICT(tenant,scope_id,entity_family,record_key) DO UPDATE SET subtype=excluded.subtype,parent_key=excluded.parent_key,row_version=inventory_records.row_version+1,status=excluded.status,last_accepted_sequence=excluded.last_accepted_sequence,last_observed_at=excluded.last_observed_at,last_page_id=excluded.last_page_id`),
      bound(`INSERT INTO inventory_record_facets(tenant,scope_id,entity_family,record_key,facet,row_version,revision,revision_order,body_hash,semantic_hash,payload_id,raw_version,semantic_version,last_accepted_sequence,first_observed_at,last_observed_at,last_page_id)
        SELECT p.tenant,p.scope_id,r.entity_family,r.record_key,r.facet,1,r.revision,r.revision_order,r.body_hash,r.semantic_hash,r.payload_id,1,1,p.expected_sequence+1,p.request_started_at,p.request_started_at,p.page_id ${accepted}
        ON CONFLICT(tenant,scope_id,entity_family,record_key,facet) DO UPDATE SET row_version=inventory_record_facets.row_version+1,revision=excluded.revision,revision_order=excluded.revision_order,body_hash=excluded.body_hash,semantic_hash=excluded.semantic_hash,payload_id=excluded.payload_id,
        raw_version=inventory_record_facets.raw_version+(SELECT changed FROM ingestion_page_rows r WHERE r.tenant=excluded.tenant AND r.page_id=excluded.last_page_id AND r.entity_family=excluded.entity_family AND r.record_key=excluded.record_key AND r.facet=excluded.facet),
        semantic_version=inventory_record_facets.semantic_version+(SELECT semantic_changed FROM ingestion_page_rows r WHERE r.tenant=excluded.tenant AND r.page_id=excluded.last_page_id AND r.entity_family=excluded.entity_family AND r.record_key=excluded.record_key AND r.facet=excluded.facet),
        last_accepted_sequence=excluded.last_accepted_sequence,last_observed_at=CASE WHEN inventory_record_facets.revision!=excluded.revision OR inventory_record_facets.body_hash!=excluded.body_hash OR inventory_record_facets.semantic_hash!=excluded.semantic_hash THEN excluded.last_observed_at ELSE max(inventory_record_facets.last_observed_at,excluded.last_observed_at) END,last_page_id=excluded.last_page_id`),
      bound(
        `INSERT INTO inventory_work(tenant,scope_id,work_key,work_version,due_at) SELECT p.tenant,p.scope_id,json_array(r.entity_family,r.record_key,r.facet),1,p.request_started_at ${accepted} AND r.semantic_changed=1 ON CONFLICT(tenant,scope_id,work_key) DO UPDATE SET work_version=inventory_work.work_version+1,due_at=min(inventory_work.due_at,excluded.due_at)`,
      ),
      ...(this.comparisons?.effects(input, page.comparison ?? null) ?? []),
      ...inventoryRunEffects(this.store, input),
      bound(
        `UPDATE inventory_scopes SET accepted_sequence=accepted_sequence+1 WHERE tenant=? AND scope_id=(SELECT scope_id FROM ingestion_pages WHERE tenant=inventory_scopes.tenant AND page_id=?)`,
      ),
      bound(
        `UPDATE inventory_streams SET checkpoint_version=checkpoint_version+1,resume_state=(SELECT next_resume FROM ingestion_pages p WHERE p.tenant=inventory_streams.tenant AND p.page_id=?2),committed_checkpoint=coalesce((SELECT next_checkpoint FROM ingestion_pages p WHERE p.tenant=inventory_streams.tenant AND p.page_id=?2),committed_checkpoint),updated_at=(SELECT request_started_at FROM ingestion_pages p WHERE p.tenant=inventory_streams.tenant AND p.page_id=?2) WHERE tenant=?1 AND (scope_id,stream_id)=(SELECT scope_id,stream_id FROM ingestion_pages WHERE tenant=?1 AND page_id=?2)`,
      ),
      bound(
        "UPDATE ingestion_pages SET state='committed' WHERE tenant=? AND page_id=?",
      ),
      ...(this.comparisons?.cleanup(input, page.comparison ?? null) ?? []),
      bound("DELETE FROM ingestion_page_rows WHERE tenant=? AND page_id=?"),
      ...inventoryRunCleanup(this.store, input),
      bound("DELETE FROM ingestion_page_guards WHERE tenant=? AND page_id=?"),
    );
    requireValue(plan.length <= 200, "inventory_transaction_too_large");
    const started = performance.now();
    let result: D1Result[];
    try {
      result = await this.store.db.batch(plan);
    } catch (error) {
      // D1 may have committed even if the caller lost its response. A receipt
      // is the authority; never restore a cursor from this old page on retry.
      const committed = await this.recover(page).catch(() => null);
      if (committed) return committed;
      throw error;
    }
    return {
      pageId: input.pageId,
      recovered: false,
      committedVersion: s.version + 1,
      currentVersion: s.version + 1,
      resume: input.nextResume,
      checkpoint:
        input.nextCheckpoint === undefined
          ? s.checkpoint
          : input.nextCheckpoint,
      records: rows.length,
      accepted: acceptedCount,
      changed: changedCount,
      statements: plan.length,
      rowsRead: result.reduce((n, row) => n + row.meta.rows_read, 0),
      rowsWritten: result.reduce((n, row) => n + row.meta.rows_written, 0),
      publicationMs: performance.now() - started,
    };
  }

  async body<T>(
    tenant: string,
    scope: string,
    family: string,
    key: string,
    facet: "source" | "receipt",
  ): Promise<T | null> {
    const row = await this.store
      .statement(
        `SELECT p.* FROM inventory_record_facets f JOIN inventory_payloads p ON p.tenant=f.tenant AND p.scope_id=f.scope_id AND p.payload_id=f.payload_id WHERE f.tenant=? AND f.scope_id=? AND f.entity_family=? AND f.record_key=? AND f.facet=?`,
        tenant,
        scope,
        family,
        key,
        facet,
      )
      .first<{
        envelope: string;
        connection_id: string;
        payload_id: string;
        kind: string;
      }>();
    return row
      ? open<T>(
          JSON.parse(row.envelope) as Envelope,
          {
            tenant,
            connection: row.connection_id,
            id: row.payload_id,
            kind: row.kind,
            purpose: "storage",
          },
          this.store.keys,
        )
      : null;
  }
}
