import assert from "node:assert/strict";
import test from "node:test";
import { contactReconciliationAdif } from "../src/delivery.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { projectContact, sourceFingerprint } from "../src/projection.ts";
import { classifyHistory } from "../src/reconcile.ts";

const qso = (frequency: number | string, band: string): SourceRecord => ({
  uuid: "qso-frequency",
  operation: null,
  startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
  freq: frequency,
  band,
  mode: "CW",
  their: { call: "W1AW" },
  our: { stationCall: "N0CALL/P", grid: "FN31PR" },
});

test("decimal kHz projection avoids invented precision in LoTW historical matching", async () => {
  for (const [frequency, band, expected] of [
    [7032.1, "40m", "7.0321"],
    [10116.1, "30m", "10.1161"],
  ] as const) {
    const record = Object.freeze(qso(frequency, band));
    const contact = await projectContact(record, null);
    assert.notEqual(String(frequency / 1000), expected);
    assert.equal(contact.frequencyMHz, Number(expected));
    const projected = contactReconciliationAdif(contact);
    assert.equal(projected.FREQ, expected);
    const outcome = classifyHistory(
      projected,
      [{ ...projected, FREQ: Number(expected).toFixed(5) }],
      {
        destination: "lotw",
        capturedGeneration: contact.generation,
        currentGeneration: contact.generation,
        readAccess: true,
        inventoryComplete: true,
        catchupComplete: true,
        freshCheckComplete: true,
      },
    );
    assert.equal(outcome.state, "adopted_existing");
    assert.equal(record.freq, frequency);
    assert.equal(contact.context.qso.freq, frequency);
  }
});

test("decimal unit conversion preserves supported band boundaries and meaningful digits", async () => {
  for (const [frequency, band, expected] of [
    [1800, "160m", "1.8"],
    [2000, "160m", "2"],
    [3500, "80m", "3.5"],
    [4000, "80m", "4"],
    [5000, "60m", "5"],
    [5500, "60m", "5.5"],
    [7000, "40m", "7"],
    [7300, "40m", "7.3"],
    [10100, "30m", "10.1"],
    [10150, "30m", "10.15"],
    [14000, "20m", "14"],
    [14350, "20m", "14.35"],
    [18068, "17m", "18.068"],
    [18168, "17m", "18.168"],
    [21000, "15m", "21"],
    [21450, "15m", "21.45"],
    [24890, "12m", "24.89"],
    [24990, "12m", "24.99"],
    [28000, "10m", "28"],
    [29700, "10m", "29.7"],
    [50000, "6m", "50"],
    [54000, "6m", "54"],
    [144000, "2m", "144"],
    [148000, "2m", "148"],
    [420000, "70cm", "420"],
    [450000, "70cm", "450"],
    [7032.11, "40m", "7.03211"],
    [7032.111, "40m", "7.032111"],
    [14074.00001, "20m", "14.07400001"],
  ] as const) {
    const contact = await projectContact(qso(frequency, band), null);
    assert.equal(contact.frequencyMHz, Number(expected));
    assert.equal(contactReconciliationAdif(contact).FREQ, expected);
    assert.equal(contact.band, band);
  }
});

test("actual sub-ten-Hz source precision remains visible and held by LoTW history", async () => {
  for (const [frequency, band, expected] of [
    [7032.111, "40m", "7.032111"],
    [14074.001, "20m", "14.074001"],
    [14074.00001, "20m", "14.07400001"],
  ] as const) {
    const contact = await projectContact(qso(frequency, band), null);
    const projected = contactReconciliationAdif(contact);
    assert.equal(projected.FREQ, expected);
    const outcome = classifyHistory(
      projected,
      [{ ...projected, FREQ: Number(expected).toFixed(5) }],
      {
        destination: "lotw",
        capturedGeneration: contact.generation,
        currentGeneration: contact.generation,
        readAccess: true,
        inventoryComplete: true,
        catchupComplete: true,
        freshCheckComplete: true,
      },
    );
    assert.equal(outcome.state, "history_ambiguous");
    assert.equal(
      outcome.reason,
      "LoTW query cannot establish the transmitted precision of FREQ",
    );
    assert.equal(outcome.remote, undefined);
  }
});

test("numeric source notation is preserved while decimal unit conversion stays deterministic", async () => {
  const standard = await projectContact(qso(7032.1, "40m"), null);
  for (const frequency of ["7032.1000", "7.0321e3", " 7032.1 "]) {
    const contact = await projectContact(qso(frequency, "40m"), null);
    assert.equal(contact.frequencyMHz, 7.0321);
    assert.equal(contact.context.qso.freq, frequency);
    assert.equal(
      await sourceFingerprint(contact, "lotw"),
      await sourceFingerprint(standard, "lotw"),
    );
  }
  const oldProjection = { ...standard, frequencyMHz: 7032.1 / 1000 };
  for (const destination of ["qrz", "lotw"] as const)
    assert.notEqual(
      await sourceFingerprint(standard, destination),
      await sourceFingerprint(oldProjection, destination),
      "corrected source projection must invalidate the old fingerprint",
    );
  assert.equal(
    (await projectContact(qso(7032.1, "40m"), null)).generation,
    standard.generation,
  );
});

test("decimal conversion preserves invalid-frequency and band-conflict rejection", async () => {
  for (const frequency of [0, -7032.1, Number.NaN, Infinity, "invalid", ""])
    await assert.rejects(projectContact(qso(frequency, "40m"), null), {
      code: "invalid_frequency_khz",
    });
  for (const [frequency, band] of [
    [7.0321, "40m"],
    [7032100, "40m"],
    [7032.1, "20m"],
    [7300.001, "40m"],
    [1e21, "40m"],
  ] as const)
    await assert.rejects(projectContact(qso(frequency, band), null), {
      code: "frequency_band_mismatch",
    });
});
