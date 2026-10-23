import { normalizeAdifValue, serializeAdifRecord } from "./adif.ts";
import { clublogDeliveryAdapter } from "./clublog-delivery.ts";
import {
  activeTemplate,
  certificateCurrentlyValid,
  countyLotw,
  enabled,
  type LotwConfig,
  type LotwCredential,
  lotwAttemptIdentity,
  type QrzConfig,
  type QrzCredential,
  qrzClient,
  routedQrz,
  templateContext,
  unchangedProjection,
} from "./delivery-support.ts";
import type {
  DeliveryAdapter,
  DispatchContext,
  DispatchOutcome,
  Observation,
  ObserveContext,
  ObserveOutcome,
  Preparation,
  PrepareContext,
  PreparedPayload,
} from "./delivery-types.ts";
import { LotwClient, observeLotwContact } from "./lotw.ts";
import { contactAdif } from "./projection.ts";
import type { DestinationKind } from "./providers.ts";
import { mergeQrzCorrection, QrzError, sameQrzIdentity } from "./qrz.ts";
import { comparableRemote, reconcileQrzAttempt } from "./reconcile.ts";
import { b64, canonical, randomToken, sha256, unb64 } from "./security.ts";
import {
  buildSignedTq8,
  type LotwContact,
  type LotwStation,
} from "./signing.ts";
import { renderNarrative } from "./templates.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

