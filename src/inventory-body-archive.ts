import { canonical, type Envelope, open, sha256 } from "./security.ts";
import type { Store } from "./store.ts";

export interface InventoryBodyArchive {
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
  put(key: string, body: string): Promise<unknown>;
}

export interface InventoryBodyLocation {
  tenant: string;
  scope: string;
  id: string;
  connection: string;
  kind: string;
}

interface ArchivePointer {
  archive: { version: 1; digest: string; bytes: number };
}

const encoder = new TextEncoder();
export const INVENTORY_ARCHIVE_MAX_BODY_BYTES = 512 * 1024;
// SQL readers bind the stored marker length into native fences separately.
export const INVENTORY_BODY_CIPHER_BYTES =
  "coalesce(json_extract(p.envelope,'$.archive.bytes'),length(CAST(p.envelope AS BLOB)))";

export class InventoryBodyArchiveUnavailable extends Error {
  constructor(readonly location: InventoryBodyLocation) {
    super("inventory_body_archive_unavailable");
  }
}

function pointer(value: Envelope | ArchivePointer) {
  if (!(value && typeof value === "object" && "archive" in value)) return null;
  const archived = value.archive;
  if (
    archived?.version !== 1 ||
    typeof archived.digest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(archived.digest) ||
    !Number.isSafeInteger(archived.bytes) ||
    archived.bytes < 1 ||
    archived.bytes > INVENTORY_ARCHIVE_MAX_BODY_BYTES
  )
    throw new Error("invalid_inventory_body_archive_pointer");
  return archived;
}

async function objectKey(location: InventoryBodyLocation, digest: string) {
  const binding = await sha256(
    canonical([location.tenant, location.scope, location.id]),
  );
  return `inventory/body-v1/${binding}/${digest}`;
}

export async function archiveInventoryBody(
  archive: InventoryBodyArchive,
  location: InventoryBodyLocation,
  encrypted: string,
) {
  const bytes = encoder.encode(encrypted).byteLength;
  const envelope = JSON.parse(encrypted) as Envelope;
  if (
    bytes > INVENTORY_ARCHIVE_MAX_BODY_BYTES ||
    envelope?.v !== 1 ||
    envelope.algorithm !== "AES-256-GCM"
  )
    throw new Error("invalid_inventory_body_archive_input");
  const digest = await sha256(encrypted);
  const written = await archive.put(
    await objectKey(location, digest),
    encrypted,
  );
  if (written === null) throw new Error("inventory_body_archive_write_failed");
  return canonical({ archive: { version: 1, digest, bytes } });
}

/** Open either an inline envelope or an immutable cold object with the same
 * key identity. An absent or altered archive never supplies source evidence. */
export async function openInventoryBody<T>(
  store: Store,
  location: InventoryBodyLocation,
  stored: string,
  expectedBytes?: number,
): Promise<T> {
  let parsed = JSON.parse(stored) as Envelope | ArchivePointer;
  const archived = pointer(parsed);
  if (archived) {
    if (expectedBytes !== undefined && expectedBytes !== archived.bytes)
      throw new Error("inventory_body_archive_size_changed");
    const object = await store.inventoryBodyArchive?.get(
      await objectKey(location, archived.digest),
    );
    if (!object) throw new InventoryBodyArchiveUnavailable(location);
    if (object.size !== archived.bytes)
      throw new Error("inventory_body_archive_size_changed");
    const encrypted = await object.text();
    if (
      encoder.encode(encrypted).byteLength !== archived.bytes ||
      (await sha256(encrypted)) !== archived.digest
    )
      throw new Error("inventory_body_archive_digest_changed");
    parsed = JSON.parse(encrypted) as Envelope;
  } else if (
    expectedBytes !== undefined &&
    encoder.encode(stored).byteLength !== expectedBytes
  )
    throw new Error("inventory_body_archive_size_changed");
  const { tenant, connection, id, kind } = location;
  return open<T>(
    parsed as Envelope,
    { tenant, connection, id, kind, purpose: "storage" },
    store.keys,
  );
}
