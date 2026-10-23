import assert from "node:assert/strict";
import test from "node:test";
import { saveVerifiedConnection } from "../src/connections.ts";
import worker from "../src/index.ts";
import { sha256 } from "../src/security.ts";
import { defaultTemplate, saveDefaultTemplate } from "../src/settings.ts";
import {
  DEFAULT_COMMENT_TEMPLATE,
  TEMPLATE_PROFILE,
  type TemplateVersion,
} from "../src/templates.ts";
import { database } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

async function setup() {
  const state = await database();
  await applyAdditionalMigrations(state.db);
  const tokens = { a: "a".repeat(43), b: "b".repeat(43) };
  for (const tenant of ["a", "b"] as const) {
    await state.store
      .statement(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES(?,?,?,0)",
        tenant,
        `${tenant}@example.test`,
        `user-${tenant}`,
      )
      .run();
    await state.store
      .statement(
        "INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at) VALUES(?,?, 'fixture',0,'{}','Fixture',0)",
        `key-${tenant}`,
        tenant,
      )
      .run();
    await state.store
      .statement(
        "INSERT INTO sessions(token_hash,tenant,credential_id,created_at,verified_at,expires_at) VALUES(?,?,?,?,?,?)",
        await sha256(tokens[tenant]),
        tenant,
        `key-${tenant}`,
        Date.now(),
        Date.now(),
        Date.now() + 86400_000,
      )
      .run();
  }
  const env = fixtureEnvironment(state.db);
  const request = async (
    tenant: keyof typeof tokens,
    path: string,
    input?: unknown,
  ) => {
    const headers = new Headers({
      Cookie: `__Host-ferry_browser=${"c".repeat(43)}; __Host-ferry_session=${tokens[tenant]}`,
    });
    if (input !== undefined) {
      const csrf = await worker.fetch(
        new Request(`${env.ORIGIN}/api/auth/session`, { headers }),
        env,
      );
      const session = (await csrf.json()) as { csrf: string };
      headers.set("Origin", env.ORIGIN);
      headers.set("Content-Type", "application/json");
      headers.set("X-CSRF-Token", session.csrf);
    }
    const response = await worker.fetch(
      new Request(`${env.ORIGIN}${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers,
        body: input === undefined ? undefined : JSON.stringify(input),
      }),
      env,
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { ...state, request };
}

for (const service of [null, "lofi", "qrz", "lotw"] as const)
  test(`settings and account templates save with ${service ?? "no"} connection independently`, async (context) => {
    const state = await setup();
    context.after(() => state.mf.dispose());
    const { store, request } = state;
    if (service)
      await store
        .statement(
          "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','only-service',?,?,?,'active',0)",
          service,
          `remote-${service}`,
          service,
        )
        .run();
    assert.equal(
      (await request("a", "/api/settings", { quietMinutes: 45 })).status,
      200,
    );
    assert.equal((await request("a", "/api/dashboard")).body.quietMinutes, 45);
    assert.equal((await request("b", "/api/dashboard")).body.quietMinutes, 30);
    const first = await request("a", "/api/templates", {
      fields: { COMMENT: "My default {{ qso.notes }}" },
      fallbackNotes: false,
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const next = await request("a", "/api/templates", {
      destination: "",
      fields: { COMMENT: "My next default {{ qso.notes }}" },
      fallbackNotes: true,
    });
    assert.equal(next.status, 200);
    assert.notEqual(first.body.id, next.body.id);
    const dashboard = (await request("a", "/api/dashboard")).body;
    const saved = dashboard.defaultTemplate as TemplateVersion;
    assert.equal(saved.id, next.body.id);
    assert.equal(saved.fields.COMMENT, "My next default {{ qso.notes }}");
    assert.equal(saved.fallbackNotes, true);
    assert.equal(
      (
        (await request("b", "/api/dashboard")).body
          .defaultTemplate as TemplateVersion
      ).fields.COMMENT,
      DEFAULT_COMMENT_TEMPLATE,
    );
    const original = await store
      .statement(
        "SELECT config FROM account_templates WHERE tenant='a' AND id=?",
        first.body.id as string,
      )
      .first<{ config: string }>();
    assert.equal(
      JSON.parse(original!.config).fields.COMMENT,
      "My default {{ qso.notes }}",
    );
    await assert.rejects(
      store
        .statement("UPDATE account_templates SET config='{}' WHERE tenant='a'")
        .run(),
      /immutable account template/,
    );
    assert.equal(
      (await request("a", "/api/templates", { fields: { CALL: "forbidden" } }))
        .status,
      400,
    );
    assert.equal((await request("a", "/api/dashboard")).body.quietMinutes, 45);
    assert.equal((await defaultTemplate(store, "a")).id, next.body.id);
    for (const table of [
      "templates",
      "active_templates",
      "cursors",
      "ledger",
      "attempts",
    ])
      assert.equal(
        (
          await store
            .statement(`SELECT count(*) n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
        `${table} must not change when saving defaults`,
      );
    if (service === "lofi" || service === "lotw")
      assert.equal(
        (
          await request("a", "/api/templates", {
            destination: "only-service",
            fields: { COMMENT: "Wrong kind" },
          })
        ).status,
        404,
      );
    assert.equal(
      (
        await request("b", "/api/templates", {
          destination: "only-service",
          fields: { COMMENT: "Wrong tenant" },
        })
      ).status,
      404,
    );
  });

test("new QRZ books inherit account defaults while saved versions and staged bindings remain pinned", async (context) => {
  const { store, mf, request } = await setup();
  context.after(() => mf.dispose());
  const preference = (comment: string): TemplateVersion => ({
    id: "pending",
    profile: TEMPLATE_PROFILE,
    fields: { COMMENT: comment },
    fallbackNotes: false,
  });
  await saveDefaultTemplate(store, "a", preference("First default"));
  const input = {
    kind: "qrz" as const,
    remoteIdentity: "book-first",
    label: "First book",
    credential: { apiKey: "fixture-secret" },
    config: {},
  };
  const first = await saveVerifiedConnection(store, "a", input);
  const selected = async (destination: string) =>
    store
      .statement(
        "SELECT t.id,t.config FROM active_templates a JOIN templates t ON t.tenant=a.tenant AND t.destination=a.destination AND t.id=a.version WHERE a.tenant='a' AND a.destination=?",
        destination,
      )
      .first<{ id: string; config: string }>();
  const initial = await selected(first.id);
  assert.ok(initial);
  assert.equal(JSON.parse(initial.config).fields.COMMENT, "First default");
  await store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','source','lofi','source','Source','active',0)",
    )
    .run();
  const key = {
    tenant: "a",
    source: "source",
    qso: "qso-1",
    destination: first.id,
  };
  await store.observe(key, "generation", "hash", 30);
  await store
    .statement("UPDATE ledger SET state='live_new',due_at=0 WHERE tenant='a'")
    .run();
  const attempt = await store.stage(
    key,
    "generation",
    { immutable: "First default" },
    first.version,
    initial.id,
  );
  const cursorsBefore = await store
    .statement("SELECT count(*) n FROM cursors")
    .first<{ n: number }>();
  await saveDefaultTemplate(store, "a", preference("Second default"));
  assert.deepEqual(await selected(first.id), initial);
  assert.equal((await store.ledger(key))?.template_version, initial.id);
  assert.deepEqual(await store.private("a", first.id, attempt, "outbox"), {
    immutable: "First default",
  });
  assert.deepEqual(
    await store.statement("SELECT count(*) n FROM cursors").first(),
    cursorsBefore,
  );
  const second = await saveVerifiedConnection(store, "a", {
    ...input,
    remoteIdentity: "book-second",
  });
  assert.equal(
    JSON.parse((await selected(second.id))!.config).fields.COMMENT,
    "Second default",
  );
  await saveVerifiedConnection(store, "a", {
    ...input,
    credential: { apiKey: "fixture-renewal" },
  });
  assert.deepEqual(
    await selected(first.id),
    initial,
    "renewal must not copy a newer default into an existing book",
  );
  const perBook = await request("a", "/api/templates", {
    destination: first.id,
    fields: { COMMENT: "Book-specific future version" },
    fallbackNotes: true,
  });
  assert.equal(perBook.status, 200);
  assert.notEqual(perBook.body.id, initial.id);
  assert.equal((await store.ledger(key))?.template_version, initial.id);
  assert.equal(
    (await defaultTemplate(store, "a")).fields.COMMENT,
    "Second default",
  );
  const dashboard = (await request("a", "/api/dashboard")).body;
  assert.equal(
    (
      dashboard.destinationTemplates as (TemplateVersion & {
        destination: string;
      })[]
    ).find((template) => template.destination === first.id)?.fields.COMMENT,
    "Book-specific future version",
  );
});
