import {
  structuredContactAdif,
  contactIsTest as testContact,
} from "./contact-adif.ts";
import { type DeliveryGates, deliveryMode } from "./delivery-gates.ts";
import {
  decodeTemplate,
  type QrzConfig,
  routedQrz,
  templateContext,
} from "./qrz-delivery-input.ts";

export { contactAdif, contactReconciliationAdif } from "./contact-adif.ts";

import {
  type AdifRecord,
  normalizeAdifValue,
  serializeAdifRecord,
} from "./adif.ts";
import {
  type DispatchWork,
  deliveryWorkKey,
  loadDispatchWork,
  loadPreparationWork,
  type PreparationWork,
} from "./delivery-work.ts";
import { historyCoveringRange } from "./history-inventory.ts";
import {
  availableIdentityClaim,
  claimedAttemptChecks,
  claimedAttemptCurrent,
  destinationIdentityClaim,
} from "./identity-claims.ts";
import { type IntakeContact, pendingContacts } from "./intake.ts";
import { LotwClient, observeLotwContact } from "./lotw.ts";
import {
  certificateCurrentlyValid,
  type LotwConfig,
  type LotwCredential,
  lotwAttemptIdentity,
  lotwDeliveryInput,
  lotwProjectionHash,
  lotwSigningCertificate,
} from "./lotw-delivery-input.ts";
import { checkLotwFirstInsertHistory } from "./lotw-first-insert.ts";
import {
  attemptLotwOwnershipCurrent,
  LotwOwnershipUnavailable,
  lotwOwnershipAvailable,
  renewAttemptLotwOwnership,
} from "./lotw-ownership-bridge.ts";
import { type Contact, isTestCallsign } from "./projection.ts";
import {
  mergeQrzCorrection,
  QrzClient,
  type QrzCoveringRead,
  QrzError,
  type QrzOptions,
  sameQrzIdentity,
} from "./qrz.ts";
import { type QrzPlanningAllowance, qrzPlanningFetch } from "./qrz-planning.ts";
import { comparableRemote, reconcileQrzAttempt } from "./reconcile.ts";
import {
  b64,
  canonical,
  type Envelope,
  open,
  randomToken,
  sha256,
  unb64,
} from "./security.ts";
import {
  buildSignedTq8,
  canonicalSigningData,
  type LotwContact,
  type LotwStation,
  SIGNING_CONFIGURATION,
} from "./signing.ts";
import {
  attemptSourceExportProofCurrent,
  attemptSourceExportProofGuard,
  loadCurrentSourceExportProof,
  lotwFreshInsertCurrent,
  qrzFreshInsertCurrent,
  qrzFreshInsertEligibleGuard,
  type SourceExportAuthorization,
  type SourceExportAuthorizationMode,
} from "./source-export-proofs.ts";
import {
  type Connection,
  type Lease,
  type Ledger,
  type LedgerKey,
  LOTW_PRIOR_IDENTITY_NOTICE,
  type LotwIdentityEvidence,
  type StageInput,
  type Store,
} from "./store.ts";
import { renderNarrative, type TemplateVersion } from "./templates.ts";
import {
  type VendorAdmission,
  VendorDeferredError,
  type VendorPriority,
  vendorFetch,
} from "./vendor-requests.ts";

export { type DeliveryGates, deliveryMode } from "./delivery-gates.ts";
export interface DeliveryDependencies {
  fetcher?: typeof fetch;
  now?: number;
  sign?: typeof buildSignedTq8;
  priority?: VendorPriority;
  /** Scheduler projection already fenced by observeContact in this turn. */
  sourceContact?: Pick<
    IntakeContact,
    "id" | "generation" | "contextGeneration"
  >;
  /** Immutable, current evidence from the post-collection canonical drain. */
  sourceProof?: SourceExportAuthorization;
  /** Single-use empty scan from this source turn; never valid for dispatch. */
  qrzEmptyObservation?: QrzEmptyObservation;
  /** Invocation-local planning reads only; dispatch and recovery never consume it. */
  qrzPlanning?: QrzPlanningAllowance;
  /** Scheduler capacity only; cannot authorize or extend any export proof. */
  preparationAllowed?: () => boolean;
}
/** An injected test origin cannot freeze expiry while asynchronous work runs. */
function deliveryClock(origin?: number): () => number {
  const started = Date.now();
  const base = origin ?? started;
  let latest = base;
  return () => {
    latest = Math.max(latest, base + Math.max(0, Date.now() - started));
    return latest;
  };
}
class UnsentAuthorizationError extends Error {
  constructor() {
    super("Authorization changed before mutation transport");
  }
}
interface QrzCredential {
  apiKey: string;
}
interface QrzCredentialSnapshot {
  source_envelope: string;
  source_created_at: number;
  source_expires_at: number | null;
  destination_envelope: string;
  destination_created_at: number;
  destination_expires_at: number | null;
}
interface Member {
  id: string;
  generation: string;
}
export type PreparedPayload =
  | {
      kind: "qrz";
      record: AdifRecord;
      operation: "insert" | "replace";
      mappedLogId: string | null;
      narrative: "remote_preserved" | "template_bound";
      projectionHash: string;
      members: Member[];
      preparedAt: string;
      priorIdentityEvidenceId?: string;
    }
  | {
      kind: "lotw";
      tq8: string;
      station: LotwStation;
      contact: LotwContact;
      members: Member[];
      certificateVersion: string;
      configurationVersion: string;
      projectionHash: string;
      preparedAt: string;
    };
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
function modeEnabled(
  gates: DeliveryGates,
  mode: SourceExportAuthorizationMode,
): boolean {
  return (
    gates.exportsEnabled &&
    gates.liveWriteAuthorized &&
    (mode === "source_boundary"
      ? gates.sourceBoundaryVerified
      : mode === "qrz_fresh_insert"
        ? gates.qrzFreshInsertsEnabled === true
        : mode === "lotw_fresh_insert" &&
          gates.lotwFreshInsertsEnabled === true)
  );
}
function scoped(
  gates: DeliveryGates,
  key: LedgerKey,
  requireDefined = false,
): boolean {
  return (
    (!requireDefined ||
      (gates.allowedQsoIds !== undefined &&
        gates.allowedDestinationIds !== undefined)) &&
    (!gates.allowedQsoIds || gates.allowedQsoIds.includes(key.qso)) &&
    (!gates.allowedDestinationIds ||
      gates.allowedDestinationIds.includes(key.destination))
  );
}
function freshInsertPayload(
  payload: PreparedPayload,
  mode: SourceExportAuthorizationMode,
  key: LedgerKey,
  generation: string,
): boolean {
  if (mode === "source_boundary") return true;
  if (mode === "qrz_fresh_insert")
    return (
      payload.kind === "qrz" &&
      payload.operation === "insert" &&
      payload.mappedLogId === null &&
      payload.priorIdentityEvidenceId === undefined
    );
  return (
    payload.kind === "lotw" &&
    payload.contact.id === key.qso &&
    payload.contact.generation === generation &&
    payload.members.length === 1 &&
    payload.members[0].id === key.qso &&
    payload.members[0].generation === payload.contact.generation
  );
}
function freshInsertUnavailable(mode: SourceExportAuthorizationMode): string {
  return mode === "lotw_fresh_insert"
    ? "lotw_fresh_insert_unavailable"
    : "qrz_fresh_insert_unavailable";
}
/** Recheck retained source even for an upload prepared by an older version. */
async function sourceExportContext(
  store: Store,
  key: LedgerKey,
  now: number,
  observed?: DeliveryDependencies["sourceContact"],
): Promise<number | null | undefined> {
  const ledger = await store.ledger(key);
  if (!ledger) return undefined;
  // Legacy/directly staged records have no retained intake context. Their
  // immutable station call is still checked at the dispatch boundary below.
  if (ledger.context_generation == null) return null;
  if (
    observed?.id === key.qso &&
    observed.generation === ledger.generation &&
    observed.contextGeneration === ledger.context_generation
  )
    return observed.contextGeneration;
  const source = await store.connection(key.tenant, key.source);
  if (source?.status !== "active") return undefined;
  const [current] = await pendingContacts(
    store,
    source,
    1,
    now,
    undefined,
    key.qso,
  );
  return current !== undefined &&
    current.generation === ledger.generation &&
    current.contextGeneration === ledger.context_generation
    ? current.contextGeneration
    : undefined;
}

async function sourceContextUnchanged(
  store: Store,
  key: LedgerKey,
  generation: number | null,
  now: number,
): Promise<boolean> {
  const check = sourceContextCheck(store, key, generation, now);
  if (!check) return true;
  return Boolean(await check.first());
}

function sourceContextCheck(
  store: Store,
  key: LedgerKey,
  generation: number | null,
  now: number,
): D1PreparedStatement | null {
  if (generation === null) return null;
  return store.statement(
    "SELECT 1 current FROM ledger l JOIN cursors c ON c.tenant=l.tenant AND c.connection=l.source AND c.stream='context' JOIN source_work w ON w.tenant=l.tenant AND w.source=l.source AND w.id=l.qso AND w.kind='qso' WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=? AND l.context_generation=? AND c.generation=? AND json_extract(c.cursor,'$.complete')=1 AND w.state IN('pending','waiting') AND w.expires_at>?",
    key.tenant,
    key.source,
    key.qso,
    key.destination,
    generation,
    generation,
    now,
  );
}
/** Read authorization only; it cannot replace the final immutable-attempt fence. */
export function qrzNeighborhoodFallback(
  store: Store,
  source: Connection | null | undefined,
  destination: Connection,
  fixedNow?: number | (() => number),
): NonNullable<QrzOptions["neighborhoodFallback"]> {
  const config = JSON.parse(destination.config) as QrzConfig;
  const currentTime =
    typeof fixedNow === "function" ? fixedNow : deliveryClock(fixedNow);
  return {
    book: {
      bookId: config.bookId ?? "",
      stationCallsign: config.stationCallsign,
      startDate: config.startDate,
      endDate: config.endDate,
    },
    now: currentTime,
    selectCover: async (record, target) =>
      source
        ? historyCoveringRange(
            store,
            { source, destination, record },
            target,
            currentTime(),
          )
        : null,
    isCurrent: async () => {
      if (!source || source.tenant !== destination.tenant) return false;
      const at = currentTime();
      return Boolean(
        await store
          .statement(
            "SELECT 1 n FROM accounts a JOIN connections s ON s.tenant=a.id JOIN connections d ON d.tenant=a.id JOIN private_data sp ON sp.tenant=s.tenant AND sp.connection=s.id AND sp.id=s.credential_version AND sp.kind='credential' JOIN private_data dp ON dp.tenant=d.tenant AND dp.connection=d.id AND dp.id=d.credential_version AND dp.kind='credential' WHERE a.id=? AND a.status='active' AND s.id=? AND s.kind='lofi' AND s.status='active' AND s.remote_identity=? AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>?) AND d.id=? AND d.kind='qrz' AND d.status='active' AND d.remote_identity=? AND d.credential_version=? AND d.config=? AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>?)",
            destination.tenant,
            source.id,
            source.remote_identity,
            at,
            destination.id,
            destination.remote_identity,
            destination.credential_version,
            destination.config,
            at,
          )
          .first(),
      );
    },
  };
}

