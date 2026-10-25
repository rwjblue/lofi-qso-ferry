# Credential security and retention

Status: implemented v1 contract, locally verified with tenant isolation, envelope rotation and restore-quarantine tests. See [operations](operations.md) for deployment controls. Ferry intentionally holds credentials that permit unattended delivery. The goal is to protect stored material, isolate users, and constrain its use while making that trust boundary explicit.

## Secrets and trust boundary

Protect LoFi client credentials, QRZ logbook keys, LoTW signing private keys, and optional LoTW query credentials. Treat pending source records, location data, reconciliation evidence, and outbound payloads as private user data too. A passkey's private key stays with the user's authenticator; it is distinct from the LoTW private key entrusted to Ferry.

Use Cloudflare Worker Secrets for a versioned application key-encryption key (KEK), email-provider credentials, and independent application authentication secrets. D1 contains encrypted credential records and wrapped data-encryption keys (DEKs), never a plaintext KEK. Cloudflare documents Secrets as [encrypted bindings accessible to running Worker code](https://developers.cloudflare.com/workers/configuration/secrets/).

This protects against disclosure of a D1 export or backup alone. Compromise of the running Worker, its deployment authority, or both storage and KEKs can expose or misuse service credentials. This is not a zero-knowledge design. Do not derive the unattended encryption key from a passkey, email address, callsign, or password the user must enter at every scheduled run.

## Envelope format

Use reviewed platform cryptography rather than a custom cipher. The following is the implemented envelope, following the [envelope-encryption model](https://docs.cloud.google.com/kms/docs/envelope-encryption) and using [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/):
1. Generate a fresh random 256-bit DEK for each credential version or private-payload write.
2. Encrypt the payload with AES-256-GCM, a fresh random 96-bit nonce, and a 128-bit authentication tag.
3. Authenticate canonical additional data containing the tenant UUID, logical connection/destination ID, credential or payload ID, kind, schema version, and purpose. Moving ciphertext to another tenant or purpose must fail authentication.
4. Wrap the DEK with the selected KEK using AES-256-GCM, an independent fresh nonce, and wrapping-specific additional data binding the same identity and KEK version.
5. Store ciphertext/tag, payload nonce, wrapped DEK/tag, wrap nonce, algorithm/schema versions, and KEK version. Store nonsecret status and certificate metadata separately as needed.

Generate nonces with cryptographic randomness; never derive them from QSO IDs, clocks, or counters that can reset. Rotate the KEK by rewrapping DEKs, preserving the payload and its identity-bound additional data. During rotation, accept only the explicitly configured old and new key versions; new writes use the new version. Test interrupted rotation and restore before retiring old keys.

Random encryption keys do not require a password salt. A salt is relevant to password-derived keys, including the imported PKCS#12 file's existing protection. Verify that format properly instead of using a fixed password as database encryption. Keep application hash functions on SHA-256 or a reviewed stronger choice; the legacy signature required by LoTW is a separate, narrowly scoped compatibility concern.

## LoTW certificate import

Import a PKCS#12 `.p12` containing the user's certificate and matching private key. A certificate-only `.tq6` cannot provide the signing key; see [LoTW files](https://lotw.arrl.org/lotw-help/files-icons/). Require a fresh passkey assertion for import, replacement, or removal, as described in [authentication](authentication.md).

Parse in the Worker with bounded input size and work. Validate PKCS#12 integrity/MAC, key/certificate correspondence and algorithm support. LoTW validates certificate authority when processing a signed upload; Ferry does not maintain a signing-CA trust store. Local preflight checks must not claim ARRL issuance or upload acceptance. Extract and validate callsign, DXCC, certificate validity, and the separately encoded authorized QSO date range. Check certificate revocation/supersession status through the verified LoTW mechanism; unknown status must not be silently represented as valid. Never infer station location solely from the callsign certificate. Test encrypted legacy and modern PKCS#12 files, incorrect passwords, missing keys, unexpected extra keys, malformed ASN.1, and expired, revoked, superseded, or otherwise unsuitable credentials.

Normalize the selected key to PKCS#8 and retain the necessary certificate chain inside the encrypted envelope. Discard the original import password and original PKCS#12 bytes after successful import by default. Do not log either representation. JavaScript does not provide a guarantee that every temporary copy has been zeroized; minimize its lifetime and avoid persistent or global caches of decrypted keys.

Certificate renewal creates a new credential version without resetting the destination's delivery ledger. Select certificates by exact station callsign, DXCC, and permitted QSO dates. Keep an in-flight signed artifact immutable; retiring a credential must not silently regenerate an uncertain submission under different signing inputs.

## Runtime access and tenant isolation

Derive the tenant from a validated session for user requests and from a claimed, tenant-scoped durable job for scheduled work. Include the tenant in every connection, credential, QSO, destination, template, and job lookup. Composite constraints and repository helpers should make unscoped access difficult; tests must attempt cross-tenant references explicitly.

Passkey authentication does not authorize choosing an arbitrary source or destination account ID. Link and verify each LoFi account and each destination through its own credential flow. Replacing a key must prove it refers to the intended logical destination before reusing mappings. Require recent passkey verification for connection changes, credential exports if ever added, account deletion, and other security-sensitive settings.

Decrypt only for the operation that needs a secret. Keep credentials out of template contexts, browser responses, analytics, logs, traces, error messages, and dead-letter metadata. LoTW query authentication appears in request parameters; redact the complete credential-bearing URL and avoid middleware that records outbound URLs. Allow only configured vendor hosts and endpoints; user templates and connection settings cannot introduce arbitrary fetch URLs.

Restrict production deployment and secret access, separate preview/prod databases and keys, and use independent application secrets for session/code authentication. Staging fixtures must use synthetic contacts and generated test keys. Never commit personal certificates, tokens, imported logs, or private diagnostic payloads.

## Retention, revocation, and deletion

Keep encrypted credentials only while the connection requires them. Disabling a connection prevents new work; revocation/deletion cancels unsent work and removes credential material according to the documented lifecycle. Recheck connection and credential status immediately before signing or submission. An already-dispatched request may still finish remotely; revocation cannot recall it. Already accepted third-party contacts remain governed by the destination's behavior. Account removal must not issue mass remote deletes.

The long-lived delivery ledger contains minimal IDs, associations, versioned hashes, template bindings or preservation policy, and compact encrypted identity evidence. Bounded source/remote indexes exist only while a bootstrap partition is unresolved. Active outbox payloads and signed TQ8 files are purged after a successful durable checkpoint. Migration `0038` separately captures the original encrypted outbox for recovery, atomically with its attempt. These immutable copies keep the original storage AAD and seven-day expiry; delivery does not extend their lifetime. Expiry cleanup removes them, and they never authorize dispatch or retry. Already purged legacy bodies cannot be reconstructed.

Set explicit retention ceilings during implementation for unfinished indexes and parked attempts. Expiring a payload must leave an unresolved state requiring reconciliation; it must never turn an uncertain upload into “missing” and trigger a blind second write. Preserve immutable template versions referenced by ledger rows. Redact contact details from routine operational metrics.

Deleting live ciphertext does not instantly remove historical backups. Document backup retention and key-retirement consequences, and exercise a restore that cannot resume revoked connections or replay completed uploads. Retained attempt artifacts preserve their original envelopes and are not rewrapped by ordinary private-data rotation. Keep every referenced KEK until the artifacts and retained backups have expired. Restore a complete SQL snapshot into a fresh isolated database before quarantine; importing terminal artifact rows into an existing schema with active insertion guards is not the supported recovery path.

## Acceptance criteria

- D1-only access yields no plaintext service credentials or private pending payloads; modifying ciphertext, tenant binding, or purpose fails authentication.
- KEK rotation, credential renewal, crash recovery, and connection revocation preserve delivery identity and do not create duplicate work.
- Two tenants using identical source UUIDs cannot read, sign with, route through, or modify each other's data.
- Logs and errors contain no passwords, private keys, tokens, raw QSO payloads, or credential-bearing URLs.
- Pending-data expiry and restored backups require reconciliation before any uncertain remote action.
- LoTW signing uses the intended certificate/location only; passkeys remain dashboard credentials and never become hosted signing keys.
