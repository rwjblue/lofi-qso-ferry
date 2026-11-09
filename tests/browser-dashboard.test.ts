import assert from "node:assert/strict";
import test from "node:test";
import {
  type ConnectionSummary,
  connectionGroups,
  connectionStatus,
  inventoryStatusLabel,
  vendorName,
} from "../src/browser-dashboard.ts";

function connection(
  id: string,
  kind: string,
  status: string,
): ConnectionSummary {
  return { id, kind, status, label: id, last_poll_at: null };
}

test("all current connections remain visible and removed credentials permit a new link", () => {
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
    ],
  );
  assert.equal(groups[0]?.previous[0]?.id, "old");
  const removed = connectionGroups([connection("old", "lofi", "revoked")]);
  assert.equal(removed[0]?.current.length, 0);
  assert.equal(removed[0]?.previous.length, 1);
});

test("friendly labels preserve distinctions between pending, paused and unverified connections and native delivery states", () => {
  assert.equal(vendorName("lofi"), "LoFi");
  assert.equal(vendorName("lotw"), "LoTW");
  assert.equal(connectionStatus("disabled"), "Paused");
  assert.equal(connectionStatus("approval_pending"), "Approval pending");
  assert.equal(connectionStatus("needs_verification"), "Verification needed");
  assert.equal(
    inventoryStatusLabel("projection_mismatch"),
    "Operating details differ",
  );
  assert.equal(inventoryStatusLabel("submitted"), "Submitted to LoTW");
  assert.equal(inventoryStatusLabel("observed"), "Receipt verified");
});
