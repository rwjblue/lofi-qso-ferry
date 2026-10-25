import { LotwLoginError } from "./lotw.ts";
import { QrzError } from "./qrz.ts";
import { VendorDeferredError } from "./vendor-requests.ts";

export type FailureStage =
  | "observation"
  | "projection"
  | "history_read"
  | "history_group"
  | "reconciliation"
  | "preparation"
  | "contact"
  | "source_poll"
  | "source_rescan"
  | "context"
  | "source_proof"
  | "source_cycle"
  | "scheduler";
export type FailureVendor = "lofi" | "qrz" | "lotw" | "none";
export interface FailureCount {
  events: number;
  affected: number;
}
export interface FailureDiagnostics {
  counts: Record<string, FailureCount>;
  record(
    error: unknown,
    stage: FailureStage,
    vendor?: FailureVendor,
    affected?: number,
  ): void;
}

const stages = new Set<FailureStage>([
  "observation",
  "projection",
  "history_read",
  "history_group",
  "reconciliation",
  "preparation",
  "contact",
  "source_poll",
  "source_rescan",
  "context",
  "source_proof",
  "source_cycle",
  "scheduler",
]);
const vendors = new Set<FailureVendor>(["lofi", "qrz", "lotw", "none"]);
const qrzDetails = new Map([
  ["Invalid QRZ ADIF entity encoding", "qrz_entity_encoding"],
  ["Invalid QRZ response framing", "qrz_response_framing"],
  ["Duplicate QRZ response parameter", "qrz_duplicate_parameter"],
  ["Invalid QRZ form encoding", "qrz_form_encoding"],
  ["Missing QRZ result", "qrz_missing_result"],
  ["QRZ response exceeds 2 MiB", "qrz_response_bound"],
  ["QRZ response body could not be read", "qrz_response_body_unreadable"],
  ["Invalid QRZ response UTF-8", "qrz_response_utf8"],
  [
    "Invalid QRZ response; mutation outcome must be reconciled",
    "qrz_response_invalid",
  ],
  ["Invalid QRZ page bounds", "qrz_page_bounds"],
  ["Invalid QRZ filter", "qrz_filter_invalid"],
  ["Invalid QRZ LOGIDs", "qrz_logids_invalid"],
  ["Missing QRZ inventory count", "qrz_missing_count"],
  ["Inconsistent QRZ inventory framing", "qrz_inventory_framing"],
  ["Invalid or repeated QRZ LOGID", "qrz_logid_invalid_or_repeated"],
  ["QRZ cursor did not advance", "qrz_cursor_stalled"],
  ["Invalid QRZ date", "qrz_date_invalid"],
  ["Missing precise ADIF date/time", "adif_time_missing"],
  ["Invalid ADIF date/time", "adif_time_invalid"],
]);
const internalMessages = new Map([
  [
    "invalid_source_export_snapshot_request",
    "invalid_source_export_snapshot_request",
  ],
  [
    "invalid_source_export_proof_expiry_cap",
    "invalid_source_export_proof_expiry_cap",
  ],
  [
    "invalid_source_export_proof_request",
    "invalid_source_export_proof_request",
  ],
  ["source_export_proof_lease_scope", "source_export_proof_lease_scope"],
  [
    "source_export_proof_snapshot_unavailable",
    "source_export_proof_snapshot_unavailable",
  ],
  ["duplicate_source_export_dependency", "duplicate_source_export_dependency"],
  ["source_export_positive_unavailable", "source_export_positive_unavailable"],
  [
    "source_export_dependency_set_invalid",
    "source_export_dependency_set_invalid",
  ],
  ["source_export_positive_expired", "source_export_positive_expired"],
  ["source_export_dependency_limit", "source_export_dependency_limit"],
  [
    "source_export_proof_admission_deadline",
    "source_export_proof_admission_deadline",
  ],
  [
    "source_export_proof_admission_unavailable",
    "source_export_proof_admission_unavailable",
  ],
  [
    "source_export_proof_admission_expired",
    "source_export_proof_admission_expired",
  ],
  [
    "source_export_proof_clock_unavailable",
    "source_export_proof_clock_unavailable",
  ],
  [
    "source_export_proof_result_mismatch",
    "source_export_proof_result_mismatch",
  ],

  ["Invalid history coverage manifest", "history_manifest_invalid"],
  [
    "History destination credentials are unavailable",
    "history_credentials_unavailable",
  ],
  ["History response does not match partition scope", "history_scope_mismatch"],
  [
    "History response is missing required identity fields",
    "history_identity_missing",
  ],
  ["History response is missing station callsign", "history_station_missing"],
  [
    "History response station does not match partition",
    "history_station_mismatch",
  ],
  [
    "History response date is outside partition",
    "history_date_outside_partition",
  ],
  ["History field exceeds retained evidence bound", "history_field_bound"],
  ["History record exceeds retained evidence bound", "history_record_bound"],
  [
    "History partition exceeds retained evidence bound",
    "history_partition_bound",
  ],
  ["History cache exceeds retained evidence bound", "history_cache_bound"],
  ["History partition changed during save", "history_save_changed"],
  ["Invalid retained history page", "history_page_invalid"],
  ["History inventory batch exceeds twenty contacts", "history_batch_bound"],
  ["History inventory batch mixes read scopes", "history_batch_scope"],
  [
    "Vendor response exceeds bounded partition; split the date range",
    "vendor_response_bound",
  ],
  ["Incomplete or non-ADIF LoTW report", "lotw_report_incomplete"],
  [
    "LoTW report count or program identity mismatch",
    "lotw_report_count_or_identity",
  ],
  [
    "LoTW report is missing required identity/confirmation fields",
    "lotw_report_fields_missing",
  ],
  [
    "LoTW report has invalid identity/confirmation fields",
    "lotw_report_fields_invalid",
  ],
  [
    "LoTW report does not match the requested scope",
    "lotw_report_scope_mismatch",
  ],
  ["Invalid LoTW query callsign", "lotw_query_callsign_invalid"],
  ["Invalid LoTW receive checkpoint", "lotw_checkpoint_invalid"],
  [
    "LoTW query credentials are not configured",
    "lotw_query_credentials_missing",
  ],
  [
    "LoTW query requires a date partition of at most 32 inclusive days",
    "lotw_partition_invalid",
  ],
  [
    "LoTW query transport failed; coverage remains incomplete",
    "lotw_transport",
  ],
  ["LoTW query unavailable; coverage remains incomplete", "lotw_unavailable"],
  ["ADIF document too large", "adif_document_bound"],
  ["Malformed ADIF tag", "adif_tag_invalid"],
  ["Unexpected ADIF header", "adif_header_unexpected"],
  ["Empty ADIF record", "adif_record_empty"],
  ["Too many ADIF records", "adif_record_count_bound"],
  ["Malformed ADIF field", "adif_field_invalid"],
  ["Truncated or excessive ADIF field", "adif_field_truncated_or_bound"],
  ["Not ADIF", "adif_invalid"],
  ["Unterminated ADIF record", "adif_record_unterminated"],
  ["Invalid ADIF field name", "adif_field_name_invalid"],
  ["ADIF record exceeds 64 KiB", "adif_record_bound"],
  ["source_connection_unavailable", "source_connection_unavailable"],
  ["operation_context_expired", "operation_context_expired"],
  ["operation_context_unavailable", "operation_context_unavailable"],
  ["source_payload_expired", "source_payload_expired"],
  ["operation_payload_unavailable", "operation_payload_unavailable"],
  ["observation_batch_exceeds_20_contacts", "observation_batch_bound"],
  ["duplicate_observation_contact", "observation_duplicate"],
  ["contact_observation_exceeds_100_statements", "observation_statement_bound"],
  ["invalid_destination_scope", "destination_scope_invalid"],
  ["reconciliation_batch_too_large", "reconciliation_batch_bound"],
  ["invalid_reconciliation_scope", "reconciliation_scope_invalid"],
  ["duplicate_reconciliation_route", "reconciliation_route_duplicate"],
  ["unsupported envelope/key version", "envelope_version_unsupported"],
]);
const databaseGuards = new Map([
  ["history lease lost", "history_lease_lost"],
  ["history partition changed", "history_partition_changed"],
  ["history account inactive", "history_account_inactive"],
  ["history connection changed", "history_connection_changed"],
  ["history source changed", "history_source_changed"],
  ["history retention capacity changed", "history_capacity_changed"],
  ["source connection inactive", "source_connection_inactive"],
  ["source context changed", "source_context_changed"],
  ["operation context unavailable", "operation_context_unavailable"],
  ["source connection changed", "source_connection_changed"],
  ["source row changed", "source_row_changed"],
  ["lease lost", "lease_lost"],
  ["cursor changed", "cursor_changed"],
  ["source historical index publication stale", "source_index_stale"],
  ["LoTW ownership unavailable", "lotw_ownership_unavailable"],
  ["LoTW ownership changed", "lotw_ownership_changed"],
  ["LoTW ownership mapping unavailable", "lotw_mapping_unavailable"],
  ["LoTW ownership mapping changed", "lotw_mapping_changed"],
  [
    "LoTW historical ownership unavailable",
    "lotw_history_ownership_unavailable",
  ],
  ["LoTW historical source changed", "lotw_history_source_changed"],
  ["LoTW historical publication changed", "lotw_history_publication_changed"],
  ["LoTW historical prior delivery", "lotw_history_prior_delivery"],
]);

