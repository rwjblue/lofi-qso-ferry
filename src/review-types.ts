/** Public data only: safe to import from the browser without Worker types. */
export interface ReviewSource {
  id: string;
  label: string;
  status: string;
  /** Last scheduler attempt, including unsuccessful attempts. */
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  initialScanComplete: boolean;
  contextComplete: boolean;
  sync: {
    mode: "backfill" | "forward" | "unknown";
    generation: number;
    updatedAt: number | null;
  };
  counts: {
    operations: number;
    contacts: number;
    events: number;
    tombstones: number;
    expired: number;
    archived: number;
    reviewable: number;
    pendingOperations: number;
    operationReadFailures: number;
  };
  message: string;
}
export interface ReviewContact {
  id: string;
  sourceId: string;
  operationId: string | null;
  call?: string;
  stationCall?: string;
  at?: string;
  band?: string;
  mode?: string;
  grid?: string;
  operationName?: string;
  ownParks?: string[];
  workedParks?: string[];
  state: string;
  reason?: string;
  retainedUntil: number;
  preview?: Partial<Record<"COMMENT" | "NOTES" | "QSLMSG", string>>;
  templateStatus:
    | "current_preview"
    | "pinned"
    | "remote_preserved"
    | "unavailable";
  pinnedTemplateVersion?: string;
}
export interface ReviewResponse {
  readOnly: true;
  generatedAt: string;
  retention: { contactsDays: 7; contextDays: 30 };
  sources: ReviewSource[];
  sourcesTruncated: boolean;
  readiness: {
    kind: "lofi" | "qrz" | "lotw";
    status: "ready" | "not_connected" | "scanning" | "attention" | "paused";
    message: string;
  }[];
  template: {
    scope: "account_default" | "destination";
    destinationId?: string;
    version: string;
    notice: string;
  };
  recentContacts: ReviewContact[];
}
