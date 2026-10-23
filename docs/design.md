# System design

Status: v1 implementation contract, checked on 2026-10-22. The Worker, D1, adapters, signer and dashboard are implemented. Local workerd tests pass; live mutation, source-boundary and deployment checks remain gated. See [rollout checklist](rollout-checklist.md) and the evidence documents for measured limits.

## Scope and components

Ferry reads Ham2K LoFi and delivers to QRZ, LoTW and Club Log. PoLo/HaLo remain the place to log and edit contacts. The dashboard manages connections, routing, templates, and exceptions; it does not become another log editor. Multiple independent users share the service, with tenant boundaries enforced from the first release.

Start with one TypeScript Worker, D1, a five-minute Cron Trigger, and Worker Secrets. The Worker handles the web application, passkeys, source intake, bounded delivery jobs, and LoTW signing. D1 holds durable state and leases. Each scheduled invocation resumes bounded work and leaves checkpoints before exhausting its budget. Queues can be introduced when measured scale needs them; a queue, container, R2 archive, and separate signer host are not initial dependencies.

Use [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and the platform's current runtime limits. The [Workers paid plan](https://developers.cloudflare.com/workers/platform/pricing/) currently has a $5 monthly account minimum; do not treat either the free CPU allowance or zero incremental cost as proven sufficient for PKCS#12 import and signing. Measure actual workloads in the first milestone. An existing paid account may make the incremental cost small.

| Boundary               | Responsibility                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Account/authentication | Email-confirmed registration, passkey login, sessions, tenant identity                 |
| LoFi adapter           | Link account, page operations and QSOs, durable change intake, current-source reads    |
| Projection             | Effective operation/segment, normalized contact, destination-specific supported fields |
| Reconciler             | Initial history adoption, remote readback, uncertain-delivery resolution               |
| Scheduler/outbox       | Per-contact quiet period, immutable attempts, leases, retries, checkpoints             |
| QRZ adapter            | Book routing, readback, insert/replace, narrowly scoped identity cleanup               |
| LoTW adapter/signer    | Certificate/location selection, signing, submission, readback state                    |
| Club Log adapter       | Callsign routing, history adoption, merge-only uploads and exact readback              |

Keep these as modules with explicit interfaces in one application until operational evidence justifies separate services.

The browser-safe provider registry describes provider roles and capabilities.
Destination adapters own routing, supported projections, fingerprints, history
matching and remote identities. Delivery adapters own preparation, dispatch and
observation; the scheduler owns leases, immutable attempts, rollout gates and
source/credential rechecks. Adding a provider requires an adapter and a provider
catalog entry, without adding columns to the ledger. Provider-specific forms and
credential validation remain explicit. The current product still permits only
one nonrevoked account per provider.

## Source contract and reuse

Reuse the researched protocol knowledge from [qso-sidecar's LoFi client](https://github.com/rwjblue/qso-sidecar/blob/c502cecd068a6a4330afd94458e5636fa17f3a51/src/lofi.rs) and [HaLo's LoFi extension](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sync/ham2k-lofi/src/index.ts). Sidecar demonstrates browser-client registration, email permission approval, account enumeration, operation listing, and operation-QSO reads. This is a **LoFi connection flow**, separate from Ferry's passkey account authentication; do not invent an OAuth endpoint.

HaLo also uses `/v1/sync`, server synchronization timestamps, and separate cursor state. Prove the contract before selecting the polling path. Treat cursors as opaque. A device-authored `updatedAtMillis` is not a reliable server change watermark. Preserve independent operation/QSO and forward/backfill progress. An empty page with more records indicated is not completion; a repeated cursor must not cause an infinite loop or silent truncation.

Process both operation and QSO changes. Sidecar's one-page operation listing, contest-specific filtering, and simplified tombstone handling are not a complete general logger client. Preserve event rows for segment reconstruction even though they are not exported as contacts. Parse observed deletion/purge representations explicitly. Do not assume every QSO belongs to an operation: general-log entries can have a null operation ID, and selective UUID rereads for those entries have not yet been verified.

For every contact, resolve its **effective operation** using HaLo's [segment model](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/models/segments.dart). Apply segment overrides independently, respect explicit clearing values, and include a boundary-time contact in the new segment. Then apply the documented QSO-level precedence for station and location data. The composite source generation includes the QSO, effective operation, and segment inputs—not just the QSO's own revision.

Dependent jobs wait until the required operation and segment-event data for that generation are complete. A missing, purged, or partially fetched referenced operation is not a null-operation general-log contact and must not fall back to a default station/location. Operation tombstones and event edits invalidate dependent work even when QSO revisions remain unchanged.

Keep UTC timestamps to their actual precision and convert source frequency units deliberately; the inspected QSON paths use kHz while ADIF frequency fields use MHz. Derive the operator's activated POTA references from `op.refs` entries of type `potaActivation`, not the worked station's `qso.refs` entries. See [HaLo's ADIF projection](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/core/adif/src/index.ts) and the [POTA extension](https://github.com/ham2k/extensions/blob/bae00d055791be03f20f84479c810951f64ca313/extensions/activities/ham2k-pota/src/index.ts).

## Quiet period and durable delivery

The default quiet period is 30 minutes, configurable between 20 and 60 minutes. Measure it from Ferry's observation of the last meaningful change to that contact's destination-relevant source inputs. This works for offline uploads and corrected old contacts without trusting device clocks. Unrelated new QSOs or changes to another segment do not postpone an already stable contact.
1. Claim a tenant/source polling lease. Fetch a bounded page and atomically persist its affected work, necessary temporary source data, and next cursor. Never advance the cursor first.
2. Compute a versioned input fingerprint for each affected destination and its field-ownership policy. Include structured inputs and source-edit inputs consumed by the pinned QRZ narrative profile, even if they are not standalone QRZ fields; exclude note-only changes for `remote_preserved` records. Exclude polling metadata, designated render-time snapshots, and fields that destination ignores. If it changed, coalesce pending work and update that contact/destination's due time. Operation edits may require a paged reread of affected QSOs.
3. After the quiet period, validate routing and the latest composite source generation. Recheck destination absence for a first delivery, or the known mapping for a correction. Unresolved bootstrap evidence blocks only the affected record/destination. The explicit exception is LoTW without read credentials: a record established as new after the source cutover may be submitted with submission-only evidence; historical records remain unverified.
4. Prepare a validated destination projection. QRZ has three branches: an unbound record atomically binds the active version at first staging; a template-bound record uses its pinned version; a `remote_preserved` record retains fetched remote narrative and never acquires a template implicitly. Commit the policy/binding, generation/hash, and encrypted immutable outbox payload before the request. Detect actual source changes before sampling a template's `now` value.
5. Send that exact attempt. Record the response and mapping atomically. If the request may have succeeded but the response was lost, mark it uncertain and reconcile before attempting another create.
6. A newer source generation waits behind an unresolved in-flight attempt. Once its outcome is known, generate the correction using the same template binding. Never mutate a payload that may already have been accepted.

Use per-tenant/destination leases with expirations and fencing tokens, uniqueness constraints, and conditional updates. [D1 batches are transactional](https://developers.cloudflare.com/d1/worker-api/d1-database/), but they cannot make a database commit and an external request atomic. Do not hold a transaction across network I/O or promise exactly-once vendor delivery. Design retries and uncertain outcomes explicitly. Apply bounded backoff with jitter, honor vendor throttling, and isolate authentication, validation, and transient network failures.

Persist one atomic request budget and cooldown per vendor across tenants and Worker invocations. Reads, pagination, certificate/authentication requests and uploads share the budget; background history consumes a smaller allowance within it. Honor `Retry-After` on 429 and 503 without clearing cooldowns at window boundaries. Reserve scheduler capacity for forward arrivals and meaningful corrections, while retaining separate bounded history turns. Pin each prepared attempt's traffic class so historical readback remains background. Admission denial before network I/O preserves the same unsent artifact; ambiguous dispatched writes require readback. See [operations](operations.md#failures-throttling-and-revocation) for current policies and migration requirements.

## Minimal retained state

The stable ledger key is `(tenant, linked LoFi account, QSO UUID, logical destination)`. A logical QRZ destination includes the account/book; a logical LoTW destination identifies the account; a Club Log destination identifies the account and callsign log. Key rotation, certificate renewal, and reconnecting the same destination preserve that identity and its history. Migration 0016 replaces the provider-name checks in connections and request budgets with a shared provider catalog; the existing ledger is unchanged.

| Data                        | Retention and purpose                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Account, passkeys, sessions | Authentication metadata; no passkey private keys                                                                                   |
| Connections and routing     | Verified account/book IDs, certificate metadata, station/location rules, encrypted credentials                                     |
| Source progress             | Separate opaque cursors, coverage checkpoints, operation dependencies, generation tokens                                           |
| Per-destination ledger      | Source baseline/input hashes, observed remote hash, last submission hash, status, QRZ LOGID or encrypted LoTW identity, provenance |
| Narrative policy            | `unbound`, `template_bound` plus immutable version, or `remote_preserved`; null alone cannot distinguish these states              |
| Jobs/outbox                 | Due time, attempt/lease state, encrypted pending payload, exact signed artifact when needed                                        |
| Bootstrap workspace         | Bounded encrypted source/remote projections and candidate index, deleted after durable reconciliation                              |

Keep source input hashes separate from hashes of remote observations and transmitted payloads. They have different projections and cannot be compared interchangeably. In particular, adoption records an observed source baseline, not a fictional Ferry delivery. See [bootstrap](bootstrap.md).

Retain pending source material when the source cannot reread it selectively. General-log entries and current operation/segment reconstruction may need temporary encrypted buffers. Do not claim zero source storage; avoid a permanent full mirror. Once an attempt or partition resolves, retain only the ledger and essential dependencies. Template changes require no historical scan. Retention expiry of an uncertain attempt creates a reconciliation requirement, not permission to resend.

Club Log identity corrections retain compact encrypted prior-identity evidence
alongside the immutable attempt. Future matching may exclude only those proven
prior identities; unrelated nearby records still block mutation. Detailed
correction evidence expires after 90 days, while the compact identity evidence
and visible retained-record notice persist.

Before dispatch, Club Log reserves the intended identity in the existing
attempt-state row. This is ownership metadata, not proof of acceptance. History
adoption and competing attempts cannot claim another source contact's current,
retained or unresolved identity. Rejected and cancelled attempts release their
reservation; uncertain reservations survive outbox expiry until reconciled.

## Destination contracts

### QRZ

Use a logbook-specific API key; the [QRZ API setup documentation](https://www.qrz.com/docs/logbook30/api) describes the subscription and key requirement. Verify the exact station callsign, date range, and book identity during connection. Route portable suffixes explicitly, and preserve the per-contact own-location fields accepted by the adapter. A shared default station location must not overwrite the operation's actual location.

The [QRZ API](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html) provides `INSERT`, `FETCH`, and `DELETE`. `INSERT` with `OPTION=REPLACE` replaces a matching duplicate; it is not a general update-by-LOGID operation. Capture the returned LOGID rather than assuming it is stable across a replacement. Replacements can reset confirmation until the contact matches again. Prove the duplicate predicate, time precision, field preservation, and portable-location behavior in a focused adapter test.

Send an identifiable `LoFiQSOFerry/<version>` User-Agent as required by that API, and use its HTTPS form-POST endpoint. Never put the API key in a browser-visible URL or log body.

Start first deliveries and changed identities with plain `INSERT`. A duplicate response requires reconciliation; it does not authorize retrying with `REPLACE`. For unchanged identity, fetch the mapped record, establish that the API's duplicate predicate selects that expected record unambiguously, merge according to field ownership, and replace only when the supported transmitted projection changed. Fetching a known LOGID alone does not make the subsequent replacement targeted. Preserve remote-owned fields and server-managed state according to the tested API contract. Never copy server identifiers/status fields into an outgoing record simply because they appeared in a fetched ADIF file.

For an identity correction, attempt the new identity and resolve its result before cleanup. Delete an old LOGID only when Ferry-created provenance is established, the corrected record is acknowledged and mapped, the IDs differ, and a fresh read still identifies the expected old record. Adoption or replacement of a historical record does not establish that provenance. Leave adopted/unknown old identities in place and surface them. Ambiguous duplicate behavior must stop that record's mutation, not guess which contact to replace.

Adopted QRZ text stays `remote_preserved`, even during structured corrections. Fetch and preserve it when replacement semantics require a full record; transient fetch failures retry automatically. Ferry-created contacts use their original template version with current source data. [Templates](templates.md) defines this policy.

### LoTW

LoTW receives a signed TQ8 upload. A signed upload authenticates itself; website credentials are separately needed for account readback. Its [submission API](https://lotw.arrl.org/lotw-help/developer-submit-qsos/) uses multipart field `upfile`. A transport/queue acknowledgement is not proof that every QSO has been processed, and a processed QSO is not necessarily a confirmed QSL.

Track at least `submitted` and `observed` distinctly, with confirmation as separate optional metadata. Use the [query API](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/) to verify acceptance and reconcile uncertain results. Queries must include accepted unconfirmed QSOs. Observation must compare the particular attempt's identity and supported readback-visible projection, including location; an older record with the same identity cannot acknowledge a later correction. Report verification coverage where a transmitted field is not exposed by readback, and do not represent identity presence as proof of that revision. Resolve outcomes per QSO when only part of a batch is accepted. Without read credentials, report submission evidence honestly and leave historical adoption unverified.

LoTW's [correction rules](https://lotw.arrl.org/lotw-help/submitting-qsos/) distinguish an existing QSO from a changed callsign/date/time/band/mode identity. Resubmitting supported nonidentity data can update an existing record; identity changes can create another QSO, with the old one retained. Award-linked records can restrict changes. Keep the last submitted identity so the dashboard can explain these outcomes; do not pretend LoTW supports deletion or arbitrary UUID-based updates.

The [supported signed record fields](https://lotw.arrl.org/lotw-help/developer-submit-qsos/) do not provide a general COMMENT/NOTES/QSLMSG or POTA-reference channel. A QRZ comment-only change therefore produces no LoTW work. Transmit supported station/location data with the appropriate certificate, preserving grid and relevant subdivisions. Multiple locations are station data, not separate Ferry login sessions; see [LoTW callsigns and locations](https://lotw.arrl.org/lotw-help/multiple-callsigns-locations/).

### Club Log

Use one account email, application password and callsign log, plus the deployed
application's `CLUBLOG_API_KEY`. Verification reads the bounded ADIF export; it
does not establish upload authorization or validate the application key. Route
only the exact verified station callsign. New forward contacts use the realtime
endpoint; history uses merge-only batch uploads under a separate background
allowance. Never send the API's clear-log option.

Adopt exact historical matches without writing. Every upload, including an
acknowledged realtime request, remains submitted until supported fields match
readback. Unknown mutation outcomes retain their immutable payload and require
reconciliation before another create. A non-200 response suspends the affected
connection; it does not establish that a dispatched write failed.

Changed identities may append a corrected record and visibly retain the prior
record. Same-identity changes to frequency, operator or reports require review
because duplicate upload is not a verified update contract. The adapter exposes
no remote delete, confirmation refresh or narrative template support. Own
location and park-reference changes therefore create no Club Log work.

The initial bounded export supports at most 2 MiB and 10,000 records. Unsupported
submodes and subsecond source times block only this destination. See
[Club Log evidence](evidence-clublog.md) for protocol sources, test coverage and
remaining live-contract validation limits.

### Direct Worker signing

[Wavelog's LoTW controller](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/controllers/Lotw.php) and [signed export builder](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/views/lotw_views/adif_views/adif_export.php) demonstrate direct certificate import, canonical signing, TQ8 construction, gzip, and upload without launching TQSL. That is evidence for the approach, not proof of Ferry's Worker compatibility or a storage design to copy.

Implement the LoTW signing protocol behind a pure, fixture-tested module: validate certificate authorization; group contacts by certificate and effective station location; construct the versioned `tCERT`, `tSTATION`, and `tCONTACT` records; canonicalize exactly; sign the required `SIGN_LOTW_V2.0` data; gzip and upload. The inspected implementation uses RSA PKCS#1 v1.5 with SHA-1 for this legacy protocol. Confine that algorithm to LoTW compatibility; do not use it for application hashing or encryption.

A multi-contact TQ8 has one immutable batch attempt: exact member UUIDs, source generations/identities, certificate and signing-configuration versions, and encrypted signed bytes. Commit membership and member attempt states together before submission. Retry or reconcile that artifact unchanged; a member edit or certificate renewal cannot regenerate an uncertain batch. Readback resolves individual members. A one-contact artifact is a valid first implementation until these batching semantics are in place.

Workers provides [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) and [gzip streams](https://developers.cloudflare.com/workers/runtime-apis/web-standards/). The spike must prove actual key import/signing support, legacy and modern PKCS#12 parsing, certificate metadata, canonical byte construction, station-field order, accepted modes/locations, bundle size, and CPU cost. Use generated keys plus native TQSL/reference output as development fixtures where appropriate. Do not claim live ARRL acceptance from an offline signature comparison.

Maintain the signing-field/mode/location configuration as a versioned dependency. Retain required upstream notices. The user will pursue ARRL partner coordination independently; the intended deployment remains one hosted unattended signer. Credential import and encryption are specified in [security](security.md).

## User experience and operational boundaries

Signup is email confirmation followed by passkey creation; all later login uses passkeys. The [authentication contract](authentication.md) covers multiple credentials and the explicit v1 recovery boundary. LoFi linking, QRZ keys, LoTW certificate/read credentials and Club Log application passwords are service connections, not alternative Ferry login methods.

Show last source poll, pending quiet-period work, adopted history, submitted/observed deliveries, and actionable exceptions independently per destination. Prefer aggregate counts and short redacted explanations; fetch detailed contact context when needed. A bad certificate or ambiguous historical match must not pause unrelated users or contacts.

The current product permits one nonrevoked connection per optional service, while retaining the data model and history of existing additional destinations. Pausing retains that service slot; same-identity credential renewal preserves history, and removing credentials permits linking another account. No service is required for saving account settings or template defaults. LoFi account labels are vendor-provided names. Source ingestion counts and bounded retained-source previews are independent of destination delivery counts; previewing current saved templates never binds a version or changes adopted narrative.

On first connection, perform [history reconciliation](bootstrap.md) while establishing durable source change intake. Already uploaded contacts are adopted without writes. Missing current identities enter normal delivery only after complete evidence and a fresh check. Destinations can finish at different times.

Source tombstones cancel unsent work. For already delivered contacts, v1 records deletion locally and exposes retained remote state; it does not propagate broad remote deletes. The narrow QRZ identity-correction cleanup above is a separate, provenance-checked operation. Identity corrections, ambiguous history, and destination restrictions must be visible without adding an operation-release step to ordinary logging.

Initial scope excludes two-way editing, contest Cabrillo generation, historical template reformatting, a full log archive, and automatic account recovery by email. Those exclusions keep the first implementation focused on dependable live delivery and safe adoption of the history already present.
