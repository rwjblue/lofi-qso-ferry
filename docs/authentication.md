# Authentication

Status: v1 implemented with real Worker HTTP cryptographic tests and local Chromium virtual-authenticator signup/login. Physical keys, synced providers and real email delivery remain rollout checks. See [auth evidence](evidence-auth.md). Primary sources checked on 2026-10-22.

## Account contract

Registration is **email ownership confirmation followed by creation of a discoverable passkey**. Every subsequent sign-in uses a passkey. Ferry has no password, GitHub OAuth account flow, email magic-link login, or automated email account reset. Email identifies and contacts an account; possession of its inbox does not authorize access to an existing account.

Passkeys authorize dashboard access and account changes. They do not become encryption keys for connection credentials or require the user to be present for scheduled synchronization.

## Library and relying party

Use `@simplewebauthn/server` and `@simplewebauthn/browser` as the implementation candidates. Current documentation covers 14.x; the publisher's [14.0.3 package documentation](https://jsr.io/@simplewebauthn/server/doc) explicitly lists Cloudflare Workers support and an MIT license. Pin reviewed releases when implementing and verify them in the actual Worker runtime. This design is not evidence that a Ferry compatibility spike has passed.

Choose the permanent production hostname before enrolling real accounts. Configure a fixed RP ID and exact HTTPS origin allowlist, independent of incoming host headers. Development and previews use separate RP IDs, databases, and cookies. Follow the library's [RP configuration and response verification](https://simplewebauthn.dev/docs/packages/server); do not accept arbitrary origins, wildcard subdomains, or cross-origin iframe ceremonies.

## Registration

Hosted enrollment is invite only. The general landing page explains this and keeps passkey sign-in available; `/join` reveals the invited-email form. Hiding that form is not an authorization check: the server requires a live, unclaimed invitation before sending a signup code, creating registration options, and activating the account. Local development retains open signup with its browser-bound fixture mailbox.

The operator runs `mise run invite -- person@example.com`. This grants a seven-day invitation in the dedicated production D1, then sends an ordinary `/join` link using the configured Cloudflare sender. The email carries no bearer enrollment token. The recipient must still prove control of that exact address and create a passkey. The invitation is claimed by a D1 transition guard in the same transaction as the account/key/session; expiry or a concurrent claim rolls the whole transition back. Existing accounts and email changes never require another invitation, and an invitation cannot reset an existing account. Expired invitation metadata is purged; restore quarantine removes all invitations.
1. Accept an invited email and create an expiring signup transaction bound to a random, secure, HttpOnly browser cookie. Unavailable invitations return a generic invite-only response; rate-limit requests without locking an existing account out.
2. Deliver a single-use six-digit verification code in both branded HTML and plain text. Enter the code in the original signup tab within ten minutes. Store a keyed digest of the code, its expiry, and an attempt limit; invalidate replaced codes. Signup and email-change fields use `autocomplete="one-time-code"`, numeric input hints and formatted-paste support. Subjects contain the code, and the final plaintext/visible line uses `@configured-host #code`. Apple's [documented domain-bound format](https://developer.apple.com/documentation/security/enabling-autofill-for-domain-bound-sms-codes) describes SMS; using it in email is a compatibility measure, not proof of mail-client/device autofill.
3. Successful verification grants only a short-lived capability to finish that signup. It does not create an authenticated session. If the verified address already belongs to an account, direct the owner to passkey sign-in; never attach a new credential, replace credentials, or reset the account through signup.
4. Allocate an opaque random WebAuthn user handle and generate registration options bound to this verified transaction. Request `residentKey: 'required'`, `userVerification: 'required'`, and `attestationType: 'none'`. Leave authenticator attachment unrestricted so platform passkeys, password managers, and compatible security keys remain available.
5. Verify the response with the stored challenge, expected RP ID and origin, and `requireUserVerification: true`. Require ordinary user presence; this flow does not use conditional credential creation. Consume the ceremony once, enforce globally unique credential IDs, and activate the account with its first credential atomically. Only then issue a fresh authenticated session.

Email confirmation and WebAuthn challenges have separate purposes and expiries. Cancellation leaves an expiring pending signup, never an active account without a passkey. A database uniqueness constraint resolves concurrent attempts to activate the same email.

Apply the same email policy at signup and email change: trim surrounding whitespace, validate the address, and normalize its domain to a canonical lowercase form. V1 preserves and compares the local part case-sensitively. Keep the delivery/display address separately if necessary. Do not remove dots, strip plus tags, or invent provider-specific aliases.

