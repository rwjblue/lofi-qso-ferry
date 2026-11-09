# Native inventory capacity

Measure provider reads, preparation and matching, upload requests and
readback independently. Record elapsed time, SQL statements, D1 binding
calls, read and write rows, payload bytes and allocated storage.

| Profile                | Observed boundary                                                 |
| ---------------------- | ----------------------------------------------------------------- |
| 1,000-contact page     | Set-based ingest and encrypted publication                        |
| Personal replay        | 4,251 source contacts and two captured destinations               |
| 200,000-contact source | Synthetic native classification with one empty destination        |
| 100 accounts           | One synthetic 10,000-contact burst after baseline setup           |
| 100-contact LoTW file  | Native signing, guarded submission and partial simulated readback |

[Ingestion evidence](evidence-inventory-ingestion.md) ·
[Personal replay](evidence-inventory-fresh-start.md) ·
[Scale evidence](evidence-inventory-pipeline.md) ·
[Upload qualification](evidence-inventory-source-proof.md)

## Provider admission

Ferry budgets 60 requests per minute each for QRZ and LoTW across linked
accounts. Reads, certificate checks, writes and receipt queries consume
slots. HTTP throttling can extend a shared provider cooldown. LoFi has
its own background and bootstrap admission.

QRZ uses a single-record INSERT after a final collision check. LoTW
uses up to 100 compatible contacts per signed file. Effective LoTW
batch sizes depend on source proof fit, station and certificate
compatibility, and bounded final history queries. Quota arithmetic is
separate from measured elapsed time.

## Storage

D1 retains encrypted payloads, projections, indexes, coverage and
ownership. Measure current and superseded proof detail separately from
payload bodies. Historical adoption and sent receipt recovery keep
durable provenance. Measure aged settled state before extrapolating
the synthetic 200,000-contact footprint to long-term storage spend.

[Storage evidence](evidence-inventory-adoption-scheduling.md#storage-census)