// Fixed documented provider messages only. These are diagnostic categories, not
// retry advice; a failed write can have an unknown committed outcome.
const databaseProviderFailures = new Map([
  ["D1 DB reset because its code was updated.", "db_reset"],
  [
    "Internal error while starting up D1 DB storage caused object to be reset.",
    "db_reset",
  ],
  ["Internal error in D1 DB storage caused object to be reset.", "db_reset"],
  ["Network connection lost.", "db_connection_lost"],
  ["Replica disconnected from primary.", "db_connection_lost"],
  [
    "Cannot resolve D1 DB due to transient issue on remote node.",
    "db_remote_unavailable",
  ],
  [
    "Can't read from request stream because client disconnected.",
    "db_request_disconnected",
  ],
  [
    "D1 DB storage operation exceeded timeout which caused object to be reset.",
    "db_storage_timeout",
  ],
  ["D1 DB is overloaded. Requests queued for too long.", "db_queue_timeout"],
  ["D1 DB is overloaded. Too many requests queued.", "db_queue_full"],
  [
    "D1 DB's isolate exceeded its memory limit and was reset.",
    "db_memory_limit",
  ],
  ["D1 DB exceeded its CPU time limit and was reset.", "db_cpu_limit"],
]);
const invocationLimit = "Too many API requests by single Worker invocation";

