# Live read-only vendor evidence

Verified on 2026-10-22 using the owner's configured OS-keychain persona. Credentials were obtained through the pinned `qso-auth` runtime in captured subprocess memory. The reproducible probe emits only fixed boolean/count metadata; no credentials, returned contact values, dates, locations, narrative, raw bodies or unknown field names enter its output or repository artifacts. An earlier exploratory diagnostic incorrectly enumerated raw HTML-encoded ADIF fragments as field names and printed contact values; that output path was discarded and is covered by fixed-output regression tests.

## Reproduce

```sh
npm ci
mise run vendor-readonly -- PERSONA_NAME
# Optional date instead of deriving one from the QRZ sample in memory:
mise run vendor-readonly -- PERSONA_NAME --date YYYY-MM-DD
```

Replace the placeholders with a configured `qso-auth` persona and, optionally, one ISO calendar day. The script uses existing `qrz_logbook` and `lotw` keychain entries. It captures `mise exec pipx:qso-graph-auth@0.1.1` credential reads without displaying them. Missing credentials or unavailable vendors produce fixed false/count metadata and a failing exit status; independent available reads still run. It does not create credentials, register a vendor client, scan whole history or write D1.

The transport independently permits only QRZ HTTPS form `ACTION=STATUS`/`FETCH` and the LoTW HTTPS GET QSO report endpoint. INSERT, REPLACE, DELETE, uploads, LoFi registration/permission requests, alternate hosts and redirects are blocked. Tests exercise this boundary and prove that synthetic credential values, contact contents, vendor errors and unknown key names cannot enter the emitted metadata.

The default probe fetches one QRZ record, derives its date only in memory, then requests that one-day LoTW partition with accepted/unconfirmed records and own-station detail. It makes no follow-up QRZ page request. The pagination metadata only verifies that the calculated next cursor advances; it does not prove complete inventory coverage.

## Observed result

| Fixed metadata                                         | Result                  |
| ------------------------------------------------------ | ----------------------- |
| QRZ read completed                                     | true                    |
| QRZ sample records                                     | 1                       |
| QRZ required identity fields present                   | true                    |
| QRZ own-location fields present                        | true                    |
| QRZ narrative fields present in this sample            | false                   |
| QRZ calculated pagination cursor advances              | true                    |
| LoTW one-day report parsed completely                  | true                    |
| LoTW records                                           | 2                       |
| LoTW accepted/unconfirmed records                      | 2                       |
| LoTW confirmed records                                 | 0                       |
| LoTW required identity and own-location fields present | true                    |
| Read-only requests in reproducible invocation          | 1 QRZ FETCH; 1 LoTW GET |

The nonempty LoTW response initially exposed an ADIF framing defect: the parser rejected uncounted annotation text between data specifiers. [ADIF 3.1.6 IV.A.6](https://adif.org/316/ADIF_316.htm#ADI_Records) explicitly allows characters outside counted fields and record terminators to be ignored. The parser now follows that rule while retaining strict tag syntax, declared lengths, duplicate detection and EOR framing. Literal markup inside counted values remains data. Synthetic regression tests cover annotations and malformed/truncated records; no real record was turned into a fixture. The scoped live query then passed, including its header count and terminal LoTW EOF checks.

[ARRL's query contract](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/) describes accepted/unconfirmed reports and own-station fields. This live observation verifies the implemented read path for a nonempty scoped response. It does not establish complete owner-history coverage, zero-write adoption of the full log, fresh absence semantics, QRZ replacement/narrative preservation, certificate import, Worker-signed upload acceptance, confirmation tracking over time, or production deployment compatibility. Empty QRZ FAIL responses remain incomplete evidence until their documented/observed meaning is safely established. Production exports remain disabled.
