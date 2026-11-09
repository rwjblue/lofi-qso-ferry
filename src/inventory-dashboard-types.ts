export const inventoryDashboardProviders = ["lofi", "qrz", "lotw"] as const;
export type InventoryDashboardProvider =
  (typeof inventoryDashboardProviders)[number];

export interface InventoryStatusCount {
  state: string;
  reason: string | null;
  count: number;
  since: number | null;
  dueAt: number | null;
}

export interface InventoryProviderDashboard {
  provider: InventoryDashboardProvider;
  contacts: number;
  lastProgressAt: number | null;
  coverage: InventoryStatusCount[];
  scans: InventoryStatusCount[];
  matches: InventoryStatusCount[];
  matching: InventoryStatusCount[];
  review: InventoryStatusCount[];
  deliveries: InventoryStatusCount[];
  adopted: number;
}

export interface InventoryDashboardWindow {
  provider: InventoryDashboardProvider;
  state: string;
  phase: string | null;
  reason: string | null;
  from: string | null;
  through: string | null;
  completedAt: number | null;
  nextDueAt: number | null;
}

export interface InventoryDashboardActivity {
  provider: "qrz" | "lotw";
  qso: string;
  destination: string;
  state: string;
  reason: string | null;
  confirmed: number;
  updated_at: number;
}
