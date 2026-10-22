import test from "node:test";
import assert from "node:assert/strict";
import { parseAdif, serializeAdifRecord } from "../src/adif.ts";
test("ADIF framing handles literal markup and length-correct CRLF normalization", () => {
  const result = serializeAdifRecord({
    CALL: "W1AW",
    NOTES: "First\nSecond <EOR> & +",
    COMMENT: "  a\n b ",
    QSLMSG: "Thanks\r\n73",
  });
  const parsed = parseAdif(result).records[0]!;
  assert.equal(parsed.NOTES, "First\r\nSecond <EOR> & +");
  assert.equal(parsed.COMMENT, "a b");
  assert.equal(parsed.QSLMSG, "Thanks 73");
  assert.match(result, /<COMMENT:3>a b/);
});
test("ADIF preserves header metadata and time precision", () => {
  const value = parseAdif(
    "Synthetic fixture\n<ADIF_VER:5>3.1.6<APP_LOTW_NUMREC:1>1<EOH><TIME_ON:4>1200<EOR>",
  );
  assert.equal(value.header.APP_LOTW_NUMREC, "1");
  assert.equal(value.records[0]!.TIME_ON, "1200");
});
test("malformed, truncated and unsupported ADI data fails clearly", () => {
  for (const invalid of [
    "<CALL:9>W1AW<EOR>",
    "<CALL:4>W1AW",
    "<CALL:1>A<CALL:1>B<EOR>",
    "<html>bad</html>",
    "<EOR>",
  ])
    assert.throws(() => parseAdif(invalid));
  assert.throws(() => serializeAdifRecord({ NOTES: "Café" }), /ASCII/);
  assert.throws(() => serializeAdifRecord({ CALL: "bad\nline" }));
});
test("ADIF ignores documented outside-field annotations without scanning counted values as tags", () => {
  const input =
    "Synthetic vendor report\n<PROGRAMID:4>LoTW\nHeader annotation\n<EOH>\nRecord annotation\n<CALL:4>W1AW\nUncounted diagnostic line\n<NOTES:17>literal <EOR> tag\n<eor>\nEnd annotation";
  const parsed = parseAdif(input);
  assert.equal(parsed.header.PROGRAMID, "LoTW");
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]!.CALL, "W1AW");
  assert.equal(parsed.records[0]!.NOTES, "literal <EOR> tag");
  assert.throws(() =>
    parseAdif("<CALL:4>W1AW\nAnnotation but missing record terminator"),
  );
  assert.throws(() => parseAdif("<CALL:4>W1AW\n<html>error</html><EOR>"));
});
