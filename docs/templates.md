# QRZ narrative templates

This document defines the proposed v1 behavior. Templates format QRZ narrative fields; they do not control QSO identity or station/location fields. LoTW exports have no narrative template binding. Changing a template must never schedule a LoTW export.

## HaLo compatibility

Use HaLo's Liquid syntax, documented context vocabulary, and filters. Configuration belongs to Ferry initially: current HaLo export preferences are local settings, and their availability through LoFi has not been established. Copying a template between applications is supported; synchronizing their preferences is not assumed.

The SDK renderer and context helpers are MIT-licensed; reuse must retain their license notices. Their availability does not make the separate core ADIF exporter MIT-licensed.

For the operator's activated POTA parks, use `op.refs` with type `potaActivation`:

```liquid
{% assign parks = op.refs | where: "type", "potaActivation" | map: "ref" %}{% if parks.size > 0 %}POTA {{ parks | sentence }}{% endif %}
```

`qso.refs` entries of type `pota` identify the contacted station's parks. They must not substitute for the operator's activation. Check `.size` or `blank` when testing empty values; Liquid treats empty strings as truthy.

Ferry supplies an **effective operation for each QSO**, after applying the segment containing that QSO. Consequently, `op.refs`, the station call, and location describe that contact's segment. This deliberately differs from HaLo's current ADIF text-template context, which uses the operation context even though its structured ADIF projection handles segments. Syntax compatibility does not promise identical output for that case. Templates cannot override the independently validated structured location projection.

## Immutable versions and the binding boundary

A version snapshots the complete effective narrative configuration: template text, enabled fields, fallback behavior, whitespace rules, and renderer/context compatibility profile. Saving a change creates a new immutable version and moves the active-version pointer. Referenced versions remain available after later edits, rollback, or configuration removal.

The durable binding belongs to `(tenant, LoFi account, source QSO UUID, logical destination)`. Credential rotation and reconnection retain the same destination identity. A different QRZ logbook is a different destination.

The **composite source generation** includes the QSO plus the effective operation and segment inputs that determine its projection, including segment boundaries and applicable station, location, and reference overrides. Capture and validate those dependencies together; an unchanged QSO revision does not establish an unchanged generation when its operation or segment changed.

The first **durable outbound generation** pins the active version. This means the validated, rendered export has been committed to the outbox, before any network request. Binding at the first successful response would leave timeouts and crashes ambiguous.

1. A contact waiting for cooldown or failing pre-export validation remains unbound.
2. Render and validate against the active version and current source generation.
3. Atomically commit the version binding, output hash, delivery identity, and immutable outbox payload. If the selected version or source generation changed before commit, retry preparation.
4. Once committed, that version remains pinned through queued, sending, failed, and uncertain outcomes. Network retries reuse the saved payload.

Changing the active template causes **no historical scan, invalidation, hash recomputation, or export job**. A contact with an old QSO date that first reaches this boundary after a template change receives the new version. The boundary is export preparation, not the contact's date or its operation's completion.

Each destination binds independently. LoTW receipt state must never create or replace a QRZ template binding.

## Later source changes

A genuine source change can create a new outbound generation, using the contact's pinned template with its **current** source data. The rendered text may therefore change when an actual park reference, source note, or other referenced value changes. Its formatting remains governed by the old version.

Operation and segment changes reevaluate affected contacts with their individual pinned versions. An operation can legitimately contain contacts bound to different versions. A source identity correction retains the binding when the source UUID is unchanged. Deletion and restoration of that UUID also retain it.

Do not mutate an in-flight payload. Reconcile its outcome, then prepare any superseding source generation with the same binding. A destination update is necessary only if its supported, transmitted projection changed; fields the destination ignores must not create updates.

Gate new rendering on an initial delivery or a meaningful source-input change: compare the destination-relevant input fingerprint with its processed baseline **before** sampling `now`. An unchanged poll or dependency reevaluation creates no new generation; existing delivery retries still use their saved payloads. Relevant inputs include source-edit values used by the pinned narrative template as well as supported structured fields. For an eligible new generation, capture `now` once and preserve it during retries. Reevaluation must not invent a changed output by sampling a new clock value; clock passage alone is never an export trigger.

