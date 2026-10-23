/** ADI is ASCII, not ADX: reject unsupported text instead of corrupting lengths. */
export type AdifRecord = Record<string, string>;
export interface AdifDocument {
  header: AdifRecord;
  records: AdifRecord[];
}
const MAX_DOCUMENT = 2 * 1024 * 1024;
export function normalizeAdifValue(name: string, value: string): string {
  if (name.toUpperCase() === "NOTES")
    return value.replace(/\r\n|\r|\n/g, "\n").replace(/\n/g, "\r\n");
  if (name.toUpperCase() === "COMMENT" || name.toUpperCase() === "QSLMSG")
    return value.replace(/\s+/g, " ").trim();
  return value;
}
export function serializeAdifRecord(record: AdifRecord): string {
  let result = "";
  for (const [rawName, rawValue] of Object.entries(record)) {
    const name = rawName.toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name === "EOH" || name === "EOR")
      throw new Error("Invalid ADIF field name");
    const value = normalizeAdifValue(name, rawValue);
    if (
      /[^\x20-\x7e\r\n]/.test(value) ||
      (name !== "NOTES" && /[\r\n]/.test(value))
    )
      throw new Error(`Unsupported ADI encoding in ${name}; ASCII is required`);
    if (value.length > 8192)
      throw new Error(`ADIF field ${name} exceeds 8 KiB`);
    result += `<${name}:${value.length}>${value}`;
    if (result.length > 65536) throw new Error("ADIF record exceeds 64 KiB");
  }
  return `${result}<EOR>`;
}
export function parseAdif(input: string): AdifDocument {
  if (input.length > MAX_DOCUMENT) throw new Error("ADIF document too large");
  const header: AdifRecord = Object.create(null);
  const records: AdifRecord[] = [];
  let record: AdifRecord = Object.create(null);
  let pos = 0;
  let hadHeader = false;
  let sawTag = false;
  while (pos < input.length) {
    const start = input.indexOf("<", pos);
    if (start < 0) break;
    // ADIF 3.1.6 IV.A.6 permits arbitrary text outside counted fields.
    // Advance using each declared length first, so embedded tags in values
    // remain data; malformed tags and missing record terminators still fail.
    const end = input.indexOf(">", start);
    if (end < 0 || end - start > 128) throw new Error("Malformed ADIF tag");
    const tag = input.slice(start + 1, end);
    const upper = tag.toUpperCase();
    sawTag = true;
    pos = end + 1;
    if (upper === "EOH") {
      if (hadHeader || records.length)
        throw new Error("Unexpected ADIF header");
      Object.assign(header, record);
      record = Object.create(null);
      hadHeader = true;
      continue;
    }
    if (upper === "EOR") {
      if (!Object.keys(record).length) throw new Error("Empty ADIF record");
      records.push(record);
      if (records.length > 10000) throw new Error("Too many ADIF records");
      record = Object.create(null);
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*):(\d{1,7})(?::[A-Z])?$/i.exec(tag);
    if (!match) throw new Error("Malformed ADIF field");
    const name = match[1].toUpperCase();
    const length = Number(match[2]);
    if (length > 65536 || pos + length > input.length)
      throw new Error("Truncated or excessive ADIF field");
    if (Object.hasOwn(record, name))
      throw new Error(`Duplicate ADIF field ${name}`);
    record[name] = input.slice(pos, pos + length);
    pos += length;
  }
  if (!sawTag && input.trim()) throw new Error("Not ADIF");
  if (Object.keys(record).length) throw new Error("Unterminated ADIF record");
  return { header, records };
}
