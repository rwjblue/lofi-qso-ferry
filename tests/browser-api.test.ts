import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  type BrowserSession,
  createApiClient,
} from "../src/browser-api.ts";

function fixture(recent = false) {
  const session: BrowserSession = {
    authenticated: true,
    recent,
    csrf: "fixture-original-csrf",
    account: { user_handle: "fixture-user" },
  };
  const calls: {
    path: string;
    method: string;
    body: unknown;
    csrf: string | null;
  }[] = [];
  let response = () => Response.json({ ok: true });
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      csrf: headers.get("X-CSRF-Token"),
    });
    return path === "/api/auth/session" ? Response.json(session) : response();
  };
  return {
    session,
    calls,
    fetcher,
    respond: (next: () => Response) => {
      response = next;
    },
    mutations: () => calls.filter((call) => call.method === "POST"),
  };
}

test("admin invitations require fresh verification and never replay uncertain acceptance", async () => {
  const state = fixture();
  let verifications = 0;
  const client = createApiClient(async () => {
    verifications++;
    assert.equal(state.mutations().length, 0);
    state.session.recent = true;
    state.session.csrf = "verified-admin-csrf";
  }, state.fetcher);
  state.respond(() =>
    Response.json({ invitation: { mailStatus: "uncertain" } }, { status: 202 }),
  );
  await client.request("/api/auth/session");
  const result = await client.request<{ invitation: { mailStatus: string } }>(
    "/api/admin/invitations",
    { email: "friend@example.test" },
  );
  assert.equal(result.invitation.mailStatus, "uncertain");
  assert.equal(verifications, 1);
  assert.equal(state.mutations().length, 1);
  assert.equal(state.mutations()[0].csrf, "verified-admin-csrf");
});

test("a stale protected action verifies a passkey before sending exactly one captured payload with fresh CSRF", async () => {
  const state = fixture();
  let verifications = 0;
  const client = createApiClient(async () => {
    verifications++;
    assert.equal(state.mutations().length, 0);
    state.session.recent = true;
    state.session.csrf = "fixture-new-csrf";
  }, state.fetcher);
  await client.request("/api/auth/session");
  const payload = { email: "fixture@example.test" };
  await client.request("/api/connections/lofi/start", payload);
  assert.equal(verifications, 1);
  assert.deepEqual(state.mutations(), [
    {
      path: "/api/connections/lofi/start",
      method: "POST",
      body: payload,
      csrf: "fixture-new-csrf",
    },
  ]);
  assert.deepEqual(payload, { email: "fixture@example.test" });
});

test("fresh actions skip the prompt and ordinary settings, templates and authentication need no freshness check", async () => {
  const state = fixture(true);
  let verifications = 0;
  const client = createApiClient(async () => {
    verifications++;
  }, state.fetcher);
  await client.request("/api/auth/session");
  await client.request("/api/connections/lofi/start", {
    email: "fixture@example.test",
  });
  assert.equal(verifications, 0);
  const before = state.calls.length;
  for (const path of [
    "/api/settings",
    "/api/templates",
    "/api/auth/login/options",
    "/api/auth/reauth/options",
    "/api/auth/register/options",
    "/api/auth/logout",
  ]) {
    await client.request(path, {});
  }
  assert.equal(state.calls.length, before + 6);
  assert.equal(verifications, 0);
});

test("canceled verification sends no mutation and a later action can verify again", async () => {
  const state = fixture();
  let canceled = true;
  let verifications = 0;
  const client = createApiClient(async () => {
    verifications++;
    if (canceled)
      throw new DOMException("Fixture cancellation", "NotAllowedError");
    state.session.recent = true;
  }, state.fetcher);
  await client.request("/api/auth/session");
  const payload = { email: "fixture@example.test" };
  await assert.rejects(client.request("/api/connections/lofi/start", payload), {
    name: "NotAllowedError",
  });
  assert.equal(state.mutations().length, 0);
  canceled = false;
  await client.request("/api/connections/lofi/start", payload);
  assert.equal(verifications, 2);
  assert.equal(state.mutations().length, 1);
});

