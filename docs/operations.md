# Operations and personal rollout

All checked-in environments disable exports. Local tests and synthetic signatures establish implementation behavior; live source replay, QRZ mutation preservation and ARRL acceptance still require the inputs below. Deployment alone must not change real logs.

## Current production target

On 2026-10-22 the operator selected `https://ferry.n1rwj.com`, with RP ID `ferry.n1rwj.com`, in Cloudflare account `478f5e15ae2afa01364d19f42a3e06f2` using its existing Workers Standard usage model. Dedicated D1 `ferry-production` (`45ad64ad-92bb-491a-b6e6-1d2b17450144`) has all nine migrations applied. The Worker `lofi-qso-ferry` is deployed read-only at the selected hostname. Its version, deployed revision and live endpoint checks are recorded in [deployment evidence](deployment.md).

Production uses the native Cloudflare `EMAIL` binding restricted to `signup@ferry.n1rwj.com`, with that address in `MAIL_FROM`. Sending domain `ferry.n1rwj.com` (`e69af8ef82a140b38eeaef98d417ef30`) is enabled and its `preview_enabled=false` setting was read back. Cloudflare and Google DNS-over-HTTPS both resolved its bounce MX/SPF, DKIM and DMARC records; the parent domain's Fastmail MX records remain unchanged. One verification message was delivered to the owner’s Fastmail inbox through the live signup form. The initial smoke test created no account. Hosted enrollment is now invite only; existing users retain their passkeys and sessions.

Independent `KEK_V1`, `AUTH_SECRET` and `EMAIL_CODE_SECRET` secrets have been provisioned. Their protected local backup is `~/.config/lofi-qso-ferry/production.secrets.json` (file mode `0600`, directory `0700`); 1Password CLI was signed out, so that backup remains necessary until secure secret-manager storage is completed. Never print its contents or commit it. Preserve these keys when resuming deployment rather than generating replacements.

The production configuration keeps `EXPORTS_ENABLED=false`, `ROLLOUT_CHECKS_PASSED=false`, `SOURCE_BOUNDARY_VERIFIED=false`, `LIVE_WRITE_AUTHORIZATION` empty and `ROLLOUT_QSO_IDS_JSON=[]`. Production `workers.dev` and preview URLs are disabled. The staging placeholder is intentionally undeployed.

## Prepare a disabled deployment

