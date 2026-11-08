import { randomToken } from "./security.ts";
import type { Store } from "./store.ts";

export interface InventoryRuntime {
  mode: "legacy" | "inventory_read_only";
  version: number;
  activated_at: number | null;
}

export async function inventoryRuntime(
  store: Store,
): Promise<InventoryRuntime> {
  const row = await store
    .statement(
      "SELECT mode,version,activated_at FROM inventory_runtime WHERE id=1",
    )
    .first<InventoryRuntime>();
  if (!row) throw new Error("inventory_runtime_unavailable");
  return row;
}

/** A native, one-way handoff. Existing account and credential rows stay intact. */
export async function activateInventoryRuntime(store: Store) {
  const current = await inventoryRuntime(store);
  if (current.mode === "inventory_read_only") return current;
  const lease = await store.claim(
    "inventory-runtime",
    "inventory:runtime",
    Date.now(),
    60_000,
  );
  if (!lease) throw new Error("inventory_runtime_busy");
  try {
    const guard = randomToken();
    try {
      await store.db.batch([
        store.statement(
          "INSERT INTO inventory_runtime_switch_guards(id,expected_version,lease_tenant,lease_token,lease_fence) VALUES(?,?,?,?,?)",
          guard,
          current.version,
          lease.tenant,
          lease.token,
          lease.fence,
        ),
        store.statement(
          "UPDATE inventory_runtime SET mode='inventory_read_only',version=version+1,activated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=1 AND version=?",
          current.version,
        ),
        store.statement(
          "DELETE FROM inventory_runtime_switch_guards WHERE id=?",
          guard,
        ),
      ]);
    } catch (error) {
      // A concurrent activation or lost acknowledgement has a durable answer.
      const committed = await inventoryRuntime(store);
      if (committed.mode === "inventory_read_only") return committed;
      throw error;
    }
    return await inventoryRuntime(store);
  } finally {
    await store.release(lease);
  }
}

/** Only a fresh scope can be attached; accepted standalone work is not relabeled. */
export async function bindInventoryScopeRuntime(
  store: Store,
  tenant: string,
  scope: string,
  version: number,
) {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("invalid_inventory_runtime_version");
  await store
    .statement(
      "UPDATE inventory_scopes SET runtime_version=?,config_version=config_version+1 WHERE tenant=? AND scope_id=? AND runtime_version=0 AND accepted_sequence=0",
      version,
      tenant,
      scope,
    )
    .run();
  const current = await store
    .statement(
      "SELECT runtime_version FROM inventory_scopes WHERE tenant=? AND scope_id=?",
      tenant,
      scope,
    )
    .first<{ runtime_version: number }>();
  if (current?.runtime_version !== version)
    throw new Error("inventory_scope_runtime_changed");
}
