# Admin console

The operator dashboard at `/admin` shows native inventory and delivery state
across accounts. The account dashboard at `/` shows the same categories for the
signed-in account, with recent scan windows and delivery activity.

## Inventory and delivery

- **Coverage windows** count completed source or destination selections
  separately from partial, held, collecting, or stale selections. A completed
  window establishes coverage within its recorded bounds.
- **Work waiting and on hold** shows scan phases, pending comparisons,
  delivery review, sends, and receipt verification. The oldest and next due
  times are shown when the corresponding work records provide them.
- **Comparison outcomes** count results with a current dependency set.
  Missing contacts still need current source proof and a destination check
  before Ferry can send. Historical associations are reported separately from
  contacts delivered by Ferry.
- **Delivery outcomes** count individual contacts. A LoTW file acknowledgement
  is shown as submitted until the individual contacts are verified by readback.
  A lost acknowledgement can also enter receipt verification.
- **Vendor request capacity** distinguishes the Ferry request counters from
  upstream cooldowns. The counters cover reserved requests across accounts in
  the current window. Background requests consume total capacity as well.
- **Settled contact retention** controls how long settled contact details remain
  hot for routine reconciliation. The initial value is 90 days. Required
  duplicate suppression and upload recovery evidence follow their own lifetime.
- **Export controls** show the current configuration and runtime mode.
  Coverage, a pending candidate, or a prepared artifact provides no authority
  to send by itself.

## Sync scope

Each connected destination has its own sync scope. All LoFi history schedules
the observed source months. Since a date applies the inclusive UTC QSO date
before comparison. The planner clips the date windows and includes one day
of padding for matches across midnight. Widening schedules gaps left by
the earlier plan. A scope change immediately fences older prepared work and
requeues comparisons through bounded source and destination pairs.

From now on skips destination history scans. It uses the complete all-client
LoFi baseline and contacts first seen in a completed managed delta started
after the setting changed. A later edit keeps the original birth record.
A newly seen backdated contact can qualify. This evidence comes from the
verified source replay and does not establish an upstream creation timestamp.
The current source proof, final destination collision check, and write gates
still apply. Existing possibly-sent work keeps its receipt recovery path.

Refresh to get a new read-only snapshot. Account and connection lists have
explicit limits. Global metrics contain controlled states and counts. The
connection list omits private contact bodies, keys, and raw provider errors.

## Access and onboarding

Every admin API verifies the signed-in account's current active status and
admin email. The navigation link is a convenience. Invitation and retention
changes require same-origin CSRF validation and a recent passkey verification.

Invitations are single-use, tied to an exact email address, and valid for seven
days. Accepting one requires email confirmation and a passkey. Revoking an
unused invitation leaves existing accounts alone. Provider acceptance of
invitation mail and inbox delivery are different states. An uncertain send
leaves the invitation usable and requires an intentional resend. Console
invitation audit records are retained for 90 days.

## Build

Apply all outstanding migrations before serving the Worker. Build both browser
entry points with `mise run build` and verify with `mise run check`.
