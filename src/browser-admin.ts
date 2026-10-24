import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";
import type {
  AdminInvitationResult,
  AdminInvitations,
} from "./admin-invitation-types.ts";
import type { AdminOverview, AdminPriority } from "./admin-types.ts";
import {
  trendSegments,
  workloadChange,
  workloadStatus,
} from "./browser-admin-workload.ts";
import {
  ApiError,
  type BrowserSession,
  createApiClient,
} from "./browser-api.ts";
import { connectionStatus, vendorName } from "./browser-dashboard.ts";

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
const priorityName = (value: string) =>
  value === "live" ? "Live sync" : "Background imports";
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

function svgNode<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
  text = "",
) {
  const value = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, attribute] of Object.entries(attributes))
    value.setAttribute(name, String(attribute));
  value.textContent = text;
  return value;
}

function renderTrend(data: AdminOverview, priority: AdminPriority) {
  const trend = data.workload.trend;
  const target = element(`trend-${priority}`);
  target.replaceChildren(node("h3", priorityName(priority)));
  const change = workloadChange(trend, priority);
  if (change) {
    const direction =
      change.ready === 0
        ? "unchanged"
        : `${count(Math.abs(change.ready))} ${change.ready > 0 ? "more" : "fewer"}`;
    target.append(
      node(
        "p",
        `Ready: ${count(change.first.ready)} → ${count(change.last.ready)} (${direction}). Held: ${count(change.first.held)} → ${count(change.last.held)}. Blocked: ${count(change.first.blocked)} → ${count(change.last.blocked)}.`,
        "small",
      ),
    );
  }
  const segments = trendSegments(trend, priority);
  const samples = segments.flat();
  if (!samples.length) {
    target.append(
      node(
        "p",
        "No classified backlog samples yet. New scheduler runs will record ready, held and blocked counts.",
        "admin-note",
      ),
    );
    return;
  }
  if (samples.length === 1)
    target.append(
      node("p", "One sample recorded; a trend needs at least two.", "small"),
    );
  const first = trend.points[0].at;
  const last = trend.points.at(-1)?.at ?? first;
  const maximum = Math.max(
    1,
    ...samples.flatMap(({ counts }) => [
      counts.ready,
      counts.held,
      counts.blocked,
    ]),
  );
  const x = (at: number) =>
    54 + ((at - first) / Math.max(1, last - first)) * 476;
  const y = (value: number) => 168 - (value / maximum) * 140;
  const chart = svgNode("svg", {
    viewBox: "0 0 550 205",
    role: "img",
    "aria-labelledby": `trend-title-${priority} trend-description-${priority}`,
    class: "admin-trend-chart",
  });
  chart.append(
    svgNode(
      "title",
      { id: `trend-title-${priority}` },
      `${priorityName(priority)} backlog`,
    ),
    svgNode(
      "desc",
      { id: `trend-description-${priority}` },
      "Source records ready, held and blocked in the sampled period. Gaps indicate missing samples. Exact counts and timestamps are in the backlog samples table below.",
    ),
  );
  for (const value of [0, maximum / 2, maximum]) {
    const position = y(value);
    chart.append(
      svgNode("line", {
        x1: 54,
        x2: 530,
        y1: position,
        y2: position,
        class: "trend-grid",
      }),
      svgNode(
        "text",
        { x: 44, y: position + 4, "text-anchor": "end", class: "trend-label" },
        count(Math.round(value)),
      ),
    );
  }
  for (const key of ["ready", "held", "blocked"] as const) {
    for (const segment of segments) {
      chart.append(
        svgNode("polyline", {
          points: segment
            .map((point) => `${x(point.at)},${y(point.counts[key])}`)
            .join(" "),
          class: `trend-line trend-${key}`,
        }),
      );
      for (const point of segment)
        chart.append(
          svgNode("circle", {
            cx: x(point.at),
            cy: y(point.counts[key]),
            r: 2.5,
            class: `trend-dot trend-${key}`,
          }),
        );
    }
  }
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  chart.append(
    svgNode("text", { x: 54, y: 196, class: "trend-label" }, time(first)),
    svgNode(
      "text",
      { x: 530, y: 196, "text-anchor": "end", class: "trend-label" },
      time(last),
    ),
  );
  target.append(chart);
}

