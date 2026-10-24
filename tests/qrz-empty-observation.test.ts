import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  type QrzEmptyObservation,
  QrzEmptyObservationScope,
} from "../src/delivery.ts";
import { projectContact } from "../src/projection.ts";
import { seal } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";

async function fixture(t: TestContext) {
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  h.qrzRecords.length = 0;
  const input = {
    key: {
      tenant: "a",
      source: "source",
      qso: "q1",
      destination: "destination",
    },
    contact: await projectContact(h.qso, h.operation, [], {
      operationComplete: true,
    }),
    source: (await h.store.connection("a", "source"))!,
    destination: (await h.store.connection("a", "destination"))!,
  };
  const credential = (await h.store.private<{ apiKey: string }>(
    "a",
    "destination",
    "fixture-qrz",
    "credential",
  ))!;
  const scope = new QrzEmptyObservationScope(h.store);
  t.after(() => scope.close());
  const read = (fetcher = h.fetcher) =>
    scope.read(input, credential, { fetcher });
  const consume = (
    observation: QrzEmptyObservation | undefined,
    captured = input,
    at = Date.now(),
  ) =>
    QrzEmptyObservationScope.consume(
      observation,
      h.store,
      captured,
      credential,
      () => at,
    );
  return { ...h, input, credential, scope, read, consume };
}

test("only an actual complete empty scan issues a single-use, instance-local capability", async (t) => {
  const h = await fixture(t);
  const read = await h.read();
  assert.equal(h.calls.qrzReads, 1);
  assert(read.observation);
  assert.equal(
    await QrzEmptyObservationScope.consume(
      read.observation,
      new Store(h.db, h.store.keys),
      h.input,
      h.credential,
      Date.now,
    ),
    false,
  );
  assert.equal(await h.consume(read.observation), true);
  assert.equal(await h.consume(read.observation), false);
  for (const scope of [true, "forged", 1, {}, null])
    assert.equal(
      await h.consume({ scope, token: {} } as unknown as QrzEmptyObservation),
      false,
    );
  assert.equal(await h.consume({ scope: h.scope, token: {} }), false);
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM attempts")
      .first<number>("n"),
    0,
  );
});

test("projection, generation, raw source context and route bindings are exact and a mismatch burns the token", async (t) => {
  const h = await fixture(t);
  for (const change of [
    (v: typeof h.input) => {
      v.key.qso = "other";
    },
    (v: typeof h.input) => {
      v.contact.generation += "changed";
    },
    (v: typeof h.input) => {
      v.contact.call = "K2ABC";
    },
    (v: typeof h.input) => {
      v.contact.startAtMillis += 123;
    },
    (v: typeof h.input) => {
      v.contact.context.qso.syncedAtMillis = 999;
    },
    (v: typeof h.input) => {
      v.contact.context.op.syncedAtMillis = 999;
    },
    (v: typeof h.input) => {
      v.source.config = "{}";
    },
    (v: typeof h.input) => {
      v.destination.remote_identity += "changed";
    },
    (v: typeof h.input) => {
      v.destination.config = "{}";
    },
  ]) {
    const { observation } = await h.read();
    assert(observation);
    const changed = structuredClone(h.input);
    change(changed);
    assert.equal(await h.consume(observation, changed), false);
    assert.equal(await h.consume(observation), false);
  }
});

test("credential envelope replacement and revocation prevent reuse even with the same version", async (t) => {
  const h = await fixture(t);
  const first = await h.read();
  assert(first.observation);
  const envelope = await seal(
    h.credential,
    {
      tenant: "a",
      connection: "destination",
      id: "fixture-qrz",
      kind: "credential",
      purpose: "storage",
    },
    h.store.keys,
  );
  await h.store
    .statement(
      "UPDATE private_data SET envelope=? WHERE connection='destination' AND kind='credential'",
      JSON.stringify(envelope),
    )
    .run();
  assert.equal(await h.consume(first.observation), false);
  const second = await h.read();
  assert(second.observation);
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=? WHERE connection='source' AND kind='credential'",
      Date.now(),
    )
    .run();
  assert.equal(await h.consume(second.observation), false);
  await assert.rejects(
    h.read(),
    /scope changed/,
    "the existing QRZ client also refuses revoked source access",
  );
  assert.equal(h.calls.qrzReads, 2);
});

