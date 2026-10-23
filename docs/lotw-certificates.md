# LoTW certificate and login checks

Ferry follows Wavelog's direct-signing model: it checks the imported certificate
and private key, signs contacts, and lets LoTW validate certificate authority when
processing the upload. Ferry has no ARRL CA bundle, custom certificate-path
validator, root download, or root-refresh configuration. The platform's normal
system CA verification still protects every HTTPS connection to ARRL.

## What the checks establish

- **Certificate imported:** the `.p12` integrity MAC and export password were
  accepted, it contains exactly one matching supported RSA private key and
  certificate, and the LoTW callsign, DXCC, key usage and date fields are usable.
  Certificate validity, QSO-date authorization and station matching are checked
  before signing. Current certificate validity is checked again before dispatch.
- **Website login verified:** an independent read-only LoTW query accepted the
  saved username/password. The `.p12` export password is separate from this login.
  Optional readback credentials enable history adoption and result reconciliation.
- **Serial status checked:** ARRL reported the certificate's serial as unrevoked.
  Signing requires fresh status evidence. This lookup does not authenticate the
  certificate's issuer, callsign or website-account membership.

These are preflight checks. They do not establish that ARRL issued the imported
certificate or that LoTW will accept a signed upload. Before submission the UI
states that upload acceptance has not been verified. A queue acknowledgement
means **submitted**; exact subsequent readback establishes **observed acceptance**.
QSL confirmation is separate. Unknown responses stay uncertain and cannot
trigger blind retries. Certificate import never submits a contact.

Without website credentials, a `station:<CALL>:<DXCC>` route uses the station
identity claimed by the imported certificate. It does not prove LoTW account
membership. Adding verified query credentials requires the existing reconciliation
boundary; local certificate metadata cannot grant access to another Ferry tenant.

## Saved connections and maintenance

Existing encrypted credentials remain usable without reimport. Old `trusted`,
`chainPem` and trust-check timestamps are ignored. Bounded scheduled maintenance
refreshes public certificate date/serial-status evidence without rewriting keys
or credential versions. Paused, disabled and removed connections remain so;
explicitly rejected website logins and unsuitable certificate status still
require attention. All export authorization and source/history gates remain.

Migration 0014 removes only the obsolete shared public-root cache. Migration 0013
is retained in migration history so existing and fresh databases upgrade normally.
No private credential data is removed or rotated.

## References

[Wavelog certificate import, status checks and upload implementation](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/controllers/Lotw.php)
and [ARRL signed-upload documentation](https://lotw.arrl.org/lotw-help/developer-submit-qsos/)
describe the upstream behavior. See [signing evidence](evidence-signing.md) for
local compatibility checks and the remaining scoped live-acceptance work.
