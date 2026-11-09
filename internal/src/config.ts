const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`環境変数 ${k} が未設定です`);
  return v;
};

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // 外部からは直接受け付けない想定。ローカルホストにだけ bind する。
  host: process.env.HOST ?? "127.0.0.1",
  secret: need("INTERNAL_SECRET"),
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  db: {
    host: process.env.DB_HOST ?? "127.0.0.1",
    user: need("DB_USER"),
    password: need("DB_PASSWORD"),
    database: process.env.DB_NAME ?? "discord_messageapi",
  },
  retentionDays: Number(process.env.RETENTION_DAYS ?? 90),
  maxMessagesPerChannel: Number(process.env.MAX_MESSAGES_PER_CHANNEL ?? 200_000),
  maxBytesPerChannel: Number(process.env.MAX_BYTES_PER_CHANNEL ?? 5_000_000_000),
  maxChannelsPerGuild: Number(process.env.MAX_CHANNELS_PER_GUILD ?? 20),
  maxChannelsTotal: Number(process.env.MAX_CHANNELS_TOTAL ?? 1000),
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES ?? 20_000_000),
};