1. Set the permanent HTTPS hostname as the exact `ORIGIN` and hostname-only `RP_ID` in the production environment of `wrangler.jsonc` before real passkey enrollment. The selected target above is already configured. Use separate D1 databases, keys, RP/origins and cookies for local/staging/production.
2. For a new target, create its Cloudflare D1 resource and replace that environment's placeholder ID; do not recreate the prepared production database or deploy staging merely to complete this checklist. Keep `EXPORTS_ENABLED=false`, `ROLLOUT_CHECKS_PASSED=false`, `SOURCE_BOUNDARY_VERIFIED=false` and `LIVE_WRITE_AUTHORIZATION` empty, and `ROLLOUT_QSO_IDS_JSON=[]`. Configure the five-minute cron and review paid-plan CPU limits before certificate import.
3. Configure native [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/configuration/subdomains/) for a dedicated sending subdomain, set `MAIL_FROM`, and restrict the `EMAIL` binding with `allowed_sender_addresses`. Sending uses its own bounce/authentication records; leave existing inbound MX records intact. Disable activity-log email previews before sending signup codes. This target needs no Resend key. Other deployments without an `EMAIL` binding can use the optional [Resend sender path](https://resend.com/docs/dashboard/domains/introduction) with verified DNS and a restricted `RESEND_API_KEY`; a native send failure never triggers a second send through Resend. Use independent random `KEK_V1`, `AUTH_SECRET` and `EMAIL_CODE_SECRET` secrets with a protected backup. Never commit or paste them into issue reports, command arguments or logs.
4. Review [certificate and login checks](lotw-certificates.md), [signing evidence](evidence-signing.md), current mode/location configuration, dependency advisories and representative deployed CPU/memory measurements. Ferry checks the `.p12`, matching key, dates and current serial status; LoTW validates certificate authority when processing an upload. There is no ARRL root configuration or updater. Normal system CA verification protects HTTPS.
5. Build, review the disabled configuration, migrate the intended remote database and deploy only when authorized:

```sh
mise run check
mise run deploy-readonly
```

For a new target, provision each required application secret with `npx wrangler secret put SECRET_NAME --env production`, which prompts securely, before deployment. Only the optional Resend path needs its API key. The guarded task builds assets, checks all export gates are closed, applies outstanding migrations to the dedicated database and deploys production. It refuses an open gate or an unconfigured production origin/database. The resource record above and [deployment evidence](deployment.md) identify the completed deployment. Confirm `/health` reports exports disabled, and test production email delivery and passkey ceremonies at the permanent origin. Record deployed revision, database IDs, RP/origin, dependency versions and evidence dates without secrets.

## Invite a user

Hosted enrollment is invite only; existing accounts keep passkey-only sign-in.
After deploying this admin release, the sole administrator `me@rwjblue.com` can
send and revoke invitations from `/admin`, with fresh passkey verification and
a 90-day audit of web actions. The console also shows scheduler history, live
and background workload, source freshness, vendor budgets and export gates.
See the [admin proposal](admin.md) for metric definitions and follow-ups.

Apply `0011_admin_metrics.sql` and `0012_admin_invitations.sql` before deploying
this release or using its invite CLI. Scheduler history starts with deployment;
seven days of run metadata are retained. Pushing commits does not apply these
migrations or deploy the Worker; `mise run deploy-readonly` builds both browser
entry points, applies migrations and deploys with the existing export gates
closed when deployment is requested.

The authenticated Cloudflare CLI remains available through the project task:

```sh
mise run invite -- person@example.com
mise run invite -- --dry-run person@example.com
```

The normal command grants a seven-day, exact-email invitation in `ferry-production` and sends a branded invitation through the configured native Cloudflare sender. It uses the project production account/database/sender, shell-free query arguments and an exact returned-grant check; no application secret, admin web endpoint or bearer invite token is needed. The preview command renders `.wrangler/invite-preview/invitation.html` without any remote operation, access grant or email send.

The ordinary `/join` link opens the enrollment form. The recipient must enter the exact invited address, confirm its six-digit email code and enroll a passkey. Local-part case and plus tags are preserved; only the email domain is normalized. Expired, revoked or claimed invitations cannot enroll, and account/key/session creation claims the invitation atomically. No connected vendor is required. The task refuses existing accounts and claimed invitations. To renew an eligible unused invitation, intentionally rerun the command after its 60-second recipient cooldown; this also sends a new message. Both CLI and web sends share that cooldown and block renewal of an active invitation with uncertain mail status. Web sends additionally allow at most 20 attempts per admin per hour.

Provider acceptance does not prove inbox delivery. If submission fails or its result is uncertain, the granted invitation remains usable at `/join` unless it was revoked or claimed concurrently; the task reports that boundary and never retries automatically. Inspect provider delivery metadata or confirm receipt before deciding to resend. Revoke a pending uncertain invitation in admin before intentionally sending another, still observing the cooldown. A permanent-bounce warning is treated as failure even though the current Wrangler CLI exits zero. Do not automate repeated invitations. CLI actions update invitation/mail status but do not create web audit events. Expired and revoked invitation metadata is retained for 90 days after expiry; web audit events are retained for 90 days. Scheduled auth cleanup enforces retention, and restore quarantine removes all restored invitations.

## Connect and adopt read-only

Invited signup confirms email and enrolls the first passkey atomically. Register a second key in an independent provider/security key. Losing every usable passkey has no email reset. Existing-account email confirmation cannot replace a passkey. Sensitive changes require a fresh passkey assertion within five minutes; session and key revocation take effect on subsequent requests. Settings and account-default templates can be saved before connecting any service; LoFi, QRZ and LoTW are individually optional.

Connection buttons now prompt for a passkey automatically when that verification has expired, then continue without clearing the form. The separate Verify passkey button is also available. Canceling sends no connection request. A vendor or same-origin failure is reported separately and never triggers an automatic replay of an approval email or credential operation.

Link LoFi through its approval email, then finish the connection so Ferry verifies the vendor account UUID. Link QRZ using its book API key plus exact book ID, station callsign and date range; incomplete STATUS evidence blocks linking. Import a LoTW `.p12` with its matching private key and original password; `.tq6` alone cannot sign. Optional LoTW website credentials enable accepted/unconfirmed history readback. The original import password and PKCS#12 bytes are discarded after normalized encrypted import; optional query passwords remain encrypted for unattended readback. Renewal must use the same verified query username (and read credentials) as the original account connection; omitting optional readback fields creates a distinct station-only destination. Renewal retains the verified logical destination and ledger; a different QRZ book or verified LoTW account starts separate reconciliation.

The current account controls permit one nonrevoked connection of each service. A paused connection retains its slot and can be resumed; remove credentials before linking a different account. Updating the same verified identity retains its ledger and templates. Existing additional connections remain visible and are preserved; overlapping active routes remain ambiguous. The API checks before contacting vendors and checks again within the credential transaction, including concurrent linking and atomic replacement of pending LoFi approvals. D1 [batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) roll back the complete credential change if that guard fails. Removing credentials retains existing vendor records and delivery history.

LoTW query accounts can hold several exact callsign/DXCC certificates. Without read credentials the route uses the station identity claimed by the certificate, without proving ARRL issuance or website-account membership; switching to query access requires removing the station-only credentials and read-only adoption of the newly verified destination. Resume checks certificate dates and fresh unrevoked serial status. An old local trust flag does not block a usable import; rejected logins and unsuitable certificate evidence still require attention.

LoFi's account name is the `current_account.name` returned by the vendor. A name such as `iPad` identifies that LoFi account label; Ferry does not infer a device from the browser. It may take multiple five-minute cycles to scan history and reread operation events. Deleted operations are skipped, and failed or partial operation reads yield their turn so they cannot starve other context reads. A successful canonical sync clears stale source errors and records its success timestamp separately from the last poll attempt.

Use **Read-only review** on the dashboard to inspect source scan/context progress and retained contact samples, including effective station, location, references and current comment previews. **Refresh review** reads Ferry's existing retained data; cron advances vendor reads. Current previews do not pin a template, create an attempt, sign a contact or imply an adopted record's narrative will change. Existing pinned/adopted states are explicitly distinguished. Missing or incomplete context blocks a preview rather than guessing location. A LoFi-only connection can have source contacts while all destination delivery counts remain zero. Connect only the optional destination you want to evaluate to populate its separate reconciliation/adoption states. The review uses existing bounded retention, and a source sample or completed client scan does not establish vendor replay/absence guarantees.

A genuinely new destination atomically requests a bounded source backfill stream so retained-source expiry cannot hide older contacts. Same-identity reconnection/renewal preserves its existing rescan progress; template edits never trigger rescans. Review adopted/missing/ambiguous/mismatched/incomplete aggregate counts and exceptions before writes. Adoption creates no insert, replace, delete or signature, and keeps existing QRZ narrative. A partial or failed inventory never proves absence. Without a verified source server cutover, absence/backfill and source-new classifications remain blocked. Do not turn the source-evidence flag on simply because fixture tests pass. General-log reread/cursor expiry behavior and historical operation rereads need the documented source evidence or explicit visible recovery work.

## First writes and expansion

Required inputs are: Cloudflare deployment authority and resource IDs; the permanent hostname; a verified configured transactional sender; independently stored application secrets; the approved LoFi account and replay/cutover evidence; QRZ book key/identity/range plus a deliberately designated test contact/book; LoTW `.p12` import password, matching key and current certificate/serial status; optional LoTW query credentials; supported callsign/location/mode configuration; and explicit authorization naming the first genuinely new contacts and permitted destinations.

Set `ROLLOUT_QSO_IDS_JSON` to the exact authorized source QSO UUIDs for the first writes; the default empty array permits none. The explicit `["*"]` scope enables normal coverage only after scoped evidence and authorization. Preparation and dispatch both enforce the scope. Keep a small identifiable scope for the first writes. Verify QRZ INSERT/duplicate/REPLACE identity and narrative preservation on the designated test record. Verify one real Worker-signed LoTW upload reaches the queue, then separately observe its exact supported projection in readback. Confirmation is additional evidence. Record contact IDs/source generations, destination mappings, certificate/configuration versions, deployed revision, timing and redacted outcomes. Expand automatic coverage only after reviewing these results and the adopted-history exceptions. Template changes alone never authorize historical work; existing bindings remain pinned at durable export preparation.

After those checks and the separate human authorization, the full set of required production values is `EXPORTS_ENABLED=true`, `ROLLOUT_CHECKS_PASSED=true`, `SOURCE_BOUNDARY_VERIFIED=true`, `LIVE_WRITE_AUTHORIZATION=I_AUTHORIZE_LIVE_VENDOR_WRITES`, and a nonempty `ROLLOUT_QSO_IDS_JSON` scope. Keep the exact UUID allowlist initially; `["*"]` is an explicit later expansion.

The enablement flags are operational gates, not authorization obtained from this runbook. Explicit human live-write authorization and completed rollout evidence are both necessary. Never clear uncertain states or reset the source cursor to force a first write.

## Failures, throttling and revocation

A prepared attempt owns immutable encrypted bytes, members and versions. Repeated cron ticks must send the saved artifact. A crash after dispatch or lost response becomes uncertain and is reconciled before any new create. A LoTW queue acknowledgement is `submitted`, exact readback is `observed`, and QSL confirmation remains separate. An old identity or wrong location cannot acknowledge a correction. Without read access, submission-only uncertainty remains visible.

Transient failures proven to occur before dispatch may retry with bounded exponential delay and jitter, capped at six hours with a five-minute scheduler floor. Authentication, certificate, ambiguous history and unsupported-field errors require attention on that connection/contact. Never log credential-bearing LoTW URLs or raw vendor payloads. Routine `ferry_tick` logs contain aggregate source/contact/attempt counters, deferred work separately from errors, `rounds`, `elapsedMs` and `stopReason` (`idle` or `deadline`).

Every hosted LoFi, QRZ and LoTW request passes through a persistent D1 budget, including connection checks, token refreshes, pagination, certificate checks, inventory reads and uploads. These are conservative application defaults, not claims about vendor quotas. The limits apply across all tenants and overlapping Worker invocations in fixed five-minute UTC-aligned windows:

| Vendor | Total requests | Background requests, included in total |
| ------ | -------------- | -------------------------------------- |
| LoFi   | 24             | 4                                      |
| QRZ    | 120            | 24                                     |
| LoTW   | 40             | 8                                      |

The policy constants are in `src/vendor-requests.ts`. Background requests consume both counters; they cannot spend the capacity reserved for live work. Admission is atomic and happens before network dispatch. Exhaustion defers work until another window without sleeping inside the Worker. The limiter bounds bursts per window; it does not space individual requests apart.

HTTP 429 establishes a shared vendor cooldown. Honor `Retry-After` as either seconds or an HTTP date; missing or invalid values on 429 use five minutes. HTTP 503 with a valid `Retry-After` also establishes a cooldown. A shorter concurrent response cannot shorten an existing cooldown, and window rollover does not clear it. Connections return a scrubbed 503 response with `Retry-After` while deferred. An upload that may have reached a vendor remains uncertain and uses readback; a request denied before dispatch retains its prepared artifact and retries no earlier than the cooldown. Do not reset ledgers or source cursors to bypass throttling.

Each five-minute invocation drains eligible work in repeated fair rounds until its 90-second soft deadline or no new eligible work remains. A round selects up to two sources, reserving a source turn for each traffic class when both forward sync and initial imports are waiting. Each selected source gets one contact turn per traffic class per round, keeping inventory and preparation close to dispatch. Live source polling and contact processing run before the round's six live delivery/readback turns, so a new edit can cancel stale prepared bytes before dispatch. History gets two delivery/readback turns per round; already prepared historical uploads get their turn before new inventory reads can consume the background allowance. These are scheduling quanta, not per-invocation ceilings: further rounds can process more history when live work is idle, within the same background request caps. Preparation pauses when a vendor already has two prepared background attempts, keeping saved artifacts close to their dispatch turn instead of letting a large import fill the outbox.

A completed canonical source poll is not repeated in the same invocation; incomplete pages can continue while request and time budgets permit. Operation context is read at most once per operation per invocation. Contact turns are marked against an invocation cutoff, so waiting records are not selected again, and delivery/readback attempts are deferred at least five minutes after their turn. Waiting contacts and attempts therefore cannot consume repeated rounds without new eligible work. The scheduler stops without sleeping when it has no work left. Initial scans, destination rescans and repair scans request 25 rows per side/page; forward sync and operation context needed by live contacts request 100. LoTW confirmation refreshes also use the background budget.

Priority follows durable arrival/change provenance, not the QSO date. An offline upload of an old-dated contact arriving through forward sync gets live priority. A meaningful forward correction promotes historical work; reconciliation baselines, timestamp-only replays and destination rescans do not. Each prepared attempt pins its traffic class through submission and readback. The first source inventory still requires complete canonical operation/segment context before any contact can be exported; prioritization does not bypass coverage or cutover checks. Imports may take hours or days, and the 25-row source pages are a separate bound from the one-contact processing quantum. If unresolved source payloads expire while waiting, a separate resumable background repair scan reacquires current inputs without resetting forward sync. Resolved unchanged contacts are skipped on repair, and expired unresolved metadata stays visible until reread.

Migrations `0009_vendor_requests.sql` and `0010_source_priority.sql` add the shared budget/cooldown state and persistent source/attempt priorities. Both are applied to the selected production database; apply them before deploying this scheduler to another existing environment.

Disable a connection to stop new work while retaining configuration; revoke it to remove credential ciphertext and cancel unsent attempts. A request already dispatched may finish remotely. Account/connection removal never mass-deletes vendor records. Source tombstones retain remote history. LoTW identity changes can leave old contacts; QRZ cleanup requires Ferry-created provenance, acknowledged new mapping and a fresh exact old-record check. Automatic cleanup is not enabled in v1 until that live contract is proven; prior identities remain retained and visible.

## Retention and rotation

Current ceilings: ordinary encrypted source QSO buffers seven days; operation/segment-event context 30 days; pending LoFi approval credentials one day; outbox/signed artifacts seven days; retired credential versions seven days. Successful resolved artifacts are purged after the durable checkpoint. Expired unresolved artifacts become reconciliation-required, never missing/retryable. Minimal ledger identities/hashes/associations and referenced immutable template versions persist. Source/context expiry blocks dependent work until a verified reread restores it. Email proofs last ten minutes, ceremonies five minutes and authenticated sessions at most 30 days; expired authentication state is purged.

For KEK rotation, retain old `KEK_Vn` secrets, install a new independent 32-byte `KEK_Vn`, and change `ACTIVE_KEK_VERSION` so new writes use it. Rewrap each stored DEK with its exact tenant/connection/id/kind/purpose identity; payload ciphertext and mappings do not change. Each cron tick automatically rewraps up to 50 `private_data` envelopes using a compare-and-set on the old envelope, without any vendor writes. Interrupted ticks resume on the next run. Inspect aggregate remaining versions with:

```sh
npx wrangler d1 execute ferry-production --env production --remote --command "SELECT json_extract(envelope, '$.kek') AS kek, count(*) AS remaining FROM private_data GROUP BY kek"
```

Require all live rows to use the active version; an unreadable envelope blocks that row and needs its original KEK. Exercise interrupted rotation, decrypt/readback and a restored backup before retiring an old KEK. A missing KEK is data loss, not permission to relink or resend. Keep old keys available for retained backups and any unexpired local-only mailbox envelopes until their documented retention expires.

Certificate renewal imports a new verified credential version on the same logical route. In-flight signed artifacts keep their certificate/configuration version; renewal must not regenerate an uncertain artifact. Revalidate the matching key, date authorization, current validity and revocation/supersession. Import rejects unsuitable keys and excessive work. Signing requires fresh unrevoked serial status; LoTW validates certificate authority when processing the upload. Successful preflight checks do not verify upload acceptance.

## Backup and restore

Export backups to restricted storage outside the repository and keep encryption keys separately:

```sh
npx wrangler d1 export ferry-production --env production --remote --output /secure/backup/ferry.sql
npx wrangler d1 time-travel info ferry-production --env production
```

D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) retains up to 30 days on Paid or seven days on Free. Deleting live ciphertext does not erase those backups. Record a bookmark and current authoritative revocations before changes. Restoring an old database can resurrect old sessions, revoked credentials and prepared work: first disable production exports and scheduled delivery, restore into an isolated review path where possible, revoke restored sessions, reapply current account/passkey/connection revocations, expire stale leases, and reconcile every dispatched/uncertain artifact against vendors. Preserve successful mappings, source baselines, provenance and template versions. Re-enable only after reviewing the resulting exceptions. If the current revocation record or required KEKs are unavailable, keep the restored service disabled. A backup predating an upload cannot prove that contact absent.

