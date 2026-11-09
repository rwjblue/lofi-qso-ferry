import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";
import type {
  AdminInvitationResult,
  AdminInvitations,
} from "./admin-invitation-types.ts";
import type { AdminOverview } from "./admin-types.ts";
import {
  ApiError,
  type BrowserSession,
  createApiClient,
} from "./browser-api.ts";
import {
  connectionStatus,
  inventoryStatusLabel,
  vendorName,
} from "./browser-dashboard.ts";
import { exportPresentation } from "./browser-export-mode.ts";

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element ${id}`);
  return value as T;
};
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) {
  const value = document.createElement(tag);
  value.textContent = text;
  if (className) value.className = className;
  return value;
}
function message(text: string, error = false) {
  const target = element("admin-message");
  target.textContent = text;
  target.hidden = !text;
  target.classList.toggle("error", error);
}
const count = (value: number) => value.toLocaleString();
const date = (value: number | null) =>
  value === null ? "Not recorded" : new Date(value).toLocaleString();
function age(value: number | null, now: number) {
  if (value === null) return "Not recorded";
  const minutes = Math.max(0, Math.floor((now - value) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440)
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
const readable = (value: string) => value.replaceAll("_", " ");
function pill(text: string, warning = false, muted = false) {
  return node(
    "span",
    text,
    `admin-pill${warning ? " warning" : muted ? " muted" : ""}`,
  );
}
function cell(main: string, detail?: string) {
  const value = node("span", main);
  if (detail) value.append(node("span", detail, "small"));
  return value;
}
function table(
  id: string,
  headings: string[],
  rows: (string | HTMLElement)[][],
  empty: string,
) {
  const target = element(id);
  if (!rows.length) {
    target.replaceChildren(node("p", empty, "small"));
    return;
  }
  const output = node("table");
  const head = node("thead");
  const heading = node("tr");
  for (const text of headings) {
    const th = node("th", text);
    th.scope = "col";
    heading.append(th);
  }
  head.append(heading);
  const body = node("tbody");
  for (const row of rows) {
    const tr = node("tr");
    for (const value of row) {
      const td = node("td");
      td.append(value);
      tr.append(td);
    }
    body.append(tr);
  }
  output.append(head, body);
  const wrap = node("div", "", "table-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", `${headings[0]} table`);
  wrap.append(output);
  target.replaceChildren(wrap);
}

const { request: api } = createApiClient(async () => {
  message("Verify your passkey to make this change.");
  const begin = await api<{
    ceremonyId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("/api/auth/reauth/options", {});
  const response = await startAuthentication({ optionsJSON: begin.options });
  await api("/api/auth/reauth/verify", {
    ceremonyId: begin.ceremonyId,
    response,
  });
});
let overview: AdminOverview | null = null;
let refreshing = false;
let mutating = false;

function selectPage() {
  const page = ["overview", "people", "invitations"].includes(
    location.hash.slice(1),
  )
    ? location.hash.slice(1)
    : "overview";
  for (const section of document.querySelectorAll<HTMLElement>(".admin-page"))
    section.hidden = section.id !== page;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    ".admin-nav a",
  )) {
    if (link.hash === `#${page}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", selectPage);