test("the original request-start deadline is not renewed by a late completed read", async (t) => {
  const h = await fixture(t);
  const start = Date.now();
  let now = start;
  t.mock.method(Date, "now", () => now);
  const read = await h.read(async (input, init) => {
    now = start + 59_000;
    return h.fetcher(input, init);
  });
  assert(read.observation);
  assert.equal(
    await h.consume(read.observation, h.input, start + 60_000),
    false,
  );
});

test("closing an in-flight scope cannot issue a token or start another read", async (t) => {
  const h = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = h.read(async (input, init) => {
    entered();
    await wait;
    return h.fetcher(input, init);
  });
  await started;
  h.scope.close();
  release();
  assert.equal((await pending).observation, undefined);
  await assert.rejects(h.read(), /scope unavailable/);
  assert.equal(h.calls.qrzReads, 1);
});

test("caller mutation during the read cannot change the captured identity", async (t) => {
  const h = await fixture(t);
  const original = structuredClone(h.input);
  const { observation } = await h.read(async (input, init) => {
    h.input.contact.call = "K2ABC";
    h.input.contact.context.qso.syncedAtMillis = 999;
    h.credential.apiKey = "changed";
    return h.fetcher(input, init);
  });
  assert(observation);
  h.credential.apiKey = "synthetic-qrz";
  assert.equal(await h.consume(observation, original), true);
});

test("nonempty, ambiguous incomplete, oversized context and exhausted scopes never issue reusable absence", async (t) => {
  const h = await fixture(t);
  h.qrzRecords.push({ ...h.initial, APP_QRZLOG_LOGID: "500" });
  assert.equal((await h.read()).observation, undefined);
  h.qrzRecords.length = 0;
  await assert.rejects(h.read(async () => new Response("RESULT=FAIL&COUNT=0")));
  h.input.contact.context.qso.large = "x".repeat(64 * 1024);
  assert.equal((await h.read()).observation, undefined);
  delete h.input.contact.context.qso.large;
  for (let i = 0; i < 20; i++) assert((await h.read()).observation);
  assert.equal((await h.read()).observation, undefined);
  assert.equal(h.calls.qrzWrites, 0);
});

test("only the normal poll diagnostic timestamp may change between read and consume", async (t) => {
  const h = await fixture(t);
  const first = await h.read();
  assert(first.observation);
  await h.store
    .statement(
      "UPDATE connections SET config=json_set(config,'$.lastSuccessfulPollAt',?) WHERE id='source'",
      Date.now(),
    )
    .run();
  h.input.source = (await h.store.connection("a", "source"))!;
  assert.equal(await h.consume(first.observation), true);
  for (const field of [
    "accountId",
    "accountEmail",
    "replayBoundaryVerified",
    "lastError",
    "unexpectedSetting",
  ]) {
    const { observation } = await h.read();
    assert(observation);
    await h.store
      .statement(
        "UPDATE connections SET config=json_set(config,?,?) WHERE id='source'",
        `$.${field}`,
        "changed",
      )
      .run();
    assert.equal(await h.consume(observation), false);
    await h.store
      .statement(
        "UPDATE connections SET config=? WHERE id='source'",
        h.input.source.config,
      )
      .run();
  }
});

test("consume captures before its database await and closing during that await rejects it", async (t) => {
  const h = await fixture(t);
  for (const close of [false, true]) {
    const originalInput = structuredClone(h.input);
    const { observation } = await h.read();
    assert(observation);
    const originalStatement = h.store.statement.bind(h.store);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mocked = t.mock.method(
      h.store,
      "statement",
      (sql: string, ...params: (string | number | null)[]) => {
        const statement = originalStatement(sql, ...params);
        if (!sql.startsWith("SELECT sp.envelope")) return statement;
        return new Proxy(statement, {
          get(target, name) {
            if (name === "first")
              return async (...args: unknown[]) => {
                entered();
                await waiting;
                return Reflect.apply(target.first, target, args);
              };
            const value = Reflect.get(target, name);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    );
    const consuming = h.consume(observation);
    await started;
    h.input.contact.startAtMillis += 123;
    h.credential.apiKey = "changed";
    if (close) h.scope.close();
    release();
    assert.equal(await consuming, !close);
    mocked.mock.restore();
    Object.assign(h.input, originalInput);
    h.credential.apiKey = "synthetic-qrz";
  }
});
