# Wavelog integration evidence and boundaries

Reviewed against Wavelog **3.2.4**, tag commit
[`7f8eef4de94c674f73c6859ed4e0b0247f68dcd9`](https://github.com/wavelog/wavelog/tree/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9).
The pinned implementation is the contract reference. No Wavelog account was
contacted or modified during this work; tests inject synthetic responses.
Connection verification checks capabilities and ownership, not the installed
release number. The application does not request administrator privileges to
discover that number. Reassess these contracts when upgrading Wavelog.

## Read-only connection evidence

[`Token_resource`](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/libraries/api_v2/Token_resource.php)
returns the authenticated token's stable user ID, scopes, and expiry. Ferry
requires `station:read`, `station:write`, `logbook:read`, `logbook:write`,
`qso:read`, and `qso:write`. It requests neither delete scopes nor system
statistics access. Renewing a token for the same instance, owner, logbook, and
callsign retains the logical destination and ledger.

The selected logbook must be owned by the token account. It may be empty;
otherwise every linked station returned by the read-only inventory must match
the selected callsign. These reads establish a route, not upload acceptance or
permission to bypass Ferry's export gates.

## Station and logbook contracts

[`Station_resource`](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/libraries/api_v2/Station_resource.php)
requires station name, callsign, DXCC, CQ zone, and ITU zone. Version 3.2.4
exposes `clublog_upload` and the eQSL QTH nickname, but not arbitrary external
service credentials. Station listing respects the account's active-logbook
filter. Disable that preference so discovery can see existing locations.
Creating the first station can make it active; Ferry does not explicitly
change active selection. Station deletion also deletes its contacts, so Ferry
does not expose that operation.

Ferry derives station metadata from the source contact. Missing entity, zone,
grid, or unsupported location evidence holds delivery for review; it does not
guess defaults from the connected callsign. Station locations use the supplied
Maidenhead grid's resolution; precise latitude/longitude is not exported or
claimed synchronized. Existing locations must match the supported location and
activity fields and the passive upload policy. Conflicts remain for review
rather than causing a duplicate location or a station edit.

[`Logbook_resource`](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/libraries/api_v2/Logbook_resource.php)
enforces ownership and requires club officer privileges even for club logbook
reads. `PATCH station_ids` replaces the complete link list. Ferry reads current
links, preserves them while adding a station recorded as created by Ferry in
the provisioning journal, and verifies readback. A preexisting matching station
outside the chosen logbook requires a manual link; Ferry does not attach it
automatically.
The upstream operation has no conditional revision or atomic append contract;
external UI/API relationship edits must be serialized with provisioning.

## Contact writes, readback, and downstream policy

[`Qso_resource`](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/libraries/api_v2/Qso_resource.php)
provides owner-scoped station/date/callsign queries, pagination totals, single
contact IDs, and ADIF creation. JSON frequencies are Hz; ADIF frequencies are
MHz. An import receipt does not replace exact content and station readback.
Ferry adopts only an unambiguous compatible existing contact and preserves
uncertain outcomes until independent readback resolves them.

Frequency is required: the reviewed Wavelog importer substitutes a band-based
frequency when it is missing, which would invent source evidence. Ferry holds
such contacts instead. Comments, notes, and template narratives are excluded
from the Wavelog projection and comparison. Existing remote narrative remains
unowned and unchanged.

When source transmit power is absent, Ferry reads the station before import
and holds the contact if its default power is nonzero. The reviewed API
[exposes that default](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/libraries/api_v2/Station_resource.php#L456),
and the importer [uses it when `TX_PWR` is missing](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/models/Logbook_model.php#L5528-L5534).
A null or zero station default permits the import, whose readback must still
have no transmit power. Explicit source power is sent and compared exactly
after normalization. Station defaults are not modified.

The first implementation supports new contact creation, adoption, and
readback. Every correction to a mapped Wavelog contact is held for review.
[`Logbook_model::update_qso_columns`](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/models/Logbook_model.php)
can mark HRDLog and Club Log uploads modified after an edit; the API's QSO edit
allowlist cannot restore all passive upload flags. Moving or replacing a
contact is therefore not an automatic correction strategy.

New imports carry supported external-upload status fields set to `I` (ignore),
and newly provisioned stations disable Club Log uploads and leave the eQSL
nickname empty. Import handling for these statuses is in
[`Logbook_model::import`](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/models/Logbook_model.php).
These settings do not change existing Wavelog jobs, user preferences, station
credentials, or already stored contacts. An operator must review those existing
routes when Ferry also delivers directly to QRZ, LoTW, or Club Log. Adoption
does not retroactively change an existing contact's outbound policy.

## Network and recovery boundaries

Only canonical HTTPS installation URLs in the server's
`WAVELOG_ALLOWED_BASE_URLS` allowlist may receive credentials. The allowlist
defaults to empty. URL credentials, query strings, local addresses, and
redirects are rejected; tokens are encrypted and never included in dashboard
configuration or vendor error messages. Request budgets and cooldowns are
scoped to the normalized instance URL.

Station provisioning retains an encrypted intent before a write. Lost station
or link responses require discovery/readback before continuing. If a created
station's ID is unknown and it is hidden by the station filter, the attempt
stays held until the user makes all stations visible. A known ID permits direct
station readback during recovery.

A durable per-attempt contact-write intent distinguishes a crash before contact
submission from an unknown write outcome. Recovery may resume provisioning
when there is durable proof no contact request began. Once the request could
have begun, readback must resolve it; a retry does not assume the original write
failed. Connection renewal, source freshness, leases, rollout gates, and
source-QSO scope still govern every mutation.

Synthetic coverage checks these local safeguards. It does not verify a live
instance's proxies, user preferences, installed patches, cron behavior, or the
absence of concurrent edits. Live acceptance remains a separately authorized,
scoped rollout check.