test("only an explicit pre-dispatch reauth failure permits one bounded retry", async () => {
  for (const keepFailing of [false, true]) {
    const state = fixture(true);
    let attempts = 0;
    let effects = 0;
    let verifications = 0;
    state.respond(() => {
      attempts++;
      if (attempts === 1 || keepFailing)
        return Response.json(
          { error: "Verify your passkey again", code: "reauth_required" },
          { status: 403 },
        );
      effects++;
      return Response.json({ ok: true });
    });
    const client = createApiClient(async () => {
      verifications++;
    }, state.fetcher);
    await client.request("/api/auth/session");
    const action = client.request("/api/connections/lofi/start", {
      email: "fixture@example.test",
    });
    if (keepFailing)
      await assert.rejects(
        action,
        (error) =>
          error instanceof ApiError && error.code === "reauth_required",
      );
    else await action;
    assert.equal(verifications, 1);
    assert.equal(attempts, 2);
    assert.equal(effects, keepFailing ? 0 : 1);
  }
});

test("vendor, CSRF, origin and ambiguous HTTP failures never prompt or replay a mutation", async () => {
  for (const [status, code] of [
    [403, "connection_verification_failed"],
    [403, "csrf_invalid"],
    [403, "origin_invalid"],
    [503, undefined],
    [400, undefined],
  ] as const) {
    const state = fixture(true);
    let verifications = 0;
    state.respond(() =>
      Response.json({ error: "Fixture failure", code }, { status }),
    );
    const client = createApiClient(async () => {
      verifications++;
    }, state.fetcher);
    await client.request("/api/auth/session");
    await assert.rejects(
      client.request("/api/connections/lofi/start", {
        email: "fixture@example.test",
      }),
    );
    assert.equal(verifications, 0);
    assert.equal(state.mutations().length, 1);
  }
});

test("concurrent stale actions share one passkey check", async () => {
  const state = fixture();
  const begun = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let verifications = 0;
  const client = createApiClient(async () => {
    verifications++;
    begun.resolve();
    await finish.promise;
    state.session.recent = true;
  }, state.fetcher);
  await client.request("/api/auth/session");
  const a = client.request("/api/connections/lofi/start", {
    email: "fixture@example.test",
  });
  const b = client.request("/api/auth/email", {
    email: "changed@example.test",
  });
  await begun.promise;
  assert.equal(verifications, 1);
  assert.equal(state.mutations().length, 0);
  finish.resolve();
  await Promise.all([a, b]);
  assert.equal(verifications, 1);
  assert.equal(state.mutations().length, 2);
});

test("lost sessions, account switches and unverified passkeys stop the original action", async () => {
  for (const failure of [
    "signed-out",
    "switched",
    "not-verified",
    "switch-during-verification",
  ] as const) {
    const state = fixture();
    const client = createApiClient(async () => {
      if (failure === "switch-during-verification") {
        state.session.account = { user_handle: "different-user" };
        state.session.recent = true;
      }
    }, state.fetcher);
    await client.request("/api/auth/session");
    if (failure === "signed-out") state.session.authenticated = false;
    if (failure === "switched")
      state.session.account = { user_handle: "different-user" };
    await assert.rejects(
      client.request("/api/connections/lofi/start", {
        email: "fixture@example.test",
      }),
    );
    assert.equal(state.mutations().length, 0);
  }
});

