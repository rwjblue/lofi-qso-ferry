import assert from "node:assert/strict";
import test from "node:test";
import { invitationSql, invite } from "../scripts/invite.ts";
import { database } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("operator invitations use the dedicated D1, preserve exact addresses and send only after grant", async () => {
  const { db, mf } = await database();
  try {
    await applyAdditionalMigrations(db);
    let sends = 0;
    const runner = async (args: string[]) => {
      assert.ok(args.includes("production"));
      if (args[0] === "d1") {
        assert.ok(args.includes("--remote"));
        assert.equal(args[2], "ferry-production");
        assert.ok(args.includes("--yes"));
        const sql = args[args.indexOf("--command") + 1];
        const result = await db.prepare(sql).all();
        return JSON.stringify([{ success: true, results: result.results }]);
      }
      sends++;
      assert.deepEqual(args.slice(0, 3), ["email", "sending", "send"]);
      assert.ok(args.includes("--to=O'Neil+tag@example.test"));
      assert.ok(
        args.some(
          (arg) =>
            arg.startsWith("--html=") &&
            arg.includes("https://ferry.n1rwj.com/join"),
        ),
      );
      assert.ok(
        await db
          .prepare("SELECT email FROM invitations WHERE email=?")
          .bind("O'Neil+tag@example.test")
          .first(),
      );
      return "Queued for fixture";
    };
    const message = await invite(" O'Neil+tag@EXAMPLE.TEST ", false, runner);
    assert.match(message, /inbox delivery is not confirmed/);
    assert.equal(sends, 1);
    await invite("O'Neil+tag@example.test", false, runner);
    assert.equal(sends, 2, "an intentional rerun may renew and resend");
    await db.prepare("UPDATE invitations SET claimed_at=1").run();
    await assert.rejects(
      invite("O'Neil+tag@example.test", false, runner),
      /claimed invitation/,
    );
    assert.equal(sends, 2);
    await db
      .prepare(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('existing',?,'handle',0)",
      )
      .bind("O'Neil+tag@example.test")
      .run();
    await db.prepare("DELETE FROM invitations").run();
    await assert.rejects(
      invite("O'Neil+tag@example.test", false, runner),
      /already has an account/,
    );
    assert.equal(sends, 2);
  } finally {
    await mf.dispose();
  }
});

test("invitation preview does no remote work and uncertain sends do not automatically retry or revoke access", async () => {
  let operations = 0;
  const preview = await invite("Preview@example.test", true, () => {
    operations++;
    throw new Error("no operations allowed");
  });
  assert.equal(operations, 0);
  assert.match(preview, /No invitation was granted and no email was sent/);
  const { db, mf } = await database();
  try {
    await applyAdditionalMigrations(db);
    await assert.rejects(
      invite("Pending@example.test", false, async (args) => {
        operations++;
        if (args[0] === "d1") {
          const sql = args[args.indexOf("--command") + 1];
          const result = await db.prepare(sql).all();
          return JSON.stringify([{ success: true, results: result.results }]);
        }
        throw new Error("fixture lost acknowledgement");
      }),
      /invitation is active.*uncertain/,
    );
    assert.equal(operations, 2);
    assert.equal(
      (
        await db
          .prepare("SELECT email FROM invitations WHERE claimed_at IS NULL")
          .first<{ email: string }>()
      )?.email,
      "Pending@example.test",
    );
    assert.throws(() => invitationSql("bad\naddress@example.test", Date.now()));
    assert.throws(() => invitationSql("valid@example.test", NaN));
  } finally {
    await mf.dispose();
  }
});

test("operator never sends from an import summary or a mismatched grant result", async () => {
  for (const results of [
    [{ "Total queries executed": 1, "Rows written": 0 }],
    [{ email: "Different@example.test", expires_at: Date.now() }],
    [],
  ]) {
    let operations = 0;
    await assert.rejects(
      invite("Invited@example.test", false, (args) => {
        operations++;
        assert.equal(args[0], "d1");
        return JSON.stringify([{ success: true, results }]);
      }),
      /No invitation created/,
    );
    assert.equal(operations, 1, "no email follows an unproven grant");
  }
});
