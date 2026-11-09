import { config } from "./config";
import { q, audit } from "./db";
import { removeMessageFiles } from "./storage";

/** 保存時刻から retentionDays を過ぎた本文・画像・行を削除する。 */
export async function purgeExpired() {
  const rows = await q<{ id: string; channel_id: string }>(
    "SELECT id, channel_id FROM messages WHERE stored_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) LIMIT 5000",
    [config.retentionDays],
  );
  for (const r of rows) {
    await removeMessageFiles(r.channel_id, r.id);
    await q("DELETE FROM messages WHERE id = ?", [r.id]);
  }
  await q("DELETE FROM api_keys WHERE (expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)) OR (revoked_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY))");
  await q("DELETE FROM audit_log WHERE at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 365 DAY)");
  if (rows.length) await audit("system", `purged_${rows.length}`);
  return { purged: rows.length };
}
