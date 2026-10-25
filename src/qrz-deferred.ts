import { type IntakeContact, pendingContactBatch } from "./intake.ts";
import type { Connection, Store } from "./store.ts";
import type { VendorPriority } from "./vendor-requests.ts";

export interface DeferredQrzKey {
  tenant: string;
  source: string;
  qso: string;
  destination: string;
  generation: string;
  version: number;
  dueAt: number;
  workDueAt: number;
  priority: VendorPriority;
}

/** Scheduling hints only: one bounded cohort's primitive keys, never contacts or evidence. */
export class DeferredQrzPlanning {
  #entries = new Map<string, Readonly<DeferredQrzKey>>();
  #seen = new Set<string>();

  add(key: DeferredQrzKey) {
    const id = JSON.stringify([
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    ]);
    if (this.#seen.size >= 20 || this.#seen.has(id)) return;
    this.#seen.add(id);
    this.#entries.set(id, Object.freeze({ ...key }));
  }

  async take(
    store: Store,
    source: Connection,
    priority: VendorPriority,
    limit: number,
    now: () => number,
    admitted: () => boolean,
  ): Promise<{ contacts: IntakeContact[]; destinations: Map<string, string> }> {
    const contacts: IntakeContact[] = [];
    const destinations = new Map<string, string>();
    let visited = 0;
    for (const [id, key] of this.#entries) {
      if (
        key.tenant !== source.tenant ||
        key.source !== source.id ||
        key.priority !== priority
      )
        continue;
      if (!admitted() || visited >= Math.min(20, Math.max(0, limit))) break;
      // Burn before the first await. Failed projections, races, and blocked proofs
      // cannot turn into an invocation-local retry loop.
      this.#entries.delete(id);
      visited++;
      const current = () =>
        store
          .statement(
            `SELECT 1 FROM reconciliation_work r
         JOIN ledger l ON l.tenant=r.tenant AND l.source=r.source AND l.qso=r.qso
         JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination
         WHERE r.tenant=? AND r.source=? AND r.qso=? AND l.destination=?
          AND r.version=? AND r.priority=? AND r.eligible=1 AND r.next_due_at=? AND r.next_due_at<=?
          AND r.context_ready=1 AND r.context_expires_at>?
          AND l.generation=? AND l.due_at=? AND l.due_at<=?
          AND d.kind='qrz' AND d.status='active'`,
            key.tenant,
            key.source,
            key.qso,
            key.destination,
            key.version,
            key.priority,
            key.workDueAt,
            now(),
            now(),
            key.generation,
            key.dueAt,
            now(),
          )
          .first();
      if (!(await current()) || !admitted()) continue;
      // Exact-qso intake is normally for receipt recovery and skips the ordinary
      // due selector. Both surrounding reads therefore enforce the original hint.
      const fresh = await pendingContactBatch(
        store,
        source,
        1,
        now(),
        priority,
        key.qso,
      );
      const contact = fresh.contacts[0];
      if (
        !contact ||
        contact.id !== key.qso ||
        contact.generation !== key.generation ||
        contact.reconciliationVersion !== key.version ||
        !admitted() ||
        !(await current()) ||
        !admitted()
      )
        continue;
      contacts.push(contact);
      destinations.set(key.qso, key.destination);
    }
    return { contacts, destinations };
  }
}
