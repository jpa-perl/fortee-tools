import type { LogFields } from "./log.ts";

// Worker のバインディングと秘密（Design Doc 3.6、7.5）。
// 名前は wrangler.jsonc と .dev.vars.example に合わせる。
export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;

  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_GUILD_ID: string;
  /** 受付スタッフのロール ID。カンマ区切り */
  DISCORD_ROLE_IDS: string;
  SESSION_SECRET: string;
};

/** すべてのルートに共通の、Hono の環境。log は要求のログの行に足す項目（Design Doc 7.6） */
export type AppEnv = { Bindings: Env; Variables: { log: LogFields } };
