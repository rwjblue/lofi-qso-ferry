import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { createApiClient } from "./browser-api.ts";
import {
  type ConnectionSummary,
  connectionGroups,
  connectionStatus,
  ledgerEmptyMessage,
  previewStatus,
  vendorName,
} from "./browser-dashboard.ts";
import { lofiAccountLabel, LOFI_CLIENT_NAME } from "./lofi-identity.ts";
import type { ReviewResponse } from "./review-types.ts";

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element ${id}`);
  return value as T;
};
let signupId = "";
let emailId = "";
let messageSequence = 0;
let authIntent = 0;
const joining = location.pathname.replace(/\/+$/, "") === "/join";
let focusJoinEmail = joining;
const DEFAULT_COMMENT_TEMPLATE =
  '{% assign refs = op.refs | refLabels | join: ", " %}{{ refs }}{% if qso.notes != blank %}{% if refs != blank %} | {% endif %}{{ qso.notes }}{% endif %}';
interface NarrativeTemplate {
  fields: { COMMENT?: string; NOTES?: string; QSLMSG?: string };
  fallbackNotes: boolean;
}
const builtInTemplate: NarrativeTemplate = {
  fields: { COMMENT: DEFAULT_COMMENT_TEMPLATE },
  fallbackNotes: false,
};
let availableTemplates = new Map<string, NarrativeTemplate>();
function message(value: string, error = false) {
  const node = element("message");
  node.textContent = value;
  node.classList.toggle("error", error);
  node.hidden = false;
  const sequence = ++messageSequence;
  setTimeout(() => {
    if (messageSequence === sequence) node.hidden = true;
  }, 8000);
}
const { request: api } = createApiClient(async () => {
  message("Verify your passkey to continue.");
  await ceremony("reauth");
});
function bind(id: string, callback: () => Promise<void>) {
  element(id).addEventListener("click", () => {
    void run(callback);
  });
}
async function run(callback: () => Promise<void>) {
  try {
    await callback();
  } catch (error) {
    message(
      error instanceof Error ? error.message : "Unable to complete this action",
      true,
    );
  }
}
function form(id: string, callback: (data: FormData) => Promise<void>) {
  element<HTMLFormElement>(id).addEventListener("submit", (event) => {
    event.preventDefault();
    const button = element(id).querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (button) button.disabled = true;
    void run(async () => {
      try {
        await callback(new FormData(element<HTMLFormElement>(id)));
      } finally {
        if (button) button.disabled = false;
      }
    });
  });
}
const text = (data: FormData, key: string) => String(data.get(key) ?? "");
function confirmationInput(id: string) {
  const input = element<HTMLInputElement>(id);
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
  });
  input.addEventListener("paste", (event) => {
    const pasted = event.clipboardData?.getData("text");
    if (pasted && /^[\d\s-]+$/.test(pasted)) {
      event.preventDefault();
      input.value = pasted.replace(/\D/g, "").slice(0, 6);
    }
  });
}
function focusConfirmation(id: string) {
  const input = element<HTMLInputElement>(id);
  input.value = "";
  input.focus();
}
function showSelectedTemplate() {
  const form = element<HTMLFormElement>("template");
  const destination = element<HTMLSelectElement>("template-destination").value;
  const version = availableTemplates.get(destination) ?? builtInTemplate;
  for (const [name, field] of [
    ["comment", "COMMENT"],
    ["notes", "NOTES"],
    ["qslmsg", "QSLMSG"],
  ] as const) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLTextAreaElement)
      input.value = version.fields[field] ?? "";
  }
  const fallback = form.elements.namedItem("fallbackNotes");
  if (fallback instanceof HTMLInputElement)
    fallback.checked = version.fallbackNotes;
  element("template-scope").textContent = destination
    ? "New template bindings for this logbook use this version. Existing contacts keep their version; adopted QRZ text stays preserved."
    : "New QRZ connections inherit this default. Existing logbooks and contacts keep their versions.";
}
async function ceremony(path: string, label?: string) {
  ++authIntent;
  WebAuthnAbortService.cancelCeremony();
  const begin = await api<{
    ceremonyId: string;
    options:
      | PublicKeyCredentialRequestOptionsJSON
      | PublicKeyCredentialCreationOptionsJSON;
  }>(`/api/auth/${path}/options`, path === "register" ? { signupId } : {});
  const registration = path === "register" || path === "passkeys";
  const response: AuthenticationResponseJSON | RegistrationResponseJSON =
    registration
      ? await startRegistration({
          optionsJSON: begin.options as PublicKeyCredentialCreationOptionsJSON,
        })
      : await startAuthentication({
          optionsJSON: begin.options as PublicKeyCredentialRequestOptionsJSON,
        });
  await api(`/api/auth/${path}/verify`, {
    ceremonyId: begin.ceremonyId,
    response,
    ...(label ? { label } : {}),
    ...(path === "register" ? { signupId } : {}),
  });
}
interface Dashboard {
  email: string;
  admin: boolean;
  quietMinutes: number;
  exportsEnabled: boolean;
  defaultTemplate?: NarrativeTemplate;
  destinationTemplates?: (NarrativeTemplate & { destination: string })[];
  counts: Record<string, number>;
  connections: ConnectionSummary[];
  activity: {
    qso: string;
    destination: string;
    state: string;
    reason: string | null;
    confirmed: number;
    priorIdentityCount?: number;
  }[];
  passkeys: { id: string; label: string; last_used_at: number | null }[];
  sessions: {
    token_hash?: string;
    id?: string;
    created_at: number;
    current?: boolean;
  }[];
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value: string,
  className?: string,
) {
  const output = document.createElement(tag);
  output.textContent = value;
  if (tag === "button") output.setAttribute("type", "button");
  if (className) output.className = className;
  return output;
}
function action(label: string, callback: () => Promise<void>) {
  const button = node("button", label, "secondary");
  button.addEventListener("click", () => {
    button.disabled = true;
    void run(async () => {
      try {
        await callback();
      } finally {
        button.disabled = false;
      }
    });
  });
  return button;
}

let lotwLoginRequest = 0;
interface LotwLoginCheckResponse {
  loginVerification: {
    status: "verified" | "rejected" | "unavailable";
    checkedAt: string;
  };
  message: string;
}

function showLotwLoginResult(value: string, failed = false) {
  const result = element("lotw-login-result");
  result.textContent = value;
  result.classList.toggle("connection-error", failed);
  result.hidden = false;
}

async function updateCredentials(connection: ConnectionSummary) {
  const response = await api<{
    connections: { id: string; config: Record<string, unknown> }[];
  }>("/api/connections");
  const existing = response.connections.find((row) => row.id === connection.id);
  if (!existing)
    throw new Error("This connection has changed. Refresh and try again.");
  const details = element<HTMLDetailsElement>(`connect-${connection.kind}`);
  const form = element<HTMLFormElement>(connection.kind);
  form.reset();
  if (connection.kind === "lotw") {
    ++lotwLoginRequest;
    element("lotw-login-result").hidden = true;
  }
  const fields =
    connection.kind === "qrz"
      ? ["bookId", "stationCallsign", "startDate", "endDate"]
      : ["username"];
  for (const field of fields) {
    const input = form.elements.namedItem(field);
    const value =
      field === "username"
        ? existing.config.queryUsername
        : existing.config[field];
    if (input instanceof HTMLInputElement && typeof value === "string")
      input.value = value;
  }
  details.hidden = false;
  details.open = true;
  element(`connect-${connection.kind}-title`).textContent =
    `Update ${vendorName(connection.kind)} credentials`;
  element(`connect-${connection.kind}-help`).textContent =
    "Update credentials for this same connected account. To link a different account, remove the current credentials first. Historical delivery records stay available.";
  details.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const first = form.querySelector("input");
  first?.focus();
}

function renderConnection(connection: ConnectionSummary, previous = false) {
  const item = node("div", "", "connection");
  item.append(
    node(
      "b",
      connection.kind === "lofi" && connection.status !== "approval_pending"
        ? LOFI_CLIENT_NAME
        : connection.label,
    ),
    node(
      "span",
      connectionStatus(connection.status),
      `badge status-${connection.status}`,
    ),
  );
  if (connection.kind === "lofi" && connection.status !== "approval_pending")
    item.append(
      node(
        "p",
        `LoFi account: ${lofiAccountLabel(connection.label)}`,
        "small connection-note",
      ),
    );
  if (connection.kind === "lotw" && !previous && connection.lotwVerification) {
    const checks = node("ul", "", "verification-checks");
    checks.setAttribute("aria-label", "LoTW verification checks");
    const labels = {
      login: "LoTW website login",
      certificate: "Certificate import",
      certificate_status: "ARRL certificate status",
    };
    const statuses = {
      ok: "Passed",
      warning: "Needs attention",
      error: "Failed",
      unknown: "Not checked",
    };
    for (const check of connection.lotwVerification) {
      const row = node("li", "", "verification-check");
      const heading = node("div", "", "verification-heading");
      heading.append(
        node("span", labels[check.id]),
        node(
          "span",
          statuses[check.status],
          `verification-state check-${check.status}`,
        ),
      );
      row.append(heading, node("p", check.message, "small"));
      if (check.checkedAt)
        row.append(
          node(
            "p",
            `Checked ${new Date(check.checkedAt).toLocaleString()}`,
            "small verification-time",
          ),
        );
      checks.append(row);
    }
    item.append(checks);
  }
  if (connection.last_error)
    item.append(node("p", connection.last_error, "small connection-error"));
  if (connection.last_poll_at)
    item.append(
      node(
        "p",
        `Last poll attempt ${new Date(connection.last_poll_at).toLocaleString()}`,
        "small",
      ),
    );
  if (previous) {
    item.append(
      node(
        "p",
        "Credentials removed. Historical delivery records are retained.",
        "small",
      ),
    );
    return item;
  }
  const actions = node("div", "", "actions connection-actions");
  if (connection.status === "approval_pending") {
    item.append(
      node(
        "p",
        "Approve the request from Ham2K in your email, then finish linking.",
        "small",
      ),
    );
    actions.append(
      action("Finish linking", async () => {
        await api("/api/connections/lofi/finish", { id: connection.id });
        await load();
      }),
    );
  } else if (
    connection.status === "disabled" ||
    connection.status === "paused"
  ) {
    actions.append(
      action("Resume", async () => {
        await api("/api/connections/enable", { id: connection.id });
        await load();
      }),
    );
  } else {
    actions.append(
      action("Pause", async () => {
        await api("/api/connections/disable", { id: connection.id });
        await load();
      }),
    );
  }
  if (connection.kind !== "lofi" && connection.status !== "approval_pending")
    actions.append(
      action("Update credentials", () => updateCredentials(connection)),
    );
  if (connection.kind === "lotw")
    actions.append(
      action("Check login", async () => {
        try {
          const result = await api<LotwLoginCheckResponse>(
            "/api/connections/lotw/check-login",
            { id: connection.id },
          );
          message(
            result.message,
            result.loginVerification.status !== "verified",
          );
        } finally {
          await load();
        }
      }),
    );
  actions.append(
    action(
      connection.status === "approval_pending"
        ? "Cancel linking"
        : "Remove credentials",
      async () => {
        await api("/api/connections/revoke", { id: connection.id });
        await load();
      },
    ),
  );
  item.append(actions);
  return item;
}

function renderConnections(data: Dashboard) {
  const connections = element("connections");
  for (const group of connectionGroups(data.connections)) {
    // Move the existing forms before replacing cards so their event handlers survive.
    const details = element<HTMLDetailsElement>(`connect-${group.kind}`);
    element("connection-forms").append(details);
  }
  connections.replaceChildren();
  for (const group of connectionGroups(data.connections)) {
    const section = node("section", "", "service");
    const heading = node("div", "", "service-heading");
    heading.append(
      node("h3", vendorName(group.kind)),
      node("span", group.kind === "lofi" ? "Source" : "Destination", "small"),
    );
    section.append(heading);
    const details = element<HTMLDetailsElement>(`connect-${group.kind}`);
    details.hidden = group.current.length > 0;
    details.open = false;
    element(`connect-${group.kind}-title`).textContent =
      `Connect ${vendorName(group.kind)}`;
    element(`connect-${group.kind}-help`).textContent =
      group.kind === "lofi"
        ? "Link your LoFi account to begin a read-only scan of your source contacts."
        : "Verify your account before Ferry reviews existing destination history.";
    if (group.current.length > 1)
      section.append(
        node(
          "p",
          `${group.current.length} existing connections are retained. Review each route before enabling delivery.`,
          "notice",
        ),
      );
    for (const connection of group.current)
      section.append(renderConnection(connection));
    if (!group.current.length)
      section.append(node("p", "Not connected", "small"));
    section.append(details);
    if (group.previous.length) {
      const previous = node("details", "");
      previous.append(
        node("summary", `Previous connections (${group.previous.length})`),
      );
      for (const connection of group.previous)
        previous.append(renderConnection(connection, true));
      section.append(previous);
    }
    connections.append(section);
  }
}

let reviewRequest = 0;
let dashboardLoad = 0;
function renderMetrics(
  id: string,
  values: readonly (readonly [string, number | string])[],
) {
  const metrics = element(id);
  metrics.replaceChildren();
  for (const [label, count] of values) {
    const metric = node("div", "", "metric");
    metric.append(node("b", String(count)), node("span", label));
    metrics.append(metric);
  }
}
function clearReview() {
  ++reviewRequest;
  element<HTMLButtonElement>("review-refresh").disabled = false;
  for (const id of ["readiness", "source-progress", "review-contacts"])
    element(id).replaceChildren();
  element("review-status").textContent = "Loading source progress…";
  element("review-template-notice").textContent = "";
  element("review-retention").textContent = "";
  element("review-empty").hidden = true;
  renderMetrics("metrics", [
    ["Contacts seen", "—"],
    ["Live operations", "—"],
    ["Available details", "—"],
    ["Services need attention", "—"],
  ]);
  element("source-metrics-explainer").textContent =
    "Loading source scan progress…";
}
async function refreshReview() {
  const request = ++reviewRequest;
  const button = element<HTMLButtonElement>("review-refresh");
  button.disabled = true;
  element("review-status").textContent = "Loading retained source contacts…";
  try {
    const destination = element<HTMLSelectElement>("review-destination").value;
    const query = destination
      ? `?destination=${encodeURIComponent(destination)}`
      : "";
    const data = await api<ReviewResponse>(`/api/review${query}`);
    if (request !== reviewRequest) return;
    renderReview(data);
  } catch (error) {
    if (request !== reviewRequest) return;
    element("review-status").textContent =
      error instanceof Error
        ? error.message
        : "Read-only review is unavailable. Try again shortly.";
  } finally {
    if (request === reviewRequest) button.disabled = false;
  }
}

function renderReview(data: ReviewResponse) {
  renderMetrics("metrics", [
    [
      "Contacts seen",
      data.sources.reduce((count, source) => count + source.counts.contacts, 0),
    ],
    [
      "Live operations",
      data.sources.reduce(
        (count, source) => count + source.counts.operations,
        0,
      ),
    ],
    [
      "Available details",
      data.sources.reduce(
        (count, source) => count + source.counts.reviewable,
        0,
      ),
    ],
    [
      "Services need attention",
      data.readiness.filter((item) => item.status === "attention").length,
    ],
  ]);
  const scanning = data.sources.some(
    (source) =>
      !source.initialScanComplete ||
      !source.contextComplete ||
      source.counts.pendingOperations > 0,
  );
  element("source-metrics-explainer").textContent = !data.sources.length
    ? "Connect LoFi to see source contacts here. Destination delivery activity is shown separately below."
    : `${scanning ? "Source scan in progress. " : ""}Counts show live source records seen so far, excluding deleted records and non-contact events. Available details are limited by retention.${data.sourcesTruncated ? " Only the displayed source connections are counted." : ""}`;
  element("review-status").textContent =
    `Updated ${new Date(data.generatedAt).toLocaleString()}. This review reads retained data; it does not prepare or deliver contacts.`;
  const readiness = element("readiness");
  readiness.replaceChildren();
  for (const item of data.readiness) {
    const row = node("div", "", "readiness-item");
    row.append(
      node("b", vendorName(item.kind)),
      node(
        "span",
        item.status.replaceAll("_", " "),
        `badge status-${item.status}`,
      ),
      node("p", item.message, "small"),
    );
    readiness.append(row);
  }
  const sources = element("source-progress");
  sources.replaceChildren();
  for (const source of data.sources) {
    const card = node("div", "", "source-progress");
    card.append(
      node("h3", `LoFi account · ${lofiAccountLabel(source.label)}`),
      node("p", `Client: ${LOFI_CLIENT_NAME}`, "small"),
      node("p", source.message, "small"),
    );
    const counts = node("div", "", "source-counts");
    for (const [label, value] of [
      ["Live operations", source.counts.operations],
      ["Contacts seen", source.counts.contacts],
      ["Available for review", source.counts.reviewable],
    ] as const) {
      const count = node("div", "");
      count.append(node("b", String(value)), node("span", label));
      counts.append(count);
    }
    card.append(counts);
    card.append(
      node(
        "p",
        "Counts reflect the source index seen so far. Contacts exclude non-contact events and deleted records; available details are limited by retention.",
        "small",
      ),
    );
    card.append(
      node(
        "p",
        `${source.initialScanComplete ? "Initial contact scan complete" : "Initial contact scan in progress"} · ${source.contextComplete && source.counts.pendingOperations === 0 ? "Operation and location context complete" : "Operation and location context still loading"}`,
        "small",
      ),
    );
    if (source.counts.pendingOperations || source.counts.operationReadFailures)
      card.append(
        node(
          "p",
          `${source.counts.pendingOperations} operation context reads pending · ${source.counts.operationReadFailures} reads need retry. Previews wait for complete contact context.`,
          "small",
        ),
      );
    if (source.lastSuccessAt)
      card.append(
        node(
          "p",
          `Last successful source page ${new Date(source.lastSuccessAt).toLocaleString()}`,
          "small",
        ),
      );
    const excluded = [
      source.counts.events ? `${source.counts.events} non-contact events` : "",
      source.counts.tombstones
        ? `${source.counts.tombstones} deleted records`
        : "",
      source.counts.expired ? `${source.counts.expired} expired payloads` : "",
    ].filter(Boolean);
    if (excluded.length)
      card.append(
        node("p", `Shown separately: ${excluded.join(" · ")}.`, "small"),
      );
    sources.append(card);
  }
  if (!data.sources.length)
    sources.append(
      node(
        "p",
        "Connect LoFi to scan source contacts. Existing destination history is reviewed separately before any delivery.",
        "small",
      ),
    );
  if (data.sourcesTruncated)
    sources.append(
      node(
        "p",
        "This bounded review shows only the first source connections.",
        "small",
      ),
    );
  element("review-template-notice").textContent = data.template.notice;
  const contacts = element("review-contacts");
  contacts.replaceChildren();
  for (const contact of data.recentContacts) {
    const card = node("article", "", "contact-review");
    const heading = node("div", "", "contact-heading");
    heading.append(
      node("h3", contact.call ?? "Contact details unavailable"),
      node(
        "span",
        [contact.band, contact.mode].filter(Boolean).join(" · "),
        "small",
      ),
    );
    card.append(heading);
    if (contact.at)
      card.append(node("p", new Date(contact.at).toLocaleString(), "small"));
    const context = [
      contact.stationCall ? `Station ${contact.stationCall}` : "",
      contact.grid,
      contact.operationName ??
        (contact.operationId ? "Operation context loading" : ""),
    ].filter(Boolean);
    if (context.length) card.append(node("p", context.join(" · "), "small"));
    const references = [
      ...(contact.ownParks ?? []).map((park) => `Own ${park}`),
      ...(contact.workedParks ?? []).map((park) => `Worked ${park}`),
    ];
    if (references.length)
      card.append(node("p", references.join(" · "), "small"));
    card.append(
      node(
        "span",
        contact.state === "test"
          ? "Test — not exported"
          : previewStatus(contact.templateStatus),
        "badge",
      ),
      node("p", `Review state: ${contact.state.replaceAll("_", " ")}`, "small"),
    );
    if (contact.templateStatus === "remote_preserved")
      card.append(
        node(
          "p",
          "The existing QRZ narrative stays unchanged. Current templates do not rewrite adopted history.",
          "small",
        ),
      );
    if (contact.preview) {
      if (contact.templateStatus === "pinned")
        card.append(
          node(
            "p",
            "This hypothetical current template output does not replace the contact’s pinned version.",
            "small",
          ),
        );
      const fields = node("dl", "", "preview-fields");
      for (const [field, label] of [
        ["COMMENT", "Comment"],
        ["NOTES", "Notes"],
        ["QSLMSG", "QSL message"],
      ] as const) {
        if (contact.preview[field] !== undefined)
          fields.append(
            node("dt", label),
            node("dd", contact.preview[field] || "(empty)"),
          );
      }
      card.append(fields);
    }
    if (contact.reason)
      card.append(
        node(
          "p",
          contact.reason === "test_operation_not_exported"
            ? "Test contacts are retained here and excluded from external services."
            : contact.reason.replaceAll("_", " "),
          "small",
        ),
      );
    if (contact.pinnedTemplateVersion)
      card.append(
        node("p", `Pinned version ${contact.pinnedTemplateVersion}`, "small"),
      );
    card.append(
      node(
        "p",
        `Source details retained until ${new Date(contact.retainedUntil).toLocaleString()}.`,
        "small retention",
      ),
    );
    contacts.append(card);
  }
  element("review-empty").hidden = data.recentContacts.length > 0;
  element("review-retention").textContent =
    `Recent source contact details expire after ${data.retention.contactsDays} days; operation context expires after ${data.retention.contextDays} days. This is a bounded review, not a full copy of your log.`;
}
async function load() {
  const request = ++dashboardLoad;
  clearReview();
  const entering = !element("welcome").hidden;
  const session = await api<{
    authenticated: boolean;
    csrf: string;
    email?: string;
    signupAllowed?: boolean;
  }>("/api/auth/session");
  if (request !== dashboardLoad) return;
  element("welcome").hidden = session.authenticated;
  element("dashboard").hidden = !session.authenticated;
  element("admin-link").hidden = true;
  if (!session.authenticated) {
    ++reviewRequest;
    element("account").textContent = "";
    const openSignup = session.signupAllowed === true;
    const joinPanel = element<HTMLDetailsElement>("join-panel");
    joinPanel.hidden = !openSignup && !joining;
    joinPanel.open = joining || joinPanel.open;
    element("invite-only").hidden = openSignup;
    element("join-link").hidden = joining;
    element("join-explainer").hidden = openSignup;
    element("join-summary").textContent = openSignup
      ? "Create your account"
      : "Accept your invitation";
    if (focusJoinEmail) {
      focusJoinEmail = false;
      element<HTMLInputElement>("signup-email").focus();
    }
    if (!joining) void autofill().catch(() => {});
    return;
  }
  const data = await api<Dashboard>("/api/dashboard");
  if (request !== dashboardLoad) return;
  element("account").textContent = data.email;
  element("admin-link").hidden = !data.admin;
  element("export-banner").textContent = data.exportsEnabled
    ? "Automatic delivery is enabled. Existing history is adopted before any eligible backfill."
    : "Read-only rollout: production exports are disabled. Connections and history can be reviewed safely.";
  if (entering) window.scrollTo({ top: 0 });
  const counts = data.counts;
  const metrics = element("delivery-metrics");
  metrics.replaceChildren();
  for (const [label, count] of [
    ["History adopted", counts.adopted_existing ?? 0],
    [
      "Waiting / pending",
      (counts.inventory_pending ?? 0) +
        (counts.missing_current_identity ?? 0) +
        (counts.changed ?? 0),
    ],
    [
      "Submitted / observed",
      (counts.submitted ?? 0) +
        (counts.observed ?? 0) +
        (counts.delivered ?? 0),
    ],
    [
      "Needs attention",
      Object.entries(counts)
        .filter(([key]) =>
          /ambiguous|mismatch|unverified|uncertain|reconciliation|blocked/.test(
            key,
          ),
        )
        .reduce((sum, [, value]) => sum + value, 0),
    ],
  ] as const) {
    const metric = node("div", "", "metric");
    metric.append(node("b", String(count)), node("span", label));
    metrics.append(metric);
  }
  renderConnections(data);
  const templateDestination = element<HTMLSelectElement>(
    "template-destination",
  );
  const selectedDestination = templateDestination.value;
  const defaultOption = node("option", "Account default · new QRZ connections");
  defaultOption.value = "";
  templateDestination.replaceChildren(defaultOption);
  availableTemplates = new Map([
    ["", data.defaultTemplate ?? builtInTemplate],
    ...(data.destinationTemplates ?? []).map(
      (template) => [template.destination, template] as const,
    ),
  ]);
  const reviewDestination = element<HTMLSelectElement>("review-destination");
  const selectedReview = reviewDestination.value;
  reviewDestination.replaceChildren();
  for (const [value, label] of [
    ["", "Automatic · connected QRZ or account default"],
    ["account_default", "Saved account default"],
  ]) {
    const option = node("option", label ?? "");
    option.value = value ?? "";
    reviewDestination.append(option);
  }
  for (const connection of data.connections) {
    if (connection.kind !== "qrz" || connection.status === "revoked") continue;
    for (const select of [templateDestination, reviewDestination]) {
      const option = node("option", connection.label);
      option.value = connection.id;
      select.append(option);
    }
  }
  reviewDestination.value = [...reviewDestination.options].some(
    (option) => option.value === selectedReview,
  )
    ? selectedReview
    : "";
  templateDestination.value = [...templateDestination.options].some(
    (option) => option.value === selectedDestination,
  )
    ? selectedDestination
    : "";
  showSelectedTemplate();
  const activity = element("activity");
  activity.replaceChildren();
  for (const row of data.activity) {
    const tr = document.createElement("tr");
    const destinationKind = data.connections.find(
      (connection) => connection.id === row.destination,
    )?.kind;
    tr.append(
      node("td", row.qso.slice(0, 12)),
      node("td", destinationKind ? vendorName(destinationKind) : "—"),
      node(
        "td",
        row.state.replaceAll("_", " ") + (row.confirmed ? " · confirmed" : ""),
      ),
      node(
        "td",
        [
          row.reason,
          row.priorIdentityCount
            ? `${row.priorIdentityCount} prior LoTW identity retained; remote record may remain`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || "—",
      ),
    );
    activity.append(tr);
  }
  element("empty").hidden = data.activity.length > 0;
  element("empty").textContent = ledgerEmptyMessage(data.connections);
  const quietPeriod =
    element<HTMLFormElement>("settings").elements.namedItem("quietMinutes");
  if (quietPeriod instanceof HTMLSelectElement) {
    const saved = String(data.quietMinutes);
    if (![...quietPeriod.options].some((option) => option.value === saved)) {
      const option = node("option", saved);
      option.value = saved;
      quietPeriod.append(option);
    }
    quietPeriod.value = saved;
  }
  void refreshReview();
  const keys = element("keys");
  keys.replaceChildren();
  for (const key of data.passkeys) {
    const item = node("div", "", "key");
    item.append(node("span", key.label));
    const revoke = node("button", "Revoke", "secondary");
    revoke.disabled = data.passkeys.length <= 1;
    revoke.addEventListener("click", () => {
      void run(async () => {
        await api("/api/auth/passkeys/revoke", { id: key.id });
        await load();
      });
    });
    item.append(revoke);
    keys.append(item);
  }
  const sessions = element("sessions");
  sessions.replaceChildren();
  for (const current of data.sessions)
    sessions.append(
      node(
        "p",
        `${new Date(current.created_at).toLocaleString()}${current.current ? " · this session" : ""}`,
        "small",
      ),
    );
}
bind("login", async () => {
  await ceremony("login");
  await load();
});
form("signup", async (data) => {
  ++authIntent;
  WebAuthnAbortService.cancelCeremony();
  const result = await api<{ id: string }>("/api/auth/signup", {
    email: text(data, "email"),
  });
  signupId = result.id;
  element("verify").hidden = false;
  element("signup-code-help").textContent =
    `Enter the six-digit code sent to ${text(data, "email")}. You can paste it or use email autofill.`;
  focusConfirmation("signup-code");
  message("Enter the confirmation code from your email in this tab.");
});
form("verify", async (data) => {
  const verification = await api("/api/auth/signup/verify", {
    id: signupId,
    code: text(data, "code"),
  });
  if (verification.existingAccount) {
    message("This account already exists. Sign in with your passkey.");
    return;
  }
  await ceremony("register", "First passkey");
  await load();
  message(
    "Welcome aboard. Add a backup passkey before connecting your logbooks.",
  );
});
bind("refresh", load);
bind("review-refresh", refreshReview);
element("review-destination").addEventListener("change", () => {
  void refreshReview();
});
bind("reauth", async () => {
  await ceremony("reauth");
  await load();
  message("Passkey verified for the next five minutes.");
});
bind("add-key", async () => {
  await ceremony("passkeys", "Backup passkey");
  await load();
});
bind("logout", async () => {
  clearReview();
  ++dashboardLoad;
  await api("/api/auth/logout", {});
  await load();
});
form("lofi-start", async (data) => {
  const result = await api<{ id: string }>("/api/connections/lofi/start", {
    email: text(data, "email"),
  });
  if (!result.id) throw new Error("LoFi did not return a pending connection.");
  await load();
  message(
    "Check your email for the Ham2K approval request, then choose Finish linking.",
  );
});
form("qrz", async (data) => {
  await api("/api/connections/qrz", {
    apiKey: text(data, "apiKey"),
    book: {
      bookId: text(data, "bookId"),
      stationCallsign: text(data, "stationCallsign"),
      startDate: text(data, "startDate"),
      endDate: text(data, "endDate"),
    },
  });
  element<HTMLFormElement>("qrz").reset();
  await load();
});
bind("lotw-check-login", async () => {
  const button = element<HTMLButtonElement>("lotw-check-login");
  button.disabled = true;
  const request = ++lotwLoginRequest;
  showLotwLoginResult("Checking LoTW website login…");
  try {
    const data = new FormData(element<HTMLFormElement>("lotw"));
    const result = await api<LotwLoginCheckResponse>(
      "/api/connections/lotw/check-login",
      {
        username: text(data, "username"),
        password: text(data, "queryPassword"),
      },
    );
    if (request !== lotwLoginRequest) return;
    const failed = result.loginVerification.status !== "verified";
    showLotwLoginResult(
      `${result.message} Checked ${new Date(result.loginVerification.checkedAt).toLocaleString()}.`,
      failed,
    );
    message(result.message, failed);
  } catch (error) {
    if (request !== lotwLoginRequest) return;
    showLotwLoginResult(
      error instanceof Error ? error.message : "Unable to check LoTW login.",
      true,
    );
    throw error;
  } finally {
    button.disabled = false;
  }
});
for (const name of ["username", "queryPassword"]) {
  const input = element<HTMLFormElement>("lotw").elements.namedItem(name);
  if (input instanceof HTMLInputElement)
    input.addEventListener("input", () => {
      ++lotwLoginRequest;
      if (!element("lotw-login-result").hidden)
        showLotwLoginResult("Credentials changed. Check LoTW login again.");
    });
}
form("lotw", async (data) => {
  const file = data.get("p12");
  if (!(file instanceof File) || file.size > 256000)
    throw new Error("Choose a .p12 file smaller than 256 KB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = await api<{ status: string; message: string }>(
    "/api/connections/lotw",
    {
      p12: btoa(binary),
      password: text(data, "password"),
      ...(text(data, "username")
        ? {
            query: {
              username: text(data, "username"),
              password: text(data, "queryPassword"),
            },
          }
        : {}),
    },
  );
  element<HTMLFormElement>("lotw").reset();
  ++lotwLoginRequest;
  element("lotw-login-result").hidden = true;
  await load();
  message(result.message, result.status === "needs_verification");
});
form("settings", async (data) => {
  await api("/api/settings", {
    quietMinutes: Number(text(data, "quietMinutes")),
  });
  message("Quiet period saved.");
});
form("template", async (data) => {
  const destination = text(data, "destination");
  await api("/api/templates", {
    ...(destination ? { destination } : {}),
    fields: {
      COMMENT: text(data, "comment"),
      ...(text(data, "notes") ? { NOTES: text(data, "notes") } : {}),
      ...(text(data, "qslmsg") ? { QSLMSG: text(data, "qslmsg") } : {}),
    },
    fallbackNotes: data.has("fallbackNotes"),
  });
  await load();
  message(
    destination
      ? "New template version saved. Existing contacts keep their bindings."
      : "Account default saved. New QRZ connections will use it.",
  );
});
form("email", async (data) => {
  const result = await api<{ id: string }>("/api/auth/email", {
    email: text(data, "email"),
  });
  emailId = result.id;
  element("email-verify").hidden = false;
  focusConfirmation("email-code");
  message("Enter the code sent to the new address.");
});
form("email-verify", async (data) => {
  await api("/api/auth/email/verify", {
    id: emailId,
    code: text(data, "code"),
  });
  element("email-verify").hidden = true;
  await load();
});
bind("other-sessions", async () => {
  await api("/api/auth/sessions/revoke", { allOthers: true });
  await load();
  message("Other sessions signed out.");
});
confirmationInput("signup-code");
confirmationInput("email-code");
element("template-destination").addEventListener(
  "change",
  showSelectedTemplate,
);
void run(load);

if (location.hostname === "localhost") {
  element("local-mail").hidden = false;
  bind("show-mail", async () => {
    const response = await api<{ messages: { to: string; code: string }[] }>(
      "/api/auth/local-mailbox",
    );
    element("mail").textContent =
      response.messages.map((item) => `${item.to}: ${item.code}`).join("\n") ||
      "No local messages for this browser.";
  });
}

let autofillInFlight = false;
async function autofill() {
  const intent = authIntent;
  if (
    autofillInFlight ||
    !(await browserSupportsWebAuthnAutofill()) ||
    intent !== authIntent
  )
    return;
  autofillInFlight = true;
  try {
    const begin = await api<{
      ceremonyId: string;
      options: PublicKeyCredentialRequestOptionsJSON;
    }>("/api/auth/login/options", {});
    if (intent !== authIntent) return;
    const response = await startAuthentication({
      optionsJSON: begin.options,
      useBrowserAutofill: true,
    });
    if (intent !== authIntent) return;
    await api("/api/auth/login/verify", {
      ceremonyId: begin.ceremonyId,
      response,
    });
    await load();
  } catch {
    /* Conditional UI is optional; the explicit passkey button remains available. */
  } finally {
    autofillInFlight = false;
  }
}
