import assert from "node:assert/strict";
import test from "node:test";
import {
  type ConnectionSummary,
  connectionGroups,
  connectionStatus,
  ledgerEmptyMessage,
  previewStatus,
  vendorName,
} from "../src/browser-dashboard.ts";

function connection(
  id: string,
  kind: string,
  status: string,
): ConnectionSummary {
  return { id, kind, status, label: id, last_poll_at: null };
}

test("all current legacy connections remain visible and removed credentials permit a new link", () => {
  const groups = connectionGroups([
    connection("old", "lofi", "revoked"),
    connection("pending", "lofi", "approval_pending"),
    connection("active", "qrz", "active"),
    connection("extra", "qrz", "disabled"),
    connection("cert", "lotw", "needs_verification"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.kind, group.current.map((row) => row.id)]),
    [
      ["lofi", ["pending"]],
      ["qrz", ["active", "extra"]],
      ["lotw", ["cert"]],
      ["clublog", []],
      ["wavelog", []],
    ],
  );
  assert.equal(groups[0]?.previous[0]?.id, "old");
  const removed = connectionGroups([connection("old", "lofi", "revoked")]);
  assert.equal(removed[0]?.current.length, 0);
  assert.equal(removed[0]?.previous.length, 1);
});

test("source-only empty ledger explains review instead of implying zero imported contacts", () => {
  assert.match(ledgerEmptyMessage([]), /Connect LoFi/);
  assert.match(
    ledgerEmptyMessage([connection("s", "lofi", "active")]),
    /LoFi contacts appear in read-only review/,
  );
  assert.match(
    ledgerEmptyMessage([
      connection("s", "lofi", "active"),
      connection("d", "qrz", "active"),
    ]),
    /reconciled with a destination/,
  );
  assert.match(
    ledgerEmptyMessage([connection("s", "lofi", "revoked")]),
    /Connect LoFi/,
  );
});

test("friendly labels preserve distinctions between pending, paused and unverified connections and historical preview bindings", () => {
  assert.equal(vendorName("lofi"), "LoFi");
  assert.equal(vendorName("lotw"), "LoTW");
  assert.equal(vendorName("clublog"), "Club Log");
  assert.equal(vendorName("wavelog"), "Wavelog");
  assert.equal(connectionStatus("disabled"), "Paused");
  assert.equal(connectionStatus("approval_pending"), "Approval pending");
  assert.equal(connectionStatus("needs_verification"), "Verification needed");
  assert.equal(
    previewStatus("remote_preserved"),
    "Current preview · existing QRZ text preserved",
  );
  assert.equal(
    previewStatus("pinned"),
    "Current preview · export uses pinned version",
  );
  assert.equal(previewStatus("current_preview"), "Current template preview");
});

test("Club Log cards show current and retained destinations without combining account state", () => {
  const clublog = connectionGroups([
    connection("removed", "clublog", "revoked"),
    connection("current", "clublog", "disabled"),
  ]).find((group) => group.kind === "clublog");
  assert.deepEqual(
    clublog?.current.map((row) => row.id),
    ["current"],
  );
  assert.deepEqual(
    clublog?.previous.map((row) => row.id),
    ["removed"],
  );
});
