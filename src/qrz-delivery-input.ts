import type { Contact } from "./projection.ts";
import {
  TEMPLATE_PROFILE,
  type TemplateValue,
  type TemplateVersion,
} from "./templates.ts";

export interface QrzConfig {
  bookId?: string;
  stationCallsign: string;
  startDate: string;
  endDate: string;
}

export function templateContext(
  contact: Contact,
  now: number,
): Record<string, TemplateValue> {
  // JSON roundtrip rejects non-data source objects and strips undefined fields.
  const raw = JSON.parse(JSON.stringify(contact.context)) as {
    qso: Record<string, TemplateValue>;
    op: Record<string, TemplateValue>;
  };
  const iso = new Date(contact.startAtMillis).toISOString();
  const dates = {
    date: iso.slice(0, 10),
    dateCompact: iso.slice(0, 10).replaceAll("-", ""),
    time: iso.slice(11, 16).replace(":", ""),
    at: iso,
  };
  const object = (
    value: TemplateValue | undefined,
  ): Record<string, TemplateValue> =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const firstText = (...values: (TemplateValue | undefined)[]) =>
    values
      .find(
        (value) =>
          (typeof value === "string" || typeof value === "number") &&
          String(value).trim(),
      )
      ?.toString()
      .trim() ?? "";
  const their = object(raw.qso.their);
  const guess = object(their.guess);
  const serial = (field: string) =>
    (Array.isArray(raw.qso.refs) ? raw.qso.refs : [])
      .map((ref) => firstText(object(ref)[field]))
      .find(Boolean) ?? "";
  const opBoundary = (value: TemplateValue | undefined) => {
    const millis = Number(value);
    if (!Number.isFinite(millis) || millis <= 0)
      return { date: "", time: "", at: "" };
    const stamp = new Date(millis).toISOString();
    return {
      date: stamp.slice(0, 10),
      time: stamp.slice(11, 16).replace(":", ""),
      at: stamp,
    };
  };
  const start = opBoundary(raw.op.startAtMillisMin ?? raw.op.startAtMillis);
  const end = opBoundary(raw.op.startAtMillisMax);
  return {
    app: { name: "LoFi QSO Ferry" },
    now: new Date(now).toISOString(),
    op: {
      ...raw.op,
      ...dates,
      station: contact.stationCall,
      call: contact.stationCall,
      stations: [contact.stationCall],
      grid: contact.grid ?? "",
      operator: contact.operatorCall ?? firstText(raw.op.operatorCall),
      startDate: start.date,
      startTime: start.time,
      startAt: start.at,
      endDate: end.date,
      endTime: end.time,
      endAt: end.at,
      qsoCount: raw.op.qsoCount ?? 0,
    },
    qso: {
      ...raw.qso,
      ...dates,
      call: contact.call,
      fullCall: contact.call,
      partial: "",
      nextCall: "",
      nextPartial: "",
      band: contact.band,
      mode: contact.submode ?? contact.mode,
      freq:
        contact.frequencyMHz === undefined ? "" : contact.frequencyMHz * 1000,
      rstSent: contact.rstSent ?? "",
      rstRcvd: contact.rstReceived ?? "",
      rst: contact.rstSent ?? "",
      state: firstText(their.state, guess.state),
      name: firstText(their.name, guess.name).split(/\s+/)[0] ?? "",
      serialSent: serial("ourSerial"),
      serialRcvd: serial("theirSerial"),
      serial: serial("ourSerial"),
      startAtMillis: contact.startAtMillis,
      notes: contact.notes ?? "",
    },
    log: {
      station: contact.stationCall,
      ref: contact.ownParks[0] ?? "",
      refName: "",
      refShortName: "",
      activity: contact.ownParks.length ? "POTA" : "",
      format: "adif",
      exportType: "qrz",
    },
  };
}

export function routedQrz(config: QrzConfig, contact: Contact): boolean {
  const date = new Date(contact.startAtMillis).toISOString().slice(0, 10);
  return (
    config.stationCallsign?.toUpperCase() === contact.stationCall &&
    /^\d{4}-\d{2}-\d{2}$/.test(config.startDate ?? "") &&
    /^\d{4}-\d{2}-\d{2}$/.test(config.endDate ?? "") &&
    date >= config.startDate &&
    date <= config.endDate
  );
}

export function decodeTemplate(row: {
  id: string;
  config: string;
}): TemplateVersion {
  const config = JSON.parse(row.config) as TemplateVersion;
  return { ...config, id: row.id, profile: config.profile ?? TEMPLATE_PROFILE };
}
