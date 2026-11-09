import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalLotwIdentity,
  destinationIdentityClaim,
  lotwRemoteIdentity,
} from "../src/destination-receipts.ts";
import { sameQrzIdentity } from "../src/qrz.ts";
import { canonical, sha256 } from "../src/security.ts";

const record = {
  STATION_CALLSIGN: "W1AW",
  CALL: "K1ABC",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "SSB",
  SUBMODE: "USB",
  MY_GRIDSQUARE: "FN31AA12",
};

test("claim normalization matches existing vendor identity semantics without location or narrative collapse", async () => {
  const upper = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, value.toUpperCase()]),
  );
  assert(sameQrzIdentity(record, upper));
  assert.deepEqual(
    await destinationIdentityClaim("qrz", record),
    await destinationIdentityClaim("qrz", {
      ...upper,
      MY_GRIDSQUARE: "FN32",
      COMMENT: "unrelated",
    }),
  );
  assert.equal(
    (await destinationIdentityClaim("lotw", record)).hash,
    await lotwRemoteIdentity(record),
  );
  assert.equal(
    (await destinationIdentityClaim("lotw", record)).hash,
    await sha256(canonical(canonicalLotwIdentity(record))),
  );
  assert.notEqual(
    (await destinationIdentityClaim("qrz", record)).hash,
    (await destinationIdentityClaim("qrz", { ...record, TIME_ON: "120002" }))
      .hash,
  );
  await assert.rejects(
    destinationIdentityClaim("qrz", { ...record, TIME_ON: "1200" }),
    /Invalid outbound destination identity/,
  );
});

test("legacy FST4W claims retain the exact profile-2 identity", async () => {
  const legacy = {
    STATION_CALLSIGN: "W1AW",
    CALL: "K1ABC",
    QSO_DATE: "20261022",
    TIME_ON: "123456",
    BAND: "20m",
    MODE: "MFSK",
    SUBMODE: "FST4W",
  };
  // Captured from the unchanged profile-2 claim and remote-identity functions.
  const hash = "ARzR059NELU_UuEn5eZ6i4WD03kU921TQGDxRwtDg9k";
  assert.deepEqual(await destinationIdentityClaim("lotw", legacy), {
    vendor: "lotw",
    hash,
  });
  assert.equal(await lotwRemoteIdentity(legacy), hash);
  assert.equal(
    await lotwRemoteIdentity({ ...legacy, MODE: "FST4W", SUBMODE: "" }),
    hash,
  );
  assert.notEqual(
    await lotwRemoteIdentity({ ...legacy, MODE: "DATA", SUBMODE: "" }),
    hash,
  );
});
