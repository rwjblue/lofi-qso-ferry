import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventoryTrialAccess } from "../scripts/inventory-run-trial.ts";
import { trialCapture } from "./inventory-trial-capture-fixtures.ts";

test("captured access supports flat and managed LoTW credentials without changing original identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferry-captured-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const wrapped of [false, true]) {
    const directory = await trialCapture(root, wrapped);
    const keys = await readFile(join(directory, "keys.json"), "utf8");
    const first = await inventoryTrialAccess(directory),
      second = await inventoryTrialAccess(directory);
    assert.deepEqual(first.lotwCredential, {
      username: "synthetic",
      password: "synthetic",
    });
    assert.deepEqual(first.sourceCredential, {
      key: "browser:synthetic",
      secret: "synthetic",
      token: "synthetic",
    });
    assert.deepEqual(first.qrzCredential, { apiKey: "synthetic" });
    assert.equal(first.captureFingerprint, second.captureFingerprint);
    assert.equal(first.reportDay, "2026-11-08");
    assert.equal(await readFile(join(directory, "keys.json"), "utf8"), keys);
  }
});
