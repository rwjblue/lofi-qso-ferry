import { canonical, randomToken } from "./security.ts";
import type { Store } from "./store.ts";
import {
  DEFAULT_COMMENT_TEMPLATE,
  TEMPLATE_PROFILE,
  type TemplateVersion,
  validateTemplateVersion,
} from "./templates.ts";

/** A default is a preference for new destinations, never a historical binding. */
export async function defaultTemplate(
  store: Store,
  tenant: string,
): Promise<TemplateVersion> {
  const saved = await store
    .statement(
      "SELECT t.id,t.config FROM active_account_templates a JOIN account_templates t ON t.tenant=a.tenant AND t.id=a.version WHERE a.tenant=?",
      tenant,
    )
    .first<{ id: string; config: string }>();
  if (!saved)
    return {
      id: "builtin-default",
      profile: TEMPLATE_PROFILE,
      fields: { COMMENT: DEFAULT_COMMENT_TEMPLATE },
      fallbackNotes: false,
    };
  const version = JSON.parse(saved.config) as TemplateVersion;
  validateTemplateVersion(version);
  return { ...version, id: saved.id };
}

export async function saveDefaultTemplate(
  store: Store,
  tenant: string,
  version: TemplateVersion,
): Promise<string> {
  validateTemplateVersion(version);
  const id = randomToken();
  await store.db.batch([
    store.statement(
      "INSERT INTO account_templates(tenant,id,config,created_at) VALUES(?,?,?,?)",
      tenant,
      id,
      canonical({ ...version, id }),
      Date.now(),
    ),
    store.statement(
      "INSERT INTO active_account_templates(tenant,version) VALUES(?,?) ON CONFLICT(tenant) DO UPDATE SET version=excluded.version",
      tenant,
      id,
    ),
  ]);
  return id;
}

export async function destinationTemplates(
  store: Store,
  tenant: string,
): Promise<(TemplateVersion & { destination: string })[]> {
  const rows = (
    await store
      .statement(
        "SELECT t.id,t.destination,t.config FROM active_templates a JOIN templates t ON t.tenant=a.tenant AND t.destination=a.destination AND t.id=a.version JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination AND c.kind='qrz' WHERE a.tenant=?",
        tenant,
      )
      .all<{ id: string; destination: string; config: string }>()
  ).results;
  return rows.map((row) => ({
    ...(JSON.parse(row.config) as TemplateVersion),
    id: row.id,
    destination: row.destination,
  }));
}