function renderWorkload(data: AdminOverview) {
  const { workload } = data;
  const status = workloadStatus(data);
  element("workload-title").textContent = status.title;
  element("workload-detail").textContent = status.detail;
  element("workload-status").classList.toggle("admin-warning", status.warning);
  table(
    "source-backlog",
    ["Traffic", "Ready", "Held", "Blocked", "Expired"],
    workload.source.map((row) => [
      cell(
        priorityName(row.priority),
        row.oldestRetainedAt === null
          ? "No retained input"
          : `Oldest retained input: ${age(row.oldestRetainedAt, data.generatedAt)}`,
      ),
      count(row.ready),
      count(row.held),
      count(row.blocked),
      count(row.expired),
    ]),
    "No outstanding source work.",
  );
  element("source-retention").textContent =
    `${count(data.backlog.source.reduce((total, row) => total + row.expiring24h, 0))} source records expire within the next 24 hours. Retained input age measures time since the buffered input was stored, not how long a contact has been stuck. Expired records need fresh source data before processing.`;
  for (const [id, reasons, empty] of [
    ["held-reasons", workload.heldReasons, "No held source work."],
    ["blocked-reasons", workload.blockedReasons, "No blocked source work."],
  ] as const)
    table(
      id,
      ["Reason", "Traffic", "Source records"],
      reasons.map((row) => [
        row.label,
        priorityName(row.priority),
        count(row.count),
      ]),
      empty,
    );
  const { trend, deliveries } = workload;
  const coverage = `${count(trend.sampleCount)} of ${count(trend.expectedSamples)} expected scheduler snapshots available`;
  element("trend-coverage").textContent =
    `${coverage}.${trend.lastAt === null ? "" : ` Latest sample: ${age(trend.lastAt, data.generatedAt)} (${date(trend.lastAt)}).`}${trend.stale ? " Recent sampling is incomplete or out of date." : ""}${trend.truncated ? " Only the newest 2,000 scheduler records are included; older samples in this window may be missing." : ""}${trend.maxGapMs === null ? "" : ` Largest sampling gap: ${Math.round(trend.maxGapMs / 60_000)} minutes.`}`;
  for (const priority of ["live", "background"] as const)
    renderTrend(data, priority);
  table(
    "backlog-samples",
    [
      "Sampled",
      "Live: ready / held / blocked",
      "Imports: ready / held / blocked",
    ],
    trend.points.map((point) => [
      date(point.at),
      ...(["live", "background"] as const).map((priority) => {
        const counts = point[priority];
        return counts === null
          ? "No classified sample"
          : `${count(counts.ready)} / ${count(counts.held)} / ${count(counts.blocked)}`;
      }),
    ]),
    "No backlog samples available.",
  );
  const hours = deliveries.windowMs / 3_600_000;
  element("delivery-window").textContent = `Last ${hours} hours`;
  table(
    "delivery-throughput",
    ["Destination", "Completed deliveries", "Average / hour"],
    [
      [
        "QRZ accepted",
        count(deliveries.qrz),
        (deliveries.qrz / hours).toLocaleString(undefined, {
          maximumFractionDigits: 1,
        }),
      ],
      [
        "LoTW confirmed by readback",
        count(deliveries.lotw),
        (deliveries.lotw / hours).toLocaleString(undefined, {
          maximumFractionDigits: 1,
        }),
      ],
      [
        "Total",
        count(deliveries.total),
        (deliveries.total / hours).toLocaleString(undefined, {
          maximumFractionDigits: 1,
        }),
      ],
    ],
    "No completed deliveries in this period.",
  );
  element("delivery-context").textContent =
    `Last completed delivery in this period: ${age(deliveries.lastCompletedAt, data.generatedAt)}. ${count(deliveries.submittedOutstanding)} LoTW submissions await readback. ${count(deliveries.adoptedExisting)} existing destination records are currently adopted; these are not new deliveries.`;
  table(
    "delivery-buckets",
    ["Hour ending", "QRZ accepted", "LoTW readback", "Total completed"],
    deliveries.buckets.map((bucket) => [
      date(bucket.at),
      count(bucket.qrz),
      count(bucket.lotw),
      count(bucket.total),
    ]),
    "No completed deliveries in this period.",
  );
}

