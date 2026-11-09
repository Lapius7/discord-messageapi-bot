import mysql from "mysql2/promise";
import { config } from "./config";

export const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 8,
  // Snowflake は 2^53 を超えるので文字列で受ける
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
  timezone: "Z",
});

export const q = async <T = any>(sql: string, params: any[] = []): Promise<T[]> =>
  (await pool.execute(sql, params))[0] as T[];

export const audit = (actor: string, action: string, channelId?: string) =>
  q("INSERT INTO audit_log (at, actor, action, channel_id) VALUES (UTC_TIMESTAMP(), ?, ?, ?)", [
    actor,
    action,
    channelId ?? null,
  ]);
