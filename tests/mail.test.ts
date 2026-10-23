import assert from "node:assert/strict";
import test from "node:test";
import { invitationEmail, verificationEmail } from "../src/mail.ts";

const origin = "https://ferry.n1rwj.com";
// Public fixtures only. Never snapshot a real delivery or verification code.
const fixtureCode = "123456";
const visibleText = (html: string): string =>
  html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("verification contains readable code, expiry and final domain-bound line in both alternatives", () => {
  const content = verificationEmail({
    origin,
    code: fixtureCode,
    purpose: "signup",
  });
  assert.match(content.subject, /123456.*verification code/);
  assert.equal(content.text.split("\n").at(-1), "@ferry.n1rwj.com #123456");
  assert.match(visibleText(content.html), /@ferry\.n1rwj\.com #123456$/);
  assert.match(content.text, /Verification code: 123456/);
  for (const text of [content.text, visibleText(content.html)]) {
    assert.match(text, /original Ferry tab/);
    assert.match(text, /expires in 10 minutes/);
    assert.match(text, /create a passkey next/);
    assert.match(text, /cannot sign you in or recover/);
  }
  assert.match(content.html, /<html lang="en">/);
  assert.match(content.html, /role="presentation"/);
  assert.match(content.html, /<h1\b/);
  assert.match(content.html, /max-width:560px/);
  assert.doesNotMatch(
    content.html,
    /<(?:img|script|iframe|form)\b|https?:\/\//i,
  );
  const nativeMessage: EmailMessageBuilder = {
    to: "fixture@example.test",
    from: { email: "signup@ferry.n1rwj.com", name: "LoFi QSO Ferry" },
    ...content,
  };
  assert.equal(nativeMessage.subject, content.subject);
});

test("email-change copy preserves passkeys and does not describe a new signup", () => {
  const content = verificationEmail({
    origin,
    code: fixtureCode,
    purpose: "email",
  });
  for (const text of [content.text, visibleText(content.html)]) {
    assert.match(text, /new email/);
    assert.match(text, /existing passkeys continue/);
    assert.doesNotMatch(text, /create a passkey next/);
  }
});

test("configured origin exclusively determines binding and invitation URL", () => {
  const content = verificationEmail({
    origin: "https://ferry.example.test:8443/",
    code: "001234",
    purpose: "signup",
  });
  assert.equal(content.text.split("\n").at(-1), "@ferry.example.test #001234");
  const invitation = invitationEmail({
    origin: "https://ferry.example.test:8443",
  });
  assert.match(
    invitation.html,
    /href="https:\/\/ferry\.example\.test:8443\/join"/,
  );
  assert.doesNotMatch(invitation.text, /n1rwj/);
});

test("invalid origin and code inputs fail without echoing their values", () => {
  for (const badOrigin of [
    "javascript:alert(1)",
    "http://ferry.n1rwj.com",
    "https://user:secret@ferry.n1rwj.com",
    "https://ferry.n1rwj.com/join",
    "https://ferry.n1rwj.com?token=secret",
    "https://ferry.n1rwj.com#secret",
    "https://ferry.n1rwj.com./",
    "not an origin",
  ]) {
    assert.throws(() => invitationEmail({ origin: badOrigin }), {
      message: "Email origin must be a configured HTTPS origin",
    });
  }
  for (const code of [
    "12345",
    "1234567",
    "123 456",
    "12<456",
    "12345\n",
    "123456\n",
  ]) {
    assert.throws(
      () => verificationEmail({ origin, code, purpose: "signup" }),
      {
        message: "Verification code must contain six digits",
      },
    );
  }
});

test("invitation has an ordinary join link, no bearer token or code, and explicit single-use onboarding", () => {
  const expiry = Date.UTC(2026, 10, 1, 12, 30);
  const content = invitationEmail({ origin, expiresAt: expiry });
  assert.match(content.html, /href="https:\/\/ferry\.n1rwj\.com\/join"/);
  assert.match(content.text, /Open Ferry: https:\/\/ferry\.n1rwj\.com\/join/);
  for (const text of [content.text, visibleText(content.html)]) {
    assert.match(text, /invited email address/);
    assert.match(text, /separate verification code, then create a passkey/);
    assert.match(text, /2026-11-01 12:30:00 UTC/);
    assert.match(text, /used once and only with the invited email address/);
  }
  assert.doesNotMatch(
    content.text + content.html,
    /[?&](?:token|code|invite)=|#[0-9]{6}|123456/,
  );
  assert.match(
    invitationEmail({ origin }).text,
    /expires seven days after it was issued/,
  );
  assert.throws(() => invitationEmail({ origin, expiresAt: Number.NaN }), {
    message: "Invitation expiry must be a valid timestamp",
  });
});
