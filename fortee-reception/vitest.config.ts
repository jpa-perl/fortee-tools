import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 層ごとに Vitest のプロジェクトを分ける（Design Doc 11 章）。
// core、app、cli は Node.js で、worker だけを Workers の実行環境（workerd）で動かす。

const root = fileURLToPath(new URL(".", import.meta.url));

// D1 のマイグレーションは Node.js の側で読み、バインディングとして Worker のテストに渡す。
// readD1Migrations はパッケージの直下から読み込む（Design Doc 12.1）
const migrations = await readD1Migrations(`${root}migrations`);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          // DOM のモックを入れない（Design Doc 3.2）
          environment: "node",
          include: ["test/core/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "app",
          environment: "node",
          include: ["test/app/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "cli",
          environment: "node",
          include: ["test/cli/**/*.test.ts"],
        },
      },
      {
        test: {
          // 依存の方向と CSS のクラスの lint が、違反を検出することの検査（Design Doc 3.2）
          name: "tooling",
          environment: "node",
          include: ["test/tooling/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            // wrangler.jsonc の最上位（ローカルの開発用。Design Doc 3.6）の設定で動かす
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                // テスト用の値。本番の秘密ではない
                DISCORD_CLIENT_ID: "test-client-id",
                DISCORD_CLIENT_SECRET: "test-client-secret",
                DISCORD_GUILD_ID: "test-guild-id",
                DISCORD_ROLE_IDS: "test-role-1,test-role-2",
                SESSION_SECRET: "test-session-secret-0123456789abcdef",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["test/worker/setup.ts"],
        },
      },
    ],
  },
});
