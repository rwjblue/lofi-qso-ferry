import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMMENT_TEMPLATE,
  POTA_TEMPLATE,
  renderNarrative,
  renderTemplate,
  TEMPLATE_PROFILE,
} from "../src/templates.ts";

const context = {
  op: {
    refs: [
      { type: "potaActivation", ref: "US-1234" },
      { type: "potaActivation", ref: "US-5678" },
    ],
  },
  qso: { refs: [{ type: "pota", ref: "US-9999" }], notes: "First\nsecond" },
  now: "2026-10-22T12:34:56Z",
};
test("default comment combines effective reference labels and notes without empty separators", () => {
  assert.equal(
    DEFAULT_COMMENT_TEMPLATE,
    '{% assign refs = op.refs | refLabels | join: ", " %}{{ refs }}{% if qso.notes != blank %}{% if refs != blank %} | {% endif %}{{ qso.notes }}{% endif %}',
  );
  for (const [refs, notes, expected] of [
    [
      [
        { shortLabel: "POTA US-1234", ref: "US-1234" },
        { label: "Summit W1/AA-001", ref: "W1/AA-001" },
      ],
      "Nice contact",
      "POTA US-1234, Summit W1/AA-001 | Nice contact",
    ],
    [[{ ref: "US-1234" }], "", "US-1234"],
    [[], "Nice contact", "Nice contact"],
    [[], "   ", ""],
  ] as const)
    assert.equal(
      renderTemplate(DEFAULT_COMMENT_TEMPLATE, {
        op: { refs: [...refs] },
        qso: { notes },
      }),
      expected,
    );
  assert.equal(renderTemplate(DEFAULT_COMMENT_TEMPLATE, {}), "");
});
test("POTA example names operator parks with HaLo helper semantics", () => {
  assert.equal(
    renderTemplate(POTA_TEMPLATE, context),
    "POTA US-1234 & US-5678",
  );
  assert.equal(renderTemplate(POTA_TEMPLATE, { op: { refs: [] } }), "");
});
test("Liquid values preserve empty-string truthiness, blank and UTC dates", () => {
  assert.equal(
    renderTemplate("{% if qso.notes %}yes{% endif %}", { qso: { notes: "" } }),
    "yes",
  );
  assert.equal(
    renderTemplate("{% if qso.notes == blank %}empty{% endif %}", {
      qso: { notes: "" },
    }),
    "empty",
  );
  assert.equal(
    renderTemplate('{{ now | date: "%Y%m%d %H%M%S" }}', context),
    "20261022 123456",
  );
  assert.equal(renderTemplate("{{ 9 | pad: 3 | cut }}", {}), "TTN");
});
test("narrative normalization follows pinned profile and fallback settings", () => {
  const rendered = renderNarrative(
    {
      id: "v1",
      profile: TEMPLATE_PROFILE,
      fields: { COMMENT: "  {{ qso.notes }}  ", QSLMSG: "Thanks\n73" },
      fallbackNotes: true,
    },
    context,
  );
  assert.equal(rendered.COMMENT, "First second");
  assert.equal(rendered.NOTES, "First\r\nsecond");
  assert.equal(rendered.QSLMSG, "Thanks 73");
});
test("resource bounds apply with fixed clocks, nested loops and expensive filters", () => {
  assert.throws(
    () => renderTemplate("{% for a in (1..1001) %}x{% endfor %}", {}),
    /range/,
  );
  assert.throws(
    () =>
      renderTemplate(
        "{% for a in (1..40) %}{% for b in (1..40) %}x{% endfor %}{% endfor %}",
        {},
      ),
    /iteration/,
  );
  assert.throws(() => renderTemplate("x".repeat(8193), {}), /8 KiB/);
  assert.throws(
    () => renderTemplate('{{ "x" | pad: 999999999 }}', {}),
    /width/,
  );
  assert.throws(
    () => renderTemplate('{% include "secrets" %}', {}),
    /Unsupported/,
  );
  assert.throws(
    () => renderTemplate("{{ qso.constructor }}", context),
    /Unsafe/,
  );
  assert.throws(
    () =>
      renderTemplate("{% if true %}".repeat(17) + "{% endif %}".repeat(17), {}),
    /nesting/,
  );
});
test("same durable inputs and now snapshot give stable retry payloads", () => {
  const template = '{{ qso.notes }} {{ now | date: "%H:%M" }}';
  assert.equal(
    renderTemplate(template, context),
    renderTemplate(template, context),
  );
});
