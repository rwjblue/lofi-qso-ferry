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