export interface QrzEmptyObservation {
  readonly scope: QrzEmptyObservationScope;
  readonly token: object;
}
type QrzObservationInput = {
  key: LedgerKey;
  contact: Contact;
  source: Connection;
  destination: Connection;
};
function qrzObservationSourceConfig(config: string) {
  const value = JSON.parse(config);
  // The mandatory canonical drain updates only this diagnostic timestamp.
  // Every other source setting and every destination setting remains bound.
  delete value.lastSuccessfulPollAt;
  return canonical(value);
}
const qrzObservationConnection = (connection: Connection, source = false) => ({
  tenant: connection.tenant,
  id: connection.id,
  kind: connection.kind,
  status: connection.status,
  remoteIdentity: connection.remote_identity,
  credentialVersion: connection.credential_version,
  config: source
    ? qrzObservationSourceConfig(connection.config)
    : connection.config,
});
function qrzObservationInput(input: QrzObservationInput) {
  const {
    contextGeneration: _context,
    reconciliationVersion: _queue,
    ...projection
  } = input.contact as IntakeContact;
  const binding = canonical({
    key: input.key,
    projection,
    record: structuredContactAdif(input.contact),
    source: qrzObservationConnection(input.source, true),
    destination: qrzObservationConnection(input.destination),
  });
  // Large source contexts still use normal reads; they are not retained here.
  return new TextEncoder().encode(binding).byteLength <= 64 * 1024
    ? binding
    : undefined;
}
/** A bounded source-turn capability, not a cache shared between invocations. */
export class QrzEmptyObservationScope {
  #open = true;
  #issued = 0;
  readonly #store: Store;
  #observations = new WeakMap<object, { binding: string; expiresAt: number }>();
  #covers = new Map<string, { read: QrzCoveringRead; expiresAt: number }>();
  #coverBytes = 0;
  constructor(store: Store) {
    this.#store = store;
  }

  close() {
    this.#open = false;
    this.#observations = new WeakMap();
    this.#covers.clear();
    this.#coverBytes = 0;
  }

