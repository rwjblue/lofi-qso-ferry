# LoFi adapter evidence

Checked 2026-10-22. No live account, permission, inventory, or mutation request was made. Fixture results establish Ferry behavior, not server compatibility or production coverage.

The protocol references are [Sidecar's browser registration and operation reads](https://github.com/rwjblue/qso-sidecar/blob/c502cecd068a6a4330afd94458e5636fa17f3a51/src/lofi.rs), [HaLo's transport](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sync/ham2k-lofi/src/index.ts), and [its sync engine](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/sync/sync_engine.dart). These are client implementation evidence; public server retention and replay guarantees were not found.

## Implemented contract

`LoFiClient` registers a stable `browser:` identity at `POST /v1/client`, sends the existing permission approval flow at `POST /v1/client/permissions`, and verifies `current_account.uuid` through `GET /v1/accounts`. A protected request renews a rejected bearer once using the same identity. It does not replace a refused client identity or silently connect a different account. Callers must encrypt and durably save `credentialsSnapshot()` when its token changes. Registration/approval are separate from Ferry account signup.

Read intake uses `POST /v1/sync` with only `meta.inboundSync` and `meta.sync`; no operations, QSOs, or claims are uploaded. Backfill windows carry `syncedUntilMillis`, `anyClient: true`; forward windows carry `syncedSinceMillis`, `anyClient: false`, following the inspected client. Operation and QSO cursors/watermarks are independent. `next_cursor`/`nextCursor` remain opaque. Forward and backward cursor state are never reused across directions.

Only the server-authored `syncedAtMillis` advances watermarks. Cursor pages retain a one-millisecond overlap in their fallback watermark so equal-timestamp rows can be replayed. Missing record UUIDs or timestamps fail the whole page. Explicit `records_left`/`recordsLeft: 0` establishes page completion; a short page does not. Empty cooldown pages with more history preserve their cursor. Repeated nonterminal cursors and server pagination errors require reconciliation. HTML, malformed records, redirects, unexpected account IDs, and oversized responses cannot establish coverage.

`syncPage()` returns records and a new checkpoint together without changing the supplied state. The caller must commit both atomically under its source lease; an external fetch cannot itself provide database atomicity. UUID-scoped upserts make replay harmless. Tests serialize/recreate the client between pages and cover tied timestamps, empty pages, refusals, and renewal. All endpoints are fixed to `https://lofi.ham2k.net`; templates/settings cannot select a credential-bearing fetch host.

## Effective contact context

The segment rules come from [HaLo's segment model](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/models/segments.dart). A `band: event` row whose `event.event` is `start` or `break` can open a segment. Its allowed overrides apply independently over the base operation. A contact exactly at a boundary uses the new segment. Missing keys fall back to the base; explicit nulls and empty reference arrays clear values. Stops, deleted events, and purges do not open segments. Two opening events at the same instant block the affected projection because inspected code does not establish a stable tie-breaker. QSO-level location replaces the grid/coordinate group as a unit.

Projection uses the effective operation's `potaActivation` references for own parks and QSO `pota` references for worked parks. It converts QSON kHz to MHz explicitly, preserving fractional seconds. An operation-only change changes each affected contact's generation. An edit to a later segment leaves earlier projections unchanged. Operation running totals/end-of-log snapshots and synchronization metadata do not trigger work. LoTW fingerprints exclude narrative and park-only changes; `remote_preserved` QRZ fingerprints exclude narrative inputs.

The normalization is independently implemented from the documented wire behavior; no MPL application/exporter source was copied. Unknown mode mappings and inconsistent band/frequency pairs block projection. A comma-separated multi-station segment requires an explicit routing decision rather than silently selecting one callsign.

## Unverified boundaries and required inputs

- Supply a deliberately approved LoFi browser connection and a synthetic operation/general-log dataset to verify server responses, operation/QSO cursors, `anyClient` behavior, historical edits, equal-time pages, tombstones, account renewal, and cursor invalidation. The current code exposes `coverage: client-contract-only` until this is established.
- Client code supplies no immutable snapshot token or documented cursor retention interval. A completed inventory alone is insufficient evidence for historical absence. Keep coverage-dependent backfill disabled until a live source cutover/replay experiment establishes the necessary boundary; overlapping rescans are mitigation, not proof of a snapshot.
- Null-operation QSOs are represented and projected when they contain their own station context. A selective UUID reread endpoint was not established. Preserve their encrypted records temporarily within the configured retention ceiling while work remains unresolved; expiry must produce a visible reconciliation exception.
- A non-null operation cannot be projected until the current operation and its complete event timeline have been obtained. Missing/purged/partial context must not fall back to a default station. Re-fetching an operation's paged QSOs can recover event context; the required operation-QSO endpoint is shown by Sidecar, but this adapter intentionally uses the single sync pull path pending live validation.

Reproduce focused checks with `npx tsx --test tests/lofi.test.ts tests/projection.test.ts`. They use synthetic records and injected fetch responses; they do not establish live LoFi behavior.
