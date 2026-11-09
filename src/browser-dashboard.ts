export const vendorKinds = ["lofi", "qrz", "lotw"] as const;
export type VendorKind = (typeof vendorKinds)[number];

export interface LotwVerificationCheck {
  id: "login" | "certificate" | "certificate_status";
  status: "ok" | "warning" | "error" | "unknown";
  message: string;
  checkedAt?: string;
}

export interface ConnectionSummary {
  id: string;
  kind: string;
  label: string;
  status: string;
  last_error?: string | null;
  last_poll_at: number | null;
  lotwVerification?: LotwVerificationCheck[];
}

export function vendorName(kind: string): string {
  return { lofi: "LoFi", qrz: "QRZ Logbook", lotw: "LoTW" }[kind] ?? kind;
}

const inventoryLabels: Record<string, string> = {
  adopted_existing: "Adopted history",
  absent_at_inventory: "Missing in scanned history",
  ambiguous: "Multiple possible matches",
  awaiting_readback: "Awaiting receipt verification",
  awaiting_review: "Waiting for delivery review",
  cancelled: "Cancelled before send",
  catchup: "Checking for changes",
  collecting: "Reading contacts",
  delivered: "Accepted by QRZ",
  excluded: "Excluded",
  forward_baseline_pending: "Waiting for a verified LoFi baseline",
  forward_birth_pending: "Waiting for the LoFi read to finish",
  forward_check: "New contact · final destination check required",
  forward_destination_candidate: "Possible existing destination contact",
  held: "On hold",
  historical_exact_identity_unavailable: "Exact contact identity unavailable",
  historical_grid_changed: "LoFi grid changed after this contact was matched",
  lotw_grid_update_attention: "Grid update needs attention",
  lotw_grid_update_deferred: "Grid update on hold",
  lotw_grid_update_observed: "Grid update verified",
  lotw_grid_update_submitted: "Grid update submitted",
  lotw_grid_update_uncertain: "Grid update awaiting readback",
  historical_remote_time_precision:
    "Destination time is recorded to the minute",
  historical_source_location_unavailable: "LoFi station location unavailable",
  incomplete: "Waiting for comparison evidence",
  matched_existing: "Matched existing",
  observed: "Receipt verified",
  out_of_scope: "Outside sync scope",
  partial: "Partial coverage",
  prepared: "Prepared",
  projection_mismatch: "Operating details differ",
  publishing: "Publishing coverage",
  quarantining: "Checking scan membership",
  queued: "Queued",
  readback_held: "Receipt verification needs attention",
  ready: "Verified coverage",
  rejected: "Provider rejected submission",
  send_held: "Send on hold",
  source_proof_required: "Waiting for fresh source verification",
  stale: "Coverage needs refresh",
  submitted: "Submitted to LoTW",
  sync_scope_changed: "Sync scope changed",
  waiting: "Waiting",
};

const historicalFieldLabels: Record<string, string> = {
  freq: "Transmit frequency",
  freq_rx: "Receive frequency",
  my_gridsquare: "Station grid",
  my_state: "Station state or province",
  my_cnty: "Station county",
  my_dxcc: "Station DXCC entity",
  my_lat: "Station latitude",
  my_lon: "Station longitude",
  my_cq_zone: "Station CQ zone",
  my_itu_zone: "Station ITU zone",
  my_iota: "Station IOTA reference",
};

export function inventoryStatusLabel(state: string): string {
  const label = inventoryLabels[state];
  if (label) return label;
  const historical = /^historical_([a-z_]+)_(differs|unavailable)$/.exec(state);
  const field = historical && historicalFieldLabels[historical[1]];
  return field ? `${field} ${historical[2]}` : state.replaceAll("_", " ");
}

export function connectionGroups(connections: ConnectionSummary[]) {
  return vendorKinds.map((kind) => ({
    kind,
    current: connections.filter(
      (connection) =>
        connection.kind === kind && connection.status !== "revoked",
    ),
    previous: connections.filter(
      (connection) =>
        connection.kind === kind && connection.status === "revoked",
    ),
  }));
}

export function connectionStatus(status: string): string {
  return (
    {
      active: "Connected",
      approval_pending: "Approval pending",
      disabled: "Paused",
      paused: "Paused",
      revoked: "Credentials removed",
      needs_verification: "Verification needed",
    }[status] ?? status.replaceAll("_", " ")
  );
}