Before a planned restore, capture a fresh restricted revocations manifest from the current authoritative service: creation time, deployed revision/database bookmark, all account IDs/statuses, passkey IDs/account IDs/revocation times, and connection IDs/account IDs/statuses. Include current identity sets so rows deleted since the backup cannot silently reappear. Do not include credential ciphertext or plaintext secrets. After restoring, invalidate every restored session, freeze all restored connections, and reapply that manifest before any account or delivery resumes. A manifest older than intervening access changes is insufficient; if current state is unavailable, restoration remains disabled pending authoritative reconstruction. A historical backup is not a fresh manifest.

The checked-in quarantine is executable for a restored **local** database:

```sh
mise run restore-lock
```

It always targets `ferry-local --local` and takes no remote/environment arguments. Apply all v1 migrations first. `ops/lock-restored.sql` is the identical operator SQL tested against the runtime `lockRestoredDatabase()` helper. It locks active accounts, preserves already revoked accounts/keys, revokes sessions and credential-envelope access, disables connections, expires leases, clears pending email/passkey proofs, invalidates prior absence coverage, and moves prepared/dispatching/submitted/uncertain attempts to reconciliation-required. Immutable attempts, outbox bytes, mappings, narrative policies, provenance and template versions remain intact. Repeating the lock cannot make work retryable.

