import type { AdifRecord } from "./adif.ts";
import type { Contact } from "./projection.ts";
import type { buildSignedTq8, LotwContact, LotwStation } from "./signing.ts";
import type {
  Connection,
  Lease,
  Ledger,
  LedgerKey,
  LotwIdentityEvidence,
  RemoteIdentityEvidence,
  Store,
} from "./store.ts";
import type { VendorPriority } from "./vendor-requests.ts";

export interface DeliveryGates {
  exportsEnabled: boolean;
  liveWriteAuthorized: boolean;
  sourceBoundaryVerified: boolean;
  allowedQsoIds?: string[] | null;
}
export interface DeliveryDependencies {
  fetcher?: typeof fetch;
  now?: number;
  sign?: typeof buildSignedTq8;
  priority?: VendorPriority;
  clublogApiKey?: string;
}
interface PayloadBase {
  projectionHash: string;
  members: { id: string; generation: string }[];
  preparedAt: string;
}
export interface QrzPayload extends PayloadBase {
  kind: "qrz";
  record: AdifRecord;
  operation: "insert" | "replace";
  mappedLogId: string | null;
  narrative: "remote_preserved" | "template_bound";
  priorIdentityEvidenceId?: string;
}
export interface LotwPayload extends PayloadBase {
  kind: "lotw";
  tq8: string;
  station: LotwStation;
  contact: LotwContact;
  certificateVersion: string;
  configurationVersion: string;
}
export interface ClublogPayload extends PayloadBase {
  kind: "clublog";
  record: AdifRecord;
  remoteId: string;
  previousRemoteId: string | null;
  retainedRemoteIds: string[];
  mode: "live" | "background";
}
export type PreparedPayload = QrzPayload | LotwPayload | ClublogPayload;
export interface DeliveryResult {
  state:
    | "prepared"
    | "skipped"
    | "blocked"
    | "delivered"
    | "submitted"
    | "observed"
    | "uncertain"
    | "rejected"
    | "unresolved"
    | "retry_scheduled";
  reason?: string;
  attemptId?: string;
}
export interface AttemptRow {
  id: string;
  source: string;
  qso: string;
  destination: string;
  generation: string;
  payload_id: string;
  credential_version: string;
}
export interface AttemptData {
  attempt: AttemptRow;
  connection: Connection;
  payload: PreparedPayload;
}
export interface PrepareContext {
  store: Store;
  key: LedgerKey;
  contact: Contact;
  row: Ledger;
  connection: Connection & { credential_version: string };
  gates: DeliveryGates;
  deps: DeliveryDependencies;
  now: number;
}
export type Preparation =
  | DeliveryResult
  | {
      state: "ready";
      payload: PreparedPayload;
      template?: string | null;
      lotwIdentityId?: string;
      notice?: string;
      priorIdentity?: RemoteIdentityEvidence;
    };
export interface DispatchContext {
  store: Store;
  tenant: string;
  id: string;
  data: AttemptData;
  lease: Lease;
  gates: DeliveryGates;
  deps: DeliveryDependencies;
  beforeWrite: () => Promise<boolean>;
  hasStarted: () => boolean;
}
export interface DispatchOutcome {
  state:
    | "delivered"
    | "submitted"
    | "uncertain"
    | "rejected"
    | "retry_scheduled";
  remoteId?: string | null;
  reason?: string;
  attemptId?: string;
}
export interface ObserveContext {
  store: Store;
  tenant: string;
  data: AttemptData;
  deps: DeliveryDependencies;
}
export interface Observation {
  confirmed: boolean;
  data: unknown;
  identity?: LotwIdentityEvidence;
}
export type ObserveOutcome =
  | { state: "observed"; remoteId: string | null; observation?: Observation }
  | { state: "unresolved"; reason: string };
export interface DeliveryAdapter {
  prepare(context: PrepareContext): Promise<Preparation>;
  dispatch(context: DispatchContext): Promise<DispatchOutcome>;
  observe(context: ObserveContext): Promise<ObserveOutcome>;
  identityEvidence?(payload: PreparedPayload): Promise<LotwIdentityEvidence>;
  /** Intended identity reservation; it is not evidence of remote acceptance. */
  reservationId?(payload: PreparedPayload): string;
  afterResolved?(
    context: ObserveContext,
    state: string,
    remoteId: string | null,
  ): Promise<void>;
}
