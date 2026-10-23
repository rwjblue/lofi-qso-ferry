import {
  browserSupportsWebAuthnAutofill,
  WebAuthnAbortService,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element ${id}`);
  return value as T;
};
let csrf = "";
let signupId = "";
let lofiId = "";
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
async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(result.error ?? "Request failed; try again.");
  return result;
}
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
    const button = element(id).querySelector("button");
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
  quietMinutes: number;
  exportsEnabled: boolean;
  defaultTemplate?: NarrativeTemplate;
  destinationTemplates?: (NarrativeTemplate & { destination: string })[];
  counts: Record<string, number>;
  connections: {
    id: string;
    kind: string;
    label: string;
    status: string;
    last_error?: string | null;
    last_poll_at: number | null;
  }[];
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
async function load() {
  const entering = !element("welcome").hidden;
  const session = await api<{
    authenticated: boolean;
    csrf: string;
    email?: string;
    signupAllowed?: boolean;
  }>("/api/auth/session");
  csrf = session.csrf;
  element("welcome").hidden = session.authenticated;
  element("dashboard").hidden = !session.authenticated;
  if (!session.authenticated) {
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
  element("account").textContent = data.email;
  element("export-banner").textContent = data.exportsEnabled
    ? "Automatic delivery is enabled. Existing history is adopted before any eligible backfill."
    : "Read-only rollout: production exports are disabled. Connections and history can be reviewed safely.";
  if (entering) window.scrollTo({ top: 0 });
  const counts = data.counts;
  const metrics = element("metrics");
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
  const connections = element("connections");
  connections.replaceChildren();
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
  for (const connection of data.connections) {
    const item = node("div", "", "connection");
    item.append(
      node("b", `${connection.kind.toUpperCase()} · ${connection.label}`),
      node("span", connection.status.replaceAll("_", " "), "badge"),
    );
    if (connection.last_error)
      item.append(node("p", connection.last_error, "small"));
    if (connection.last_poll_at)
      item.append(
        node(
          "p",
          `Last checked ${new Date(connection.last_poll_at).toLocaleString()}`,
          "small",
        ),
      );
    const disable = node("button", "Disable", "secondary");
    disable.addEventListener("click", () => {
      void run(async () => {
        await api("/api/connections/disable", { id: connection.id });
        await load();
      });
    });
    if (connection.status === "approval_pending") {
      const finish = node("button", "Check LoFi approval", "secondary");
      finish.addEventListener("click", () => {
        void run(async () => {
          await api("/api/connections/lofi/finish", { id: connection.id });
          await load();
        });
      });
      item.append(finish);
    }
    item.append(disable);
    const revoke = node("button", "Remove credentials", "secondary");
    revoke.addEventListener("click", () => {
      void run(async () => {
        await api("/api/connections/revoke", { id: connection.id });
        await load();
      });
    });
    item.append(revoke);
    connections.append(item);
    if (connection.kind === "qrz") {
      const option = document.createElement("option");
      option.value = connection.id;
      option.textContent = connection.label;
      templateDestination.append(option);
    }
  }
  if (!data.connections.length)
    connections.append(node("p", "No services connected yet.", "small"));
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
    tr.append(
      node("td", row.qso.slice(0, 12)),
      node(
        "td",
        data.connections
          .find((c) => c.id === row.destination)
          ?.kind.toUpperCase() ?? "—",
      ),
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
  await api("/api/auth/logout", {});
  await load();
});
form("lofi-start", async (data) => {
  const result = await api<{ id: string }>("/api/connections/lofi/start", {
    email: text(data, "email"),
  });
  lofiId = result.id;
  element("lofi-finish").hidden = false;
  message("Check your email for the Ham2K approval request.");
});
form("lofi-finish", async () => {
  await api("/api/connections/lofi/finish", { id: lofiId });
  await load();
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
form("lotw", async (data) => {
  const file = data.get("p12");
  if (!(file instanceof File) || file.size > 256000)
    throw new Error("Choose a .p12 file smaller than 256 KB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  await api("/api/connections/lotw", {
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
  });
  element<HTMLFormElement>("lotw").reset();
  await load();
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
