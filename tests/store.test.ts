import assert from "node:assert/strict";
import test from "node:test";
import { database, seed } from "./helpers.ts";

test("D1 isolates credentials and keeps lease fencing across competing claims", async (t) => {
  const { mf, store } = await database();
  t.after(() => mf.dispose());
  await seed(store);
  await seed(store, "b");
  assert.equal(await store.connection("other", "source"), null);
  assert.equal(
    await store.private("other", "source", "v1", "credential"),
    null,
  );
  const lease = await store.claim("a", "inventory", 1000, 100);
  assert.ok(lease);
  assert.equal(await store.claim("a", "inventory", 1050, 100), null);
  const other = await store.claim("b", "inventory", 1050, 100);
  assert.ok(other);
  const next = await store.claim("a", "inventory", 1100, 100);
  assert.ok(next);
  assert.equal(next.fence, lease.fence + 1);
  await store.release(lease);
  assert.equal(await store.claim("a", "inventory", 1150, 100), null);
  await store.release(next);
  const released = await store.claim("a", "inventory", 1150, 100);
  assert.equal(released?.fence, next.fence + 1);
});
