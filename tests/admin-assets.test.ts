import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

test("real Worker assets serve the admin page without a canonical redirect loop", async (context) => {
  const [bundle, html] = await Promise.all([
    build({
      entryPoints: ["src/index.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["node:*"],
      target: "es2022",
    }),
    readFile(new URL("../public/admin.html", import.meta.url), "utf8"),
  ]);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "admin-assets-test",
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-22",
      compatibilityFlags: ["nodejs_compat"],
      assets: {
        directory: "public",
        binding: "ASSETS",
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
      },
      outboundService: () => {
        throw new Error("Asset requests must not contact live services");
      },
    }),
  );
  context.after(() => mf.dispose());
  const origin = "http://localhost:8787";
  const page = await mf.dispatchFetch(`${origin}/admin`, {
    redirect: "manual",
  });
  assert.equal(page.status, 200, await page.clone().text());
  assert.match(page.headers.get("Content-Type") ?? "", /text\/html/);
  assert.equal(await page.text(), html);
  const responses = [page];
  for (const path of ["/admin.html", "/admin/"]) {
    const redirect = await mf.dispatchFetch(`${origin}${path}`, {
      redirect: "manual",
    });
    assert.ok([301, 302, 307, 308].includes(redirect.status));
    const location = redirect.headers.get("Location");
    assert.ok(location);
    assert.equal(new URL(location, origin).href, `${origin}/admin`);
    const canonical = await mf.dispatchFetch(new URL(location, origin), {
      redirect: "manual",
    });
    assert.equal(canonical.status, 200, `${path} redirects exactly once`);
    assert.equal(await canonical.text(), html);
    responses.push(redirect, canonical);
  }
  const api = await mf.dispatchFetch(`${origin}/api/admin/overview`, {
    redirect: "manual",
  });
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: "Sign in with a passkey" });
  assert.equal(api.headers.get("Cache-Control"), "no-store");
  responses.push(api);
  for (const response of responses) {
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /frame-ancestors 'none'/,
    );
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  }
});
