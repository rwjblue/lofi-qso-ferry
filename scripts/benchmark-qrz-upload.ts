import assert from "node:assert/strict";
import { qrzDeliveryQueueWorkload } from "../tests/qrz-delivery-queue-workload.ts";
import {
  QRZ_UPLOAD_SCENARIOS,
  qrzUploadWorkload,
} from "../tests/qrz-upload-workload.ts";

const selected = process.argv.slice(2);
const queueScenarios = ["queue-10", "queue-20"] as const;
assert(
  selected.every((value) =>
    [...QRZ_UPLOAD_SCENARIOS, ...queueScenarios].some(
      (scenario) => scenario === value,
    ),
  ),
);
for (const scenario of QRZ_UPLOAD_SCENARIOS.filter(
  (value) => selected.length === 0 || selected.includes(value),
))
  await qrzUploadWorkload(scenario, (row) => console.log(JSON.stringify(row)));
for (const scenario of queueScenarios.filter((value) =>
  selected.includes(value),
))
  console.log(
    JSON.stringify(
      await qrzDeliveryQueueWorkload(scenario === "queue-10" ? 10 : 20),
    ),
  );