/** Read only bounded own strings; never inspect names, stacks or nested causes. */
function ownString(error: object, key: string, limit = 512): string {
  const value: unknown = Object.getOwnPropertyDescriptor(error, key)?.value;
  return typeof value === "string" && value.length <= limit ? value : "";
}
function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const message = ownString(error, "message");
  if (error instanceof VendorDeferredError)
    return Object.getOwnPropertyDescriptor(error, "requestSent")?.value === true
      ? "vendor_response_deferred"
      : "vendor_budget_deferred";
  if (error instanceof QrzError) {
    const kind = ownString(error, "kind");
    if (kind === "protocol") return qrzDetails.get(message) ?? "qrz_protocol";
    switch (kind) {
      case "auth":
        return "qrz_auth";
      case "rejected":
        return ownString(error, "detail") === "ambiguous_empty_selection"
          ? "qrz_ambiguous_empty_selection"
          : "qrz_rejected";
      case "transient":
        return "qrz_transient";
      case "uncertain":
        return "qrz_uncertain";
      case "blocked":
        return "qrz_blocked";
      default:
        return "unknown";
    }
  }
  if (error instanceof LotwLoginError) {
    switch (ownString(error, "reason")) {
      case "credentials":
        return "lotw_credentials";
      case "unavailable":
        return "lotw_login_unavailable";
      default:
        return "unknown";
    }
  }
  const exact = internalMessages.get(message);
  if (exact) return exact;
  if (message === invocationLimit || message === `${invocationLimit}.`)
    return "db_invocation_limit";
  // D1 may append query context. Match only fixed prefixes of bounded text and
  // never retain the remainder, which can contain SQL or private bound values.
  const raw: unknown = Object.getOwnPropertyDescriptor(error, "message")?.value;
  const prefix = typeof raw === "string" ? raw.slice(0, 160) : "";
  if (prefix.startsWith("D1_ERROR: ")) {
    const detail = prefix.slice(10);
    for (const [guard, code] of databaseGuards)
      if (detail === guard || detail.startsWith(`${guard}:`)) return code;
    for (const [known, code] of databaseProviderFailures)
      if (detail === known || detail.startsWith(`${known}:`)) return code;
    if (detail === invocationLimit || detail === `${invocationLimit}.`)
      return "db_invocation_limit";
    for (const constraint of ["CHECK", "UNIQUE", "NOT NULL", "FOREIGN KEY"])
      if (
        detail === `${constraint} constraint failed` ||
        detail.startsWith(`${constraint} constraint failed:`)
      )
        return "db_constraint";
    if (detail.startsWith("too many SQL variables")) return "db_bind_limit";
    if (detail.startsWith("Expression tree is too large"))
      return "db_expression_limit";
    if (detail.startsWith("too many SQL queries")) return "db_query_limit";
    return "db_d1";
  }
  if (prefix.startsWith("D1_EXEC_ERROR:")) return "db_execution";
  if (prefix.startsWith("D1_TYPE_ERROR:")) return "db_bind_type";
  if (prefix.startsWith("D1_COLUMN_NOTFOUND")) return "db_column_missing";
  return "unknown";
}

/** Invocation-local aggregate telemetry. Its keys and values contain no error text. */
export function createFailureDiagnostics(): FailureDiagnostics {
  const counts: Record<string, FailureCount> = Object.create(null);
  const seen = new WeakMap<object, Set<string>>();
  return {
    counts,
    record(error, stage, vendor = "none", affected = 1) {
      if (!stages.has(stage) || !Number.isFinite(affected) || affected < 1)
        return;
      const increment = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(affected));
      let code = "unknown";
      try {
        code = failureCode(error);
      } catch {
        /* Diagnostics cannot fail work. */
      }
      const key = `${stage}:${vendors.has(vendor) ? vendor : "none"}:${code}`;
      counts[key] ??= { events: 0, affected: 0 };
      const count = counts[key];
      const object =
        (typeof error === "object" && error !== null) ||
        typeof error === "function";
      const keys = object ? seen.get(error) : undefined;
      if (!keys?.has(key)) {
        count.events = Math.min(Number.MAX_SAFE_INTEGER, count.events + 1);
        if (object) {
          const updated = keys ?? new Set<string>();
          updated.add(key);
          seen.set(error, updated);
        }
      }
      count.affected = Math.min(
        Number.MAX_SAFE_INTEGER,
        count.affected + increment,
      );
    },
  };
}