For an isolated restored remote database, the explicit operator equivalent is `npx wrangler d1 execute RESTORED_DATABASE --env REVIEW_ENVIRONMENT --remote --file ops/lock-restored.sql`, with both names deliberately replaced after reviewing its bindings. Run this **before binding a Worker**, and keep all export gates disabled. Never point the local task at production by editing it casually. This implementation deliberately provides no automatic unlock, account-reset or replay command. Returning to service requires the fresh manifest, current credential proof and read-only vendor receipt reconciliation described above; preserving old ciphertext does not restore authorization.

Keep backup retention explicit in the operator's storage policy. This repository does not configure an external backup destination or authorize destructive Time Travel restoration. [Cloudflare documents](https://developers.cloudflare.com/d1/reference/time-travel/) that restore overwrites the live database and cancels in-flight transactions.

## Capacity and cost evidence

Checked 2026-10-22: [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) has a $5 account monthly minimum, including 10 million requests and 30 million CPU ms; overages are $0.30/million requests and $0.02/million CPU ms. [D1 Paid](https://developers.cloudflare.com/d1/platform/pricing/) includes 25 billion rows read, 50 million written and 5 GB; overages are $0.001/million read, $1/million written and $0.75/GB-month. These allowances are account-wide; existing services consume part of them. [Email Sending Paid](https://developers.cloudflare.com/email-service/platform/pricing/) includes 3,000 outbound emails per account per month, then $0.35 per 1,000; sending to verified account destinations does not consume that quota. Model email overage as `max(quota_counted_emails-3000,0)/1000*0.35`, rather than assuming this project receives a separate allowance.

For a 30-day month, a five-minute cron schedules 8,640 invocations. Measure dashboard/API invocations, per-cycle CPU, certificate-import CPU, source rows, adopted/backfilled/changed contacts, retries, scanned/written D1 rows and average storage. Request and CPU overage cost is `max(requests-10M,0)/1M*0.30 + max(CPU_ms-30M,0)/1M*0.02`, plus the account plan, D1 and [Cloudflare Email Service usage](https://developers.cloudflare.com/email-service/platform/pricing/) for this target, or the selected [Resend plan](https://resend.com/pricing) for deployments using that fallback. Count verification/change emails separately from LoFi's own approval emails. Do not call the service free based on a small contact count.

[Worker limits](https://developers.cloudflare.com/workers/platform/limits/) include 128 MB per isolate, distinct CPU and wall time, and a 15-minute cron wall limit. The scheduler's 90-second deadline is a cooperative wall-time budget checked between work units, so an in-flight unit can finish after it. Worker clocks do not advance during synchronous execution between I/O events; `elapsedMs` is useful throughput evidence alongside counters and stop reasons, but does not measure billed CPU or enforce a CPU limit. Inspect deployed invocation CPU/wall metrics and memory errors. Final local bundle, startup-profile and signing timings are recorded in [signing evidence](evidence-signing.md); they do not measure deployed billed CPU or peak memory. No representative deployed full-tick capacity, production monthly usage or invoice has been measured. Collect representative deployed evidence and set an appropriate CPU limit before enabling exports.
