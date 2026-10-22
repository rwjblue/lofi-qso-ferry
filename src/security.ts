const encoder = new TextEncoder();
export const b64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64url");
export const unb64 = (value: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(value, "base64url"));
export function randomToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string"
          ? encoder.encode(value)
          : new Uint8Array(value),
      ),
    ),
  );
}
export function canonical(value: unknown): string {
  if (value === undefined) throw new Error("undefined canonical value");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((k) => object[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
    .join(",")}}`;
}
export interface PrivateIdentity {
  tenant: string;
  connection: string;
  id: string;
  kind: string;
  purpose: string;
}
export interface Envelope {
  v: 1;
  algorithm: "AES-256-GCM";
  kek: string;
  nonce: string;
  ciphertext: string;
  wrapNonce: string;
  wrappedKey: string;
}
export type Keyring = { active: string; keys: Record<string, string> };
const aad = (identity: PrivateIdentity) =>
  encoder.encode(canonical({ ...identity, schema: 1 }));
async function importAes(bytes: Uint8Array, usages: KeyUsage[]) {
  if (bytes.length !== 32) throw new Error("KEK must be 32 bytes");
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    "AES-GCM",
    false,
    usages,
  );
}
async function encrypt(
  key: CryptoKey,
  bytes: Uint8Array,
  additionalData: Uint8Array,
) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new Uint8Array(additionalData),
      tagLength: 128,
    },
    key,
    new Uint8Array(bytes),
  );
  return { nonce: b64(nonce), ciphertext: b64(new Uint8Array(ciphertext)) };
}
async function decrypt(
  key: CryptoKey,
  nonce: string,
  ciphertext: string,
  additionalData: Uint8Array,
) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64(nonce),
        additionalData: new Uint8Array(additionalData),
        tagLength: 128,
      },
      key,
      unb64(ciphertext),
    ),
  );
}
export async function seal(
  value: unknown,
  identity: PrivateIdentity,
  ring: Keyring,
): Promise<Envelope> {
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const payload = await encrypt(
    await importAes(dataKey, ["encrypt"]),
    encoder.encode(JSON.stringify(value)),
    aad(identity),
  );
  const wrapping = await encrypt(
    await importAes(unb64(ring.keys[ring.active] ?? ""), ["encrypt"]),
    dataKey,
    encoder.encode(
      canonical({ identity, schema: 1, purpose: "wrap", kek: ring.active }),
    ),
  );
  return {
    v: 1,
    algorithm: "AES-256-GCM",
    kek: ring.active,
    ...payload,
    wrapNonce: wrapping.nonce,
    wrappedKey: wrapping.ciphertext,
  };
}
async function unwrap(
  envelope: Envelope,
  identity: PrivateIdentity,
  ring: Keyring,
) {
  if (
    envelope.v !== 1 ||
    envelope.algorithm !== "AES-256-GCM" ||
    !ring.keys[envelope.kek]
  )
    throw new Error("unsupported envelope/key version");
  return decrypt(
    await importAes(unb64(ring.keys[envelope.kek]), ["decrypt"]),
    envelope.wrapNonce,
    envelope.wrappedKey,
    encoder.encode(
      canonical({ identity, schema: 1, purpose: "wrap", kek: envelope.kek }),
    ),
  );
}
export async function open<T>(
  envelope: Envelope,
  identity: PrivateIdentity,
  ring: Keyring,
): Promise<T> {
  const bytes = await decrypt(
    await importAes(await unwrap(envelope, identity, ring), ["decrypt"]),
    envelope.nonce,
    envelope.ciphertext,
    aad(identity),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
export async function rewrap(
  envelope: Envelope,
  identity: PrivateIdentity,
  ring: Keyring,
): Promise<Envelope> {
  const key = await unwrap(envelope, identity, ring);
  const wrapping = await encrypt(
    await importAes(unb64(ring.keys[ring.active] ?? ""), ["encrypt"]),
    key,
    encoder.encode(
      canonical({ identity, schema: 1, purpose: "wrap", kek: ring.active }),
    ),
  );
  return {
    ...envelope,
    kek: ring.active,
    wrapNonce: wrapping.nonce,
    wrappedKey: wrapping.ciphertext,
  };
}
export async function digestCode(
  secret: string,
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
  );
}
export function keyring(env: Env): Keyring {
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (/^KEK_V\d+$/.test(name) && typeof value === "string")
      keys[name.slice(5)] = value;
  return { active: env.ACTIVE_KEK_VERSION, keys };
}
export async function boundedJson(
  request: Request,
  max = 1_048_576,
): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > max)
    throw new Error("request too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("missing request body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new Error("request too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object");
  return value as Record<string, unknown>;
}