function renderOverview(data: AdminOverview) {
  const now = data.generatedAt;
  element<HTMLInputElement>("settled-retention-days").value = String(
    data.retention.settledRetentionDays,
  );
  element("inventory-runtime").textContent =
    `Inventory runtime · ${inventoryStatusLabel(data.inventoryRuntime)}`;
  const metrics = element("admin-metrics");
  metrics.replaceChildren();
  for (const provider of data.providers) {
    const metric = node("article", "", "admin-metric");
    metric.append(
      node("h3", vendorName(provider.provider)),
      node("strong", count(provider.contacts)),
      node("p", "Active inventory records", "small"),
      node(
        "p",
        `Last observed ${age(provider.lastProgressAt, now).toLowerCase()}`,
        "small",
      ),
    );
    metrics.append(metric);
  }
  table(
    "inventory-coverage",
    ["Service", "Coverage", "Windows", "Last completion"],
    data.providers.flatMap((provider) =>
      provider.coverage.map((row) => [
        vendorName(provider.provider),
        inventoryStatusLabel(row.state),
        count(row.count),
        date(row.since),
      ]),
    ),
    "No inventory coverage recorded yet.",
  );
  table(
    "inventory-queues",
    ["Service", "Work", "State", "Count", "Oldest recorded", "Next due"],
    data.providers.flatMap((provider) =>
      (
        [
          ["Scan", provider.scans],
          ["Comparison", provider.matching],
          ["Delivery review", provider.review],
          [
            "Send and receipt",
            provider.deliveries.filter(
              (row) =>
                !["observed", "delivered", "cancelled"].includes(row.state),
            ),
          ],
        ] as const
      ).flatMap(([kind, items]) =>
        items.map((row) => [
          vendorName(provider.provider),
          kind,
          cell(
            inventoryStatusLabel(row.state),
            row.reason ? inventoryStatusLabel(row.reason) : undefined,
          ),
          count(row.count),
          age(row.since, now),
          date(row.dueAt),
        ]),
      ),
    ),
    "No pending inventory or delivery work in this snapshot.",
  );
  table(
    "inventory-outcomes",
    ["Service", "Current comparison", "Contacts"],
    data.providers.flatMap((provider) =>
      provider.matches.map((row) => [
        vendorName(provider.provider),
        cell(
          inventoryStatusLabel(row.state),
          row.reason ? inventoryStatusLabel(row.reason) : undefined,
        ),
        count(row.count),
      ]),
    ),
    "No current comparisons yet.",
  );
  table(
    "inventory-deliveries",
    [
      "Service",
      "Adopted history",
      "Accepted by QRZ",
      "Receipt verified",
      "Cancelled before send",
    ],
    data.providers
      .filter((provider) => provider.provider !== "lofi")
      .map((provider) => {
        const deliveries = (state: string) =>
          provider.deliveries
            .filter((row) => row.state === state)
            .reduce((sum, row) => sum + row.count, 0);
        return [
          vendorName(provider.provider),
          count(provider.adopted),
          count(deliveries("delivered")),
          count(deliveries("observed")),
          count(deliveries("cancelled")),
        ];
      }),
    "No delivery outcomes yet.",
  );
  const vendors = element("vendor-budgets");
  vendors.replaceChildren();
  for (const vendor of data.vendors) {
    const wrap = node("div", "", "admin-vendor");
    const heading = node("div", "", "admin-section-heading");
    const totalUsed = vendor.requests >= vendor.totalLimit;
    const backgroundUsed = vendor.backgroundRequests >= vendor.backgroundLimit;
    heading.append(
      node("h3", vendorName(vendor.vendor)),
      ...(vendor.cooldownUntil ? [pill("Provider cooldown", true)] : []),
      ...(totalUsed || backgroundUsed
        ? [
            pill(
              totalUsed
                ? "Ferry total budget used"
                : "Ferry background budget used",
              true,
            ),
          ]
        : []),
      ...(!vendor.cooldownUntil && !totalUsed && !backgroundUsed
        ? [pill("Capacity available")]
        : []),
    );
    const meter = node("meter");
    meter.min = 0;
    meter.max = vendor.totalLimit;
    meter.value = vendor.requests;
    meter.setAttribute(
      "aria-label",
      `${vendorName(vendor.vendor)} requests reserved`,
    );
    wrap.append(
      heading,
      meter,
      node(
        "p",
        `${count(vendor.requests)} / ${count(vendor.totalLimit)} total · ${count(vendor.backgroundRequests)} / ${count(vendor.backgroundLimit)} background`,
        "small",
      ),
      node("p", `Ferry budget resets ${date(vendor.windowEndsAt)}`, "small"),
    );
    if (vendor.cooldownUntil)
      wrap.append(
        node(
          "p",
          `Provider cooldown until ${date(vendor.cooldownUntil)}`,
          "small",
        ),
      );
    vendors.append(wrap);
  }
  const exportState = exportPresentation(
    data.gates.effective,
    data.gates.exportMode,
  );
  element("export-state").replaceChildren(
    pill(exportState.label, false, !data.gates.effective),
    node("p", exportState.message, "small"),
  );
  const gates = element("export-gates");
  gates.replaceChildren();
  for (const [label, passed] of [
    ["Exports enabled", data.gates.exportsEnabled],
    ["Rollout checks passed", data.gates.rolloutChecksPassed],
    ["Live writes authorized", data.gates.liveWriteAuthorized],
    ["Source boundary verified", data.gates.sourceBoundaryVerified],
    ["QRZ first inserts enabled", data.gates.qrzFreshInsertsEnabled],
    ["LoTW first inserts enabled", data.gates.lotwFreshInsertsEnabled],
    [
      `Contact scope · ${data.gates.rolloutScope}`,
      data.gates.rolloutScopeConfigured,
    ],
    [
      `Destination scope · ${data.gates.destinationScope}`,
      data.gates.destinationScopeConfigured,
    ],
    ["Configuration valid", data.gates.configurationValid],
  ] as const) {
    const row = node("div", "", "admin-gate");
    row.append(
      node("span", label),
      pill(passed ? "Ready" : "Closed", false, !passed),
    );
    gates.append(row);
  }
}

