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

Successful source pages, drain rounds and idle/deadline stop reasons are
retained per run. Repeated time-budget stops with rising backlog suggest
capacity pressure. An idle stop only means the run found no further progress;
work held by rollout gates, quiet time, missing context or vendor budgets may
remain. The scheduler's contact and attempt counters count processing turns, not unique
contacts delivered. Waiting work may be considered repeatedly. A LoTW upload
acknowledgement is not readback confirmation. Vendor request counts measure
reserved requests in the current fixed window, not requests per second or an
official vendor quota. Source timestamps describe successful pages, not proof
that a whole log is current.

Use heartbeat freshness, due work, unresolved-attempt age, source progress and
vendor cooldowns together. Compare refreshes to see whether work is draining.
Durable scheduler history begins with this deployment; missing history is
unknown, never evidence of health. Run records retain seven days. Database
summaries and retained run counters are operational evidence, not CPU, memory,
billing measurements or a guarantee of spare capacity.

Source buffers have no reliable local arrival timestamp today. Do not invent
source queue latency from vendor timestamps or from `processed_at`, which is
updated during processing. Unresolved attempt creation times and ledger due
times provide honest age measures where available.

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

1. **Progress trends and alerts.** Add durable local first-seen timestamps and
   periodic aggregate snapshots, then show live/import backlog slopes, distinct
   completions and oldest eligible age over time. Alert on stale cron, stalled
   live work, expiring credentials and sustained throttling after observing a
   representative baseline. Keep alert delivery an explicit operator setting.
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

Apply `0011_admin_metrics.sql` and `0012_admin_invitations.sql` before deploying
this code to an existing database or running the updated invite CLI.
Build both browser entry points with `mise run build`; verify with
`mise run check`. Existing export configuration stays in effect. No real
invitation, vendor upload or production migration is part of development tests.

The admin overview refreshes on demand. Bounded lists disclose truncation; a
failed refresh must remain visibly failed rather than showing an old snapshot
as current. The API returns only allowlisted operational fields. Future growth
should move expensive summaries to scheduled aggregates, using measured query
cost to justify the extra machinery.
