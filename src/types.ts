export interface Env {
  INTERNAL_URL: string;
  CRON_SUBREQUESTS?: string;
  ADMIN_USER_ID: string;
  KEY_TTL_DAYS: string;
  RECONCILE_DAYS: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  INTERNAL_SECRET: string;
  KEY_LIMITER: RateLimit;
  IP_LIMITER: RateLimit;
}
interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
