import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const controls = {
  EXPORTS_ENABLED: "false",
  ROLLOUT_CHECKS_PASSED: "false",
  SOURCE_BOUNDARY_VERIFIED: "false",
  QRZ_FRESH_INSERTS_ENABLED: "false",
  LIVE_WRITE_AUTHORIZATION: "",
  ROLLOUT_QSO_IDS_JSON: "[]",
  ROLLOUT_DESTINATION_IDS_JSON: "[]",
};

test("all configured environments default to seven closed export controls", async () => {
  const config = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  for (const entry of [config, ...Object.values(config.env)] as {
    vars: Record<string, string>;
  }[])
    for (const [name, value] of Object.entries(controls))
      assert.equal(entry.vars[name], value, name);
});

test("read-only deployment refuses any open or missing export control before its CLI commands", async () => {
  const task = await readFile(
    new URL("../mise/tasks/deploy-readonly", import.meta.url),
    "utf8",
  );
  const body = /node --input-type=module <<'JS'\n([\s\S]+?)\nJS\n/.exec(
    task,
  )?.[1];
  assert(body);
  const code = body.replace("import { readFileSync } from 'node:fs';", "");
  const config = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  const check = (overrides: Record<string, string | undefined>) => {
    const changed = structuredClone(config);
    Object.assign(changed.env.production.vars, overrides);
    // Execute only the task's configuration assertion. The shell's migration
    // and deployment commands are neither evaluated nor available here.
    runInNewContext(code, {
      URL,
      readFileSync: () => JSON.stringify(changed),
      console: { log() {} },
    });
  };
  check({});
  for (const name of Object.keys(controls))
    for (const value of [undefined, "open"])
      assert.throws(() => check({ [name]: value }), new RegExp(name));
});
