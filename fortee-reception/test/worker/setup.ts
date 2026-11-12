import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// ローカルの D1 に、migrations/ のマイグレーションを適用する（Design Doc 11 章）。
// 適用済みのものは飛ばされるので、テストのファイルごとに呼んでよい
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