function renderPeople(data: AdminOverview) {
  const filter = element<HTMLInputElement>("people-filter")
    .value.trim()
    .toLowerCase();
  element("accounts-limit").textContent =
    `${count(data.accounts.total)} accounts in total. ${data.accounts.truncated ? "Showing the first 100; more accounts are not included in this view." : "All accounts included."} The filter applies to this loaded list.`;
  table(
    "accounts-table",
    ["Account", "Status", "Verified", "Passkeys", "Connections"],
    data.accounts.items
      .filter((row) =>
        `${row.email} ${row.status}`.toLowerCase().includes(filter),
      )
      .map((row) => [
        row.email,
        readable(row.status),
        date(row.verifiedAt),
        count(row.passkeys),
        count(row.connections),
      ]),
    "No accounts match this view.",
  );
  element("connections-limit").textContent =
    `${count(data.connections.total)} connections in total. ${data.connections.truncated ? "Showing the first 100; more connections are not included in this view." : "All connections included."} The filter applies to this loaded list.`;
  table(
    "connections-table",
    [
      "Account / connection",
      "Service",
      "State",
      "Last success",
      "Last attempt",
      "Verified windows",
    ],
    data.connections.items
      .filter((row) =>
        `${row.accountEmail} ${row.label} ${row.kind} ${row.status}`
          .toLowerCase()
          .includes(filter),
      )
      .map((row) => [
        cell(row.accountEmail, row.label),
        vendorName(row.kind),
        cell(
          connectionStatus(row.status),
          row.hasError ? "An error needs attention" : undefined,
        ),
        cell(
          age(row.lastSuccessAt, data.generatedAt),
          row.lastSuccessAt === null ? undefined : date(row.lastSuccessAt),
        ),
        age(row.lastAttemptAt, data.generatedAt),
        `${count(row.coverageReady)} / ${count(row.coverageTotal)}`,
      ]),
    "No connections match this view.",
  );
}

function renderInvitations(data: AdminInvitations) {
  element("invitations-limit").textContent = data.invitationsTruncated
    ? `Most recent ${data.limit} invitations; older invitations are not shown.`
    : "All retained invitations. Expired and revoked invitations are retained for 90 days.";
  table(
    "invitations-table",
    ["Email", "Invitation", "Mail", "Expires", "Action"],
    data.invitations.map((row) => {
      const action = node("span", "—");
      if (row.status === "pending") {
        const button = node("button", "Revoke", "secondary");
        button.type = "button";
        button.setAttribute("aria-label", `Revoke invitation for ${row.email}`);
        button.disabled = mutating;
        button.addEventListener("click", () => {
          if (!window.confirm(`Revoke the unused invitation for ${row.email}?`))
            return;
          void mutate(async () =>
            api<AdminInvitationResult>("/api/admin/invitations/revoke", {
              email: row.email,
            }),
          );
        });
        action.replaceChildren(button);
      }
      return [
        row.email,
        pill(row.status, false, row.status !== "pending"),
        cell(
          readable(row.mailStatus),
          row.lastSentAt === null ? "No send recorded" : date(row.lastSentAt),
        ),
        date(row.expiresAt),
        action,
      ];
    }),
    "No invitations yet. Send the first invitation above.",
  );
  element("audit-limit").textContent =
    `${data.auditTruncated ? `Most recent ${data.limit} events; older events are not shown.` : "All retained events."} Audit records are retained for 90 days.`;
  table(
    "audit-table",
    ["When", "Actor", "Action", "Email", "Outcome"],
    data.audit.map((row) => [
      date(row.at),
      row.actor,
      readable(row.action),
      row.email,
      readable(row.status),
    ]),
    "No invitation actions recorded yet.",
  );
}

