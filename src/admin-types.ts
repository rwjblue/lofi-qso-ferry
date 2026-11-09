import type { BrowserExportMode } from "./browser-export-mode.ts";
import type { InventoryProviderDashboard } from "./inventory-dashboard-types.ts";

export interface AdminOverview {
  generatedAt: number;
  providers: InventoryProviderDashboard[];
  retention: { settledRetentionDays: number };
  inventoryRuntime: string;
  vendors: {
    vendor: "lofi" | "qrz" | "lotw";
    requests: number;
    backgroundRequests: number;
    totalLimit: number;
    backgroundLimit: number;
    windowEndsAt: number;
    cooldownUntil: number | null;
  }[];
  gates: {
    exportsEnabled: boolean;
    rolloutChecksPassed: boolean;
    liveWriteAuthorized: boolean;
    sourceBoundaryVerified: boolean;
    qrzFreshInsertsEnabled: boolean;
    lotwFreshInsertsEnabled: boolean;
    exportMode: BrowserExportMode;
    rolloutScopeConfigured: boolean;
    rolloutScope: "none" | "limited" | "all";
    destinationScopeConfigured: boolean;
    destinationScope: "none" | "limited" | "all";
    effective: boolean;
    configurationValid: boolean;
  };
  accounts: {
    total: number;
    truncated: boolean;
    items: {
      id: string;
      email: string;
      status: string;
      verifiedAt: number;
      passkeys: number;
      connections: number;
    }[];
  };
  connections: {
    total: number;
    truncated: boolean;
    items: {
      tenant: string;
      accountEmail: string;
      id: string;
      kind: "lofi" | "qrz" | "lotw";
      label: string;
      status: string;
      lastAttemptAt: number | null;
      lastSuccessAt: number | null;
      lastFailureAt: number | null;
      hasError: boolean;
      coverageReady: number;
      coverageTotal: number;
    }[];
  };
}
