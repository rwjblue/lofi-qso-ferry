export const vendorKinds = ["lofi", "qrz", "lotw"] as const;
export type VendorKind = (typeof vendorKinds)[number];

export interface ConnectionSummary {
  id: string;
  kind: string;
  label: string;
  status: string;
  last_error?: string | null;
  last_poll_at: number | null;
}

export function vendorName(kind: string): string {
  return { lofi: "LoFi", qrz: "QRZ Logbook", lotw: "LoTW" }[kind] ?? kind;
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

export function ledgerEmptyMessage(connections: ConnectionSummary[]): string {
  const current = connections.filter(
    (connection) => connection.status !== "revoked",
  );
  if (!current.some((connection) => connection.kind === "lofi"))
    return "No delivery activity yet. Connect LoFi to review your source contacts.";
  if (!current.some((connection) => connection.kind !== "lofi"))
    return "No delivery activity yet. Your LoFi contacts appear in read-only review; connect QRZ or LoTW to begin destination history adoption.";
  return "No delivery activity yet. Check source progress and destination readiness in read-only review. Delivery counts begin when contacts are reconciled with a destination.";
}

export function previewStatus(status: string): string {
  return (
    {
      current_preview: "Current template preview",
      pinned: "Current preview · export uses pinned version",
      remote_preserved: "Current preview · existing QRZ text preserved",
      unavailable: "Preview unavailable",
    }[status] ?? "Preview unavailable"
  );
}
