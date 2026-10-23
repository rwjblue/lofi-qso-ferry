# Admin console proposal

Ferry needs an operator view that answers three questions: is work making
progress, what needs attention, and who can join? The first release puts these
at `/admin`, linked from the signed-in dashboard for `me@rwjblue.com`.

## First release

| Area            | What the operator can see or do                                               | Why it belongs now                                                                       |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Scheduler       | Last heartbeat, runs, drain rounds, time-budget stops, errors and deferrals   | A reachable website does not prove the cron is working.                                  |
| Workload        | Separate live and background work, unresolved attempts, due work and age      | An import should not hide delayed live sync.                                             |
| Source health   | Last successful page, scan/context progress and connection status             | The existing last-poll timestamp advances on attempted turns, including failures.        |
| Vendor capacity | Current application budget usage, reserved background allowance and cooldowns | Distinguish deliberate throttling from a broken scheduler.                               |
| Rollout         | Read-only view of effective export gates                                      | Disabled exports must explain a backlog rather than look like an outage.                 |
| Accounts        | Bounded account and connection summaries                                      | Find onboarding or connection problems without exposing credentials or contact payloads. |
| Invitations     | Send, intentionally renew, inspect and revoke invitations                     | Replace the production CLI for routine onboarding.                                       |
| Audit           | Recent invitation actions, actor, time and mail outcome                       | Make access changes and uncertain mail delivery inspectable.                             |

This is a small extension of the existing Worker, D1 database, passkey client,
email transport and visual design. It does not introduce a second auth system
or a dependency on Cloudflare management credentials in the app.

## Interpreting load honestly

The workload panel separates source records into **Ready**, **Held**,
**Blocked**, and **Expired**, independently for live traffic and background
imports. Each source record appears once. One contact may involve several
routes; it is ready when at least one destination has useful processing work.
These are processing categories, not permission to upload:
- **Ready:** no known metadata hold prevents further processing. This includes
  destination inventory reads and retries, even when export gates are closed.
  The worker still validates source context, routing, credentials, current
  vendor budgets, and write eligibility before acting.
- **Held:** a known prerequisite is missing, such as operation context, an active
  destination, a matching route, quiet time, export authorization, or reviewed
  destination history. Existing in-flight deliveries and resolved records
  awaiting cleanup are held separately from new processing work.
- **Blocked:** source data could not be interpreted and needs review, such as an
  invalid callsign, mode, time, or location. Reason counts use fixed labels;
  vendor responses and private payloads never appear in this panel.
- **Expired:** the buffered source input has expired and requires a fresh read.

Some rows stored internally as `blocked` are shown as held when the reason is
unavailable context or an expired payload. Finishing an operation reread already
requeues its contacts automatically. See the [production workload investigation]
(admin-workload-investigation.md) for the 767 context dependencies and one
callsign problem behind the original 768-blocked screenshot.

The charts show the latest classified scheduler snapshot in each hour over the
last 24 hours. Exact timestamps and counts are available below the charts.
Coverage, missing intervals, and the latest sample's age remain visible. Old
scheduler records without the new breakdown are unknown, not zero. Comparing
ready counts across the observed period shows whether that queue grew or shrank;
new arrivals, released holds, expiry, and source changes can all affect it. A
falling count does not by itself prove delivery throughput or spare capacity.

**Actual delivery throughput** counts each immutable contact-version/destination
attempt once, at its first completed event. QRZ acceptance and successful LoTW
readback are separate. Retries and repeated completion events never inflate the
count. Corrections are new delivery versions, and sending one contact to two
destinations counts twice. LoTW submission acknowledgements and adopted existing
history are shown separately and never counted as completed deliveries. The
hourly rate is the observed 24-hour total divided by 24, not an estimated maximum
capacity or completion ETA.

Successful source pages, drain rounds, and idle/deadline stop reasons remain in
scheduler history. Contact and attempt counters count processing turns, not
unique deliveries. Repeated time-budget stops with rising ready work suggest
capacity pressure; an idle stop only means that run found no further progress.
Missing finish checkpoints can indicate interrupted invocations. Source
freshness, incomplete reads, destination errors, vendor cooldowns, and closed
export gates help explain why a queue is not moving.

Retained-input age describes when the oldest currently buffered input was
stored. It is not the contact's date, a reliable queue-arrival timestamp, or
proof the contact has been stuck for that duration. Vendor budget usage measures
reserved requests in the current fixed window, not requests per second or an
official vendor quota. A successful source page does not prove the whole log is
current. Scheduler history retains seven days; these metrics do not measure CPU,
memory, billing, or guaranteed spare capacity.

## Access and invitation behavior

Every admin API verifies the signed-in account's current active status and exact
email `me@rwjblue.com`. Ordinary accounts cannot fetch global metrics or account
lists. Changing the admin account's email away removes this access; adding more
admins is a deliberate code/configuration change. The navigation link is only
a convenience, never the authorization boundary.

Invitation changes require same-origin CSRF validation and passkey verification
within five minutes. Invitations preserve the current exact-address, seven-day,
single-use enrollment flow. Sending an invitation grants eligibility; accepting
still requires email confirmation and a passkey. Existing accounts and claimed
invitations cannot be enrolled again. Revoking an invitation does not revoke an
existing account.

Provider acceptance is reported separately from inbox delivery. If a send fails
or its acknowledgement is lost, retain the grant, show the uncertain outcome,
and require an intentional retry. Apply send limits and a recipient cooldown to
guard accidental duplicate clicks. Store structured audit metadata rather than
provider errors, messages, tokens or credential payloads.

The web console records invitation actions and retains them for 90 days.
The existing invite CLI shares the recipient cooldown and uncertain-send guard,
and updates invitation/mail status, but does not create console audit events.
Expired and revoked invitations remain visible for 90 days after expiry.

## Follow-ups, in order

1. **Queue age and alerts.** Add durable local first-seen timestamps and oldest
   eligible age. Build on the backlog and delivery history to alert on stale
   cron, stalled live work, expiring credentials, and sustained throttling after
   observing a representative baseline. Keep alert delivery an explicit
   operator setting.
2. **Account support drill-down.** Add paginated filters and sanitized failure
   categories, source/route progress and certificate-expiry metadata. Never put
   private contact contents or credentials in a global support view.
3. **Capacity tuning.** Correlate backlog and success rates with Cloudflare CPU,
   D1 rows scanned/written, storage and billing metrics. Establish thresholds
   from production evidence before changing scheduler or vendor budgets.
4. **Controlled operations.** Consider audited pause/resume and session
   revocation with clear in-flight consequences. Recovery, replay, cursor resets,
   account impersonation and export enablement require separate designs because
   an incorrect action could duplicate vendor writes or restore revoked access.

## Shipping and operation

Apply all outstanding migrations before deploying this code. The initial admin
release requires `0011_admin_metrics.sql` and `0012_admin_invitations.sql`; the
workload breakdown and trend samples additionally require
`0015_admin_workload.sql`. Classified backlog history starts after deployment;
old samples cannot supply the missing breakdown. Completed delivery events can
be counted from existing history.
Build both browser entry points with `mise run build`; verify with
`mise run check`. Existing export configuration stays in effect. No real
invitation, vendor upload or production migration is part of development tests.

The admin overview refreshes on demand. Bounded lists disclose truncation; a
failed refresh must remain visibly failed rather than showing an old snapshot
as current. The API returns only allowlisted operational fields. Future growth
should move expensive summaries to scheduled aggregates, using measured query
cost to justify the extra machinery.
