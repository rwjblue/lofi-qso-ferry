# Wavelog delivery plan

Add Wavelog as another optional destination through the provider adapters,
preserving the compact ledger and one current connection per provider. The
initial delivery scope is create, adopt, and verify. Mapped corrections and
source deletion require review; they do not mutate Wavelog history.

## Current implementation

The connection form accepts an operator-approved instance URL, API v2 token,
station callsign, and owned logbook ID. Users explicitly enable station
creation and select Ferry as the owner of external uploads for these contacts.
Verification performs only reads. Tokens are encrypted; the public
configuration contains the normalized instance, verified owner ID, callsign,
logbook ID, and policy. Reconnecting the same logical destination preserves its
ledger, while changing the account or route requires removing the current
credentials first.

Station discovery compares the supported source location and activity fields.
Complete source frequency, DXCC, CQ/ITU zones, and grid are required; missing
metadata is held for review. Station locations preserve the supplied grid's
resolution; precise coordinates are not exported. Comments, notes, and template
narratives are also excluded from Wavelog delivery. New profiles are created
only during an authorized delivery under the destination lease. A durable
encrypted provisioning record tracks station creation, logbook linking, and
recovery. Only stations recorded as created by Ferry are automatically linked;
a preexisting matching profile outside the chosen book requires a manual link.
The selected logbook's existing links are preserved; an uncertain provisioning
result is inspected before any further write. Conflicting existing station
metadata or outbound policy is never automatically changed.

Contacts use the existing immutable attempt, reservation, lease, and readback
machinery. Exact remote adoption requires compatible content and one matching
identity, including the verified numeric Wavelog ID. A durable per-attempt
contact-write intent distinguishes a crash before submission from an unknown
write outcome; unknown outcomes require readback before another contact write.
New contact imports use passive external-upload flags and stations
with Club Log uploads disabled. Every mapped correction is held because the
reviewed Wavelog edit path can reactivate downstream upload flags. See the
[pinned API evidence](evidence-wavelog.md) for the distinction between API
capabilities and this narrower supported behavior.

## Operator setup

1. Confirm the instance implements the reviewed Wavelog 3.2.4 API v2 contract.
   Configure `WAVELOG_ALLOWED_BASE_URLS` as a JSON array of canonical HTTPS
   installation bases, for example `["https://log.example.com/wavelog/"]`.
   The default `[]` permits no instance. Credentials are never sent to an
   unlisted base; subdirectory installations are distinct destinations.
2. Create an owner-scoped v2 token with `station:read`, `station:write`,
   `logbook:read`, `logbook:write`, `qso:read`, and `qso:write`. Delete and
   administrator scopes are unnecessary. A club account needs the upstream
   privileges for station and logbook management.
3. Choose an owned logbook and callsign. An empty logbook is supported. If it
   contains stations, all linked stations must be visible and match that
   callsign. Disable Wavelog's active-logbook-only station listing preference
   and acknowledge this in the connection form. The API cannot independently
   verify that preference, so this remains an explicit operator prerequisite.
   An uncertain station creation with an unknown ID stays held until all
   stations are visible; recovery can directly read a known station ID.
4. Review existing Wavelog outbound automation before enabling Ferry delivery.
   Ferry's passive import policy does not alter existing Wavelog settings or
   other contacts. Avoid parallel Wavelog logbook relationship edits during
   automatic profile creation.
5. Connect and inspect the read-only reconciliation results. Saving credentials
   does not enable exports, create stations, or import contacts. Resolve
   missing metadata, conflicting station policies, and ambiguous history first.

## Delivery stages and validation

The provider-adapter and Club Log changes form the prerequisite change (PR 2).
Their provider catalog and scoped request budgets remain shared infrastructure.
The Wavelog follow-up adds migration `0017_wavelog.sql` after migration
`0016_providers.sql`; it adds provider membership without rebuilding the
compact contact ledger. Apply migrations in order using the transaction-aware
runner. No deployed database or production configuration was changed for this
implementation.

Local validation covers URL admission and redaction, token scope and ownership
checks, route selection, renewal and revocation, automatic profile recovery,
exact adoption, source/credential races, passive imports, uncertain receipts,
and readback. Tests use synthetic credentials and intercepted vendor traffic.
The full repository check remains the release gate; passing it establishes
local behavior, not live Wavelog acceptance.

A later explicitly authorized rollout must use a scoped test contact and
confirm station metadata, preserved logbook links, imported fields, passive
outbound statuses, and final readback on the chosen instance. Existing global
export gates and source-boundary checks remain closed until their normal
requirements are satisfied. Automatic corrections need a separately reviewed
protocol that preserves downstream status, own-station metadata, and uncertain
outcomes; they are not part of this first version.
