import { providerKinds, providerName } from "./providers.ts";
import { templateContext } from "./delivery.ts";
import type { Work } from "./intake.ts";
import type { SourceRecord } from "./lofi.ts";
import { lofiAccountLabel } from "./lofi-identity.ts";
import { lotwReadyForUpload, lotwVerification } from "./lotw-verification.ts";
import {
  isEventRecord,
  isSourceDeleted,
  ProjectionError,
  projectContact,
} from "./projection.ts";
import type {
  ReviewContact,
  ReviewResponse,
  ReviewSource,
} from "./review-types.ts";
import { type Envelope, open } from "./security.ts";
import { defaultTemplate } from "./settings.ts";
import type { Ledger, Store } from "./store.ts";
import {
  renderNarrative,
  type TemplateVersion,
  validateTemplateVersion,
} from "./templates.ts";

const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_CONTEXT_RECORDS = 65;
const PREVIEW_NOTICE =
  "Current saved template preview only. This does not prepare an export, change a pinned version, or replace adopted QRZ narrative. Unsaved editor changes are not included.";

export type {
  ReviewContact,
  ReviewResponse,
  ReviewSource,
} from "./review-types.ts";

interface SourceRow {
  id: string;
  status: string;
  last_poll_at: number | null;
  config: string;
}
interface ContextRow {
  cursor: string;
  generation: number;
  updated_at: number;
}
interface SourceState {
  hasError: boolean;
  public: ReviewSource;
  context: ContextRow | null;
}
export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function record(value: unknown): SourceRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {};
}
function display(value: unknown, maximum = 128): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : undefined;
}
function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
function reason(value: string | null): string | undefined {
  return value && /^[a-z_]{1,100}$/.test(value)
    ? value
    : value
      ? "source_requires_review"
      : undefined;
}
function identifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    value.length > 200 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new ReviewError(400, "Invalid review selection");
  return value;
}
async function sourceState(
  store: Store,
  tenant: string,
  source: SourceRow,
  now: number,
): Promise<SourceState> {
  const context = await store
    .statement(
      "SELECT cursor,generation,updated_at FROM cursors WHERE tenant=? AND connection=? AND stream='context'",
      tenant,
      source.id,
    )
    .first<ContextRow>();
  const sync = await store
    .statement(
      "SELECT cursor,generation,updated_at FROM cursors WHERE tenant=? AND connection=? AND stream='sync'",
      tenant,
      source.id,
    )
    .first<ContextRow>();
  const progress = jsonObject(sync?.cursor ?? "{}");
  const health = jsonObject(source.config);
  const counts = await store
    .statement(
      `SELECT SUM(CASE WHEN w.kind='operation' AND w.deleted=0 THEN 1 ELSE 0 END) operations,SUM(CASE WHEN w.kind='qso' AND w.is_event=0 AND w.deleted=0 THEN 1 ELSE 0 END) contacts,SUM(CASE WHEN w.is_event=1 AND w.deleted=0 THEN 1 ELSE 0 END) events,SUM(CASE WHEN w.deleted=1 THEN 1 ELSE 0 END) tombstones,SUM(CASE WHEN w.expires_at<=? THEN 1 ELSE 0 END) expired,SUM(CASE WHEN w.state='archived' THEN 1 ELSE 0 END) archived,SUM(CASE WHEN w.kind='operation' AND w.deleted=0 AND w.state!='context' AND w.expires_at>? THEN 1 ELSE 0 END) pendingOperations,SUM(CASE WHEN w.kind='operation' AND w.reason='operation_read_failed_retrying' THEN 1 ELSE 0 END) operationReadFailures,SUM(CASE WHEN w.kind='qso' AND w.is_event=0 AND w.deleted=0 AND w.expires_at>? AND p.id IS NOT NULL AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) THEN 1 ELSE 0 END) reviewable FROM source_work w LEFT JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source' WHERE w.tenant=? AND w.source=?`,
      now,
      now,
      now,
      now,
      tenant,
      source.id,
    )
    .first<Record<keyof ReviewSource["counts"], number | null>>();
  const initialScanComplete =
    progress.mode === "forward" ||
    (record(progress.operations).complete === true &&
      record(progress.qsos).complete === true);
  const contextComplete = jsonObject(context?.cursor ?? "{}").complete === true;
  const message =
    source.status === "revoked"
      ? "Credentials removed. Previously retained details remain available for review until they expire."
      : source.status !== "active"
        ? "This source is paused. Previously retained data can still be reviewed until it expires."
        : health.lastError
          ? "Source synchronization needs attention. Retained data remains available; the last poll timestamp is an attempt, not proof of success."
          : (counts?.operationReadFailures ?? 0) > 0
            ? "Some operation reads failed and are being retried. Their contact previews wait for complete operation context."
            : !sync
              ? "Connected. Waiting for the first scheduled read-only import."
              : !initialScanComplete
                ? "Initial import is in progress. Contact details can be reviewed now; effective operation/segment previews wait for complete context."
                : !contextComplete || (counts?.pendingOperations ?? 0) > 0
                  ? "Import has reached forward polling. Current operation and segment context is still being reconciled."
                  : "Your import is ready to review. Reviewing does not enable delivery. Review destination history and complete the rollout checks before enabling exports.";
  return {
    context,
    hasError:
      Boolean(health.lastError) || (counts?.operationReadFailures ?? 0) > 0,
    public: {
      id: source.id,
      label: lofiAccountLabel(health.accountEmail),
      status: source.status,
      lastPollAt: source.last_poll_at,
      lastSuccessAt: timestamp(
        health.lastSuccessfulPollAt ?? health.lastSyncSuccessAt,
      ),
      lastFailureAt: timestamp(health.lastSyncFailureAt),
      initialScanComplete,
      contextComplete,
      sync: {
        mode:
          progress.mode === "forward" || progress.mode === "backfill"
            ? progress.mode
            : "unknown",
        generation: sync?.generation ?? 0,
        updatedAt: sync?.updated_at ?? null,
      },
      counts: {
        operations: counts?.operations ?? 0,
        contacts: counts?.contacts ?? 0,
        events: counts?.events ?? 0,
        tombstones: counts?.tombstones ?? 0,
        expired: counts?.expired ?? 0,
        archived: counts?.archived ?? 0,
        reviewable: counts?.reviewable ?? 0,
        pendingOperations: counts?.pendingOperations ?? 0,
        operationReadFailures: counts?.operationReadFailures ?? 0,
      },
      message,
    },
  };
}
/** Only bounded, unexpired source ciphertext is decrypted. Never reads credentials. */
async function sourcePayload(
  store: Store,
  tenant: string,
  source: string,
  id: string,
  now: number,
): Promise<SourceRecord | null> {
  const row = await store
    .statement(
      "SELECT CASE WHEN length(envelope)<=? THEN envelope ELSE NULL END AS envelope FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='source' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",
      MAX_ENVELOPE_BYTES,
      tenant,
      source,
      id,
      now,
    )
    .first<{ envelope: string | null }>();
  if (!row) return null;
  if (!row.envelope) throw new ProjectionError("source_review_size_limit");
  const value = await open<SourceRecord>(
    JSON.parse(row.envelope) as Envelope,
    { tenant, connection: source, id, kind: "source", purpose: "storage" },
    store.keys,
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectionError("source_payload_unavailable");
  return value;
}
async function currentTemplate(
  store: Store,
  tenant: string,
  destination: string | undefined,
): Promise<TemplateVersion> {
  if (!destination) return defaultTemplate(store, tenant);
  const saved = await store
    .statement(
      "SELECT t.id,t.config FROM active_templates a JOIN templates t ON t.tenant=a.tenant AND t.destination=a.destination AND t.id=a.version WHERE a.tenant=? AND a.destination=?",
      tenant,
      destination,
    )
    .first<{ id: string; config: string }>();
  if (!saved)
    throw new ReviewError(409, "Save a template for this QRZ logbook first");
  const template = {
    ...JSON.parse(saved.config),
    id: saved.id,
  } as TemplateVersion;
  validateTemplateVersion(template);
  return template;
}
function sourceSummary(raw: SourceRecord): Partial<ReviewContact> {
  const their = record(raw.their);
  const our = record(raw.our);
  const at = timestamp(raw.startAtMillis);
  const stamp =
    at && Number.isFinite(new Date(at).getTime())
      ? new Date(at).toISOString()
      : undefined;
  return {
    ...(display(their.call)
      ? { call: display(their.call)?.toUpperCase() }
      : {}),
    ...(display(our.stationCall ?? raw.stationCall)
      ? {
          stationCall: display(
            our.stationCall ?? raw.stationCall,
          )?.toUpperCase(),
        }
      : {}),
    ...(stamp ? { at: stamp } : {}),
    ...(display(raw.band, 32) ? { band: display(raw.band, 32) } : {}),
    ...(display(raw.mode, 32) ? { mode: display(raw.mode, 32) } : {}),
  };
}
async function recentContact(
  store: Store,
  tenant: string,
  row: Work,
  state: SourceState,
  template: TemplateVersion,
  destination: string | undefined,
  now: number,
): Promise<ReviewContact> {
  const output: ReviewContact = {
    id: row.id,
    sourceId: row.source,
    operationId: row.operation_id,
    state: row.state,
    ...(reason(row.reason) ? { reason: reason(row.reason) } : {}),
    retainedUntil: row.expires_at,
    templateStatus: "unavailable",
  };
  try {
    if (row.deleted) throw new ProjectionError("source_deleted");
    if (row.expires_at <= now)
      throw new ProjectionError("source_payload_expired");
    const raw = await sourcePayload(
      store,
      tenant,
      row.source,
      row.private_id,
      now,
    );
    if (!raw) throw new ProjectionError("source_payload_no_longer_retained");
    if (isSourceDeleted(raw)) throw new ProjectionError("source_deleted");
    if (isEventRecord(raw)) throw new ProjectionError("event_is_not_contact");
    Object.assign(output, sourceSummary(raw));
    if (!state.public.contextComplete)
      throw new ProjectionError("source_context_pending");
    const operationRows = row.operation_id
      ? (
          await store
            .statement(
              "SELECT * FROM source_work WHERE tenant=? AND source=? AND operation_id=? AND (kind='operation' OR is_event=1 AND deleted=0) ORDER BY kind,id LIMIT ?",
              tenant,
              row.source,
              row.operation_id,
              MAX_CONTEXT_RECORDS + 1,
            )
            .all<Work>()
        ).results
      : [];
    if (operationRows.length > MAX_CONTEXT_RECORDS)
      throw new ProjectionError("operation_review_size_limit");
    let operation: SourceRecord | null = null;
    const events: SourceRecord[] = [];
    for (const dependency of operationRows) {
      if (dependency.expires_at <= now)
        throw new ProjectionError("operation_context_expired");
      const value = await sourcePayload(
        store,
        tenant,
        row.source,
        dependency.private_id,
        now,
      );
      if (!value) throw new ProjectionError("operation_context_unavailable");
      if (dependency.kind === "operation") {
        if (dependency.state !== "context")
          throw new ProjectionError("operation_context_pending");
        operation = value;
      } else if (isEventRecord(value)) events.push(value);
    }
    const contact = await projectContact(raw, operation, events, {
      operationComplete: true,
    });
    const stillCurrent = await store
      .statement(
        "SELECT 1 AS current FROM source_work w JOIN cursors c ON c.tenant=w.tenant AND c.connection=w.source AND c.stream='context' WHERE w.tenant=? AND w.source=? AND w.id=? AND w.kind='qso' AND w.private_id=? AND w.revision=? AND w.expires_at>? AND c.generation=? AND json_extract(c.cursor,'$.complete')=1",
        tenant,
        row.source,
        row.id,
        row.private_id,
        row.revision,
        now,
        state.context?.generation ?? -1,
      )
      .first();
    if (!stillCurrent)
      throw new ProjectionError("source_changed_during_review");
    const ledger = destination
      ? await store
          .statement(
            "SELECT narrative,template_version FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=?",
            tenant,
            row.source,
            row.id,
            destination,
          )
          .first<Pick<Ledger, "narrative" | "template_version">>()
      : null;
    const operationName =
      display(contact.context.op.title, 256) ??
      display(contact.context.op.name, 256);
    Object.assign(output, {
      call: contact.call,
      stationCall: contact.stationCall,
      at: new Date(contact.startAtMillis).toISOString(),
      band: contact.band,
      mode: contact.submode ?? contact.mode,
      ...(contact.grid ? { grid: contact.grid } : {}),
      ...(operationName ? { operationName } : {}),
      ownParks: contact.ownParks
        .slice(0, 32)
        .filter((park) => park.length <= 100),
      workedParks: contact.workedParks
        .slice(0, 32)
        .filter((park) => park.length <= 100),
      preview: renderNarrative(template, templateContext(contact, now)),
      templateStatus:
        ledger?.narrative === "remote_preserved"
          ? "remote_preserved"
          : ledger?.template_version
            ? "pinned"
            : "current_preview",
      ...(ledger?.template_version
        ? { pinnedTemplateVersion: ledger.template_version }
        : {}),
    });
  } catch (error) {
    output.reason =
      error instanceof ProjectionError
        ? error.code
        : "source_preview_unavailable";
  }
  return output;
}

/** Read retained intake data only. No vendor calls, leases, stages or writes. */
export async function reviewSource(
  store: Store,
  tenant: string,
  options: {
    source?: string;
    destination?: string;
    limit?: number;
  } = {},
  now = Date.now(),
): Promise<ReviewResponse> {
  const selectedSource = identifier(options.source);
  const selectedDestination = identifier(options.destination);
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new ReviewError(400, "Review limit must be 1–20");
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()))
    throw new ReviewError(400, "Invalid review time");
  if (selectedSource) {
    const connection = await store.connection(tenant, selectedSource);
    if (connection?.kind !== "lofi")
      throw new ReviewError(404, "Source not found");
  }
  let destination: string | undefined;
  if (selectedDestination && selectedDestination !== "account_default") {
    const connection = await store.connection(tenant, selectedDestination);
    if (connection?.kind !== "qrz")
      throw new ReviewError(404, "QRZ logbook not found");
    destination = selectedDestination;
  } else if (!selectedDestination) {
    const active = (
      await store
        .statement(
          "SELECT id FROM connections WHERE tenant=? AND kind='qrz' AND status='active' ORDER BY id LIMIT 2",
          tenant,
        )
        .all<{ id: string }>()
    ).results;
    if (active.length === 1) destination = active[0].id;
  }
  const template = await currentTemplate(store, tenant, destination);
  const rows = (
    await store
      .statement(
        "SELECT id,status,last_poll_at,config FROM connections WHERE tenant=? AND kind='lofi' AND (? IS NULL OR id=?) ORDER BY created_at,id LIMIT 11",
        tenant,
        selectedSource ?? null,
        selectedSource ?? null,
      )
      .all<SourceRow>()
  ).results;
  const states = await Promise.all(
    rows.slice(0, 10).map((source) => sourceState(store, tenant, source, now)),
  );
  const stateBySource = new Map(
    states.map((state) => [state.public.id, state]),
  );
  const sourceIds = [...stateBySource.keys()];
  const contacts = sourceIds.length
    ? (
        await store
          .statement(
            `SELECT * FROM source_work WHERE tenant=? AND source IN(${sourceIds.map(() => "?").join(",")}) AND kind='qso' AND is_event=0 ORDER BY synced_at DESC,id LIMIT ?`,
            tenant,
            ...sourceIds,
            limit,
          )
          .all<Work>()
      ).results
    : [];
  const recentContacts: ReviewContact[] = [];
  for (const row of contacts) {
    const state = stateBySource.get(row.source);
    if (state)
      recentContacts.push(
        await recentContact(
          store,
          tenant,
          row,
          state,
          template,
          destination,
          now,
        ),
      );
  }
  const connections = (
    await store
      .statement(
        "SELECT kind,status,config FROM connections WHERE tenant=? AND status!='revoked'",
        tenant,
      )
      .all<{ kind: string; status: string; config: string }>()
  ).results;
  const readiness: ReviewResponse["readiness"] = providerKinds.map((kind) => {
    const owned = connections.filter((connection) => connection.kind === kind);
    const active = owned.some((connection) => connection.status === "active");
    let status: ReviewResponse["readiness"][number]["status"] = !owned.length
      ? "not_connected"
      : active
        ? "ready"
        : "paused";
    if (kind === "lofi" && active) {
      const activeSources = states.filter(
        (source) => source.public.status === "active",
      );
      if (
        activeSources.some((source) => source.hasError) ||
        activeSources.some(
          (source) =>
            source.public.lastFailureAt &&
            source.public.lastFailureAt > (source.public.lastSuccessAt ?? 0),
        )
      )
        status = "attention";
      else if (
        activeSources.some(
          (source) =>
            !source.public.initialScanComplete ||
            !source.public.contextComplete ||
            source.public.counts.pendingOperations > 0,
        )
      )
        status = "scanning";
    } else if (
      owned.some((connection) => connection.status === "needs_verification")
    )
      status = active ? "ready" : "attention";
    let message =
      kind === "lofi"
        ? status === "not_connected"
          ? "Connect and approve a LoFi account to begin read-only ingestion."
          : "Source counts describe ingestion, not delivery. Retained recent contacts can be reviewed before any destination is connected."
        : status === "not_connected"
          ? `No ${providerName(kind)} destination is connected. Delivery counts remain zero; source review is still available.`
          : "Connected destination metadata can be reviewed. Previewing never enables delivery or proves historical absence.";
    if (kind === "lotw" && status !== "not_connected") {
      const current = owned.filter(
        (connection) =>
          connection.status === "active" ||
          connection.status === "needs_verification",
      );
      const warnings = new Set(
        current.flatMap((connection) =>
          lotwVerification(jsonObject(connection.config), { now })
            .filter(
              (check) => check.status === "warning" || check.status === "error",
            )
            .map((check) => check.message),
        ),
      );
      if (status === "paused") {
        message =
          "The LoTW connection is paused. Resume it before checking delivery readiness.";
      } else {
        const ready = current.every((connection) =>
          lotwReadyForUpload(jsonObject(connection.config), now),
        );
        status = ready ? "ready" : "attention";
        const summary = ready
          ? "LoTW certificate preflight checks passed. LoTW validates the certificate on upload; these checks do not verify upload acceptance."
          : "LoTW needs certificate or login checks before signing. Review the connection checks.";
        message = [summary, ...warnings].join(" ");
      }
    }
    return { kind, status, message };
  });
  return {
    readOnly: true,
    generatedAt: new Date(now).toISOString(),
    retention: { contactsDays: 7, contextDays: 30 },
    sources: states.map((state) => state.public),
    sourcesTruncated: rows.length > 10,
    readiness,
    template: {
      scope: destination ? "destination" : "account_default",
      ...(destination ? { destinationId: destination } : {}),
      version: template.id,
      notice: PREVIEW_NOTICE,
    },
    recentContacts,
  };
}

export async function reviewRoute(
  request: Request,
  store: Store,
  tenant: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/review") return null;
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "GET")
    return Response.json(
      { error: "Review is read only" },
      { status: 405, headers },
    );
  try {
    const limit = url.searchParams.get("limit");
    if (limit !== null && !/^\d{1,2}$/.test(limit))
      throw new ReviewError(400, "Review limit must be 1–20");
    return Response.json(
      await reviewSource(store, tenant, {
        ...(url.searchParams.has("source")
          ? { source: url.searchParams.get("source") ?? "" }
          : {}),
        ...(url.searchParams.has("destination")
          ? { destination: url.searchParams.get("destination") ?? "" }
          : {}),
        ...(limit === null ? {} : { limit: Number(limit) }),
      }),
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ReviewError
            ? error.message
            : "Review is temporarily unavailable",
      },
      { status: error instanceof ReviewError ? error.status : 503, headers },
    );
  }
}
