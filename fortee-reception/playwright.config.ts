import { defineConfig, devices } from "@playwright/test";

// 画面のテスト（Design Doc 11 章）。本番のビルドを Workers の実行環境で配って確かめる。
// データは、テスト用の設定と合成の参加者を、開発の .wrangler/state とは別の場所のローカルの D1 と KV に
// 公開して使う（test/e2e/setup/prepare.ts）。Discord には通信しない。ログインは、テストが、このサーバにだけ
// 渡す秘密で署名したセッションの Cookie を置いて済ませる（test/e2e/helpers.ts）。
// Playwright の WebKit は iOS の Safari そのものではない。ホーム画面アプリの挙動、カメラ、音、
// 画面のスリープは実機で確かめる。

// サーバは 2 つある（test/e2e/setup/data.ts の E2E_ENVIRONMENTS と同じポート）。ふつうの spec は、記録を
// サーバに送らずに MAIN を共有する。サーバへの同期を通す spec（sync.spec.ts）は、記録を送り、公開し直すので、
// 別のデータを持つ SYNC を、1 つのプロジェクトで直列に使う
const PORT = 4173;
const SYNC_PORT = 4174;
const SYNC_SPEC = /sync\.spec\.ts$/;

// デザイン基準幅 390px と、最小対応幅 360px（画面設計書 1.2）
const viewports = { "390": { width: 390, height: 844 }, "360": { width: 360, height: 640 } };

// Chromium では、偽のカメラの映像を流して、読み取り中（S03）の映像のある状態を確かめる。
// WebKit は、テストではカメラを開始できない。カメラの使用が拒否された端末の流れ（FR-27）を通すことになる
const fakeCamera = {
  permissions: ["camera"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
};

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
    { name: "chromium-390", testIgnore: SYNC_SPEC, use: { ...devices["Desktop Chrome"], viewport: viewports["390"], ...fakeCamera } },
    { name: "chromium-360", testIgnore: SYNC_SPEC, use: { ...devices["Desktop Chrome"], viewport: viewports["360"], ...fakeCamera } },
    { name: "webkit-390", testIgnore: SYNC_SPEC, use: { ...devices["Desktop Safari"], viewport: viewports["390"] } },
    { name: "webkit-360", testIgnore: SYNC_SPEC, use: { ...devices["Desktop Safari"], viewport: viewports["360"] } },
    {
      // アプリ、Worker、別の端末、CLI の書き出しを通す（PRD の AC-1 のローカル版）。Chromium だけで、直列に走らせる
      name: "sync-chromium",
      testMatch: SYNC_SPEC,
      fullyParallel: false,
      use: {
        ...devices["Desktop Chrome"],
        viewport: viewports["390"],
        ...fakeCamera,
        baseURL: `http://localhost:${SYNC_PORT}`,
      },
    },
  ],
  webServer: {
    // データを公開し直してから、ビルドして、ビルドした Worker と静的アセットを、2 つのポートで配る。
    // serve.ts は、MAIN のサーバが応えてから SYNC のサーバを起動する。SYNC が応えるのを待てば、両方が応えている
    command: "node test/e2e/setup/serve.ts",
    url: `http://localhost:${SYNC_PORT}`,
    // 別のデータや別の秘密で動いているサーバを、拾わない
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
