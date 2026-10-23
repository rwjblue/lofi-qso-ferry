/** The operator's exact installation allowlist is also required before use. */
export function normalizeWavelogBaseUrl(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\%?#]/.test(value)
  )
    throw new Error("Invalid Wavelog installation URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Wavelog installation URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|private|onion|invalid)$/.test(
      host,
    ) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(value.slice(value.indexOf("://") + 3)) ||
    !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname)
  )
    throw new Error("Wavelog requires a public HTTPS installation URL");
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/index\.php(?:\/api\/v2)?$/, "");
  if (/\/api\/v2$/.test(path)) path = path.slice(0, -7);
  url.pathname = `${path}/`;
  return url.href;
}

export function parseWavelogAllowedBaseUrls(raw: string): string[] {
  if (!raw.trim()) return [];
  if (raw.length > 16384)
    throw new Error("Wavelog installation allowlist exceeds bound");
  let entries: unknown;
  if (raw.trim().startsWith("[")) {
    try {
      entries = JSON.parse(raw);
    } catch {
      throw new Error("Invalid Wavelog installation allowlist");
    }
  } else {
    entries = raw.split(/[\s,]+/).filter(Boolean);
  }
  if (
    !Array.isArray(entries) ||
    entries.length > 32 ||
    entries.some((entry) => typeof entry !== "string")
  )
    throw new Error("Invalid Wavelog installation allowlist");
  return [
    ...new Set(entries.map((entry: string) => normalizeWavelogBaseUrl(entry))),
  ];
}

export function assertWavelogBaseUrlAllowed(
  baseUrl: string,
  allowed: readonly string[],
): string {
  const normalized = normalizeWavelogBaseUrl(baseUrl);
  if (!allowed.some((entry) => normalizeWavelogBaseUrl(entry) === normalized))
    throw new Error(
      "Wavelog installation is not allowed by this Ferry operator",
    );
  return normalized;
}
