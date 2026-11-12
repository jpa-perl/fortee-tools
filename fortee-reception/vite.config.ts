import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { appShell } from "./build/app-shell.ts";

// 受付アプリ、Service Worker、Worker を 1 つのプロジェクトでビルドする（Design Doc 3.5）。
// 開発サーバも、同じオリジンから静的アセットと /auth/、/api/ を返す。
// どのカンファレンスの環境に向けてビルドするかは、CLI の deploy が環境変数で渡す（Design Doc 8.1）。
// 手で vite build と wrangler deploy を分けて実行しない。
export default defineConfig({
  plugins: [preact(), tailwindcss(), cloudflare(), appShell()],
  server: {
    // Discord のリダイレクト URI に登録するポート（dev-setup 4.1）。ほかのポートに逃がさない
    port: 5173,
    strictPort: true,
  },
});