  async #credentials(input: QrzObservationInput, now: number) {
    return this.#store
      .statement(
        `SELECT sp.envelope source_envelope,sp.created_at source_created_at,sp.expires_at source_expires_at,
          dp.envelope destination_envelope,dp.created_at destination_created_at,dp.expires_at destination_expires_at
         FROM accounts a JOIN connections s ON s.tenant=a.id JOIN connections d ON d.tenant=a.id
         JOIN private_data sp ON sp.tenant=s.tenant AND sp.connection=s.id AND sp.id=s.credential_version AND sp.kind='credential'
         JOIN private_data dp ON dp.tenant=d.tenant AND dp.connection=d.id AND dp.id=d.credential_version AND dp.kind='credential'
         WHERE a.id=? AND a.status='active' AND s.id=? AND s.kind='lofi' AND s.status='active' AND s.remote_identity IS ? AND s.credential_version=? AND json_remove(s.config,'$.lastSuccessfulPollAt')=json_remove(?,'$.lastSuccessfulPollAt')
          AND d.id=? AND d.kind='qrz' AND d.status='active' AND d.remote_identity IS ? AND d.credential_version=? AND d.config=?
          AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>?)
          AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>?)`,
        input.key.tenant,
        input.source.id,
        input.source.remote_identity,
        input.source.credential_version,
        input.source.config,
        input.destination.id,
        input.destination.remote_identity,
        input.destination.credential_version,
        input.destination.config,
        now,
        now,
      )
      .first<{ destination_envelope: string }>();
  }

  /** Only a real, complete guarded scan can issue an empty observation. */
  async read(
    input: QrzObservationInput,
    credential: QrzCredential,
    deps: DeliveryDependencies = {},
  ) {
    input = structuredClone(input);
    const apiKey = credential.apiKey;
    if (!this.#open || !apiKey)
      throw new QrzError("blocked", "QRZ observation scope unavailable");
    const captured = qrzObservationInput(input);
    const time = deliveryClock(deps.now);
    let expiresAt = time() + 60_000;
    const before =
      captured && this.#issued < 20
        ? await this.#credentials(input, time())
        : null;
    if (!this.#open)
      throw new QrzError("blocked", "QRZ observation scope unavailable");
    // A covering read contains all records in its range, including neighbors
    // relevant only to later contacts. Bind reuse to the exact source/book and
    // encrypted credential snapshots, and retain its ORIGINAL expiry.
    const coverBinding =
      before && captured
        ? await sha256(
            canonical([
              qrzObservationConnection(input.source, true),
              qrzObservationConnection(input.destination),
              before,
              apiKey,
            ]),
          )
        : null;
    const fallback = qrzNeighborhoodFallback(
      this.#store,
      input.source,
      input.destination,
      time,
    );
    if (coverBinding)
      fallback.planningCoverage = {
        load: (cover) => {
          const saved = this.#covers.get(canonical([coverBinding, cover]));
          if (!this.#open || !saved || time() >= saved.expiresAt)
            return undefined;
          expiresAt = Math.min(expiresAt, saved.expiresAt);
          return structuredClone(saved.read);
        },
        save: (read) => {
          if (!this.#open || time() >= expiresAt || this.#covers.size >= 20)
            return;
          const bytes = new TextEncoder().encode(canonical(read)).byteLength;
          if (this.#coverBytes + bytes > 2 * 1024 * 1024) return;
          this.#coverBytes += bytes;
          this.#covers.set(canonical([coverBinding, read.cover]), {
            read: structuredClone(read),
            expiresAt,
          });
        },
      };
    const records = await new QrzClient(apiKey, {
      fetch: qrzPlanningFetch(
        this.#store,
        deps.fetcher ?? fetch,
        deps.priority,
        time,
        deps.qrzPlanning,
      ),
      neighborhoodFallback: fallback,
    }).findNeighborhood(structuredContactAdif(input.contact));
    let observation: QrzEmptyObservation | undefined;
    if (
      records.length === 0 &&
      captured !== undefined &&
      before !== null &&
      input.key.tenant === input.source.tenant &&
      input.key.tenant === input.destination.tenant &&
      input.key.source === input.source.id &&
      input.key.destination === input.destination.id &&
      input.key.qso === input.contact.id &&
      this.#open &&
      time() < expiresAt &&
      canonical(await this.#credentials(input, time())) === canonical(before) &&
      this.#open &&
      time() < expiresAt
    ) {
      const binding = await sha256(canonical([captured, before, apiKey]));
      if (!this.#open || time() >= expiresAt || this.#issued >= 20)
        return { records, observation };
      const token = Object.freeze({});
      this.#observations.set(token, {
        binding,
        expiresAt,
      });
      this.#issued++;
      observation = Object.freeze({ scope: this, token });
    }
    return { records, observation };
  }

  static async consume(
    observation: QrzEmptyObservation | undefined,
    store: Store,
    input: QrzObservationInput,
    credential: QrzCredential,
    now: () => number,
    loaded?: QrzCredentialSnapshot | null,
  ): Promise<boolean> {
    if (!observation) return false;
    const scope = observation.scope;
    if (
      typeof scope !== "object" ||
      scope === null ||
      !(#observations in scope) ||
      scope.#store !== store
    )
      return false;
    const entry = scope.#observations.get(observation.token);
    scope.#observations.delete(observation.token);
    if (!entry || !scope.#open || now() >= entry.expiresAt) return false;
    // Capture primitives before the metadata await; callers cannot change the
    // query identity while a database operation is in flight.
    input = structuredClone(input);
    const captured = qrzObservationInput(input);
    if (captured === undefined) return false;
    const apiKey = credential.apiKey;
    const current =
      loaded === undefined ? await scope.#credentials(input, now()) : loaded;
    const binding = await sha256(canonical([captured, current, apiKey]));
    return (
      scope.#open &&
      now() < entry.expiresAt &&
      current !== null &&
      binding === entry.binding
    );
  }
}
function qrzClient(
  store: Store,
  credential: QrzCredential,
  config: QrzConfig,
  gates: DeliveryGates,
  deps: DeliveryDependencies,
  scope: { source: Connection | null; destination: Connection },
  beforeWrite?: () => Promise<boolean>,
  beforeMutationTransport?: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ) => Promise<void>,
  authorizationMode: SourceExportAuthorizationMode = "source_boundary",
  planning?: QrzPlanningAllowance,
  command?: { admit: VendorAdmission; current: () => Promise<boolean> },
): QrzClient {
  if (!credential.apiKey) throw new Error("QRZ credential is unavailable");
  const currentTime = deliveryClock(deps.now);
  const neighborhoodFallback = qrzNeighborhoodFallback(
    store,
    scope.source,
    scope.destination,
    currentTime,
  );
  // Queue callbacks check local gates/deadlines. The command executes fresh
  // SQL authorization with reservation before EVERY HTTP request, including
  // FETCH/STATUS. A previous request's decision never admits another request.
  if (command) neighborhoodFallback.isCurrent = command.current;
  const transport: typeof fetch = async (input, init) => {
    const form = new URLSearchParams(String(init?.body));
    const action = form.get("ACTION");
    if (
      action === "INSERT" ||
      action === "DELETE" ||
      (authorizationMode === "qrz_fresh_insert" &&
        (form.getAll("ACTION").length !== 1 ||
          !["FETCH", "STATUS", "COUNT"].includes(action ?? "")))
    ) {
      if (authorizationMode === "qrz_fresh_insert" && !beforeMutationTransport)
        throw new UnsentAuthorizationError();
      await beforeMutationTransport?.(input, init);
    }
    return (deps.fetcher ?? fetch)(input, init);
  };
  return new QrzClient(credential.apiKey, {
    fetch: command
      ? (input, init) =>
          vendorFetch(store, "qrz", transport, {
            priority: deps.priority,
            now: currentTime(),
            admit: command.admit,
          })(input, init)
      : qrzPlanningFetch(
          store,
          transport,
          deps.priority,
          currentTime,
          planning,
        ),
    writesEnabled: modeEnabled(gates, authorizationMode),
    replacementContractVerified: config.replacementContractVerified === true,
    beforeWrite: async () =>
      (await neighborhoodFallback.isCurrent()) &&
      (beforeWrite ? await beforeWrite() : true),
    neighborhoodFallback,
  });
}
async function activeTemplate(
  store: Store,
  key: LedgerKey,
  pinned: string | null,
): Promise<TemplateVersion> {
  const row = await store
    .statement(
      pinned
        ? "SELECT id,config FROM templates WHERE tenant=? AND destination=? AND id=?"
        : "SELECT t.id,t.config FROM active_templates a JOIN templates t ON t.tenant=a.tenant AND t.destination=a.destination AND t.id=a.version WHERE a.tenant=? AND a.destination=?",
      ...[key.tenant, key.destination, ...(pinned ? [pinned] : [])],
    )
    .first<{ id: string; config: string }>();
  if (!row) throw new Error("No immutable QRZ template profile is configured");
  return decodeTemplate(row);
}
async function unchangedProjection(
  store: Store,
  key: LedgerKey,
  generation: string,
  projectionHash: string,
  now: number,
  loaded?: Ledger,
): Promise<boolean> {
  const row = loaded ?? (await store.ledger(key));
  if (!row || row.generation !== generation || row.sent_hash !== projectionHash)
    return false;
  const result = await store
    .statement(
      "UPDATE ledger SET baseline_hash=source_hash,state=CASE WHEN remote_id IS NOT NULL THEN 'observed' ELSE state END,reason=CASE WHEN reason=? THEN reason ELSE NULL END,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND sent_hash=? RETURNING qso",
      LOTW_PRIOR_IDENTITY_NOTICE,
      now,
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      generation,
      projectionHash,
    )
    .run();
  return result.results.length === 1;
}
/** Retire only a known-unsent artifact whose immutable source proof is stale. */
export async function cancelStalePreparedSourceProof(
  store: Store,
  tenant: string,
  attempt: string,
  now = Date.now(),
): Promise<boolean> {
  const proof = attemptSourceExportProofGuard(tenant, attempt, now);
  const rows = await store.db.batch([
    store.statement(
      `INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT tenant,attempt,'cancelled',?,'source_export_proof_unavailable' FROM attempt_state WHERE tenant=? AND attempt=? AND state='prepared' AND NOT (${proof.sql})`,
      now,
      tenant,
      attempt,
      ...proof.params,
    ),
    store.statement(
      `UPDATE attempt_state SET state='cancelled',reason='source_export_proof_unavailable',updated_at=? WHERE tenant=? AND attempt=? AND state='prepared' AND NOT (${proof.sql}) RETURNING attempt`,
      now,
      tenant,
      attempt,
      ...proof.params,
    ),
  ]);
  return rows[1].results.length === 1;
}
/** Prepare one immutable attempt; no template change can call this without source work. */
export async function prepareDue(
  store: Store,
  key: LedgerKey,
  contact: Contact,
  gates: DeliveryGates,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  return prepareDueWork(store, key, contact, gates, deps);
}

export interface PrepareDueMember {
  key: LedgerKey;
  contact: Contact;
  deps: DeliveryDependencies;
}
/** Load a QRZ cohort once and stage its eligible plans in one transaction.
 * All authority remains in the existing native stage guards. Other operations
 * and unresolved attempts retain their ordinary recovery paths. */
export async function prepareDueBatch(
  store: Store,
  members: readonly PrepareDueMember[],
  gates: DeliveryGates,
): Promise<PromiseSettledResult<DeliveryResult>[]> {
  if (
    !members.length ||
    members.length > 20 ||
    new Set(members.map(({ key }) => key.tenant)).size !== 1
  )
    throw new Error("invalid preparation cohort");
  const eligible = members.filter(
    ({ deps, contact }) =>
      deps.sourceProof?.authorizationMode === "qrz_fresh_insert" &&
      !testContact(contact) &&
      !contact.deleted,
  );
  let loaded: Map<string, PreparationWork>;
  try {
    loaded = eligible.length
      ? await loadPreparationWork(
          store,
          await Promise.all(
            eligible.map(async ({ key, contact, deps }) => {
              const proof = deps.sourceProof;
              if (!proof) throw new Error("missing cohort proof");
              return {
                key,
                generation: contact.generation,
                identityHash: (
                  await destinationIdentityClaim(
                    "qrz",
                    structuredContactAdif(contact),
                  )
                ).hash,
                proof,
              };
            }),
          ),
          deliveryClock(members[0].deps.now)(),
        )
      : new Map<string, PreparationWork>();
  } catch {
    const isolated: PromiseSettledResult<DeliveryResult>[] = [];
    for (const member of members) {
      try {
        isolated.push({
          status: "fulfilled",
          value: await prepareDue(
            store,
            member.key,
            member.contact,
            gates,
            member.deps,
          ),
        });
      } catch (reason) {
        isolated.push({ status: "rejected", reason });
      }
    }
    return isolated;
  }
  const plans: { input: StageInput; member: number }[] = [];
  const results: PromiseSettledResult<DeliveryResult>[] = [];
  let backgroundPlans = 0;
  for (const [index, member] of members.entries()) {
    const work = loaded.get(deliveryWorkKey(member.key));
    const fast = work?.destination.kind === "qrz" && !work.unresolved;
    try {
      const value = await prepareDueWork(
        store,
        member.key,
        member.contact,
        gates,
        member.deps,
        fast
          ? {
              ...work,
              backgroundBacklog: work.backgroundBacklog + backgroundPlans,
            }
          : undefined,
        fast
          ? (input) => {
              plans.push({ input, member: index });
              if (input.priority === "background") backgroundPlans++;
              return "planned";
            }
          : undefined,
      );
      results.push({ status: "fulfilled", value });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  if (plans.length) {
    try {
      const ids = await store.stageBatch(plans.map(({ input }) => input));
      plans.forEach(({ member }, index) => {
        results[member] = {
          status: "fulfilled",
          value: { state: "prepared", attemptId: ids[index] },
        };
      });
    } catch {
      // Native constraint failures roll back the cohort. Ordinary preparation
      // also detects a persisted attempt after an ambiguous database failure.
      for (const { member } of plans) {
        const input = members[member];
        try {
          results[member] = {
            status: "fulfilled",
            value: await prepareDue(
              store,
              input.key,
              input.contact,
              gates,
              input.deps,
            ),
          };
        } catch (reason) {
          results[member] = { status: "rejected", reason };
        }
      }
    }
  }
  return results;
}

async function prepareDueWork(
  store: Store,
  key: LedgerKey,
  contact: Contact,
  gates: DeliveryGates,
  deps: DeliveryDependencies,
  work?: PreparationWork,
  stage?: (input: StageInput) => string,
): Promise<DeliveryResult> {
  const currentTime = deliveryClock(deps.now);
  const now = currentTime();
  if (deps.preparationAllowed?.() === false)
    return { state: "blocked", reason: "dispatch_headroom_unavailable" };
  if (testContact(contact))
    return { state: "blocked", reason: "test_operation_not_exported" };
  if (gates.allowedQsoIds && !gates.allowedQsoIds.includes(key.qso))
    return { state: "blocked", reason: "qso_outside_rollout_scope" };
  if (
    gates.allowedDestinationIds &&
    !gates.allowedDestinationIds.includes(key.destination)
  )
    return { state: "blocked", reason: "destination_outside_rollout_scope" };
  const [ledger, association] = work
    ? [{ results: [work.ledger] }, { results: work.held ? [work.ledger] : [] }]
    : await store.db.batch<Ledger>([
        store.statement(
          "SELECT * FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=?",
          key.tenant,
          key.source,
          key.qso,
          key.destination,
        ),
        store.statement(
          "SELECT 1 held FROM historical_association_write_blocks WHERE tenant=? AND source=? AND qso=? AND destination=? LIMIT 1",
          key.tenant,
          key.source,
          key.qso,
          key.destination,
        ),
      ]);
  const row = ledger.results[0];
  if (association.results.length)
    return { state: "blocked", reason: "historical_association_read_only" };
  if (row?.provenance === "adoption_conflict")
    return { state: "blocked", reason: "remote_identity_claim_conflict" };
  if (
    !row ||
    row.generation !== contact.generation ||
    contact.id !== key.qso ||
    contact.deleted ||
    row.due_at > now ||
    !["missing_current_identity", "changed", "live_new"].includes(row.state)
  )
    return { state: "skipped", reason: "not_due_or_current" };
  if (
    row.context_generation != null &&
    !(work
      ? work.contextCurrent
      : await sourceContextUnchanged(store, key, row.context_generation, now))
  )
    return { state: "blocked", reason: "source_not_exportable" };
  const unresolved = work
    ? null
    : await store
        .statement(
          "SELECT a.id,s.state FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.source=? AND a.qso=? AND a.destination=? AND s.state NOT IN('delivered','observed','rejected','cancelled') LIMIT 1",
          key.tenant,
          key.source,
          key.qso,
          key.destination,
        )
        .first<{ id: string; state: string }>();
  if (
    unresolved &&
    (unresolved.state !== "prepared" ||
      !(await cancelStalePreparedSourceProof(
        store,
        key.tenant,
        unresolved.id,
        currentTime(),
      )))
  )
    return { state: "skipped", reason: "unresolved_attempt" };
  const connections = work
    ? [{ results: [work.destination] }, { results: [work.source] }]
    : await store.db.batch<Connection>([
        store.statement(
          "SELECT * FROM connections WHERE tenant=? AND id=?",
          key.tenant,
          key.destination,
        ),
        store.statement(
          "SELECT * FROM connections WHERE tenant=? AND id=?",
          key.tenant,
          key.source,
        ),
      ]);
  const connection = connections[0].results[0];
  const source = connections[1].results[0];
  if (
    connection?.status !== "active" ||
    source?.status !== "active" ||
    !connection.credential_version
  )
    return { state: "blocked", reason: "connection_inactive" };
  if (connection.kind !== "qrz" && connection.kind !== "lotw")
    return { state: "blocked", reason: "invalid_destination" };
  // Preserve the legacy boundary path; the independent fresh capability is
  // selected only with current consent and can never authorize another vendor.
  const authorizationMode = gates.sourceBoundaryVerified
    ? "source_boundary"
    : deliveryMode(gates, connection.kind);
  if (!authorizationMode)
    return { state: "blocked", reason: "source_replay_boundary_unverified" };
  const freshInsertCurrent = async () =>
    authorizationMode === "source_boundary" ||
    (modeEnabled(gates, authorizationMode) &&
      scoped(gates, key, true) &&
      (work
        ? work.freshCurrent
        : await (authorizationMode === "qrz_fresh_insert"
            ? qrzFreshInsertCurrent(store, key)
            : lotwFreshInsertCurrent(store, key))) &&
      modeEnabled(gates, authorizationMode) &&
      scoped(gates, key, true));
  if (!(await freshInsertCurrent()))
    return {
      state: "blocked",
      reason: freshInsertUnavailable(authorizationMode),
    };
  const sourceProof = deps.sourceProof;
  if (!sourceProof)
    return { state: "blocked", reason: "source_export_proof_unavailable" };
  const sourceProofCurrent = async () =>
    Boolean(
      sourceProof.scope.tenant === key.tenant &&
        sourceProof.scope.source === key.source &&
        (work
          ? work.proofExpiresAt > currentTime()
          : await loadCurrentSourceExportProof(
              store,
              sourceProof.scope,
              sourceProof.proofId,
              {
                qso: key.qso,
                generation: contact.generation,
                reconciliationVersion: sourceProof.reconciliationVersion,
              },
              currentTime(),
            )),
    );
  if (!(await sourceProofCurrent()))
    return { state: "blocked", reason: "source_export_proof_unavailable" };
  // This projection is only used by the guarded attempt path. The public ADIF
  // helper remains strict; every attempt must acquire its exact seconds claim.
  const structured = structuredContactAdif(contact);
  const identity = await destinationIdentityClaim(connection.kind, structured);
  const available = availableIdentityClaim(key, identity);
  const retained =
    connection.kind === "lotw"
      ? await store.lotwIdentityClaimGuard(key, identity.hash)
      : { sql: "1", params: [] };
  const ownership =
    work?.ownership ??
    (await store
      .statement(
        `SELECT (${available.sql}) AND (${retained.sql}) available,EXISTS(SELECT 1 FROM legacy_qrz_identity_reservations r WHERE r.tenant=? AND r.destination=?) legacy,EXISTS(SELECT 1 FROM legacy_outbound_identity_reservations r WHERE r.tenant=? AND r.destination=?) legacy_attempt`,
        ...available.params,
        ...retained.params,
        key.tenant,
        key.destination,
        key.tenant,
        key.destination,
      )
      .first<{ available: number; legacy: number; legacy_attempt: number }>());
  if (ownership?.legacy)
    return {
      state: "blocked",
      reason: "legacy_qrz_identity_backfill_required",
    };
  if (ownership?.legacy_attempt)
    return {
      state: "blocked",
      reason: "legacy_outbound_identity_backfill_required",
    };
  if (!ownership?.available)
    return { state: "blocked", reason: "outbound_identity_claim_conflict" };
  if (deps.priority === "background") {
    const backlog = work
      ? { n: work.backgroundBacklog }
      : await store
          .statement(
            "SELECT COUNT(*) n FROM (SELECT 1 FROM attempt_state s JOIN attempts a ON a.tenant=s.tenant AND a.id=s.attempt JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination AND c.status='active' JOIN connections src ON src.tenant=a.tenant AND src.id=a.source AND src.status='active' WHERE s.state='prepared' AND s.priority='background' AND c.kind=? AND a.credential_version=c.credential_version AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)) LIMIT 2)",
            connection.kind,
            now,
          )
          .first<{ n: number }>();
    if ((backlog?.n ?? 0) >= 2)
      return { state: "skipped", reason: "background_outbox_full" };
  }
  const member = { id: contact.id, generation: contact.generation };
  let payload: PreparedPayload;
  let expectedTemplate: string | null = null;
  let lotwIdentityId: string | undefined;
  if (connection.kind === "qrz") {
    const config = JSON.parse(connection.config) as QrzConfig;
    if (!routedQrz(config, contact))
      return { state: "blocked", reason: "qrz_station_or_date_route_mismatch" };
    const credential = work
      ? work.credentials
        ? await open<QrzCredential>(
            JSON.parse(work.credentials.destination_envelope) as Envelope,
            {
              tenant: key.tenant,
              connection: key.destination,
              id: connection.credential_version,
              kind: "credential",
              purpose: "storage",
            },
            store.keys,
          )
        : null
      : await store.private<QrzCredential>(
          key.tenant,
          key.destination,
          connection.credential_version,
          "credential",
        );
    if (!credential)
      return { state: "blocked", reason: "credential_unavailable" };
    const client = qrzClient(
      store,
      credential,
      config,
      gates,
      { ...deps, now: currentTime() },
      {
        source,
        destination: connection,
      },
      undefined,
      undefined,
      authorizationMode,
      authorizationMode === "qrz_fresh_insert" ? deps.qrzPlanning : undefined,
    );
    let record = structured;
    if (row.narrative !== "remote_preserved") {
      const version = work
        ? work.template
          ? decodeTemplate(work.template)
          : null
        : await activeTemplate(store, key, row.template_version);
      if (!version)
        throw new Error("No immutable QRZ template profile is configured");
      expectedTemplate = version.id;
      record = {
        ...structured,
        ...renderNarrative(version, templateContext(contact, now)),
      };
    }
    let operation: "insert" | "replace" = "insert";
    let priorIdentityEvidenceId: string | undefined;
    if (row.remote_id) {
      const remote = await client.fetchLogId(row.remote_id);
      if (!remote)
        return { state: "blocked", reason: "mapped_qrz_record_missing" };
      record = mergeQrzCorrection(
        remote,
        record,
        row.narrative === "remote_preserved"
          ? "remote_preserved"
          : "template_bound",
      );
      for (const [field, value] of Object.entries(record))
        record[field] = normalizeAdifValue(field, value);
      const recordHash = await sha256(canonical(record));
      if (
        await unchangedProjection(
          store,
          key,
          contact.generation,
          recordHash,
          now,
        )
      )
        return { state: "skipped", reason: "transmitted_projection_unchanged" };
      const observed = mergeQrzCorrection(
        remote,
        remote,
        row.narrative === "remote_preserved"
          ? "remote_preserved"
          : "template_bound",
      );
      for (const [field, value] of Object.entries(observed))
        observed[field] = normalizeAdifValue(field, value);
      if (canonical(record) === canonical(observed)) {
        await store
          .statement(
            "UPDATE ledger SET baseline_hash=source_hash,state=CASE WHEN provenance='adopted' THEN 'adopted_existing' ELSE 'observed' END,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND remote_id=?",
            now,
            key.tenant,
            key.source,
            key.qso,
            key.destination,
            contact.generation,
            row.remote_id,
          )
          .run();
        return {
          state: "skipped",
          reason: "remote_projection_already_current",
        };
      }
      if (sameQrzIdentity(remote, record)) {
        if (!config.replacementContractVerified)
          return {
            state: "blocked",
            reason: "qrz_replacement_contract_unverified",
          };
        const neighbors = await client.findNeighborhood(record);
        if (
          neighbors.length !== 1 ||
          neighbors[0].APP_QRZLOG_LOGID !== row.remote_id
        )
          return { state: "blocked", reason: "qrz_collision_ambiguous" };
        operation = "replace";
      } else {
        if ((await client.findNeighborhood(record)).length)
          return { state: "blocked", reason: "qrz_changed_identity_collision" };
        priorIdentityEvidenceId = randomToken();
        await (
          await store.putPrivate(
            key.tenant,
            key.destination,
            priorIdentityEvidenceId,
            "identity_history",
            {
              source: key.source,
              qso: key.qso,
              oldLogId: row.remote_id,
              oldProvenance: row.provenance,
              oldIdentity: comparableRemote(remote),
              newIdentity: comparableRemote(structured),
              cleanup: "retained_remote_identity",
            },
            now + 90 * 86400000,
          )
        ).run();
      }
    } else if (
      !(
        authorizationMode === "qrz_fresh_insert" &&
        (await QrzEmptyObservationScope.consume(
          deps.qrzEmptyObservation,
          store,
          { key, contact, source, destination: connection },
          credential,
          currentTime,
          work?.credentials,
        ))
      ) &&
      (await client.findNeighborhood(record)).length
    )
      return {
        state: "blocked",
        reason: "qrz_fresh_absence_check_found_candidate",
      };
    for (const [field, value] of Object.entries(record))
      record[field] = normalizeAdifValue(field, value);
    serializeAdifRecord(record);
    const projectionHash = await sha256(canonical(record));
    if (
      await unchangedProjection(
        store,
        key,
        contact.generation,
        projectionHash,
        now,
        work?.ledger,
      )
    )
      return { state: "skipped", reason: "transmitted_projection_unchanged" };
    payload = {
      kind: "qrz",
      record,
      operation,
      mappedLogId: row.remote_id,
      narrative:
        row.narrative === "remote_preserved"
          ? "remote_preserved"
          : "template_bound",
      projectionHash,
      members: [member],
      preparedAt: new Date(now).toISOString(),
      ...(priorIdentityEvidenceId ? { priorIdentityEvidenceId } : {}),
    };
  } else if (connection.kind === "lotw") {
    if (!modeEnabled(gates, authorizationMode))
      return { state: "blocked", reason: "exports_disabled_before_signing" };
    if (await store.historicalAssociationOnly(key))
      return { state: "blocked", reason: "historical_association_read_only" };
    const input = lotwDeliveryInput(
      JSON.parse(connection.config) as LotwConfig,
      contact,
    );
    if (!input)
      return { state: "blocked", reason: "lotw_station_route_mismatch" };
    const { station, qso: lotwContact } = input;
    const credential = await store.private<LotwCredential>(
      key.tenant,
      key.destination,
      connection.credential_version,
      "credential",
    );
    if (!credential)
      return { state: "blocked", reason: "credential_unavailable" };
    try {
      canonicalSigningData(station, lotwContact);
    } catch {
      return { state: "blocked", reason: "lotw_signing_fields_unavailable" };
    }
    const exactLotwIdentity = await lotwAttemptIdentity(station, lotwContact);
    lotwIdentityId = exactLotwIdentity.remoteId;
    if (!(await lotwOwnershipAvailable(store, key, exactLotwIdentity)))
      return { state: "blocked", reason: "lotw_ownership_unavailable" };
    const projectionHash = await lotwProjectionHash(station, lotwContact);
    if (
      await unchangedProjection(
        store,
        key,
        contact.generation,
        projectionHash,
        now,
      )
    )
      return { state: "skipped", reason: "transmitted_projection_unchanged" };
    const client = new LotwClient(credential.query ?? null, {
      fetcher: (input, init) =>
        vendorFetch(store, "lotw", deps.fetcher, {
          priority: deps.priority,
          now: currentTime(),
        })(input, init),
      exportsEnabled: modeEnabled(gates, authorizationMode),
    });
    if (authorizationMode === "lotw_fresh_insert") {
      if (!credential.query)
        return {
          state: "blocked",
          reason: "lotw_query_required_for_fresh_insert",
        };
      try {
        const history = await checkLotwFirstInsertHistory(
          { credentials: credential.query, station, contact: lotwContact },
          {
            fetcher: (input, init) =>
              vendorFetch(store, "lotw", deps.fetcher, {
                priority: deps.priority,
                now: currentTime(),
              })(input, init),
          },
        );
        if (history.state !== "empty")
          return {
            state: "blocked",
            reason: "lotw_fresh_insert_history_present",
          };
      } catch (error) {
        if (error instanceof VendorDeferredError) throw error;
        return {
          state: "blocked",
          reason: "lotw_fresh_insert_history_unavailable",
        };
      }
    } else if (credential.query) {
      const report = await client.query({
        startDate: lotwContact.date,
        endDate: lotwContact.date,
        stationCallsign: station.callsign,
        workedCallsign: lotwContact.call,
      });
      const observation = observeLotwContact(station, lotwContact, report);
      if (!row.remote_id && observation.state !== "absent")
        return {
          state: "blocked",
          reason: "lotw_fresh_absence_check_found_candidate",
        };
      if (
        row.remote_id &&
        ["ambiguous", "insufficient_evidence"].includes(observation.state)
      )
        return {
          state: "blocked",
          reason: "lotw_correction_readback_ambiguous",
        };
    } else if (row.state !== "live_new" && !row.remote_id)
      return {
        state: "blocked",
        reason: "lotw_historical_readback_unavailable",
      };
    // Re-read authoritative credential status immediately before signing.
    const current = await store.connection(key.tenant, key.destination);
    if (
      current?.status !== "active" ||
      current.credential_version !== connection.credential_version ||
      !(await store.private(
        key.tenant,
        key.destination,
        connection.credential_version,
        "credential",
      ))
    )
      return { state: "blocked", reason: "credential_revoked_before_signing" };
    const selected = lotwSigningCertificate(credential, station, lotwContact);
    if (!selected)
      return {
        state: "blocked",
        reason: "lotw_certificate_selection_ambiguous_or_missing",
      };
    if (!certificateCurrentlyValid(selected, currentTime()))
      return {
        state: "blocked",
        reason: "lotw_certificate_not_currently_valid",
      };
    const status = await client.certificateStatus(selected.serial);
    if (status !== "unrevoked")
      return { state: "blocked", reason: `lotw_certificate_${status}` };
    const beforeSigning = await store.connection(key.tenant, key.destination);
    if (
      beforeSigning?.status !== "active" ||
      beforeSigning.credential_version !== connection.credential_version ||
      (await store.connection(key.tenant, key.source))?.status !== "active" ||
      !(await store.private(
        key.tenant,
        key.destination,
        connection.credential_version,
        "credential",
      ))
    )
      return {
        state: "blocked",
        reason: "credential_or_source_revoked_before_signing",
      };
    if (!(await sourceProofCurrent()))
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    if (!(await freshInsertCurrent()))
      return {
        state: "blocked",
        reason: freshInsertUnavailable(authorizationMode),
      };
    if (!modeEnabled(gates, authorizationMode))
      return { state: "blocked", reason: "exports_disabled_before_signing" };
    const signingAt = currentTime();
    if (!certificateCurrentlyValid(selected, signingAt))
      return {
        state: "blocked",
        reason: "lotw_certificate_not_currently_valid",
      };
    const signing = {
      ...selected,
      status,
      statusCheckedAt: new Date(signingAt).toISOString(),
    };
    const artifact = await (deps.sign ?? buildSignedTq8)(
      signing,
      station,
      [lotwContact],
      new Date(signingAt),
    );
    payload = {
      kind: "lotw",
      tq8: b64(artifact.bytes),
      station,
      contact: lotwContact,
      members: artifact.members,
      certificateVersion: artifact.credentialVersion,
      configurationVersion: artifact.configurationVersion,
      projectionHash,
      preparedAt: new Date(signingAt).toISOString(),
    };
  } else return { state: "blocked", reason: "invalid_destination" };
  let attemptId: string;
  try {
    if (!(await sourceProofCurrent()))
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    if (
      !(await freshInsertCurrent()) ||
      !freshInsertPayload(payload, authorizationMode, key, contact.generation)
    )
      return {
        state: "blocked",
        reason: freshInsertUnavailable(authorizationMode),
      };
    const identityClaim = await preparedIdentityClaim(payload);
    // Planning, history and signing can consume the caller's remaining budget.
    // Yield before persisting an artifact that cannot get a dispatch turn.
    if (deps.preparationAllowed?.() === false)
      return { state: "blocked", reason: "dispatch_headroom_unavailable" };
    attemptId = stage
      ? stage({
          key,
          generation: contact.generation,
          payload,
          credentialVersion: connection.credential_version,
          expectedTemplate,
          now: currentTime(),
          transmittedHash: payload.projectionHash,
          lotwIdentityId,
          priority: deps.priority ?? "live",
          identity: {
            claim: identityClaim,
            sourceVersion: sourceProof.reconciliationVersion,
          },
          sourceProof: { ...sourceProof, authorizationMode },
        })
      : await store.stage(
          key,
          contact.generation,
          payload,
          connection.credential_version,
          expectedTemplate,
          currentTime(),
          payload.projectionHash,
          lotwIdentityId,
          deps.priority ?? "live",
          {
            claim: identityClaim,
            sourceVersion: sourceProof.reconciliationVersion,
          },
          { ...sourceProof, authorizationMode },
        );
  } catch (error) {
    if (
      error instanceof LotwOwnershipUnavailable ||
      (error instanceof Error && error.message.includes("LoTW ownership"))
    )
      return { state: "blocked", reason: "lotw_ownership_unavailable" };
    if (
      error instanceof Error &&
      error.message.includes("historical association is read only")
    )
      return { state: "blocked", reason: "historical_association_read_only" };
    if (
      error instanceof Error &&
      (error.message.includes("QRZ fresh insert unavailable") ||
        error.message.includes("LoTW fresh insert unavailable"))
    )
      return {
        state: "blocked",
        reason: freshInsertUnavailable(authorizationMode),
      };
    if (
      error instanceof Error &&
      error.message.includes("source export proof unavailable")
    )
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    if (
      error instanceof Error &&
      error.message.includes("outbound identity claim conflict")
    )
      return { state: "blocked", reason: "outbound_identity_claim_conflict" };
    if (
      error instanceof Error &&
      error.message.includes("legacy QRZ identity backfill required")
    )
      return {
        state: "blocked",
        reason: "legacy_qrz_identity_backfill_required",
      };
    if (
      error instanceof Error &&
      error.message.includes("legacy outbound identity backfill required")
    )
      return {
        state: "blocked",
        reason: "legacy_outbound_identity_backfill_required",
      };
    throw error;
  }
  return { state: "prepared", attemptId };
}

async function preparedIdentityClaim(payload: PreparedPayload) {
  if (payload.kind === "qrz")
    return destinationIdentityClaim("qrz", payload.record);
  return destinationIdentityClaim("lotw", {
    STATION_CALLSIGN: payload.station.callsign,
    CALL: payload.contact.call,
    QSO_DATE: payload.contact.date.replaceAll("-", ""),
    TIME_ON: payload.contact.time.replaceAll(":", "").replace(/Z$/, ""),
    BAND: payload.contact.band,
    MODE: payload.contact.mode,
    ...(payload.contact.submode ? { SUBMODE: payload.contact.submode } : {}),
    PROP_MODE: payload.contact.propagation ?? "",
    SAT_NAME: payload.contact.satellite ?? "",
  });
}
interface AttemptRow {
  id: string;
  source: string;
  qso: string;
  destination: string;
  generation: string;
  payload_id: string;
  credential_version: string;
  attempt_state: string;
}
async function attemptData(
  store: Store,
  tenant: string,
  id: string,
): Promise<{
  attempt: AttemptRow;
  connection: Connection;
  payload: PreparedPayload;
} | null> {
  const attempt = await store
    .statement(
      "SELECT a.*,s.state AS attempt_state FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.id=?",
      tenant,
      id,
    )
    .first<AttemptRow>();
  if (!attempt) return null;
  const connection = await store.connection(tenant, attempt.destination);
  if (
    connection?.status !== "active" ||
    (await store.connection(tenant, attempt.source))?.status !== "active"
  )
    return null;
  const payload = await store.private<PreparedPayload>(
    tenant,
    attempt.destination,
    attempt.payload_id,
    "outbox",
  );
  return payload ? { attempt, connection, payload } : null;
}
export async function dispatchAttempt(
  store: Store,
  tenant: string,
  id: string,
  gates: DeliveryGates,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  if (!deliveryMode(gates, "qrz") && !deliveryMode(gates, "lotw"))
    return { state: "blocked", reason: "exports_disabled" };
  const work = await loadDispatchWork(
    store,
    tenant,
    [id],
    deliveryClock(deps.now)(),
  );
  return dispatchAttemptWork(
    store,
    tenant,
    id,
    gates,
    deps,
    work.get(id) ?? null,
  );
}

export async function dispatchAttemptBatch(
  store: Store,
  tenant: string,
  members: readonly { id: string; deps: DeliveryDependencies }[],
  gates: DeliveryGates,
): Promise<PromiseSettledResult<DeliveryResult>[]> {
  if (!members.length) return [];
  if (
    members.length > 25 ||
    new Set(members.map((member) => member.id)).size !== members.length
  )
    throw new Error("invalid dispatch cohort");
  if (!deliveryMode(gates, "qrz") && !deliveryMode(gates, "lotw"))
    return members.map(() => ({
      status: "fulfilled",
      value: { state: "blocked", reason: "exports_disabled" },
    }));
  const time = deliveryClock(members[0]?.deps.now);
  let work: Map<string, DispatchWork>;
  const current = new Map<string, boolean>();
  try {
    work = await loadDispatchWork(
      store,
      tenant,
      members.map(({ id }) => id),
      time(),
    );
    const identityInputs = [];
    for (const member of members) {
      const data = work.get(member.id);
      if (
        data?.payload.kind === "qrz" &&
        data.attempt.attempt_state === "prepared"
      )
        identityInputs.push({
          id: member.id,
          checks: claimedAttemptChecks(
            store,
            tenant,
            member.id,
            await preparedIdentityClaim(data.payload),
            time(),
          ),
        });
    }
    if (identityInputs.length) {
      const checks = await store.db.batch(
        identityInputs.flatMap(({ checks }) => checks),
      );
      let offset = 0;
      for (const input of identityInputs) {
        current.set(
          input.id,
          checks
            .slice(offset, offset + input.checks.length)
            .every((result) => result.results.length === 1),
        );
        offset += input.checks.length;
      }
    }
  } catch {
    const isolated: PromiseSettledResult<DeliveryResult>[] = [];
    for (const member of members) {
      try {
        isolated.push({
          status: "fulfilled",
          value: await dispatchAttempt(
            store,
            tenant,
            member.id,
            gates,
            member.deps,
          ),
        });
      } catch (reason) {
        isolated.push({ status: "rejected", reason });
      }
    }
    return isolated;
  }
  const leases = new Map<string, Lease | null>();
  const leaseFor = async (destination: string) => {
    if (!leases.has(destination))
      leases.set(
        destination,
        await store.claim(tenant, `delivery:${destination}`, time(), 120_000),
      );
    return leases.get(destination) ?? null;
  };
  const results: PromiseSettledResult<DeliveryResult>[] = [];
  try {
    for (const member of members) {
      try {
        results.push({
          status: "fulfilled",
          value: await dispatchAttemptWork(
            store,
            tenant,
            member.id,
            gates,
            member.deps,
            work.get(member.id) ?? null,
            current.get(member.id),
            leaseFor,
          ),
        });
      } catch (reason) {
        results.push({ status: "rejected", reason });
      }
    }
  } finally {
    for (const lease of leases.values()) if (lease) await store.release(lease);
  }
  return results;
}

async function dispatchAttemptWork(
  store: Store,
  tenant: string,
  id: string,
  gates: DeliveryGates,
  deps: DeliveryDependencies,
  work: DispatchWork | null,
  identityCurrent?: boolean,
  leaseFor?: (destination: string) => Promise<Lease | null>,
): Promise<DeliveryResult> {
  if (!deliveryMode(gates, "qrz") && !deliveryMode(gates, "lotw"))
    return { state: "blocked", reason: "exports_disabled" };
  const currentTime = deliveryClock(deps.now);
  const now = currentTime();
  const data = work;
  if (
    data &&
    gates.allowedQsoIds &&
    !gates.allowedQsoIds.includes(data.attempt.qso)
  )
    return { state: "blocked", reason: "qso_outside_rollout_scope" };
  if (!data)
    return { state: "blocked", reason: "attempt_or_connection_unavailable" };
  if (
    gates.allowedDestinationIds &&
    !gates.allowedDestinationIds.includes(data.attempt.destination)
  )
    return { state: "blocked", reason: "destination_outside_rollout_scope" };
  const key = { ...data.attempt, tenant };
  if (
    isTestCallsign(
      data.payload.kind === "qrz"
        ? data.payload.record.STATION_CALLSIGN
        : data.payload.station.callsign,
    )
  ) {
    await store.db.batch([
      store.statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT tenant,attempt,'cancelled',?,'test_operation_not_exported' FROM attempt_state WHERE tenant=? AND attempt=? AND state='prepared'",
        now,
        tenant,
        id,
      ),
      store.statement(
        "UPDATE attempt_state SET state='cancelled',reason='test_operation_not_exported',updated_at=? WHERE tenant=? AND attempt=? AND state='prepared'",
        now,
        tenant,
        id,
      ),
    ]);
    return { state: "blocked", reason: "test_operation_not_exported" };
  }
  if (data.attempt.attempt_state !== "prepared")
    return { state: "skipped", reason: "attempt_not_claimable" };
  if (data.payload.kind === "lotw") {
    if (data.payload.configurationVersion !== SIGNING_CONFIGURATION)
      return { state: "blocked", reason: "lotw_signing_configuration_changed" };
    try {
      canonicalSigningData(data.payload.station, data.payload.contact);
    } catch {
      return { state: "blocked", reason: "lotw_signing_fields_unavailable" };
    }
  }
  if (data.held)
    return { state: "blocked", reason: "historical_association_read_only" };
  const authorizationMode = data.authorizationMode;
  if (!authorizationMode || !modeEnabled(gates, authorizationMode))
    return {
      state: "blocked",
      reason: "source_export_authorization_unavailable",
    };
  const operationAuthorized = () =>
    modeEnabled(gates, authorizationMode) &&
    scoped(gates, key, authorizationMode !== "source_boundary") &&
    (authorizationMode === "source_boundary" ||
      (data.connection.kind ===
        (authorizationMode === "qrz_fresh_insert" ? "qrz" : "lotw") &&
        freshInsertPayload(
          data.payload,
          authorizationMode,
          key,
          data.attempt.generation,
        )));
  if (!operationAuthorized())
    return {
      state: "blocked",
      reason: freshInsertUnavailable(authorizationMode),
    };
  const proofCheckedAt = currentTime();
  const proofExpiresAt = data.proofExpiresAt;
  if (proofExpiresAt <= proofCheckedAt || currentTime() >= proofExpiresAt) {
    await cancelStalePreparedSourceProof(store, tenant, id, currentTime());
    return { state: "blocked", reason: "source_export_proof_unavailable" };
  }
  const identity = await preparedIdentityClaim(data.payload);
  if (
    !(
      identityCurrent ??
      (await claimedAttemptCurrent(store, tenant, id, identity, currentTime()))
    )
  ) {
    if (await cancelStalePreparedSourceProof(store, tenant, id, currentTime()))
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    // A source/context refresh can invalidate the pinned proof without changing
    // the payload. Retire only known-unsent linked attempts so a fresh prepare
    // can recapture evidence; destination ownership is deliberately retained.
    await store.db.batch([
      store.statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT tenant,attempt,'cancelled',?,'outbound_identity_evidence_changed' FROM attempt_state s WHERE tenant=? AND attempt=? AND state='prepared' AND EXISTS(SELECT 1 FROM attempt_identity_claims i WHERE i.tenant=s.tenant AND i.attempt=s.attempt)",
        now,
        tenant,
        id,
      ),
      store.statement(
        "UPDATE attempt_state SET state='cancelled',reason='outbound_identity_evidence_changed',updated_at=? WHERE tenant=? AND attempt=? AND state='prepared' AND EXISTS(SELECT 1 FROM attempt_identity_claims i WHERE i.tenant=attempt_state.tenant AND i.attempt=attempt_state.attempt)",
        now,
        tenant,
        id,
      ),
    ]);
    return { state: "blocked", reason: "outbound_identity_claim_unavailable" };
  }
  const sourceContext =
    data.contextGeneration === null ||
    (deps.sourceContact?.id === data.attempt.qso &&
      deps.sourceContact.generation === data.attempt.generation &&
      deps.sourceContact.contextGeneration === data.contextGeneration)
      ? data.contextGeneration
      : await sourceExportContext(store, key, now, deps.sourceContact);
  if (sourceContext === undefined)
    return { state: "blocked", reason: "source_not_exportable" };
  const lease = leaseFor
    ? await leaseFor(data.attempt.destination)
    : await store.claim(
        tenant,
        `delivery:${data.attempt.destination}`,
        currentTime(),
        120000,
      );
  if (!lease) return { state: "skipped", reason: "delivery_lease_busy" };
  let ownershipLease: Lease | undefined;
  let ownershipExpiresAt = 0;
  let claimed = false;
  let mutationStarted = false;
  let mutationBlocked = false;
  const cohortCommand = Boolean(
    leaseFor &&
      data.payload.kind === "qrz" &&
      data.credential &&
      authorizationMode === "qrz_fresh_insert",
  );
  const retireUnsentProof = async (): Promise<DeliveryResult> => {
    // This is used only before transport begins. Return through the existing
    // fenced unsent transition before cancelling; never rewrite uncertainty.
    await store.retryUnsent(
      tenant,
      id,
      lease,
      "source_export_proof_unavailable",
      currentTime(),
    );
    await cancelStalePreparedSourceProof(store, tenant, id, currentTime());
    return { state: "blocked", reason: "source_export_proof_unavailable" };
  };
  const retryBlockedTransport = async (): Promise<DeliveryResult> => {
    if (
      !(await attemptSourceExportProofCurrent(store, tenant, id, currentTime()))
    )
      return retireUnsentProof();
    await store.retryUnsent(
      tenant,
      id,
      lease,
      "authorization_changed_before_transport",
      currentTime(),
    );
    return {
      state: "blocked",
      reason: "authorization_changed_before_transport",
    };
  };
  try {
    if (data.payload.kind === "lotw") {
      const ownership = await renewAttemptLotwOwnership(
        store,
        tenant,
        id,
        data.payload,
        currentTime(),
      );
      ownershipLease = ownership.lease;
      ownershipExpiresAt = ownership.expiresAt;
    }
    if (
      !cohortCommand &&
      !(await store.claimAttempt(
        tenant,
        id,
        lease,
        currentTime(),
        data.payload.kind === "lotw"
          ? await lotwAttemptIdentity(
              data.payload.station,
              data.payload.contact,
            )
          : undefined,
        ownershipLease
          ? { payload: data.payload, lease: ownershipLease }
          : undefined,
      ))
    )
      return { state: "skipped", reason: "attempt_not_claimable" };
    claimed = !cohortCommand;
    let state: "delivered" | "submitted" | "uncertain" | "rejected" =
      "uncertain";
    let remoteId: string | null = null;
    if (data.payload.kind === "qrz") {
      const credential = data.credential;
      if (!credential) {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return { state: "rejected", reason: "credential_revoked" };
      }
      const authorizationChecks = () => {
        const at = currentTime();
        const context = sourceContextCheck(store, key, sourceContext, at);
        const fresh =
          authorizationMode === "qrz_fresh_insert"
            ? qrzFreshInsertEligibleGuard(key, id)
            : null;
        return [
          store.statement(
            `SELECT p.envelope FROM connections d
             JOIN connections src ON src.tenant=d.tenant AND src.id=?
             JOIN private_data p ON p.tenant=d.tenant AND p.connection=d.id AND p.id=d.credential_version AND p.kind='credential'
             JOIN leases lease ON lease.tenant=d.tenant AND lease.scope=? AND lease.token=? AND lease.fence=? AND lease.expires_at>?
             WHERE d.tenant=? AND d.id=? AND d.status='active' AND d.credential_version=?
              AND d.remote_identity=? AND d.config=? AND src.status='active'
              AND src.remote_identity IS ? AND src.credential_version IS ?
              AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)`,
            data.attempt.source,
            lease.scope,
            lease.token,
            lease.fence,
            at,
            tenant,
            data.attempt.destination,
            data.attempt.credential_version,
            data.connection.remote_identity,
            data.connection.config,
            data.source.remote_identity,
            data.source.credential_version,
            Math.max(at, Date.now()),
          ),
          ...claimedAttemptChecks(store, tenant, id, identity, at, lease),
          ...(context ? [context] : []),
          ...(fresh
            ? [
                store.statement(
                  `SELECT 1 current WHERE ${fresh.sql}`,
                  ...fresh.params,
                ),
              ]
            : []),
        ];
      };
      const authorizationResult = async (
        results: D1Result<{ envelope: string }>[],
      ) => {
        if (!results.every((result) => result.results.length === 1))
          return false;
        const current = await open<QrzCredential>(
          JSON.parse(results[0].results[0].envelope) as Envelope,
          {
            tenant,
            connection: data.attempt.destination,
            id: data.attempt.credential_version,
            kind: "credential",
            purpose: "storage",
          },
          store.keys,
        );
        return (
          operationAuthorized() &&
          currentTime() < Math.min(proofExpiresAt, lease.expires_at) &&
          current?.apiKey === credential.apiKey
        );
      };
      const authorized = async () =>
        operationAuthorized() &&
        authorizationResult(
          await store.db.batch<{ envelope: string }>(authorizationChecks()),
        );
      let commandAuthorized = false;
      const command = cohortCommand
        ? {
            current: async () =>
              operationAuthorized() &&
              currentTime() < Math.min(proofExpiresAt, lease.expires_at),
            admit: async (reservation: D1PreparedStatement) => {
              commandAuthorized = false;
              if (!operationAuthorized()) throw new UnsentAuthorizationError();
              const claim = claimed
                ? []
                : [
                    store.claimAttemptStatement(
                      tenant,
                      id,
                      lease,
                      currentTime(),
                    ),
                  ];
              const checks = authorizationChecks();
              // Native guards fence the first claim and each later request in
              // the same transaction as its rate reservation. Validate the
              // returned current credential before handing anything to HTTP.
              const results = await store.db.batch<{
                envelope: string;
                window_start: number;
                cooldown_until: number;
              }>([...claim, ...checks, reservation]);
              if (claim.length) claimed = results[0].results.length === 1;
              commandAuthorized =
                claimed &&
                (await authorizationResult(
                  results.slice(claim.length, claim.length + checks.length),
                ));
              if (!commandAuthorized) {
                mutationBlocked = claimed;
                throw new UnsentAuthorizationError();
              }
              return results.at(-1)?.results[0] ?? null;
            },
          }
        : undefined;
      const client = qrzClient(
        store,
        credential,
        JSON.parse(data.connection.config) as QrzConfig,
        gates,
        { ...deps, now: currentTime() },
        {
          source: data.source,
          destination: data.connection,
        },
        command ? command.current : authorized,
        async (input, init) => {
          mutationBlocked = true;
          const validRequest = () => {
            if (authorizationMode !== "qrz_fresh_insert") return true;
            if (data.payload.kind !== "qrz") return false;
            const form = new URLSearchParams(String(init?.body));
            return (
              String(input) === "https://logbook.qrz.com/api" &&
              init?.method === "POST" &&
              init.redirect === "manual" &&
              [...form.keys()].length === 3 &&
              ["KEY", "ACTION", "ADIF"].every(
                (field) => form.getAll(field).length === 1,
              ) &&
              form.get("KEY") === credential.apiKey &&
              form.get("ACTION") === "INSERT" &&
              form.get("ADIF") === serializeAdifRecord(data.payload.record)
            );
          };
          if (
            !validRequest() ||
            !(command ? commandAuthorized : await authorized()) ||
            !operationAuthorized() ||
            !validRequest() ||
            currentTime() >= Math.min(proofExpiresAt, lease.expires_at)
          ) {
            throw new UnsentAuthorizationError();
          }
          mutationBlocked = false;
          mutationStarted = true;
        },
        authorizationMode,
        undefined,
        command,
      );
      try {
        if (
          data.payload.operation === "insert" &&
          (await client.findNeighborhood(data.payload.record)).length
        )
          throw new QrzError(
            "blocked",
            "Fresh QRZ collision appeared before dispatch",
          );
        const receipt =
          data.payload.operation === "replace" && data.payload.mappedLogId
            ? await client.replacePrepared(
                data.payload.mappedLogId,
                data.payload.record,
                data.payload.narrative,
              )
            : await client.insert(data.payload.record);
        remoteId = receipt.logId;
        state = "delivered";
      } catch (error) {
        if (cohortCommand && !claimed)
          return { state: "skipped", reason: "attempt_not_claimable" };
        if (error instanceof VendorDeferredError) throw error;
        if (mutationBlocked && !mutationStarted)
          return await retryBlockedTransport();
        if (
          !mutationStarted &&
          !(await attemptSourceExportProofCurrent(
            store,
            tenant,
            id,
            currentTime(),
          ))
        )
          return await retireUnsentProof();
        if (
          !mutationStarted &&
          error instanceof QrzError &&
          ["transient", "protocol", "rejected"].includes(error.kind)
        ) {
          await store.retryUnsent(
            tenant,
            id,
            lease,
            "qrz_readback_before_dispatch_failed",
            currentTime(),
          );
          return {
            state: "retry_scheduled",
            attemptId: id,
            reason: "qrz_readback_before_dispatch_failed",
          };
        }
        state =
          error instanceof QrzError &&
          (["rejected", "auth"].includes(error.kind) ||
            (error.kind === "blocked" && !mutationStarted))
            ? "rejected"
            : "uncertain";
      }
    } else {
      const payload = data.payload;
      const credential = await store.private<LotwCredential>(
        tenant,
        data.attempt.destination,
        data.attempt.credential_version,
        "credential",
      );
      if (!credential) {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return { state: "rejected", reason: "credential_revoked" };
      }
      let authorizeTransport: (() => Promise<boolean>) | undefined;
      const transport: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const upload = url.pathname === "/lotw/upload";
        // A narrow capability may use only the adapter's two read endpoints or
        // the exact single-artifact upload. No other mutation can bypass this hook.
        if (
          !upload &&
          !(
            url.origin === "https://lotw.arrl.org" &&
            !url.hash &&
            !url.username &&
            !url.password &&
            ["/lotwuser/lotwreport.adi", "/lotw/crl"].includes(url.pathname) &&
            (init?.method ?? "GET") === "GET" &&
            init?.redirect === "manual"
          )
        ) {
          mutationBlocked = true;
          throw new UnsentAuthorizationError();
        }
        if (upload) {
          mutationBlocked = true;
          let requestCurrent = () => true;
          {
            const form = init?.body;
            const file = form instanceof FormData ? form.get("upfile") : null;
            requestCurrent = () =>
              String(input) === "https://lotw.arrl.org/lotw/upload" &&
              init?.method === "POST" &&
              init.redirect === "manual" &&
              init.body === form &&
              form instanceof FormData &&
              [...form.keys()].length === 1 &&
              form.getAll("upfile").length === 1 &&
              form.get("upfile") === file &&
              file instanceof File &&
              file.name === "lofi-qso-ferry.tq8" &&
              file.type === "application/octet-stream" &&
              file.size > 0 &&
              file.size <= 512_000;
            if (
              !requestCurrent() ||
              !(file instanceof File) ||
              b64(new Uint8Array(await file.arrayBuffer())) !== payload.tq8
            )
              throw new UnsentAuthorizationError();
          }
          try {
            const ownership = await renewAttemptLotwOwnership(
              store,
              tenant,
              id,
              payload,
              currentTime(),
              ownershipLease,
            );
            ownershipExpiresAt = ownership.expiresAt;
          } catch {
            throw new UnsentAuthorizationError();
          }
          if (
            !requestCurrent() ||
            !authorizeTransport ||
            !(await authorizeTransport()) ||
            !(await attemptLotwOwnershipCurrent(
              store,
              tenant,
              id,
              currentTime(),
            )) ||
            !operationAuthorized() ||
            !requestCurrent() ||
            !certificate ||
            !certificateCurrentlyValid(certificate, currentTime()) ||
            currentTime() >=
              Math.min(proofExpiresAt, lease.expires_at, ownershipExpiresAt)
          ) {
            throw new UnsentAuthorizationError();
          }
          mutationBlocked = false;
          mutationStarted = true;
        }
        return (deps.fetcher ?? fetch)(input, init);
      };
      const client = new LotwClient(credential.query ?? null, {
        fetcher: (input, init) =>
          vendorFetch(store, "lotw", transport, {
            priority: deps.priority,
            now: currentTime(),
          })(input, init),
        exportsEnabled: true,
      });
      if (authorizationMode === "lotw_fresh_insert") {
        const holdUnsent = async (reason: string): Promise<DeliveryResult> => {
          await store.retryUnsent(tenant, id, lease, reason, currentTime());
          return { state: "retry_scheduled", attemptId: id, reason };
        };
        if (!credential.query)
          return await holdUnsent("lotw_query_required_for_fresh_insert");
        let history: Awaited<ReturnType<typeof checkLotwFirstInsertHistory>>;
        try {
          history = await checkLotwFirstInsertHistory(
            {
              credentials: credential.query,
              station: data.payload.station,
              contact: data.payload.contact,
            },
            {
              fetcher: (input, init) =>
                vendorFetch(store, "lotw", transport, {
                  priority: deps.priority,
                  now: currentTime(),
                })(input, init),
            },
          );
        } catch (error) {
          if (error instanceof VendorDeferredError) throw error;
          return await holdUnsent("lotw_fresh_insert_history_unavailable");
        }
        if (history.state !== "empty")
          return await holdUnsent("lotw_fresh_insert_history_present");
      }
      const certificateVersion = data.payload.certificateVersion;
      const certificate = (
        credential.signingCredentials ??
        (credential.signing ? [credential.signing] : [])
      ).find((cert) => cert.version === certificateVersion);
      if (!certificate) {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return {
          state: "rejected",
          reason: "lotw_certificate_version_unavailable",
        };
      }
      if (!certificateCurrentlyValid(certificate, currentTime())) {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return {
          state: "rejected",
          reason: "lotw_certificate_not_currently_valid",
        };
      }
      const certificateStatus = await client.certificateStatus(
        certificate.serial,
      );
      if (certificateStatus === "unknown") {
        await store.retryUnsent(
          tenant,
          id,
          lease,
          "lotw_certificate_status_unavailable",
          currentTime(),
        );
        return {
          state: "retry_scheduled",
          attemptId: id,
          reason: "lotw_certificate_status_unavailable",
        };
      }
      if (certificateStatus !== "unrevoked") {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return {
          state: "rejected",
          reason: "lotw_certificate_no_longer_usable",
        };
      }
      const beforeSubmit = await store.connection(
        tenant,
        data.attempt.destination,
      );
      if (
        !(await attemptSourceExportProofCurrent(
          store,
          tenant,
          id,
          currentTime(),
        ))
      )
        return await retireUnsentProof();
      if (
        !operationAuthorized() ||
        beforeSubmit?.status !== "active" ||
        beforeSubmit.credential_version !== data.attempt.credential_version ||
        (await store.connection(tenant, data.attempt.source))?.status !==
          "active" ||
        !(await claimedAttemptCurrent(
          store,
          tenant,
          id,
          identity,
          currentTime(),
          lease,
        )) ||
        !(await sourceContextUnchanged(
          store,
          key,
          sourceContext,
          currentTime(),
        )) ||
        !(await store.private(
          tenant,
          data.attempt.destination,
          data.attempt.credential_version,
          "credential",
        ))
      ) {
        if (authorizationMode === "lotw_fresh_insert")
          return await retryBlockedTransport();
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return {
          state: "rejected",
          reason: "connection_revoked_before_submit",
        };
      }
      authorizeTransport = async () => {
        const current = await store.connection(
          tenant,
          data.attempt.destination,
        );
        return (
          operationAuthorized() &&
          certificateCurrentlyValid(certificate, currentTime()) &&
          current?.status === "active" &&
          current.credential_version === data.attempt.credential_version &&
          current.remote_identity === data.connection.remote_identity &&
          current.config === data.connection.config &&
          (await claimedAttemptCurrent(
            store,
            tenant,
            id,
            identity,
            currentTime(),
            lease,
          )) &&
          (await sourceContextUnchanged(
            store,
            key,
            sourceContext,
            currentTime(),
          )) &&
          (authorizationMode !== "lotw_fresh_insert" ||
            (await lotwFreshInsertCurrent(store, key, id)))
        );
      };
      const result = await client.submit(unb64(data.payload.tq8), {
        liveWriteAuthorized: true,
      });
      if (mutationBlocked && !mutationStarted)
        return await retryBlockedTransport();
      state = result.state;
    }
    await store.resolve(
      tenant,
      id,
      lease,
      state,
      remoteId,
      currentTime(),
      data.payload.kind === "lotw"
        ? await lotwAttemptIdentity(data.payload.station, data.payload.contact)
        : undefined,
      state === "delivered" &&
        data.payload.kind === "qrz" &&
        data.payload.operation === "insert",
    );
    return { state, attemptId: id };
  } catch (error) {
    if (
      !mutationStarted &&
      (error instanceof LotwOwnershipUnavailable ||
        (error instanceof Error && error.message.includes("LoTW ownership")))
    ) {
      if (claimed)
        await store.retryUnsent(
          tenant,
          id,
          lease,
          "lotw_ownership_unavailable",
          currentTime(),
        );
      return { state: "blocked", reason: "lotw_ownership_unavailable" };
    }
    if (
      !mutationStarted &&
      error instanceof Error &&
      error.message.includes("historical association is read only")
    )
      return { state: "blocked", reason: "historical_association_read_only" };
    if (
      !mutationStarted &&
      error instanceof Error &&
      error.message.includes("source export proof unavailable")
    ) {
      await cancelStalePreparedSourceProof(store, tenant, id, currentTime());
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    }
    if (!(error instanceof VendorDeferredError)) throw error;
    // Only the absence of any mutation transport proves this attempt unsent.
    // A later read or admission deferral cannot undo an earlier write.
    if (!mutationStarted) {
      if (
        !(await attemptSourceExportProofCurrent(
          store,
          tenant,
          id,
          currentTime(),
        ))
      )
        return await retireUnsentProof();
      await store.retryUnsent(
        tenant,
        id,
        lease,
        "vendor_request_deferred",
        currentTime(),
        error.retryAt,
      );
      return {
        state: "retry_scheduled",
        attemptId: id,
        reason: "vendor_request_deferred",
      };
    }
    await store.resolve(
      tenant,
      id,
      lease,
      "uncertain",
      null,
      currentTime(),
      data.payload.kind === "lotw"
        ? await lotwAttemptIdentity(data.payload.station, data.payload.contact)
        : undefined,
    );
    return { state: "uncertain", attemptId: id };
  } finally {
    if (ownershipLease) await store.release(ownershipLease);
    if (!leaseFor) await store.release(lease);
  }
}
export async function reconcileAttempt(
  store: Store,
  tenant: string,
  id: string,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  const now = deps.now ?? Date.now();
  const data = await attemptData(store, tenant, id);
  if (!data)
    return {
      state: "unresolved",
      reason: "artifact_expired_or_connection_disabled",
    };
  const lease = await store.claim(
    tenant,
    `reconcile:${data.attempt.destination}`,
    now,
    120000,
  );
  if (!lease) return { state: "skipped", reason: "reconciliation_lease_busy" };
  try {
    let remoteId: string | null = null;
    let observation:
      | { confirmed: boolean; data: unknown; identity?: LotwIdentityEvidence }
      | undefined;
    if (data.payload.kind === "qrz") {
      const credential = await store.private<QrzCredential>(
        tenant,
        data.attempt.destination,
        data.connection.credential_version ?? data.attempt.credential_version,
        "credential",
      );
      if (!credential)
        return { state: "unresolved", reason: "credential_unavailable" };
      const client = qrzClient(
        store,
        credential,
        JSON.parse(data.connection.config) as QrzConfig,
        {
          exportsEnabled: false,
          liveWriteAuthorized: false,
          sourceBoundaryVerified: false,
        },
        deps,
        {
          source: await store.connection(tenant, data.attempt.source),
          destination: data.connection,
        },
      );
      const result = reconcileQrzAttempt(
        data.payload.record,
        await client.findNeighborhood(data.payload.record),
      );
      if (result.state !== "observed")
        return { state: "unresolved", reason: result.reason };
      remoteId = result.remoteId ?? null;
    } else {
      const credential = await store.private<LotwCredential>(
        tenant,
        data.attempt.destination,
        data.connection.credential_version ?? data.attempt.credential_version,
        "credential",
      );
      if (!credential?.query)
        return {
          state: "unresolved",
          reason: "lotw_query_unavailable_submission_only",
        };
      const report = await new LotwClient(credential.query, {
        fetcher: vendorFetch(store, "lotw", deps.fetcher, {
          priority: deps.priority,
          now: deps.now,
        }),
      }).query({
        startDate: data.payload.contact.date,
        endDate: data.payload.contact.date,
        stationCallsign: data.payload.station.callsign,
        workedCallsign: data.payload.contact.call,
      });
      const result = observeLotwContact(
        data.payload.station,
        data.payload.contact,
        report,
      );
      if (result.state !== "observed")
        return { state: "unresolved", reason: `lotw_${result.state}` };
      const identity = await lotwAttemptIdentity(
        data.payload.station,
        data.payload.contact,
      );
      observation = {
        confirmed: result.confirmed,
        identity,
        data: {
          station: data.payload.station,
          contact: data.payload.contact,
          projectionHash: data.payload.projectionHash,
        },
      };
      remoteId = identity.remoteId;
    }
    const applied = await store.resolveReconciled(
      tenant,
      id,
      lease,
      remoteId,
      deps.now ?? Date.now(),
      observation,
    );
    return {
      state: applied ? "observed" : "unresolved",
      reason: applied ? undefined : "reconciliation_state_or_lease_changed",
    };
  } finally {
    await store.release(lease);
  }
}

/** Refresh only compact, previously observed LoTW identities; never signs or uploads. */
export async function refreshConfirmations(
  store: Store,
  tenant: string,
  deps: DeliveryDependencies = {},
  limit = 2,
): Promise<{ checked: number; confirmed: number; unresolved: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new Error("Confirmation refresh limit must be 1–10");
  const now = deps.now ?? Date.now();
  const lease = await store.claim(tenant, "confirmation-refresh", now, 120000);
  if (!lease) return { checked: 0, confirmed: 0, unresolved: 0 };
  try {
    const rows = (
      await store
        .statement(
          "SELECT p.id,p.connection,p.created_at,a.source,a.qso,a.payload_hash FROM private_data p JOIN attempts a ON a.tenant=p.tenant AND a.destination=p.connection AND p.id='observation:'||a.id JOIN connections c ON c.tenant=p.tenant AND c.id=p.connection WHERE p.tenant=? AND p.kind='lotw_observation' AND p.revoked_at IS NULL AND c.status='active' AND p.created_at<=? ORDER BY p.created_at LIMIT ?",
          tenant,
          now - 24 * 3600000,
          limit,
        )
        .all<{
          id: string;
          connection: string;
          created_at: number;
          source: string;
          qso: string;
          payload_hash: string;
        }>()
    ).results;
    const totals = { checked: 0, confirmed: 0, unresolved: 0 };
    for (const row of rows) {
      let deferred = false;
      try {
        const evidence = await store.private<{
          station: LotwStation;
          contact: LotwContact;
          projectionHash: string;
        }>(tenant, row.connection, row.id, "lotw_observation");
        const connection = await store.connection(tenant, row.connection);
        const credential = connection?.credential_version
          ? await store.private<LotwCredential>(
              tenant,
              row.connection,
              connection.credential_version,
              "credential",
            )
          : null;
        if (!evidence || !credential?.query) {
          totals.unresolved++;
          continue;
        }
        const report = await new LotwClient(credential.query, {
          fetcher: vendorFetch(store, "lotw", deps.fetcher, {
            priority: "background",
            now: deps.now,
          }),
        }).query({
          startDate: evidence.contact.date,
          endDate: evidence.contact.date,
          stationCallsign: evidence.station.callsign,
          workedCallsign: evidence.contact.call,
        });
        const result = observeLotwContact(
          evidence.station,
          evidence.contact,
          report,
        );
        totals.checked++;
        if (result.state !== "observed") {
          totals.unresolved++;
          continue;
        }
        const updated = await store
          .statement(
            "UPDATE ledger SET confirmed=?,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND sent_hash=? AND state IN('observed','adopted_existing','delivered') AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?)",
            result.confirmed ? 1 : 0,
            now,
            tenant,
            row.source,
            row.qso,
            row.connection,
            evidence.projectionHash,
            tenant,
            lease.scope,
            lease.token,
            lease.fence,
            deps.now ?? Date.now(),
          )
          .run();
        if (updated.meta.changes && result.confirmed) totals.confirmed++;
      } catch (error) {
        if (error instanceof VendorDeferredError) {
          deferred = true;
          throw error;
        }
        totals.unresolved++;
      } finally {
        if (!deferred)
          await store
            .statement(
              "UPDATE private_data SET created_at=? WHERE tenant=? AND connection=? AND id=? AND kind='lotw_observation' AND created_at=?",
              now,
              tenant,
              row.connection,
              row.id,
              row.created_at,
            )
            .run();
      }
    }
    return totals;
  } finally {
    await store.release(lease);
  }
}
export {
  decodeTemplate,
  type QrzConfig,
  routedQrz,
  templateContext,
} from "./qrz-delivery-input.ts";