Operation-wide running totals and last-contact/end-of-log values, if exposed, are render-time snapshots like `now`, not change triggers. Sample and freeze them for an eligible generation. This is a deliberate live-export profile difference from a whole-operation file export: adding another QSO must not restart older contacts' quiet periods or rewrite their text merely because `op.qsoCount` or `op.endAt` advanced. Record these exclusions in the pinned compatibility profile; per-contact park/location edits remain real dependencies.

## Contacts adopted during bootstrap

A confidently matched, preexisting QRZ contact receives `narrative_policy = remote_preserved` and no template version. Do not claim that today's template produced historical text.

The conservative v1 default preserves **all existing narrative**, including source-note-derived text, on adopted contacts. Neither template edits nor later source-note edits take ownership of it. Structured source corrections can still sync when the destination supports them. Omit narrative fields only where omission is known to preserve existing values; otherwise read and preserve the remote values during replacement. Transient preservation FETCH failures retry automatically with normal backoff. Substantive unsupported or ambiguous preservation blocks that update for review instead of clearing text.

Explicit per-contact narrative takeover or historical reformatting is outside v1. If trustworthy Ferry provenance already identifies an earlier binding, restore that binding instead of adopting as unmanaged. Ambiguous contact matches require reconciliation before creating anything new.

## Rendering limits and storage

Proposed v1 limits are 16 KiB UTF-8 template source, 8 KiB rendered output per field, and 1,000 aggregate loop iterations. Enforce independent structural, iteration, intermediate-allocation, and output limits during parsing/rendering, before unbounded work occurs. Require bounded nesting and a verified enforceable step budget covering nested execution and allowed filters, or a proven interruption mechanism in the deployed Workers runtime. Disable filesystem/network access, dynamic code evaluation, and external template loading. Exceeding a limit is an actionable validation error; never silently truncate.

The 250 ms figure is a CPU/observability target, not an enforced render deadline. [Cloudflare documents](https://developers.cloudflare.com/workers/runtime-apis/web-standards/) that both `Date.now()` and `performance.now()` stop advancing during code execution between I/O events. A timer check inside LiquidJS therefore cannot establish that deadline on Workers. [LiquidJS's security model](https://liquidjs.com/tutorials/security-model.html) also describes its limits as cooperative: expensive filters can execute between checks, and memory accounting does not cover every allocation. Verify the independent budgets on the target runtime with fixed-clock and expensive-filter cases; do not treat `renderLimit: 250` or a raced timeout as sufficient enforcement.

Normalize fields before length-correct ADIF serialization. `NOTES` preserves logical line breaks, converted to CRLF for ADI output. `COMMENT` and `QSLMSG` collapse whitespace to single spaces and trim, matching HaLo's `oneLine` behavior. Single-line `QSLMSG` is Ferry's compatibility policy; [ADIF itself permits multiline QSL messages](https://adif.org/316/ADIF_316.htm#QSLMSG). Use a tested serializer that validates the destination's supported field/encoding rules and calculates each field length from its final normalized value, including both characters of CRLF. Do not HTML-escape values or invent backslash escaping. Recheck size limits after normalization; unsupported data or excessive output must fail validation rather than be silently truncated or dropped. These normalization rules belong to the pinned compatibility profile.

Persist immutable versions, bindings or preservation policies, delivery hashes/mappings, and outstanding outbox payloads. No historical QSO mirror or template-change backfill is required. Renderer fixes must preserve existing version semantics or introduce a new compatibility profile; they must not silently reformat history.

## Primary implementation references

- [HaLo template documentation](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/docs/extensions/templates.md), [renderer](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sdk/src/templates.ts), and [context builder](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sdk/src/templateContext.ts).
- [Export preferences](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/app/lib/services/export_preferences.dart), [ADIF exporter](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/core/adif/src/index.ts), and [segment model](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/models/segments.dart).
- [POTA reference vocabulary](https://github.com/ham2k/extensions/blob/bae00d055791be03f20f84479c810951f64ca313/extensions/activities/ham2k-pota/src/index.ts).
