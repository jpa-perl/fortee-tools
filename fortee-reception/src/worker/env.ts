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