The [SimpleWebAuthn passkey guide](https://simplewebauthn.dev/docs/advanced/passkeys) explains discoverable credentials and UV settings. Its permissive sample is not Ferry's policy: UV is required in both requested options and server verification. UV can be a device PIN, passcode, or biometric; Ferry neither receives nor stores that secret.

## Passkey-only sign-in

Offer a clear **Sign in with a passkey** action. Generate an account-independent authentication challenge with `userVerification: 'required'` and no credential allowlist. The returned discoverable credential identifies the account; the server need not expose an email-to-credential lookup.

Look up the active credential by its ID and require the returned `userHandle` to match that credential's account. Verify the assertion, challenge, RP ID, origin, presence, and UV with the library before issuing a session. Never select or switch tenants using an unverified email, user handle, or client-supplied account ID. Return a generic sign-in failure for unknown or revoked credentials.

Add conditional browser autofill as progressive enhancement, with `autocomplete="username webauthn"` and the library's `useBrowserAutofill` option. The input selects a passkey; it does not start an email login. Keep the explicit button available when conditional UI is unavailable, and cancel an outstanding ceremony before starting another. See [browser authentication and autofill](https://simplewebauthn.dev/docs/packages/browser/).

Allow the browser's native phone/security-key choices. FIDO's [cross-device authentication](https://fidoalliance.org/passkeys/) handles its QR/proximity interaction; Ferry does not implement a separate QR login protocol.

## Minimal authentication state

| Record                         | Stored values                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                        | Internal account ID, unique normalized email, email verification time, opaque stable WebAuthn user handle, status                                          |
| Passkey                        | Globally unique credential ID, account ID, public-key bytes, signature counter, backup/device flags, transports, label, creation/last-use/revocation times |
| Pending signup or email change | Intended email, bound browser/account, verification digest, attempts, expiry, consumed state                                                               |
| Invitation                     | Exact normalized email, issue/expiry times and claim time; no bearer token or verification code                                                            |
| Ceremony                       | Random ID, challenge hash, purpose, bound browser session, intended account when known, expiry, consumed state                                             |
| Session                        | Random token hash, account ID, authenticating credential ID, creation and latest passkey-verification times, expiry, revoked state                         |

The WebAuthn user handle contains no email or other identifying text and remains stable when the email changes; see [custom user IDs](https://simplewebauthn.dev/docs/advanced/server/custom-user-ids). Store only passkey public keys and metadata; the authenticator/provider retains private keys. LoTW signing keys and other service connection secrets are a separate, encrypted subsystem.

Generate challenges server-side using cryptographic randomness, preferably the library default. Retain a hash of the challenge bytes and compare it through the library's supported [challenge-verification callback](https://simplewebauthn.dev/docs/advanced/server/custom-challenges). Bind every ceremony to its purpose, browser session, and account where applicable. Use a five-minute server expiry, independent of the browser timeout. After verification, a guarded D1 transaction/batch must consume the unexpired challenge and commit the associated account, credential, or session transition together. All mutations depend on winning the single-use guard; an unguarded read followed by an update is insufficient. Concurrent submissions have one winner. A failed or interrupted attempt obtains a new challenge.

Follow [WebAuthn verification requirements](https://www.w3.org/TR/webauthn-3/#sctn-rp-operations), including rejecting reused credentials at registration and checking account ownership at authentication. Persist verified counter and backup-state updates. Zero counters are legitimate for some synced passkeys; do not impose an additional rule that every successful login must increment one. Use the library's verification semantics and handle concurrent state updates deliberately.

## Sessions and account management

Use opaque random session cookies, storing their hashes in D1. Set `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and a `__Host-` name with no Domain attribute. Rotate the session at authentication, enforce server-side expiry, and invalidate it on logout. The initial absolute lifetime is 30 days, preserving useful mobile sessions. Protect state-changing endpoints with same-origin checks and CSRF protection.

Derive the account boundary from the validated session on every request. Check authoritative session and credential status when issuing and validating sessions. Provide session listing and revocation, including “sign out other sessions.” Revocation takes effect on subsequent requests rather than waiting for cookie expiry.

Adding or revoking a passkey and changing email require a fresh passkey assertion for the same account within five minutes. Adding a key retains the same user handle and excludes registered credentials. Atomically refuse removal of the last active passkey; revoking another key also invalidates sessions established through it. Changing email requires confirmation of the new address and uniqueness checks, while retaining the account ID and all passkeys. Email confirmation alone never authorizes the change.

Security-sensitive connection changes listed in [credential security](security.md) use the same fresh-assertion policy.

## Recovery and acceptance

After signup, encourage a second passkey in an independent provider or security key. A synced passkey in 1Password can naturally remain available across devices; [FIDO describes third-party providers including 1Password](https://fidoalliance.org/passkeys-2/). Another registered passkey or the user's provider recovery can restore access without any Ferry reset. Multiple devices holding one synced credential are not independent backup credentials.

If all registered credentials and provider recovery are unavailable, **v1 cannot recover the account**. An existing browser session or verified inbox cannot enroll a replacement without fresh passkey verification. There is no hidden support email reset or recovery-code login. Explain this during setup and on the recovery-help screen.

Implementation acceptance requires:
- Confirmed email plus verified first passkey is the only account-activation path; existing-account signup cannot reset access.
- Expired, replayed, wrong-session, wrong-purpose, wrong-origin, wrong-RP-ID, missing-UV, and mismatched-user-handle responses fail; concurrent challenge submissions produce at most one successful state change.
- Cross-account credential IDs and request parameters cannot cross tenant boundaries. Session and passkey revocations are enforced.
- A synced 1Password passkey, phone/platform passkey, backup security key, explicit sign-in, and conditional autofill are exercised in the supported browser matrix against the Worker runtime.
- Adding/revoking keys and changing email enforce fresh passkey authentication; loss of all credentials follows the documented policy.
- No password, OAuth, email-login, or email-reset endpoint exists. Email delivery is separately configured and tested when implementation begins.
