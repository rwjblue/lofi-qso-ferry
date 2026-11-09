# Ferry system design

Ferry is a one-way LoFi-to-logbook synchronizer. LoFi supplies source
contacts and operation context. QRZ and LoTW inventories supply receipt
coverage and evidence about what is already present.

## Discovery and reconciliation

The scheduled Worker enrolls linked sources and publishes durable Queue
work. LoFi advances independent operation and QSO watermarks with each
accepted page. Source month hints schedule bounded destination reads.
QRZ selections intersect the linked book dates. Native coverage
describes the selection actually observed.

Ferry projects encrypted source and destination records, then compares
time-tolerant candidates in D1. A unique historical association retains
the original remote identity and provenance. Operating-detail conflicts
remain visible for review. A current absence can enter delivery planning
once ownership, source freshness and coverage agree.

## Preparation and delivery

Native preparation captures the exact source, effective station and
destination review. QRZ binds the configured book, template and an
immutable ADIF record. LoTW groups compatible contacts under one station
and certificate and signs a TQ8 in the Worker.

Dispatch requires explicit rollout authorization and fresh collision
checks. The native claim and request reservation commit before outbound
I/O. A lost response keeps the artifact and claim available for readback.
LoTW settles individual members as their receipts appear. Confirmations
are tracked independently from acceptance and submission.

## Data lifecycle

Account, passkey, connection, template and encrypted credential data
are retained during a fresh start. Keep ownership and unresolved attempt
evidence available across restore and restart. The administrator controls
the age threshold for settled-state collection. An old source change
must recover its contact and operation dependencies before processing.

[Sync scope](bootstrap.md) · [Native inventory design](inventory-reconciliation-design.md)
· [Delivery evidence](evidence-inventory-source-proof.md)
