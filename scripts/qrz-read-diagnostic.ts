import { parseAdif } from "../src/adif.ts";
import { parseQrzResponse, QRZ_ENDPOINT } from "../src/qrz.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

type Step = "selection" | "selection_count" | "control" | "control_date";
type State =
  | "response"
  | "http_error"
  | "transport_error"
  | "invalid_response"
  | "response_bound"
  | "budget_deferred"
  | "deadline"
  | "skipped_no_control";
export interface QrzReadDiagnosticStep {
  step: Step;
  state: State;
  http:
    | "none"
    | "ok"
    | "redirect"
    | "auth"
    | "client_error"
    | "server_error"
    | "other";
  result: "missing" | "ok" | "fail" | "auth" | "other";
  count: "missing" | "zero" | "positive" | "invalid";
  adifPresent: boolean;
  reasonPresent: boolean;
  records: "not_checked" | "zero" | "one" | "multiple" | "invalid";
}
export interface QrzReadDiagnosticReport {
  /** Includes a budget-deferred transport invocation; it is not a vendor request count. */
  requestAttempts: number;
  steps: QrzReadDiagnosticStep[];
}
export interface QrzReadDiagnosticInput {
  apiKey: string;
  selection: { between: [string, string]; afterLogId?: number };
  /** Required: the protected harness supplies its existing shared vendor budget. */
  fetcher: typeof fetch;
  now?: () => number;
  deadlineAt?: number;
  shouldContinue?: () => boolean;
}

const RESPONSE_LIMIT = 2 * 1024 * 1024;
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function blank(step: Step, state: State): QrzReadDiagnosticStep {
  return {
    step,
    state,
    http: "none",
    result: "missing",
    count: "missing",
    adifPresent: false,
    reasonPresent: false,
    records: "not_checked",
  };
}
function httpClass(response: Response): QrzReadDiagnosticStep["http"] {
  if (
    response.redirected ||
    response.type === "opaque" ||
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  )
    return "redirect";
  if (response.ok) return "ok";
  if (response.status === 401 || response.status === 403) return "auth";
  if (response.status >= 400 && response.status < 500) return "client_error";
  if (response.status >= 500) return "server_error";
  return "other";
}

/**
 * Four read-only differential requests at most. No result authorizes absence,
 * updates application state, or includes private response values in its report.
 */
export async function qrzReadDiagnostic(
  input: QrzReadDiagnosticInput,
): Promise<QrzReadDiagnosticReport> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const after = input.selection.afterLogId ?? 0;
  if (
    typeof input.apiKey !== "string" ||
    !input.apiKey ||
    typeof input.fetcher !== "function" ||
    input.selection.between.length !== 2 ||
    !input.selection.between.every(validDate) ||
    input.selection.between[0] > input.selection.between[1] ||
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isFinite(startedAt) ||
    (input.deadlineAt !== undefined && !Number.isFinite(input.deadlineAt))
  )
    throw new Error("Invalid QRZ read diagnostic configuration");
  const deadlineAt = Math.min(
    input.deadlineAt ?? startedAt + 60_000,
    startedAt + 60_000,
  );
  const report: QrzReadDiagnosticReport = { requestAttempts: 0, steps: [] };
  let stopped: "deadline" | "budget_deferred" | undefined;
  let controlDate: string | undefined;
  const selection = `BETWEEN:${input.selection.between.join("+")}`;
  const operations: { step: Step; options: () => string }[] = [
    {
      step: "selection",
      options: () => `TYPE:ADIF,MAX:1,AFTERLOGID:${after},${selection}`,
    },
    {
      step: "selection_count",
      options: () => `TYPE:ADIF,MAX:0,AFTERLOGID:${after},${selection}`,
    },
    { step: "control", options: () => "TYPE:ADIF,MAX:1,AFTERLOGID:0" },
    {
      step: "control_date",
      options: () =>
        `TYPE:ADIF,MAX:1,AFTERLOGID:0,BETWEEN:${controlDate}+${controlDate}`,
    },
  ];
  for (const operation of operations) {
    if (stopped || now() >= deadlineAt || input.shouldContinue?.() === false) {
      stopped ??= "deadline";
      report.steps.push(blank(operation.step, stopped));
      continue;
    }
    if (operation.step === "control_date" && !controlDate) {
      report.steps.push(blank(operation.step, "skipped_no_control"));
      continue;
    }
    const result = blank(operation.step, "transport_error");
    report.steps.push(result);
    const controller = new AbortController();
    let timedOut = false;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectDeadline: (() => void) | undefined;
    const elapsed = new Promise<never>((_, reject) => {
      rejectDeadline = () => reject(new Error("QRZ diagnostic deadline"));
    });
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
        rejectDeadline?.();
      },
      Math.max(1, Math.min(20_000, deadlineAt - now())),
    );
    try {
      report.requestAttempts++;
      // The endpoint, action, headers and options are generated here. Neither
      // the caller nor a server redirect can select a mutation or another host.
      const pending = input.fetcher(QRZ_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "User-Agent": "LoFiQSOFerry/0.1.0",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          KEY: input.apiKey,
          ACTION: "FETCH",
          OPTION: operation.options(),
        }),
      });
      // A transport which ignores abort still cannot retain a late response body.
      void pending.then(
        (late) => {
          if (timedOut) void late.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      response = await Promise.race([pending, elapsed]);
      result.http = httpClass(response);
      if (result.http !== "ok") {
        result.state = "http_error";
        continue;
      }
      result.state = "invalid_response";
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader)
        while (true) {
          const part = await Promise.race([reader.read(), elapsed]);
          if (part.done) break;
          length += part.value.length;
          if (length > RESPONSE_LIMIT) {
            result.state = "response_bound";
            break;
          }
          chunks.push(part.value);
        }
      if (result.state === "response_bound") continue;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const data = parseQrzResponse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      result.state = "response";
      result.result =
        data.RESULT === "OK"
          ? "ok"
          : data.RESULT === "FAIL"
            ? "fail"
            : data.RESULT === "AUTH"
              ? "auth"
              : "other";
      result.count =
        data.COUNT === undefined
          ? "missing"
          : /^0+$/.test(data.COUNT)
            ? "zero"
            : /^\d+$/.test(data.COUNT)
              ? "positive"
              : "invalid";
      result.adifPresent = Object.hasOwn(data, "ADIF");
      result.reasonPresent = Object.hasOwn(data, "REASON");
      if (operation.step === "control" && result.result === "ok") {
        try {
          const records = parseAdif(data.ADIF ?? "").records;
          result.records =
            records.length === 0
              ? "zero"
              : records.length === 1
                ? "one"
                : "multiple";
          const record = records.length === 1 ? records[0] : undefined;
          const day = record?.QSO_DATE;
          const id = record?.APP_QRZLOG_LOGID;
          if (
            day &&
            /^\d{8}$/.test(day) &&
            id &&
            /^\d+$/.test(id) &&
            Number.isSafeInteger(Number(id)) &&
            result.count === "positive"
          ) {
            const candidate = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
            if (validDate(candidate)) controlDate = candidate;
          }
        } catch {
          result.records = "invalid";
        }
      }
    } catch (error) {
      if (timedOut) result.state = stopped = "deadline";
      else if (error instanceof VendorDeferredError)
        result.state = stopped = "budget_deferred";
      // Preserve only the already selected fixed state; never retain an error,
      // its message/cause, arbitrary response keys, or vendor REASON contents.
    } finally {
      clearTimeout(timer);
      if (reader) void reader.cancel().catch(() => undefined);
      else if (response) void response.body?.cancel().catch(() => undefined);
    }
  }
  return report;
}
