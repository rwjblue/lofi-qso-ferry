import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrowserExportMode,
  exportPresentation,
} from "../src/browser-export-mode.ts";

test("closed common gates override every vendor mode in both browser presentations", () => {
  const closed = exportPresentation(false, null);
  for (const mode of [
    "qrz_fresh_insert",
    "lotw_fresh_insert",
    "fresh_inserts",
    null,
  ] as const) {
    assert.deepEqual(exportPresentation(false, mode), closed);
    assert.match(closed.message, /production exports are disabled/);
    assert.doesNotMatch(closed.message, /are enabled|Automatic delivery/);
  }
});

test("independent fresh modes name their permitted vendor", () => {
  const qrz = exportPresentation(true, "qrz_fresh_insert");
  const lotw = exportPresentation(true, "lotw_fresh_insert");
  assert.equal(qrz.label, "QRZ first inserts");
  assert.equal(lotw.label, "LoTW first inserts");
  for (const row of [qrz, lotw]) {
    assert.match(
      row.message,
      /authorized scope after current source verification/,
    );
    assert.doesNotMatch(
      row.message,
      /Automatic delivery is enabled|boundary verified/,
    );
  }
});

test("combined mode labels both first-insert capabilities", () => {
  const both = exportPresentation(true, "fresh_inserts");
  assert.equal(both.label, "QRZ and LoTW first inserts");
  assert.match(
    both.message,
    /authorized scope after current source verification/,
  );
});

test("missing or unknown mode fails closed and never echoes server values", () => {
  for (const mode of [
    null,
    "source_boundary" as BrowserExportMode,
    "private-unrecognized-mode" as BrowserExportMode,
  ]) {
    assert.deepEqual(
      exportPresentation(true, mode),
      exportPresentation(false, null),
    );
    assert.doesNotMatch(
      JSON.stringify(exportPresentation(true, mode)),
      /private/,
    );
  }
});
