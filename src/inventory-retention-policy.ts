export interface InventoryRetentionPolicy {
  settledRetentionDays: number;
}

export function validSettledRetentionDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 3650
  );
}

export async function readInventoryRetentionPolicy(db: D1Database) {
  const policy = await db
    .prepare(
      "SELECT settled_retention_days AS settledRetentionDays FROM inventory_retention_policy WHERE singleton=1",
    )
    .first<InventoryRetentionPolicy>();
  if (!policy) throw new Error("inventory_retention_policy_missing");
  return policy;
}

export async function updateInventoryRetentionPolicy(
  db: D1Database,
  settledRetentionDays: number,
) {
  if (!validSettledRetentionDays(settledRetentionDays))
    throw new Error("invalid_inventory_retention_days");
  const policy = await db
    .prepare(
      "UPDATE inventory_retention_policy SET settled_retention_days=? WHERE singleton=1 RETURNING settled_retention_days AS settledRetentionDays",
    )
    .bind(settledRetentionDays)
    .first<InventoryRetentionPolicy>();
  if (!policy) throw new Error("inventory_retention_policy_missing");
  return policy;
}