function handleError(error: unknown, snapshot = false) {
  const unauthorized =
    error instanceof ApiError &&
    (error.status === 401 || (error.status === 403 && !error.code));
  if (unauthorized) {
    overview = null;
    element("admin-content").hidden = true;
    for (const id of [
      "accounts-table",
      "connections-table",
      "invitations-table",
      "audit-table",
    ])
      element(id).replaceChildren();
  }
  const detail =
    error instanceof Error ? error.message : "Unable to complete this request.";
  message(
    `${snapshot && overview ? "Refresh failed. The displayed snapshot is out of date. " : ""}${detail}${unauthorized ? " Return to the dashboard to sign in with your admin passkey." : ""}`,
    true,
  );
}
async function refresh() {
  if (refreshing || mutating) return;
  refreshing = true;
  element<HTMLButtonElement>("refresh-admin").disabled = true;
  try {
    const current = await api<BrowserSession>("/api/auth/session");
    if (!current.authenticated)
      throw new ApiError("Sign in to use the admin console.", 401);
    const [data, invitations] = await Promise.all([
      api<AdminOverview>("/api/admin/overview"),
      api<AdminInvitations>("/api/admin/invitations"),
    ]);
    overview = data;
    renderOverview(data);
    renderPeople(data);
    renderInvitations(invitations);
    element("snapshot-time").textContent =
      `Snapshot ${new Date(data.generatedAt).toLocaleTimeString()}`;
    element("admin-content").hidden = false;
    message("");
  } catch (error) {
    handleError(error, true);
  } finally {
    refreshing = false;
    element<HTMLButtonElement>("refresh-admin").disabled = false;
  }
}
async function mutate(action: () => Promise<AdminInvitationResult>) {
  if (mutating || refreshing) return;
  mutating = true;
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    "#invitations button, #refresh-admin",
  );
  for (const button of buttons) button.disabled = true;
  try {
    const result = await action();
    message(result.message, result.invitation.mailStatus === "uncertain");
    try {
      renderInvitations(await api<AdminInvitations>("/api/admin/invitations"));
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      )
        handleError(error);
      else
        message(
          `${result.message} Invitation list refresh failed; refresh before taking another action.`,
          true,
        );
    }
  } catch (error) {
    handleError(error);
  } finally {
    mutating = false;
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "#invitations button, #refresh-admin",
    ))
      button.disabled = false;
  }
}
element("refresh-admin").addEventListener("click", () => {
  void refresh();
});
element<HTMLFormElement>("retention-form").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    if (refreshing || mutating) return;
    const input = element<HTMLInputElement>("settled-retention-days");
    const button = element<HTMLButtonElement>("save-retention");
    const days = input.valueAsNumber;
    void (async () => {
      mutating = true;
      button.disabled = true;
      input.disabled = true;
      try {
        const retention = await api<AdminOverview["retention"]>(
          "/api/admin/retention",
          {
            settledRetentionDays: days,
          },
        );
        if (overview) overview = { ...overview, retention };
        input.value = String(retention.settledRetentionDays);
        message(
          `Settled contact retention saved at ${retention.settledRetentionDays} days.`,
        );
      } catch (error) {
        handleError(error);
      } finally {
        input.disabled = false;
        button.disabled = false;
        mutating = false;
      }
    })();
  },
);
element("people-filter").addEventListener("input", () => {
  if (overview) renderPeople(overview);
});
element<HTMLFormElement>("invite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const email = element<HTMLInputElement>("invite-email").value;
  void mutate(async () => {
    const result = await api<AdminInvitationResult>("/api/admin/invitations", {
      email,
    });
    element<HTMLInputElement>("invite-email").value = "";
    return result;
  });
});
selectPage();
void refresh();
