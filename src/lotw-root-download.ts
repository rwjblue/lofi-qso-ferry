import forge from "node-forge";
import { verifyCertificateSignature } from "./signing.ts";
import { VendorDeferredError } from "./vendor-requests.ts";

const DOWNLOAD_ERROR = "Unable to refresh LoTW certificate trust from ARRL.";
const CERTIFICATE_ERROR = "Invalid LoTW root certificate bundle.";
const MAX_COMPRESSED = 256 * 1024;
const MAX_XML = 1024 * 1024;
const MAX_ROOTS = 8;
const PEM =
  /^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/;

/** Authenticate provenance through the fixed ARRL HTTPS download before calling
 * this validator. A self-signature alone never establishes trust in a new CA.
 */
export async function normalizeLotwTrustRoots(
  pems: string[],
): Promise<string[]> {
  try {
    if (!Array.isArray(pems) || pems.length > MAX_ROOTS)
      throw new Error(CERTIFICATE_ERROR);
    const canonical = new Map<string, string>();
    for (const pem of pems) {
      if (typeof pem !== "string" || pem.length > 16_384 || !PEM.test(pem))
        throw new Error(CERTIFICATE_ERROR);
      const certificate = forge.pki.certificateFromPem(pem);
      const basic: unknown = certificate.getExtension("basicConstraints");
      const usage: unknown = certificate.getExtension("keyUsage");
      if (
        !basic ||
        typeof basic !== "object" ||
        !("cA" in basic) ||
        basic.cA !== true ||
        (usage &&
          (typeof usage !== "object" ||
            !("keyCertSign" in usage) ||
            usage.keyCertSign !== true)) ||
        !certificate.isIssuer(certificate) ||
        !("n" in certificate.publicKey) ||
        !("e" in certificate.publicKey) ||
        certificate.publicKey.n.bitLength() < 2048 ||
        certificate.publicKey.n.bitLength() > 8192 ||
        certificate.extensions.some(
          (extension) =>
            extension.critical &&
            !["2.5.29.19", "2.5.29.15"].includes(extension.id),
        ) ||
        !(await verifyCertificateSignature(certificate, certificate))
      )
        throw new Error(CERTIFICATE_ERROR);
      const der = forge.asn1
        .toDer(forge.pki.certificateToAsn1(certificate))
        .getBytes();
      const digest = await crypto.subtle.digest(
        "SHA-256",
        Uint8Array.from(der, (value) => value.charCodeAt(0)),
      );
      const fingerprint = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      canonical.set(
        fingerprint,
        `${forge.pki.certificateToPem(certificate).replace(/\r\n/g, "\n").trim()}\n`,
      );
    }
    return [...canonical]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, pem]) => pem);
  } catch {
    throw new Error(CERTIFICATE_ERROR);
  }
}

function validReferences(value: string): boolean {
  return !value
    .replace(
      /&(?:amp|lt|gt|quot|apos);|&#(?:[0-9]+|x[0-9A-Fa-f]+);/g,
      (reference) => {
        if (!reference.startsWith("&#")) return "";
        const number = reference.startsWith("&#x")
          ? Number.parseInt(reference.slice(3, -1), 16)
          : Number.parseInt(reference.slice(2, -1), 10);
        return number === 9 ||
          number === 10 ||
          number === 13 ||
          (number >= 32 && number <= 0xd7ff) ||
          (number >= 0xe000 && number <= 0xfffd) ||
          (number >= 0x10000 && number <= 0x10ffff)
          ? ""
          : "&";
      },
    )
    .includes("&");
}

function attributes(value: string): Map<string, string> {
  const result = new Map<string, string>();
  let rest = value;
  while (rest.trim()) {
    if (result.size >= 64) throw new Error(DOWNLOAD_ERROR);
    const attribute =
      /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(
        rest,
      );
    if (!attribute || result.has(attribute[1])) throw new Error(DOWNLOAD_ERROR);
    const text = attribute[2] ?? attribute[3];
    if (!validReferences(text)) throw new Error(DOWNLOAD_ERROR);
    result.set(attribute[1], text);
    rest = rest.slice(attribute[0].length);
  }
  return result;
}

/** A bounded XML scanner: no DTD, external entities, custom entity expansion,
 * or recovery from malformed/truncated documents. Ignore all non-root payloads.
 */
