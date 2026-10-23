/** Authority follows the current verified account, never a browser claim. */
export async function isAdmin(env: Env, tenant: string): Promise<boolean> {
  return !!(await env.DB.prepare(
    "SELECT 1 FROM accounts WHERE id=? AND email='me@rwjblue.com' AND status='active' AND verified_at IS NOT NULL",
  )
    .bind(tenant)
    .first());
}
