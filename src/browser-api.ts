export interface BrowserSession {
  authenticated: boolean;
  csrf: string;
  recent: boolean;
  account: { user_handle: string } | null;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
function protectedAction(path: string, body: unknown): boolean {
  return (
    body !== undefined &&
    (path.startsWith("/api/connections/") ||
      path.startsWith("/api/admin/") ||
      path.startsWith("/api/auth/passkeys/") ||
      path === "/api/auth/email" ||
      path === "/api/auth/email/verify")
  );
}

/** Freshness checks never replay an ambiguous vendor mutation. Only the
 * server's explicit pre-dispatch reauth_required response permits one retry. */
export function createApiClient(
  verifyPasskey: () => Promise<void>,
  fetcher: typeof fetch = fetch,
) {
  let csrf = "";
  let userHandle: string | null = null;
  let verification:
    | {
        expected: string | null;
        forced: boolean;
        promise: Promise<BrowserSession>;
      }
    | undefined;
  async function send<T>(
    path: string,
    body?: unknown,
    token = csrf,
  ): Promise<T> {
    const response = await fetcher.call(globalThis, path, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    const result = (await response.json()) as T & {
      error?: string;
      code?: string;
    };
    if (!response.ok)
      throw new ApiError(
        result.error ?? "Request failed; try again.",
        response.status,
        result.code,
      );
    return result;
  }
  async function currentSession(expected: string | null) {
    const session = await send<BrowserSession>("/api/auth/session");
    if (!session.authenticated)
      throw new ApiError("Sign in with your passkey to continue.", 401);
    if (expected && session.account?.user_handle !== expected)
      throw new ApiError(
        "Your account changed in another tab. Refresh before continuing.",
        401,
      );
    csrf = session.csrf;
    return session;
  }
  async function ensureFresh(
    expected: string | null,
    force = false,
  ): Promise<BrowserSession> {
    const pending = verification;
    if (pending) {
      if (pending.expected !== expected)
        throw new ApiError(
          "Your account changed in another tab. Refresh before continuing.",
          401,
        );
      const checked = await pending.promise;
      if (!force || pending.forced) return checked;
      // A retry must not reuse a concurrent preflight that skipped the prompt.
      if (verification === pending) verification = undefined;
      return ensureFresh(expected, true);
    }
    const promise = (async () => {
      const session = await currentSession(expected);
      if (force || !session.recent) {
        await verifyPasskey();
        const verified = await currentSession(expected);
        if (!verified.recent)
          throw new ApiError("Verify your passkey again to continue.", 403);
        return verified;
      }
      return session;
    })();
    const attempt = { expected, forced: force, promise };
    verification = attempt;
    try {
      return await promise;
    } finally {
      if (verification === attempt) verification = undefined;
    }
  }
  return {
    async request<T = Record<string, unknown>>(
      path: string,
      body?: unknown,
    ): Promise<T> {
      const protectedRequest = protectedAction(path, body);
      const expected = userHandle;
      const authorization = protectedRequest
        ? await ensureFresh(expected)
        : undefined;
      let result: T;
      try {
        result = await send<T>(path, body, authorization?.csrf);
      } catch (error) {
        if (
          !protectedRequest ||
          !(error instanceof ApiError) ||
          error.status !== 403 ||
          error.code !== "reauth_required"
        )
          throw error;
        const renewed = await ensureFresh(expected, true);
        result = await send<T>(path, body, renewed.csrf);
      }
      if (path === "/api/auth/session" && body === undefined) {
        const session = result as BrowserSession;
        csrf = session.csrf;
        userHandle = session.account?.user_handle ?? null;
      }
      return result;
    },
  };
}