function rootElements(xml: string): string[] {
  for (const character of xml) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code < 32 && ![9, 10, 13].includes(code)) ||
      code === 0xfffe ||
      code === 0xffff
    )
      throw new Error(DOWNLOAD_ERROR);
  }
  const roots: string[] = [];
  const stack: string[] = [];
  let cursor = 0;
  let tokens = 0;
  let started = false;
  let completed = false;
  let declaration = false;
  let rootText: string | null = null;
  const text = (value: string) => {
    if (!validReferences(value) || value.includes("]]>"))
      throw new Error(DOWNLOAD_ERROR);
    if (!stack.length && value.trim()) throw new Error(DOWNLOAD_ERROR);
    if (rootText !== null) rootText += value;
  };
  while (cursor < xml.length) {
    if (++tokens > 40_000) throw new Error(DOWNLOAD_ERROR);
    const next = xml.indexOf("<", cursor);
    if (next === -1) {
      text(xml.slice(cursor));
      cursor = xml.length;
      break;
    }
    text(xml.slice(cursor, next));
    cursor = next;
    if (xml.startsWith("<!--", cursor)) {
      if (rootText !== null) throw new Error(DOWNLOAD_ERROR);
      const end = xml.indexOf("-->", cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes("--"))
        throw new Error(DOWNLOAD_ERROR);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", cursor)) {
      if (!stack.length || rootText !== null) throw new Error(DOWNLOAD_ERROR);
      const end = xml.indexOf("]]>", cursor + 9);
      if (end < 0) throw new Error(DOWNLOAD_ERROR);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?xml", cursor)) {
      if (started || declaration || xml.slice(0, cursor).trim())
        throw new Error(DOWNLOAD_ERROR);
      const end = xml.indexOf("?>", cursor + 5);
      if (end < 0) throw new Error(DOWNLOAD_ERROR);
      const values = attributes(xml.slice(cursor + 5, end));
      if (
        values.get("version") !== "1.0" ||
        (values.has("encoding") &&
          values.get("encoding")?.toUpperCase() !== "UTF-8") ||
        (values.has("standalone") &&
          !["yes", "no"].includes(values.get("standalone") ?? "")) ||
        [...values.keys()].some(
          (key) => !["version", "encoding", "standalone"].includes(key),
        )
      )
        throw new Error(DOWNLOAD_ERROR);
      declaration = true;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", cursor) || xml.startsWith("<?", cursor))
      throw new Error(DOWNLOAD_ERROR);
    let end = cursor + 1;
    let quote = "";
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      else if (char === "<") throw new Error(DOWNLOAD_ERROR);
    }
    if (end === xml.length) throw new Error(DOWNLOAD_ERROR);
    if (end - cursor > 16_384) throw new Error(DOWNLOAD_ERROR);
    const token = xml.slice(cursor + 1, end);
    const closing = /^\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/.exec(token);
    if (closing) {
      if (stack.pop() !== closing[1]) throw new Error(DOWNLOAD_ERROR);
      if (closing[1] === "rootcert") {
        if (rootText === null || roots.length >= MAX_ROOTS)
          throw new Error(DOWNLOAD_ERROR);
        roots.push(rootText.trim());
        rootText = null;
      }
      if (!stack.length) completed = true;
    } else {
      if (rootText !== null) throw new Error(DOWNLOAD_ERROR);
      const opening = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*?)(\/?)$/.exec(
        token,
      );
      if (!opening) throw new Error(DOWNLOAD_ERROR);
      const name = opening[1];
      const values = attributes(opening[2]);
      const selfClosing = opening[3] === "/";
      if (!stack.length) {
        if (
          started ||
          completed ||
          name !== "tqsldata" ||
          selfClosing ||
          values.size
        )
          throw new Error(DOWNLOAD_ERROR);
        started = true;
      }
      if (name === "rootcert") {
        if (
          stack.join("/") !== "tqsldata/tqslcerts" ||
          values.size ||
          selfClosing
        )
          throw new Error(DOWNLOAD_ERROR);
        rootText = "";
      }
      if (!selfClosing) stack.push(name);
      if (stack.length > 64) throw new Error(DOWNLOAD_ERROR);
    }
    cursor = end + 1;
  }
  if (!started || !completed || stack.length || !roots.length)
    throw new Error(DOWNLOAD_ERROR);
  return roots;
}

async function boundedBody(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
  compressedLimit?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  const prefix: number[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error(DOWNLOAD_ERROR);
      const result = await reader.read();
      if (signal.aborted) throw new Error(DOWNLOAD_ERROR);
      if (result.done) break;
      if (prefix.length < 2)
        prefix.push(...result.value.subarray(0, 2 - prefix.length));
      length += result.value.byteLength;
      const effectiveLimit =
        compressedLimit && prefix[0] === 0x1f && prefix[1] === 0x8b
          ? compressedLimit
          : limit;
      if (length > effectiveLimit) throw new Error(DOWNLOAD_ERROR);
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch {
    cancel();
    throw new Error(DOWNLOAD_ERROR);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** The system TLS store authenticates ARRL's HTTPS server. Only that fixed
 * network response may supply newly trusted LoTW signing CAs, never a P12.
 */
export async function downloadLotwTrustRoots(
  credentials: { username: string; password: string },
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response | undefined;
  try {
    const url = new URL("https://lotw.arrl.org/lotwuser/certs.tq6");
    url.searchParams.set("login", credentials.username);
    url.searchParams.set("password", credentials.password);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(DOWNLOAD_ERROR)),
        { once: true },
      );
    });
    response = await Promise.race([
      fetcher(url.toString(), {
        redirect: "manual",
        signal: controller.signal,
      }),
      aborted,
    ]);
    if (
      !response.ok ||
      response.redirected ||
      ["opaque", "opaqueredirect", "error"].includes(response.type) ||
      (response.url && response.url !== url.toString()) ||
      !response.body
    )
      throw new Error(DOWNLOAD_ERROR);
    const size = response.headers.get("content-length");
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_XML))
      throw new Error(DOWNLOAD_ERROR);
    let bytes = await boundedBody(
      response.body,
      MAX_XML,
      controller.signal,
      MAX_COMPRESSED,
    );
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      bytes = await boundedBody(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
        MAX_XML,
        controller.signal,
      );
    }
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return await normalizeLotwTrustRoots(rootElements(xml));
  } catch (error) {
    if (response?.body && !response.body.locked)
      void response.body.cancel().catch(() => {});
    if (error instanceof VendorDeferredError) throw error;
    throw new Error(DOWNLOAD_ERROR);
  } finally {
    clearTimeout(timeout);
  }
}