test("ordinary session refresh cannot lend another account's CSRF to a waiting protected action", async () => {
  const original: BrowserSession = {
    authenticated: true,
    recent: true,
    csrf: "fixture-account-a-csrf",
    account: { user_handle: "fixture-account-a" },
  };
  const switched: BrowserSession = {
    ...original,
    csrf: "fixture-account-b-csrf",
    account: { user_handle: "fixture-account-b" },
  };
  const preflightStarted = Promise.withResolvers<void>();
  const refreshStarted = Promise.withResolvers<void>();
  const preflightResult = Promise.withResolvers<BrowserSession>();
  const refreshResult = Promise.withResolvers<BrowserSession>();
  let sessionReads = 0;
  let currentCookie = original;
  let effects = 0;
  let verifications = 0;
  const posts: { csrf: string | null; body: string | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === "/api/auth/session") {
      sessionReads++;
      if (sessionReads === 1) return Response.json(original);
      const response = Response.json({});
      if (sessionReads === 2) {
        response.json = () => {
          preflightStarted.resolve();
          return preflightResult.promise;
        };
      } else {
        currentCookie = switched;
        response.json = () => {
          refreshStarted.resolve();
          return refreshResult.promise;
        };
      }
      return response;
    }
    const csrf = new Headers(init?.headers).get("X-CSRF-Token");
    posts.push({ csrf, body: init?.body ? String(init.body) : undefined });
    if (csrf !== currentCookie.csrf)
      return Response.json(
        { code: "csrf_invalid", error: "Fixture session changed" },
        { status: 403 },
      );
    effects++;
    return Response.json({ ok: true });
  };
  const client = createApiClient(async () => {
    verifications++;
  }, fetcher);
  await client.request("/api/auth/session");
  const payload = { email: "fixture@example.test" };
  const action = client.request("/api/connections/lofi/start", payload);
  const rejected = assert.rejects(action);
  await preflightStarted.promise;
  const refresh = client.request("/api/auth/session");
  await refreshStarted.promise;
  // Both JSON bodies are ready in one turn. A's freshness continuation and
  // B's ordinary refresh interleave before the original POST is dispatched.
  preflightResult.resolve(original);
  refreshResult.resolve(switched);
  await Promise.all([rejected, refresh]);
  assert.equal(effects, 0);
  assert.equal(verifications, 0);
  assert(posts.length <= 1);
  for (const post of posts) {
    assert.equal(post.csrf, original.csrf);
    assert.equal(post.body, JSON.stringify(payload));
  }
});

test("a bounded reauth retry keeps its original account after an ordinary session refresh", async () => {
  const original: BrowserSession = {
    authenticated: true,
    recent: true,
    csrf: "fixture-account-a-csrf",
    account: { user_handle: "fixture-account-a" },
  };
  const switched: BrowserSession = {
    ...original,
    csrf: "fixture-account-b-csrf",
    account: { user_handle: "fixture-account-b" },
  };
  const firstPostStarted = Promise.withResolvers<void>();
  const firstPostResult = Promise.withResolvers<{
    error: string;
    code: string;
  }>();
  let sessionReads = 0;
  let currentCookie = original;
  let effects = 0;
  let verifications = 0;
  const posts: { csrf: string | null; body: string | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === "/api/auth/session") {
      sessionReads++;
      if (sessionReads <= 2) return Response.json(original);
      currentCookie = switched;
      return Response.json(switched);
    }
    const csrf = new Headers(init?.headers).get("X-CSRF-Token");
    posts.push({ csrf, body: init?.body ? String(init.body) : undefined });
    if (posts.length === 1) {
      const response = Response.json({}, { status: 403 });
      response.json = () => {
        firstPostStarted.resolve();
        return firstPostResult.promise;
      };
      return response;
    }
    if (csrf !== currentCookie.csrf)
      return Response.json(
        { code: "csrf_invalid", error: "Fixture session changed" },
        { status: 403 },
      );
    effects++;
    return Response.json({ ok: true });
  };
  const client = createApiClient(async () => {
    verifications++;
  }, fetcher);
  await client.request("/api/auth/session");
  const payload = { email: "fixture@example.test" };
  const action = client.request("/api/connections/lofi/start", payload);
  const rejected = assert.rejects(action);
  await firstPostStarted.promise;
  await client.request("/api/auth/session");
  firstPostResult.resolve({
    code: "reauth_required",
    error: "Fixture freshness expired before dispatch",
  });
  await rejected;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].csrf, original.csrf);
  assert.equal(posts[0].body, JSON.stringify(payload));
  assert.equal(effects, 0);
  assert.equal(verifications, 0);
});
