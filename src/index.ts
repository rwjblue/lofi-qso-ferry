export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ status: "ok", exports: false });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
