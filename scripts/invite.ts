import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeEmail } from "../src/auth.ts";
import { invitationEmail } from "../src/mail.ts";

const sevenDays = 7 * 86_400_000;
export function invitationSql(
  address: string,
  now: number,
  sendId = crypto.randomUUID(),
): string {
  const email = normalizeEmail(address).replaceAll("'", "''");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid time");
  if (!/^[a-f0-9-]{36}$/.test(sendId)) throw new Error("Invalid send ID");
  return `INSERT INTO invitations(email,invited_at,expires_at,last_sent_at,mail_status,send_id,action_id)
SELECT '${email}',${now},${now + sevenDays},${now},'sending','${sendId}','${sendId}'
WHERE NOT EXISTS(SELECT 1 FROM accounts WHERE email='${email}')
ON CONFLICT(email) DO UPDATE SET invited_at=excluded.invited_at,expires_at=excluded.expires_at,revoked_at=NULL,last_sent_at=excluded.last_sent_at,mail_status='sending',send_id=excluded.send_id,action_id=excluded.action_id
WHERE invitations.claimed_at IS NULL
AND (invitations.last_sent_at IS NULL OR invitations.last_sent_at<=${now - 60_000})
AND (invitations.mail_status NOT IN ('sending','uncertain') OR invitations.expires_at<=${now})
RETURNING email,expires_at;`;
}
type Runner = (args: string[]) => string | Promise<string>;
function wrangler(args: string[]): string {
  const result = spawnSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    { encoding: "utf8", maxBuffer: 2_000_000 },
  );
  // Provider diagnostics may contain recipient/content details. Keep them out
  // of normal task output; never print configured credentials or environment.
  if (result.error || result.status !== 0)
    throw new Error(
      "Wrangler operation failed. Check Cloudflare login and permissions; no automatic retry was made.",
    );
  if (/Permanently bounced:/i.test(`${result.stdout}\n${result.stderr}`))
    throw new Error("Cloudflare rejected the recipient");
  return result.stdout;
}
export async function invite(
  address: string,
  dryRun = false,
  run: Runner = wrangler,
): Promise<string> {
  const email = normalizeEmail(address);
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const production = config.env.production;
  const origin = new URL(production.vars.ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== production.vars.ORIGIN ||
    origin.hostname !== production.vars.RP_ID ||
    origin.hostname.endsWith(".invalid")
  )
    throw new Error("Configure the permanent production origin first");
  const database = production.d1_databases.find(
    (binding: { binding: string }) => binding.binding === "DB",
  );
  if (!database || database.database_id.startsWith("00000000-"))
    throw new Error("Configure the dedicated production database first");
  const from = /^(.*?)\s*<([^<>]+)>$/.exec(production.vars.MAIL_FROM);
  const sender = normalizeEmail(from?.[2] ?? production.vars.MAIL_FROM);
  if (
    !production.send_email?.some(
      (binding: { name: string; allowed_sender_addresses?: string[] }) =>
        binding.name === "EMAIL" &&
        binding.allowed_sender_addresses?.includes(sender),
    )
  )
    throw new Error("Configure the restricted production email sender first");
  const now = Date.now();
  const sendId = crypto.randomUUID();
  const message = invitationEmail({
    origin: origin.origin,
    expiresAt: now + sevenDays,
  });
  if (dryRun) {
    const directory = resolve(".wrangler/invite-preview");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const preview = join(directory, "invitation.html");
    await writeFile(preview, message.html, { mode: 0o600 });
    return `Preview: ${preview}. No invitation was granted and no email was sent.`;
  }
  // D1 --file uses bulk import, whose result is an import summary rather
  // than RETURNING rows. Use the query endpoint and verify the exact grant.
  const output = await run([
    "d1",
    "execute",
    database.database_name,
    "--env",
    "production",
    "--remote",
    "--yes",
    "--json",
    "--command",
    invitationSql(email, now, sendId),
  ]);
  const results = JSON.parse(output) as {
    success?: boolean;
    results?: { email?: string; expires_at?: number }[];
  }[];
  if (
    !Array.isArray(results) ||
    results.length !== 1 ||
    results[0].success !== true ||
    results[0].results?.length !== 1 ||
    results[0].results[0].email !== email ||
    results[0].results[0].expires_at !== now + sevenDays
  )
    throw new Error(
      "No invitation created: the address already has an account or a claimed invitation, was sent an invitation within 60 seconds, or has an uncertain send. Review the admin invitation list; revoke an uncertain invitation before intentionally sending another.",
    );
  let accepted = false;
  try {
    await run([
      "email",
      "sending",
      "send",
      "--env",
      "production",
      `--from=${sender}`,
      `--from-name=${from?.[1] ?? "LoFi QSO Ferry"}`,
      `--to=${email}`,
      `--subject=${message.subject}`,
      `--text=${message.text}`,
      `--html=${message.html}`,
    ]);
    accepted = true;
  } catch {
    // Persist ambiguity below; neither a rerun nor the admin UI should blindly
    // retry a grant whose provider acknowledgement may have been lost.
  }
  const status = accepted ? "accepted" : "uncertain";
  let recorded: {
    success?: boolean;
    results?: {
      mail_status: string;
      revoked_at: number | null;
      claimed_at: number | null;
    }[];
  }[];
  try {
    recorded = JSON.parse(
      await run([
        "d1",
        "execute",
        database.database_name,
        "--env",
        "production",
        "--remote",
        "--yes",
        "--json",
        "--command",
        `UPDATE invitations SET mail_status='${status}' WHERE send_id='${sendId}' RETURNING mail_status,revoked_at,claimed_at;`,
      ]),
    );
  } catch {
    throw new Error(
      "The email attempt finished, but its status could not be recorded. Do not resend automatically; check the admin invitation list and the recipient first.",
    );
  }
  const saved = recorded?.[0]?.results?.[0];
  if (
    recorded?.length !== 1 ||
    !recorded[0].success ||
    recorded[0].results?.length !== 1 ||
    saved?.mail_status !== status
  )
    throw new Error(
      "Invitation changed while sending. Review the admin invitation list; do not resend automatically.",
    );
  if (!accepted)
    throw new Error(
      `${saved.revoked_at !== null ? "The invitation was revoked" : saved.claimed_at !== null ? "The invitation was claimed" : "The invitation is active"}, but email was rejected or delivery is uncertain. Do not resend automatically. Check the recipient, or revoke a pending invitation in admin before intentionally sending another after the 60-second cooldown.`,
    );
  if (saved.revoked_at !== null)
    return "Email accepted by Cloudflare, but the invitation was revoked while sending and can no longer be used. Inbox delivery is not confirmed.";
  return `Invited ${email}. Valid for seven days at ${origin.origin}/join. Email accepted by Cloudflare; inbox delivery is not confirmed.`;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(
      await invite(
        process.env.usage_email ?? "",
        process.env.usage_dry_run === "true",
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invitation failed");
    process.exitCode = 1;
  }
}