async function prepareQrz(ctx: PrepareContext): Promise<Preparation> {
  const { store, key, contact, gates, deps, row, connection, now } = ctx;
  const member = { id: contact.id, generation: contact.generation };
  let expectedTemplate: string | null = null;
  const config = JSON.parse(connection.config) as QrzConfig;
  if (!routedQrz(config, contact))
    return { state: "blocked", reason: "qrz_station_or_date_route_mismatch" };
  const credential = await store.private<QrzCredential>(
    key.tenant,
    key.destination,
    connection.credential_version,
    "credential",
  );
  if (!credential)
    return { state: "blocked", reason: "credential_unavailable" };
  const client = qrzClient(store, credential, config, gates, deps);
  const structured = contactAdif(contact);
  let record = structured;
  if (row.narrative !== "remote_preserved") {
    const version = await activeTemplate(store, key, row.template_version);
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
      await unchangedProjection(store, key, contact.generation, recordHash, now)
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
  } else if ((await client.findNeighborhood(record)).length)
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
    )
  )
    return { state: "skipped", reason: "transmitted_projection_unchanged" };
  const payload: PreparedPayload = {
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
  return { state: "ready", payload, template: expectedTemplate };
}
async function prepareLotw(ctx: PrepareContext): Promise<Preparation> {
  const { store, key, contact, gates, deps, row, connection, now } = ctx;
  if (!enabled(gates))
    return { state: "blocked", reason: "exports_disabled_before_signing" };
  const config = JSON.parse(connection.config) as LotwConfig;
  const routes = (
    config.stations ?? (config.station ? [config.station] : [])
  ).filter(
    (station) =>
      station.callsign === contact.stationCall &&
      (contact.dxcc === undefined || station.dxcc === contact.dxcc),
  );
  if (routes.length !== 1 || !Number.isInteger(contact.dxcc ?? routes[0]?.dxcc))
    return { state: "blocked", reason: "lotw_station_route_mismatch" };
  const route = routes[0];
  const credential = await store.private<LotwCredential>(
    key.tenant,
    key.destination,
    connection.credential_version,
    "credential",
  );
  if (!credential)
    return { state: "blocked", reason: "credential_unavailable" };
  const station: LotwStation = {
    callsign: contact.stationCall,
    dxcc: contact.dxcc ?? route.dxcc,
    ...(contact.grid ? { grid: contact.grid } : {}),
    ...(contact.state ? { state: contact.state } : {}),
    ...(contact.county
      ? { county: countyLotw(contact.county, contact.state) }
      : {}),
    ...((contact.cqZone ?? route.cqZone)
      ? { cqZone: contact.cqZone ?? route.cqZone }
      : {}),
    ...((contact.ituZone ?? route.ituZone)
      ? { ituZone: contact.ituZone ?? route.ituZone }
      : {}),
    ...(route.iota ? { iota: route.iota } : {}),
  };
  const iso = new Date(contact.startAtMillis).toISOString();
  if (contact.startAtMillis % 1000)
    return {
      state: "blocked",
      reason: "lotw_subsecond_precision_unverified",
    };
  const lotwContact: LotwContact = {
    id: contact.id,
    generation: contact.generation,
    call: contact.call,
    band: contact.band,
    mode: contact.mode,
    ...(contact.submode ? { submode: contact.submode } : {}),
    date: iso.slice(0, 10),
    time: `${iso.slice(11, 19)}Z`,
    ...(contact.frequencyMHz
      ? { frequencyMHz: String(contact.frequencyMHz) }
      : {}),
  };
  const lotwIdentityId = (await lotwAttemptIdentity(station, lotwContact))
    .remoteId;
  const { id: _id, generation: _generation, ...transmitted } = lotwContact;
  const projectionHash = await sha256(
    canonical({ station, contact: transmitted }),
  );
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
    fetcher: vendorFetch(store, "lotw", deps.fetcher, {
      priority: deps.priority,
      now: deps.now,
    }),
    exportsEnabled: enabled(gates),
  });
  if (credential.query) {
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
  const eligibleCertificates = (
    credential.signingCredentials ??
    (credential.signing ? [credential.signing] : [])
  ).filter(
    (cert) =>
      cert.callsign === station.callsign &&
      cert.dxcc === station.dxcc &&
      cert.qsoFrom <= lotwContact.date &&
      (!cert.qsoTo || cert.qsoTo >= lotwContact.date),
  );
  if (eligibleCertificates.length !== 1)
    return {
      state: "blocked",
      reason: "lotw_certificate_selection_ambiguous_or_missing",
    };
  const selected = eligibleCertificates[0];
  if (!certificateCurrentlyValid(selected, now))
    return { state: "blocked", reason: "lotw_certificate_not_currently_valid" };
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
  const signing = {
    ...selected,
    status,
    statusCheckedAt: new Date(now).toISOString(),
  };
  const artifact = await (deps.sign ?? buildSignedTq8)(
    signing,
    station,
    [lotwContact],
    new Date(now),
  );
  const payload: PreparedPayload = {
    kind: "lotw",
    tq8: b64(artifact.bytes),
    station,
    contact: lotwContact,
    members: artifact.members,
    certificateVersion: artifact.credentialVersion,
    configurationVersion: artifact.configurationVersion,
    projectionHash,
    preparedAt: new Date(now).toISOString(),
  };
  return { state: "ready", payload, lotwIdentityId };
}
async function dispatchQrz(ctx: DispatchContext): Promise<DispatchOutcome> {
  const {
    store,
    tenant,
    id,
    data,
    lease,
    gates,
    deps,
    beforeWrite,
    hasStarted,
  } = ctx;
  if (data.payload.kind !== "qrz")
    throw new Error("Invalid delivery adapter payload");
  let state: DispatchOutcome["state"] = "uncertain";
  let remoteId: string | null = null;
  const credential = await store.private<QrzCredential>(
    tenant,
    data.attempt.destination,
    data.attempt.credential_version,
    "credential",
  );
  if (!credential) {
    return { state: "rejected", reason: "credential_revoked" };
  }
  const client = qrzClient(
    store,
    credential,
    JSON.parse(data.connection.config) as QrzConfig,
    gates,
    deps,
    beforeWrite,
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
    if (error instanceof VendorDeferredError) throw error;
    if (
      !hasStarted() &&
      error instanceof QrzError &&
      ["transient", "protocol", "rejected"].includes(error.kind)
    ) {
      await store.retryUnsent(
        tenant,
        id,
        lease,
        "qrz_readback_before_dispatch_failed",
        deps.now ?? Date.now(),
      );
      return {
        state: "retry_scheduled",
        attemptId: id,
        reason: "qrz_readback_before_dispatch_failed",
      };
    }
    state =
      error instanceof QrzError &&
      ["rejected", "blocked", "auth"].includes(error.kind)
        ? "rejected"
        : "uncertain";
  }
  return { state, remoteId };
}
async function dispatchLotw(ctx: DispatchContext): Promise<DispatchOutcome> {
  const { store, tenant, id, data, lease, deps, beforeWrite } = ctx;
  if (data.payload.kind !== "lotw")
    throw new Error("Invalid delivery adapter payload");
  let state: DispatchOutcome["state"] = "uncertain";
  const remoteId: string | null = null;
  const credential = await store.private<LotwCredential>(
    tenant,
    data.attempt.destination,
    data.attempt.credential_version,
    "credential",
  );
  if (!credential) {
    return { state: "rejected", reason: "credential_revoked" };
  }
  const client = new LotwClient(credential.query ?? null, {
    fetcher: vendorFetch(store, "lotw", deps.fetcher, {
      priority: deps.priority,
      now: deps.now,
    }),
    exportsEnabled: true,
  });
  const certificateVersion = data.payload.certificateVersion;
  const certificate = (
    credential.signingCredentials ??
    (credential.signing ? [credential.signing] : [])
  ).find((cert) => cert.version === certificateVersion);
  if (!certificate) {
    return {
      state: "rejected",
      reason: "lotw_certificate_version_unavailable",
    };
  }
  if (!certificateCurrentlyValid(certificate, deps.now ?? Date.now())) {
    return {
      state: "rejected",
      reason: "lotw_certificate_not_currently_valid",
    };
  }
  const certificateStatus = await client.certificateStatus(certificate.serial);
  if (certificateStatus === "unknown") {
    await store.retryUnsent(
      tenant,
      id,
      lease,
      "lotw_certificate_status_unavailable",
      deps.now ?? Date.now(),
    );
    return {
      state: "retry_scheduled",
      attemptId: id,
      reason: "lotw_certificate_status_unavailable",
    };
  }
  if (certificateStatus !== "unrevoked") {
    return {
      state: "rejected",
      reason: "lotw_certificate_no_longer_usable",
    };
  }
  if (!(await beforeWrite()))
    return { state: "rejected", reason: "connection_revoked_before_submit" };
  const result = await client.submit(unb64(data.payload.tq8), {
    liveWriteAuthorized: true,
  });
  state = result.state;
  return { state, remoteId };
}
async function observeQrz(ctx: ObserveContext): Promise<ObserveOutcome> {
  const { store, tenant, data, deps } = ctx;
  if (data.payload.kind !== "qrz")
    throw new Error("Invalid delivery adapter payload");
  let remoteId: string | null = null;
  let observation: Observation | undefined;
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
  );
  const result = reconcileQrzAttempt(
    data.payload.record,
    await client.findNeighborhood(data.payload.record),
  );
  if (result.state !== "observed")
    return {
      state: "unresolved",
      reason: result.reason ?? "qrz_observation_unresolved",
    };
  remoteId = result.remoteId ?? null;
  return { state: "observed", remoteId, observation };
}
async function observeLotw(ctx: ObserveContext): Promise<ObserveOutcome> {
  const { store, tenant, data, deps } = ctx;
  if (data.payload.kind !== "lotw")
    throw new Error("Invalid delivery adapter payload");
  let remoteId: string | null = null;
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
  const observation: Observation = {
    confirmed: result.confirmed,
    identity,
    data: {
      station: data.payload.station,
      contact: data.payload.contact,
      projectionHash: data.payload.projectionHash,
    },
  };
  remoteId = identity.remoteId;
  return { state: "observed", remoteId, observation };
}
export const deliveryAdapters: Readonly<
  Record<DestinationKind, DeliveryAdapter>
> = {
  qrz: {
    prepare: prepareQrz,
    dispatch: dispatchQrz,
    observe: observeQrz,
    async afterResolved({ store, tenant, data }, state, remoteId) {
      if (
        state !== "delivered" ||
        data.payload.kind !== "qrz" ||
        data.payload.operation !== "insert"
      )
        return;
      await store
        .statement(
          "UPDATE ledger SET provenance='ferry_created' WHERE tenant=? AND source=? AND qso=? AND destination=? AND remote_id=?",
          tenant,
          data.attempt.source,
          data.attempt.qso,
          data.attempt.destination,
          remoteId,
        )
        .run();
    },
  },
  lotw: {
    prepare: prepareLotw,
    dispatch: dispatchLotw,
    observe: observeLotw,
    async identityEvidence(payload) {
      if (payload.kind !== "lotw") throw new Error("Invalid LoTW payload");
      return lotwAttemptIdentity(payload.station, payload.contact);
    },
  },
  clublog: clublogDeliveryAdapter,
};
