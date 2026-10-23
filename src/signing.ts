/** Direct LoTW v2 signing. Field order was compared with Wavelog's MIT signer.
 * See fixtures/signing/WAVELOG-LICENSE.txt and docs/evidence-signing.md.
 * SHA-1 is required by this legacy wire protocol, never for application hashes.
 */
import forge from "node-forge";
import { normalizeLotwStationGrid } from "./lotw-grid.ts";

const OID = {
  call: "1.3.6.1.4.1.12348.1.1",
  first: "1.3.6.1.4.1.12348.1.2",
  last: "1.3.6.1.4.1.12348.1.3",
  dxcc: "1.3.6.1.4.1.12348.1.4",
};
export const SIGNING_CONFIGURATION = "ferry-lotw-v2-us-ca-2";
export type CertificateStatus =
  | "unrevoked"
  | "revoked"
  | "superseded"
  | "unknown";
export interface SigningCredential {
  version: string;
  privateKeyPkcs8: string;
  certificatePem: string;
  serial: string;
  callsign: string;
  dxcc: number;
  validFrom: string;
  validTo: string;
  qsoFrom: string;
  qsoTo: string | null;
  status: CertificateStatus;
  statusCheckedAt: string | null;
}
export interface ImportOptions {
  now?: Date;
  version?: string;
  certificateStatus?: (serial: string) => Promise<CertificateStatus>;
}
export interface LotwStation {
  callsign: string;
  dxcc: number;
  grid?: string;
  state?: string;
  county?: string;
  cqZone?: number;
  ituZone?: number;
  iota?: string;
}
export interface LotwContact {
  id: string;
  generation: string;
  call: string;
  band: string;
  mode: string;
  submode?: string;
  date: string;
  time: string;
  frequencyMHz?: string;
  bandRx?: string;
  frequencyRxMHz?: string;
  propagation?: string;
  satellite?: string;
}
export interface SignedArtifact {
  bytes: Uint8Array;
  text: string;
  canonicalData: string[];
  members: { id: string; generation: string }[];
  credentialVersion: string;
  configurationVersion: string;
}
function fail(message: string): never {
  throw new Error(message);
}
function binary(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}
function parseDer(input: string): forge.asn1.Asn1 {
  const buffer = forge.util.createBuffer(input);
  const result = forge.asn1.fromDer(buffer, true);
  if (buffer.length() !== 0) fail("Trailing ASN.1 bytes");
  return result;
}
function asnChildren(value: forge.asn1.Asn1): forge.asn1.Asn1[] {
  return Array.isArray(value.value) ? value.value : [];
}
function boundedInteger(value: forge.asn1.Asn1 | undefined): number {
  if (!value || typeof value.value !== "string" || value.value.length > 4)
    fail("PKCS#12 KDF iteration limit exceeded");
  let result = 0;
  for (const character of value.value)
    result = result * 256 + character.charCodeAt(0);
  if (result < 1 || result > 100_000)
    fail("PKCS#12 KDF iteration limit exceeded");
  return result;
}
/** Inspect iteration parameters before entering Forge's synchronous KDF. */
function inspectP12(root: forge.asn1.Asn1): void {
  const macData = asnChildren(root)[2];
  if (!macData) fail("PKCS#12 integrity MAC is required");
  const macIterations = asnChildren(macData)[2];
  if (macIterations) boundedInteger(macIterations);
  let nodes = 0;
  const visit = (node: forge.asn1.Asn1, depth: number): void => {
    if (++nodes > 12_000 || depth > 32)
      fail("PKCS#12 structure limit exceeded");
    const children = asnChildren(node);
    if (
      children[0]?.type === forge.asn1.Type.OID &&
      typeof children[0].value === "string"
    ) {
      const oid = forge.asn1.derToOid(children[0].value);
      if (
        oid.startsWith("1.2.840.113549.1.12.1.") ||
        oid === "1.2.840.113549.1.5.12"
      ) {
        boundedInteger(asnChildren(children[1])[1]);
      }
    }
    for (const child of children) visit(child, depth + 1);
    if (
      node.type === forge.asn1.Type.OCTETSTRING &&
      typeof node.value === "string" &&
      node.value.charCodeAt(0) === 48
    ) {
      let nested: forge.asn1.Asn1 | undefined;
      try {
        nested = parseDer(node.value);
      } catch {
        /* Encrypted octets are not DER. */
      }
      if (nested) visit(nested, depth + 1);
    }
  };
  visit(root, 0);
}
function extension(
  cert: forge.pki.Certificate,
  oid: string,
): string | undefined {
  const ext = cert.extensions.find((entry) => entry.id === oid);
  if (!ext) return undefined;
  if (typeof ext.value !== "string")
    fail("Invalid certificate authorization encoding");
  // TQSL reads these extension octets as raw DXCC/date text. Also accept the
  // DER string wrappers used by other certificate producers and our fixtures.
  if (/^(?:\d{1,3}|\d{4}-\d{2}-\d{2})$/.test(ext.value)) return ext.value;
  let value: forge.asn1.Asn1;
  try {
    value = parseDer(ext.value);
  } catch {
    fail("Invalid certificate authorization encoding");
  }
  if (
    value.tagClass !== forge.asn1.Class.UNIVERSAL ||
    value.constructed ||
    ![
      forge.asn1.Type.UTF8,
      forge.asn1.Type.PRINTABLESTRING,
      forge.asn1.Type.IA5STRING,
    ].includes(value.type) ||
    typeof value.value !== "string" ||
    !value.value.length
  )
    fail("Invalid certificate authorization encoding");
  return value.value;
}
function date(value: string | undefined, optional: true): string | null;
function date(value: string | undefined, optional?: false): string;
function date(value: string | undefined, optional = false): string | null {
  if (!value && optional) return null;
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    fail("Invalid certificate QSO date authorization");
  return value;
}
export function validCallsign(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 20 &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value) &&
    /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(value) &&
    !value.startsWith("0") &&
    (!value.startsWith("1") || /^1[AMS]/.test(value))
  );
}
/** Parse the container and its signing constraints; LoTW validates the issuer on upload. */
export async function importPkcs12(
  input: Uint8Array,
  password: string,
  options: ImportOptions = {},
): Promise<SigningCredential> {
  if (!input.length || input.length > 256 * 1024 || password.length > 1024)
    fail("PKCS#12 input exceeds import limits");
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn = parseDer(binary(input));
    inspectP12(asn);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn, true, password);
  } catch (error) {
    if (error instanceof Error && /limit|MAC is required/.test(error.message))
      throw error;
    fail("Unable to verify PKCS#12 integrity or decrypt this file");
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[
      forge.pki.oids.keyBag
    ] ?? []),
  ];
  if (keyBags.length !== 1 || !keyBags[0]?.key)
    fail("Exactly one RSA private key is required");
  const key = keyBags[0].key;
  if (key.n.bitLength() < 1024 || key.n.bitLength() > 4096)
    fail("Unsupported RSA key size");
  const certificates = (
    p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ??
    []
  )
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => Boolean(cert));
  if (certificates.length > 8) fail("Certificate chain exceeds import limits");
  const matching = certificates.filter(
    (cert) =>
      "n" in cert.publicKey &&
      cert.publicKey.n.equals(key.n) &&
      cert.publicKey.e.equals(key.e),
  );
  if (matching.length !== 1)
    fail("Certificate and private key must match uniquely");
  const cert = matching[0];
  const leafUsage: unknown = cert.getExtension("keyUsage");
  if (
    leafUsage &&
    (typeof leafUsage !== "object" ||
      !("digitalSignature" in leafUsage) ||
      leafUsage.digitalSignature !== true)
  )
    fail("Certificate is not authorized for digital signatures");
  const callsignValue = cert.subject.attributes.find(
    (attribute) => attribute.type === OID.call,
  )?.value;
  const callsign =
    typeof callsignValue === "string" ? callsignValue.toUpperCase() : "";
  const dxccText = extension(cert, OID.dxcc);
  if (
    !validCallsign(callsign) ||
    !dxccText ||
    !/^\d{1,3}$/.test(dxccText) ||
    Number(dxccText) < 1
  )
    fail("LoTW callsign or DXCC authorization is missing");
  const qsoFrom = date(extension(cert, OID.first));
  const qsoTo = date(extension(cert, OID.last), true);
  if (qsoTo && qsoTo < qsoFrom)
    fail("Invalid certificate QSO date authorization");
  const now = options.now ?? new Date();
  const status = options.certificateStatus
    ? await options.certificateStatus(
        BigInt(`0x${cert.serialNumber}`).toString(),
      )
    : "unknown";
  return {
    version: options.version ?? crypto.randomUUID(),
    privateKeyPkcs8: forge.pki.privateKeyInfoToPem(
      forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key)),
    ),
    certificatePem: forge.pki.certificateToPem(cert),
    serial: BigInt(`0x${cert.serialNumber}`).toString(),
    callsign,
    dxcc: Number(dxccText),
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    qsoFrom,
    qsoTo,
    status,
    statusCheckedAt: options.certificateStatus ? now.toISOString() : null,
  };
}
const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  ),
);
const CA_PROVINCES: Record<string, string> = {
  AB: "AB",
  BC: "BC",
  MB: "MB",
  NB: "NB",
  NL: "NF",
  NS: "NS",
  NT: "NT",
  NU: "NU",
  ON: "ON",
  PE: "PE",
  QC: "PQ",
  SK: "SK",
  YT: "YT",
};
const BANDS = new Set(
  "2190M 630M 160M 80M 60M 40M 30M 20M 17M 15M 12M 10M 6M 4M 2M 1.25M 70CM 33CM 23CM 13CM 9CM 6CM 3CM 1.25CM 6MM 4MM 2.5MM 2MM 1MM".split(
    " ",
  ),
);
const MODES = new Set(
  "CW SSB AM FM DATA RTTY FT8 FT4 PSK31 PSK63 MFSK16 MFSK8 JT65 JT9 Q65 FST4 FST4W MSK144 PACKET".split(
    " ",
  ),
);
function value(input: string): string {
  if (!/^[\x20-\x7E]*$/.test(input) || input.length > 512)
    fail("Unsupported signing field encoding or length");
  return input.toUpperCase();
}
function field(name: string, input: string, type = ""): string {
  return `<${name}:${input.length}${type ? `:${type}` : ""}>${input}\n`;
}
function stationFields(station: LotwStation): Record<string, string> {
  if (
    !validCallsign(station.callsign.toUpperCase()) ||
    !Number.isInteger(station.dxcc) ||
    station.dxcc < 1 ||
    station.dxcc > 522
  )
    fail("Invalid station identity");
  const fields: Record<string, string> = {
    CALL: station.callsign.toUpperCase(),
    DXCC: String(station.dxcc),
  };
  if (station.grid) {
    fields.GRIDSQUARE = normalizeLotwStationGrid(station.grid);
  }
  if (station.cqZone !== undefined) {
    if (
      !Number.isInteger(station.cqZone) ||
      station.cqZone < 1 ||
      station.cqZone > 40
    )
      fail("Invalid CQ zone");
    fields.CQZ = String(station.cqZone);
  }
  if (station.ituZone !== undefined) {
    if (
      !Number.isInteger(station.ituZone) ||
      station.ituZone < 1 ||
      station.ituZone > 90
    )
      fail("Invalid ITU zone");
    fields.ITUZ = String(station.ituZone);
  }
  if (station.iota) {
    if (!/^(AF|AN|AS|EU|NA|OC|SA)-\d{3}$/.test(station.iota.toUpperCase()))
      fail("Invalid IOTA reference");
    fields.IOTA = station.iota.toUpperCase();
  }
  if (station.state || station.county) {
    if ([6, 110, 291].includes(station.dxcc)) {
      if (!station.state || !US_STATES.has(station.state.toUpperCase()))
        fail("Invalid US station state");
      fields.US_STATE = station.state.toUpperCase();
      if (station.county) {
        if (!/^[A-Z .'-]{1,64}$/i.test(station.county))
          fail("Invalid US county");
        fields.US_COUNTY = station.county.toUpperCase();
      }
    } else if (station.dxcc === 1 && station.state && !station.county) {
      const province = CA_PROVINCES[station.state.toUpperCase()];
      if (!province) fail("Invalid Canadian province");
      fields.CA_PROVINCE = province;
    } else
      fail("Station subdivision needs a supported versioned configuration");
  }
  return fields;
}
/** ARRL SUBMODE lookup falls back to the parent MODE; USB/LSB are SSB. */
export function lotwMode(mode: string, submode?: string): string {
  const parent = value(mode);
  const child = submode ? value(submode) : undefined;
  const mapped =
    parent === "SSB" && (child === "USB" || child === "LSB")
      ? "SSB"
      : child || parent;
  if (!MODES.has(mapped)) fail("Mode needs an explicit supported LoTW mapping");
  return mapped;
}
function normalizedContact(contact: LotwContact): Record<string, string> {
  if (!validCallsign(contact.call.toUpperCase()))
    fail("Invalid worked callsign");
  const mode = lotwMode(contact.mode, contact.submode);
  const band = value(contact.band);
  if (!BANDS.has(band)) fail("Unsupported LoTW band");
  date(contact.date);
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/.test(contact.time))
    fail("LoTW requires exact UTC seconds");
  const result: Record<string, string> = {
    CALL: contact.call.toUpperCase(),
    BAND: band,
    MODE: mode,
    QSO_DATE: contact.date,
    QSO_TIME: contact.time,
  };
  for (const [name, frequency] of [
    ["FREQ", contact.frequencyMHz],
    ["FREQ_RX", contact.frequencyRxMHz],
  ] as const) {
    if (frequency !== undefined) {
      if (
        !/^\d+(?:\.\d{1,6})?$/.test(frequency) ||
        Number(frequency) <= 0 ||
        Number(frequency) > 1_000_000
      )
        fail("Invalid MHz frequency");
      result[name] = frequency;
    }
  }
  if (contact.bandRx) {
    const bandRx = value(contact.bandRx);
    if (!BANDS.has(bandRx)) fail("Unsupported receive band");
    result.BAND_RX = bandRx;
  }
  if (contact.propagation) {
    const propagation = value(contact.propagation);
    if (
      !["SAT", "EME", "AUR", "ES", "F2", "ION", "MS", "RS", "TR"].includes(
        propagation,
      )
    )
      fail("Unsupported propagation");
    result.PROP_MODE = propagation;
  }
  if (contact.satellite) {
    if (
      result.PROP_MODE !== "SAT" ||
      !/^[A-Z0-9 -]{1,32}$/i.test(contact.satellite)
    )
      fail("Invalid satellite context");
    result.SAT_NAME = contact.satellite.toUpperCase();
  }
  if (result.PROP_MODE === "SAT" && !result.SAT_NAME)
    fail("Satellite name is required");
  return result;
}
const STATION_ORDER = [
  "AU_STATE",
  "CA_PROVINCE",
  "CN_PROVINCE",
  "CQZ",
  "FI_KUNTA",
  "GRIDSQUARE",
  "IOTA",
  "ITUZ",
  "JA_CITY_GUN_KU",
  "JA_PREFECTURE",
  "RU_OBLAST",
  "US_COUNTY",
  "US_STATE",
];
const CONTACT_ORDER = [
  "BAND",
  "BAND_RX",
  "CALL",
  "FREQ",
  "FREQ_RX",
  "MODE",
  "PROP_MODE",
  "QSO_DATE",
  "QSO_TIME",
  "SAT_NAME",
];
export function canonicalSigningData(
  station: LotwStation,
  contact: LotwContact,
): string {
  const own = stationFields(station);
  const qso = normalizedContact(contact);
  return [
    ...STATION_ORDER.map((key) => own[key] ?? ""),
    ...CONTACT_ORDER.map((key) => qso[key] ?? ""),
  ]
    .join("")
    .toUpperCase();
}
export async function signCanonical(
  privateKeyPkcs8: string,
  canonical: string,
): Promise<string> {
  const der = forge.pem.decode(privateKeyPkcs8)[0];
  if (der?.type !== "PRIVATE KEY") fail("Normalized PKCS#8 key is required");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    bytes(der.body),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(canonical),
  );
  return forge.util.encode64(binary(new Uint8Array(signature)));
}
export async function buildSignedTq8(
  credential: SigningCredential,
  station: LotwStation,
  contacts: LotwContact[],
  now = new Date(),
): Promise<SignedArtifact> {
  if (!contacts.length || contacts.length > 100)
    fail("Signed batch must contain 1–100 contacts");
  if (
    credential.status !== "unrevoked" ||
    !credential.statusCheckedAt ||
    !Number.isFinite(Date.parse(credential.statusCheckedAt)) ||
    now.getTime() - Date.parse(credential.statusCheckedAt) > 86_400_000 ||
    Date.parse(credential.statusCheckedAt) > now.getTime() + 60_000
  )
    fail("Fresh unrevoked certificate status is required");
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(Date.parse(credential.validFrom)) ||
    !Number.isFinite(Date.parse(credential.validTo)) ||
    now < new Date(credential.validFrom) ||
    now > new Date(credential.validTo)
  )
    fail("Certificate is not currently valid");
  if (
    station.callsign.toUpperCase() !== credential.callsign ||
    station.dxcc !== credential.dxcc
  )
    fail("Station callsign/DXCC does not match the certificate");
  const seen = new Set<string>();
  const own = stationFields(station);
  const certificateBody = credential.certificatePem
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s/g, "");
  let text = field("TQSL_IDENT", `LoFi QSO Ferry 1 ${SIGNING_CONFIGURATION}`);
  text +=
    field("REC_TYPE", "tCERT") +
    field("CERT_UID", "1") +
    field("CERTIFICATE", certificateBody) +
    "<eor>\n";
  text +=
    field("REC_TYPE", "tSTATION") +
    field("STATION_UID", "1") +
    field("CERT_UID", "1");
  for (const [name, input] of Object.entries(own))
    text += field(name, value(input));
  text += "<eor>\n";
  const canonicalData: string[] = [];
  for (const contact of contacts) {
    if (!contact.id || !contact.generation || seen.has(contact.id))
      fail("Batch member identities must be unique and versioned");
    seen.add(contact.id);
    if (
      contact.date < credential.qsoFrom ||
      (credential.qsoTo && contact.date > credential.qsoTo)
    )
      fail("QSO date is outside certificate authorization");
    const qso = normalizedContact(contact);
    const canonical = canonicalSigningData(station, contact);
    const signature = await signCanonical(
      credential.privateKeyPkcs8,
      canonical,
    );
    canonicalData.push(canonical);
    text += field("REC_TYPE", "tCONTACT") + field("STATION_UID", "1");
    for (const [name, input] of Object.entries(qso)) text += field(name, input);
    text +=
      field("SIGN_LOTW_V2.0", signature, "6") +
      field("SIGNDATA", canonical) +
      "<eor>\n";
  }
  const compressed = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const compressedBytes = new Uint8Array(
    await new Response(compressed).arrayBuffer(),
  );
  return {
    bytes: compressedBytes,
    text,
    canonicalData,
    members: contacts.map(({ id, generation }) => ({ id, generation })),
    credentialVersion: credential.version,
    configurationVersion: SIGNING_CONFIGURATION,
  };
}
