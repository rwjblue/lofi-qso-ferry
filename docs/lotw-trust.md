# LoTW certificate trust

Ferry ships reviewed ARRL trust anchors. All checked-in environments use
`LOTW_TRUST_ROOTS_JSON=bundled`; users do not supply or configure CA certificates.
An imported `.p12` supplies a leaf and possible intermediate certificates, never
new trust anchors. An explicit JSON PEM array overrides the release bundle for
private deployments; `[]` deliberately disables trust and invalid overrides fail
closed for LoTW.

## Provenance

Verified 2026-10-23. The current root was obtained directly from the fixed HTTPS
endpoint `https://lotw.arrl.org/lotwuser/certs.tq6` using an existing LoTW account's
read credentials. ARRL documents this download in its [certificate acceptance
instructions](https://lotw.arrl.org/lotw-help/certaccept/?lang=en). Only the public
root was retained; credentials, user certificates and private keys are not bundle
data. The root's CA flag, self-signature and SHA-256 fingerprint were checked, and
the imported leaf and Production CA signatures verified to this independently
downloaded root. Its validity is 2023-06-28 through 2033-06-25.

Two historical anchors come from ARRL's official TQSL source at revision
`aeb2dc774c46a6857a49611c4aca8ed514a2cb36`,
[`src/location.cpp`](https://sourceforge.net/p/trustedqsl/tqsl/ci/aeb2dc774c46a6857a49611c4aca8ed514a2cb36/tree/src/location.cpp?format=raw).
They retain compatibility with existing LoTW certificates. The upstream notice is
preserved in [TQSL-LICENSE.txt](../fixtures/signing/TQSL-LICENSE.txt).

| Anchor                   | SHA-256 fingerprint                                                |
| ------------------------ | ------------------------------------------------------------------ |
| Current Root CA          | `0fb96275eaca03ef29ff509d9e545b1f3861f4468f0687becc593ed00604b2e6` |
| Historical Root CA       | `2e35f96ef18626dc901a2cf31bfb56dafadc7030d733d9b307d0db8e87c79a0f` |
| Historical Production CA | `a689d0b4edc4f1afdd2c62c501c8136e1f354c9d7ded064d91c9d62af8bdec93` |

These exact certificates are pinned in `src/lotw-trust.ts` and their fingerprints
are regression tested. Root rotation can retain the same issuer name, so parent
selection requires a valid signature as well as the name. Trust anchors are
inputs to path validation under [RFC 5280 section
6.1.1](https://datatracker.ietf.org/doc/html/rfc5280#section-6.1.1); their certificate
expiry is not a path expiry. User certificates and all unpinned intermediates must
remain current. CA constraints, signing usage, unknown critical extensions and
every path signature are checked. An uploaded self-signed CA is never trusted.

[Wavelog's LoTW importer](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/controllers/Lotw.php#L399-L488)
opens the PKCS#12 and extracts certificate data without a manually configured CA
list. Ferry additionally verifies issuer signatures against its release bundle.

## Updates and saved connections

Update the versioned bundle as release data when ARRL rotates its roots. Obtain
new roots from ARRL's authenticated HTTPS certificate download, verify their CA
properties and signatures, review fingerprints, and update the pinned data,
bundle version and regression test together. Never approve a root merely because
it appears in a user upload, a matching issuer name, or a successful serial-status
lookup. TQSL's source fallback bundle alone can lag current ARRL issuance.

Every scheduled run rechecks a bounded, oldest-first batch of saved certificate
chains against current anchors. It refreshes ARRL status after twelve hours, with
at most two status requests per run and shared vendor cooldowns. Public evidence
is updated without rewriting keys or credential versions; pauses, removals,
rejected logins and concurrent renewals are preserved. Existing imports need no
new `.p12` upload after a trust update. Signing and submission independently
revalidate the current chain and check ARRL status before a vendor write. Export
rollout gates still apply.
