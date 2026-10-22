import { b64, unb64 } from "../src/security.ts";

type Value = number | string | Uint8Array | Map<Value, Value>;
function concat(...values: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    Buffer.concat(values.map((value) => Buffer.from(value))),
  );
}
function encode(value: Value): Uint8Array<ArrayBuffer> {
  const head = (major: number, length: number) =>
    length < 24
      ? new Uint8Array([major * 32 + length])
      : length < 256
        ? new Uint8Array([major * 32 + 24, length])
        : new Uint8Array([major * 32 + 25, length >> 8, length & 255]);
  if (typeof value === "number")
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  return concat(
    head(5, value.size),
    ...[...value].flatMap(([key, item]) => [encode(key), encode(item)]),
  );
}
async function digest(value: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
function clientData(
  type: string,
  challenge: string,
  origin = "http://localhost:8787",
) {
  return b64(
    new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    ),
  );
}
function der(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (bytes[i] === 0 && i < bytes.length - 1) i++;
    const trimmed = bytes.slice(i);
    const body =
      trimmed[0] & 128 ? concat(new Uint8Array([0]), trimmed) : trimmed;
    return concat(new Uint8Array([2, body.length]), body);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}
export async function syntheticAuthenticator() {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", key.publicKey);
  const id = b64(crypto.getRandomValues(new Uint8Array(32)));
  const cose = encode(
    new Map<Value, Value>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, unb64(publicKey.x as string)],
      [-3, unb64(publicKey.y as string)],
    ]),
  );
  return {
    id,
    async registration(
      options: Record<string, unknown>,
      changes: {
        origin?: string;
        rp?: string;
        flags?: number;
        challenge?: string;
      } = {},
    ) {
      const authData = concat(
        await digest(changes.rp ?? "localhost"),
        new Uint8Array([changes.flags ?? 0x5d, 0, 0, 0, 0]),
        new Uint8Array(16),
        new Uint8Array([0, 32]),
        unb64(id),
        cose,
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: clientData(
            "webauthn.create",
            changes.challenge ?? String(options.challenge),
            changes.origin,
          ),
          attestationObject: b64(
            encode(
              new Map<Value, Value>([
                ["fmt", "none"],
                ["attStmt", new Map()],
                ["authData", authData],
              ]),
            ),
          ),
          transports: ["internal"],
        },
        clientExtensionResults: { credProps: { rk: true } },
      };
    },
    async assertion(
      options: Record<string, unknown>,
      userHandle: string,
      changes: {
        origin?: string;
        rp?: string;
        flags?: number;
        challenge?: string;
        counter?: number;
      } = {},
    ) {
      const counter = changes.counter ?? 0;
      const authData = concat(
        await digest(changes.rp ?? "localhost"),
        new Uint8Array([
          changes.flags ?? 0x1d,
          (counter >>> 24) & 255,
          (counter >>> 16) & 255,
          (counter >>> 8) & 255,
          counter & 255,
        ]),
      );
      const client = clientData(
        "webauthn.get",
        changes.challenge ?? String(options.challenge),
        changes.origin,
      );
      const signed = concat(
        authData,
        new Uint8Array(await crypto.subtle.digest("SHA-256", unb64(client))),
      );
      const signature = der(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            key.privateKey,
            signed,
          ),
        ),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: client,
          authenticatorData: b64(authData),
          signature: b64(signature),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}
