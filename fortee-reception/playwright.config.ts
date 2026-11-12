import { defineConfig, devices } from "@playwright/test";

// 画面のテスト（Design Doc 11 章）。本番のビルドを Workers の実行環境で配って確かめる。
// Playwright の WebKit は iOS の Safari そのものではない。ホーム画面アプリの挙動、カメラ、音、
// 画面のスリープは実機で確かめる。

const PORT = 4173;

// デザイン基準幅 390px と、最小対応幅 360px（画面設計書 1.2）
const viewports = { "390": { width: 390, height: 844 }, "360": { width: 360, height: 640 } };

export default defineConfig({
  testDir: "test/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "ja-JP",
    // Service Worker を確かめるので、止めない
    serviceWorkers: "allow",
  },
  projects: [
    { name: "chromium-390", use: { ...devices["Desktop Chrome"], viewport: viewports["390"] } },
    { name: "chromium-360", use: { ...devices["Desktop Chrome"], viewport: viewports["360"] } },
    { name: "webkit-390", use: { ...devices["Desktop Safari"], viewport: viewports["390"] } },
    { name: "webkit-360", use: { ...devices["Desktop Safari"], viewport: viewports["360"] } },
  ],
  webServer: {
    // ローカルの開発の設定（config/local.toml）でビルドし、ビルドした Worker と静的アセットを配る
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
