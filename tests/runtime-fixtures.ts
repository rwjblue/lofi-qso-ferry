import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  type AdifRecord,
  parseAdif,
  serializeAdifRecord,
} from "../src/adif.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { importPkcs12 } from "../src/signing.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
import { database, keys, seed } from "./helpers.ts";
export const FIXTURE_NOW = Date.parse("2027-01-01T00:00:00Z");
export const FIXTURE_QSO_AT = Date.parse("2026-10-22T12:00:01Z");
export async function applyAdditionalMigrations(
  db: D1Database,
  through?: string,
) {
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        name !== "0001_foundation.sql" &&
        (!through || name <= through),
    )
    .sort()) {
    const sql = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    let current = "";
    const statements: D1PreparedStatement[] = [];
    for (const line of sql.split("\n")) {
      current += `${line}\n`;
      const trimmed = current.replace(/^\s*(?:--[^\n]*\n\s*)*/, "");
      const trigger = trimmed.startsWith("CREATE TRIGGER");
      if (
        line.trimEnd().endsWith(";") &&
        (!trigger ||
          line.trim() === "END;" ||
          /^CREATE TRIGGER[^\n]*\bEND;$/.test(trimmed.trim()))
      ) {
        statements.push(db.prepare(current));
        current = "";
      }
    }
    await db.batch(statements);
  }
}
export function fixtureEnvironment(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: {
      fetch: async () => new Response("fixture"),
      connect() {
        throw new Error("No raw sockets in fixtures");
      },
    },
    ENVIRONMENT: "local",
    RP_ID: "localhost",
    ORIGIN: "http://localhost:8787",
    EXPORTS_ENABLED: "false",
    LIVE_WRITE_AUTHORIZATION: "",
    MAIL_FROM: "ferry@example.test",
    ACTIVE_KEK_VERSION: "1",
    ROLLOUT_CHECKS_PASSED: "false",
    SOURCE_BOUNDARY_VERIFIED: "false",
    ROLLOUT_QSO_IDS_JSON: "[]",
    WAVELOG_ALLOWED_BASE_URLS: "[]",
    KEK_V1: keys.keys["1"],
    AUTH_SECRET: "synthetic-auth-secret-32-characters",
    RESEND_API_KEY: "",
    CLUBLOG_API_KEY: "",
    EMAIL_CODE_SECRET: "synthetic-code-secret-32-characters",
  } as Env;
}
export async function schedulerFixture() {
  const state = await database();
  try {
    await applyAdditionalMigrations(state.db);
    await seed(state.store);
    const env = fixtureEnvironment(state.db);
    const operation: SourceRecord = {
      uuid: "op-fixture",
      stationCall: "W1AW",
      grid: "FN31AA",
      state: "CT",
      county: "Tolland",
      syncedAtMillis: 100,
    };
    const qso: SourceRecord = {
      uuid: "q1",
      operation: "op-fixture",
      startAtMillis: FIXTURE_QSO_AT,
      band: "20m",
      freq: 14074,
      mode: "FT8",
      their: { call: "K1ABC" },
      our: { dxccCode: 291, cqZone: 5, ituZone: 8 },
      notes: "Source notes stay source-owned",
      syncedAtMillis: 101,
    };
    const initial: AdifRecord = {
      STATION_CALLSIGN: "W1AW",
      CALL: "K1ABC",
      QSO_DATE: "20261022",
      TIME_ON: "120001",
      BAND: "20m",
      MODE: "FT8",
      FREQ: "14.07400",
      MY_GRIDSQUARE: "FN31AA",
      MY_DXCC: "291",
      MY_STATE: "CT",
      MY_CNTY: "CT,Tolland",
      MY_CQ_ZONE: "5",
      MY_ITU_ZONE: "8",
    };
    const qrzRecords: AdifRecord[] = [
      {
        ...initial,
        COMMENT: "Adopted narrative & + = 100%",
        NOTES: "Existing notes",
        APP_QRZLOG_LOGID: "500",
      },
    ];
    const lotwRecords: AdifRecord[] = [{ ...initial, QSL_RCVD: "N" }];
    const changes = { operations: [operation], qsos: [qso] };
    const calls = {
      sourceSync: 0,
      reread: 0,
      qrzReads: 0,
      qrzWrites: 0,
      lotwQueries: 0,
      lotwUploads: 0,
      certificateStatus: 0,
    };
    const errors = { qrz: false, lotw: false, reread: false };
    const tq8Texts: string[] = [];
    const qrzMutations: AdifRecord[] = [];
    const fixture = async (name: string) =>
      readFile(new URL(`../fixtures/signing/${name}`, import.meta.url));
    const credential = await importPkcs12(
      await fixture("current.p12"),
      "ferry-fixture",
      {
        now: new Date(FIXTURE_NOW),
        version: "scheduler-signing-v1",
        certificateStatus: async () => "unrevoked",
      },
    );
    for (const [connection, version, value] of [
      [
        "source",
        "fixture-source",
        { key: "browser:synthetic", secret: "synthetic", token: "synthetic" },
      ],
      ["destination", "fixture-qrz", { apiKey: "synthetic-qrz" }],
    ] as const) {
      await (
        await state.store.putPrivate(
          "a",
          connection,
          version,
          "credential",
          value,
        )
      ).run();
      await state.store
        .statement(
          "UPDATE connections SET credential_version=? WHERE tenant=? AND id=?",
          version,
          "a",
          connection,
        )
        .run();
    }
    await state.store
      .statement(
        "UPDATE connections SET config=? WHERE id='source'",
        JSON.stringify({ accountId: "account-fixture" }),
      )
      .run();
    await state.store
      .statement(
        "UPDATE connections SET config=? WHERE id='destination'",
        JSON.stringify({
          stationCallsign: "W1AW",
          startDate: "2020-01-01",
          endDate: "2030-12-31",
          replacementContractVerified: true,
        }),
      )
      .run();
    await state.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','lotw','lotw','query:synthetic','Synthetic LoTW','active','fixture-lotw',?,0)",
        JSON.stringify({
          stations: [{ callsign: "W1AW", dxcc: 291 }],
          readAccess: true,
        }),
      )
      .run();
    await (
      await state.store.putPrivate("a", "lotw", "fixture-lotw", "credential", {
        signingCredentials: [credential],
        query: { username: "synthetic", password: "synthetic" },
      })
    ).run();
    const template = await state.store.saveTemplate("a", "destination", {
      profile: TEMPLATE_PROFILE,
      fields: { COMMENT: "New forward-only template {{ qso.notes }}" },
      fallbackNotes: false,
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync") {
        calls.sourceSync++;
        const operations = changes.operations.splice(0);
        const qsos = changes.qsos.splice(0);
        return Response.json({
          account: { uuid: "account-fixture" },
          operations,
          qsos,
          meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
        });
      }
      if (url.pathname === "/v1/operations/op-fixture/qsos") {
        calls.reread++;
        if (errors.reread) throw new Error("synthetic source reread outage");
        return Response.json({
          qsos: [qso],
          meta: { qsos: { records_left: 0 } },
        });
      }
      if (url.hostname === "logbook.qrz.com") {
        if (errors.qrz) throw new Error("synthetic QRZ outage");
        const form = new URLSearchParams(String(init?.body));
        if (form.get("ACTION") === "FETCH") {
          calls.qrzReads++;
          const options = (form.get("OPTION") ?? "").split(",");
          const option = (name: string) =>
            options
              .find((value) => value.startsWith(`${name}:`))
              ?.slice(name.length + 1);
          const ids = option("LOGIDS")?.split("+");
          const between = option("BETWEEN")
            ?.split("+")
            .map((date) => date.replaceAll("-", ""));
          const selected = qrzRecords.filter(
            (record) =>
              Number(record.APP_QRZLOG_LOGID) >=
                Number(option("AFTERLOGID") ?? 0) &&
              (!ids || ids.includes(record.APP_QRZLOG_LOGID!)) &&
              (!option("CALL") ||
                record.CALL?.toUpperCase() === option("CALL")!.toUpperCase()) &&
              (!option("BAND") ||
                record.BAND?.toUpperCase() === option("BAND")!.toUpperCase()) &&
              (!between ||
                (record.QSO_DATE! >= between[0]! &&
                  record.QSO_DATE! <= between[1]!)),
          );
          return new Response(
            new URLSearchParams({
              RESULT: "OK",
              COUNT: String(selected.length),
              ADIF: selected
                .slice(0, Number(option("MAX") ?? 250))
                .map(serializeAdifRecord)
                .join(""),
            }).toString(),
          );
        }
        assert.equal(form.get("ACTION"), "INSERT");
        calls.qrzWrites++;
        const projected = parseAdif(form.get("ADIF")!).records[0]!;
        qrzMutations.push(projected);
        const replaced = form.get("OPTION") === "REPLACE";
        const existing = qrzRecords.findIndex((record) =>
          [
            "STATION_CALLSIGN",
            "CALL",
            "QSO_DATE",
            "TIME_ON",
            "BAND",
            "MODE",
          ].every(
            (field) =>
              (record[field] ?? "").toUpperCase() ===
              (projected[field] ?? "").toUpperCase(),
          ),
        );
        const logId =
          replaced && existing >= 0
            ? qrzRecords[existing]!.APP_QRZLOG_LOGID!
            : String(
                Math.max(
                  500,
                  ...qrzRecords.map((record) =>
                    Number(record.APP_QRZLOG_LOGID),
                  ),
                ) + 1,
              );
        if (replaced) {
          assert(existing >= 0);
          qrzRecords.splice(existing, 1, {
            ...projected,
            APP_QRZLOG_LOGID: logId,
          });
        } else qrzRecords.push({ ...projected, APP_QRZLOG_LOGID: logId });
        return new Response(
          new URLSearchParams({
            RESULT: replaced ? "REPLACE" : "OK",
            COUNT: "1",
            LOGID: logId,
          }).toString(),
        );
      }
      if (url.pathname === "/lotw/crl") {
        calls.certificateStatus++;
        return new Response("<Status>Unrevoked</Status>");
      }
      if (url.pathname === "/lotwuser/lotwreport.adi") {
        calls.lotwQueries++;
        if (errors.lotw) throw new Error("synthetic LoTW outage");
        return new Response(
          `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(lotwRecords.length).length}>${lotwRecords.length}<EOH>${lotwRecords.map(serializeAdifRecord).join("")}<APP_LOTW_EOF>`,
        );
      }
      if (url.pathname === "/lotw/upload") {
        calls.lotwUploads++;
        if (errors.lotw) throw new Error("synthetic LoTW outage");
        assert(init?.body instanceof FormData);
        const file = init.body.get("upfile");
        assert(file instanceof Blob);
        const text = gunzipSync(
          Buffer.from(await file.arrayBuffer()),
        ).toString();
        tq8Texts.push(text);
        // Read actual transmitted station grid, rather than inventing success from source.
        const match = /<GRIDSQUARE:(\d+)>([^\n]+)/.exec(text);
        assert(match);
        const grid = match[2]!.slice(0, Number(match[1]));
        assert.match(text, /<REC_TYPE:8>tCONTACT/);
        assert.match(text, /<CALL:5>K1ABC/);
        const contactText = text.slice(text.indexOf("<REC_TYPE:8>tCONTACT"));
        const stationText = text.slice(
          text.indexOf("<REC_TYPE:8>tSTATION"),
          text.indexOf("<REC_TYPE:8>tCONTACT"),
        );
        const read = (name: string, body: string) => {
          const tag = new RegExp(`<${name}:(\\d+)>`).exec(body);
          return tag
            ? body.slice(
                tag.index + tag[0].length,
                tag.index + tag[0].length + Number(tag[1]),
              )
            : "";
        };
        const state = read("US_STATE", stationText);
        const county = read("US_COUNTY", stationText);
        const record: AdifRecord = {
          CALL: read("CALL", contactText),
          STATION_CALLSIGN: read("CALL", stationText),
          BAND: read("BAND", contactText),
          MODE: read("MODE", contactText),
          QSO_DATE: read("QSO_DATE", contactText).replaceAll("-", ""),
          TIME_ON: read("QSO_TIME", contactText)
            .replaceAll(":", "")
            .replace(/Z$/, ""),
          FREQ: Number(read("FREQ", contactText)).toFixed(5),
          MY_DXCC: read("DXCC", stationText),
          MY_GRIDSQUARE: grid,
          MY_STATE: state,
          MY_CNTY: county ? `${state},${county}` : "",
          MY_CQ_ZONE: read("CQZ", stationText),
          MY_ITU_ZONE: read("ITUZ", stationText),
          QSL_RCVD: "N",
        };
        const existing = lotwRecords.findIndex((old) =>
          [
            "STATION_CALLSIGN",
            "CALL",
            "QSO_DATE",
            "TIME_ON",
            "BAND",
            "MODE",
          ].every(
            (field) =>
              (old[field] ?? "").toUpperCase() ===
              (record[field] ?? "").toUpperCase(),
          ),
        );
        if (existing >= 0) lotwRecords.splice(existing, 1, record);
        else lotwRecords.push(record);
        return new Response("<!-- .UPL. accepted -->");
      }
      throw new Error(`Unexpected synthetic endpoint ${url.pathname}`);
    };
    const enable = () => {
      env.EXPORTS_ENABLED = "true";
      env.ROLLOUT_CHECKS_PASSED = "true";
      env.LIVE_WRITE_AUTHORIZATION = "I_AUTHORIZE_LIVE_VENDOR_WRITES";
      env.SOURCE_BOUNDARY_VERIFIED = "true";
      env.ROLLOUT_QSO_IDS_JSON = '["q1"]';
    };
    return {
      ...state,
      env,
      operation,
      qso,
      initial,
      qrzRecords,
      lotwRecords,
      changes,
      calls,
      errors,
      tq8Texts,
      qrzMutations,
      fetcher,
      enable,
      template,
    };
  } catch (error) {
    await state.mf.dispose();
    throw error;
  }
}