const { request: api } = createApiClient(async () => {
  message("Verify your passkey to change invitations.");
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
  const metrics = element("admin-metrics");
  metrics.replaceChildren();
  const sourceCount = (key: "ready" | "held" | "blocked") =>
    data.workload.source.reduce((total, row) => total + row[key], 0);
  for (const [label, value, detail] of [
    [
      "Ready source records",
      count(sourceCount("ready")),
      "No known hold · worker validation still applies",
    ],
    [
      "Held source records",
      count(sourceCount("held")),
      "Waiting on a prerequisite, quiet time or review",
    ],
    [
      "Blocked source records",
      count(sourceCount("blocked")),
      "Source data needs review",
    ],
    [
      "Completed deliveries · 24h",
      count(data.workload.deliveries.total),
      "Confirmed destination contacts · excludes submissions",
    ],
  ]) {
    const metric = node("div", "", "admin-metric");
    metric.append(
      node("p", label),
      node("strong", value),
      node("p", detail, "small"),
    );
    metrics.append(metric);
  }
  const notices = element("health-notices");
  notices.replaceChildren();
  if (data.scheduler.stale)
    notices.append(
      node(
        "p",
        data.scheduler.lastStartedAt === null
          ? "No scheduler heartbeat yet. Health is unknown until a scheduled run is recorded."
          : `No completed scheduler run in the last ${Math.round(data.scheduler.staleAfterMs / 60_000)} minutes. The most recent start was ${date(data.scheduler.lastStartedAt)}; check the deployed cron and run outcomes.`,
        "admin-notice admin-warning",
      ),
    );
  if (data.scheduler.running)
    notices.append(
      node(
        "p",
        `${count(data.scheduler.running)} run(s) have no completion record. They may be running or may have been interrupted.`,
        "admin-notice",
      ),
    );
  if (data.scheduler.totals24h.deadlineRuns)
    notices.append(
      node(
        "p",
        `${count(data.scheduler.totals24h.deadlineRuns)} runs reached the scheduler time budget in the last 24 hours. Compare backlog samples and source freshness to see whether work is falling behind.`,
        "admin-notice admin-warning",
      ),
    );
  if (!data.gates.effective && data.scheduler.stale)
    notices.append(
      node(
        "p",
        "Exports are disabled by rollout gates. Read-only imports and reviews can continue; a delivery backlog is expected.",
        "admin-notice",
      ),
    );
  renderWorkload(data);
  element("scheduler-freshness").textContent =
    `Last start: ${age(data.scheduler.lastStartedAt, now)}. Last completed: ${age(data.scheduler.lastCompletedAt, now)}. ${count(data.scheduler.totals24h.deadlineRuns)} time-budget stops in the last 24 hours.`;
  const candidates = data.backlog.deliveryCandidates;
  element("delivery-candidates").textContent =
    `${count(candidates.due)} delivery candidates past quiet time · ${count(candidates.quiet)} still settling.${candidates.oldestDueAt === null ? "" : ` Oldest due: ${age(candidates.oldestDueAt, now)}.`} Other eligibility and rollout gates still apply.`;
  table(
    "attempt-backlog",
    ["Traffic / state", "Unresolved", "Due", "Oldest created"],
    data.backlog.attempts.map((row) => [
      cell(priorityName(row.priority), readable(row.state)),
      count(row.count),
      count(row.due),
      age(row.oldestCreatedAt, now),
    ]),
    "No unresolved delivery attempts.",
  );
  const vendors = element("vendor-budgets");
  vendors.replaceChildren();
  for (const vendor of data.vendors) {
    const wrap = node("div", "", "admin-vendor");
    const heading = node("div", "", "admin-section-heading");
    heading.append(
      node("h3", vendorName(vendor.vendor)),
      pill(
        vendor.cooldownUntil
          ? "Cooling down"
          : vendor.requests >= vendor.totalLimit
            ? "Budget used"
            : "Available",
        Boolean(vendor.cooldownUntil) || vendor.requests >= vendor.totalLimit,
      ),
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
      node(
        "p",
        vendor.cooldownUntil
          ? `Cooldown until ${date(vendor.cooldownUntil)}`
          : `Window ends ${new Date(vendor.windowEndsAt).toLocaleTimeString()}`,
        "small",
      ),
    );
    vendors.append(wrap);
  }
  table(
    "attention",
    ["Area", "State", "Count"],
    data.attention
      .filter((row) => row.area !== "source")
      .map((row) => [
        readable(row.area),
        readable(row.state),
        count(row.count),
      ]),
    "No destination or delivery-attempt attention states in this snapshot.",
  );
  element("export-state").replaceChildren(
    pill(
      data.gates.effective ? "Enabled" : "Disabled",
      false,
      !data.gates.effective,
    ),
  );
  element("export-state").className = "";
  const gates = element("export-gates");
  gates.replaceChildren();
  for (const [label, passed] of [
    ["Exports enabled", data.gates.exportsEnabled],
    ["Rollout checks passed", data.gates.rolloutChecksPassed],
    ["Live writes authorized", data.gates.liveWriteAuthorized],
    ["Source boundary verified", data.gates.sourceBoundaryVerified],
    [
      `Contact scope: ${data.gates.rolloutScope}`,
      data.gates.rolloutScopeConfigured,
    ],
    [
      `Destination scope: ${data.gates.destinationScope}`,
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
  const totals = data.scheduler.totals24h;
  element("run-summary").textContent =
    `${count(totals.runs)} runs · ${count(totals.failed)} failed · ${count(totals.deadlineRuns)} reached the time budget · ${count(totals.sourcePages)} source pages · ${count(totals.contactTurns)} contact turns · ${count(totals.attemptTurns)} attempt turns · ${count(totals.errors)} processing errors · ${count(totals.deferred)} deferrals. Most recent runs below.`;
  table(
    "scheduler-runs",
    [
      "Started",
      "Outcome",
      "Elapsed",
      "Work processed",
      "Errors / deferred",
      "Stored pending source rows: live / import",
      "Due attempts: live / import",
    ],
    data.scheduler.recentRuns.map((run) => [
      date(run.startedAt),
      cell(
        run.status,
        run.stopReason === null
          ? "Stop reason not recorded"
          : `${run.rounds} rounds · ${run.stopReason === "deadline" ? "time budget reached" : run.stopReason === "database_budget" ? "database budget reached" : "idle"}`,
      ),
      run.durationMs === null ? "—" : `${(run.durationMs / 1000).toFixed(1)}s`,
      cell(
        `${run.sourcePages} source pages`,
        `${run.contactTurns} contact / ${run.attemptTurns} attempt turns`,
      ),
      `${run.errors} / ${run.deferred}`,
      run.backlog
        ? `${count(run.backlog.sourceLive)} / ${count(run.backlog.sourceBackground)}`
        : "Not sampled",
      run.backlog
        ? `${count(run.backlog.attemptsDueLive)} / ${count(run.backlog.attemptsDueBackground)}`
        : "Not sampled",
    ]),
    "No scheduled runs have been recorded yet.",
  );
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
      "Source progress",
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
        row.kind === "lofi"
          ? cell(
              row.syncMode === "forward"
                ? "Forward sync"
                : row.syncMode === "backfill"
                  ? "Initial import"
                  : "Not recorded",
              row.contextComplete ? "Context complete" : "Context incomplete",
            )
          : "—",
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
