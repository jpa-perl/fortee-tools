import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page, webkit } from "@playwright/test";
import qrcode from "qrcode-generator";
import { importZip } from "../../src/cli/commands/import.ts";
import { migrate } from "../../src/cli/commands/migrate.ts";
import { publish } from "../../src/cli/commands/publish.ts";
import { readConfigFile } from "../../src/cli/config-file.ts";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";
import type { Target } from "../../src/cli/target.ts";
import { configureJapaneseMessages } from "../../src/core/messages.ts";
import { type SyntheticEvent, syntheticZipParts, ticketTokenOf, toZip } from "../cli/synthetic-zip.ts";
import { addSessionCookie, settle } from "../e2e/helpers.ts";
import { E2E_SESSION_SECRET } from "../e2e/setup/data.ts";

// 利用者向けドキュメント（docs/user-guide/）のスクリーンショットを撮り直す。
//
//   node test/guide/capture.ts
//
// 画面のテスト（test/e2e/）と同じ仕組みで、ローカルの Worker に受付アプリを配り、Playwright で操作して撮る。
// 違うのは次の 3 つである。
//
// - 設定は config/yapc-tokyo-2026.toml を使う（公開先の環境名だけを local に替えた写しを作る）。
//   どのカンファレンスの環境にも接続しない。データは .wrangler/guide/ に置き、開発と画面のテストのデータには触れない
// - 参加者は、このファイルの合成の参加者である。実在の参加者の情報は使わない
// - ブラウザの時計を、本編受付の期間の中（2026-11-28 の朝）に合わせる。いつ撮っても、同じ受付と時刻になる
//
// ふだんのテスト（npm test、npm run test:e2e）と CI では走らない。画面を変えたときに、手で実行する。
// 画面のテストと同じ dist/ にビルドするので、画面のテストと同時には走らせない

const PORT = 4175;
const BASE_URL = `http://localhost:${PORT}`;
const DIR = join(PROJECT_ROOT, ".wrangler", "guide");
const OUT = join(PROJECT_ROOT, "docs", "user-guide", "images");
const SOURCE_CONFIG = join(PROJECT_ROOT, "config", "yapc-tokyo-2026.toml");
const CONFIG = join(DIR, "config.toml");
const VIDEO = join(DIR, "camera.y4m");
const TARGET: Target = { env: "local", local: true, configPath: CONFIG, workDir: join(DIR, "work"), persistTo: join(DIR, "state") };

/** 撮影のときの時刻。本編受付の 1 日目の期間（09:00〜12:00）の中 */
const NOW = new Date("2026-11-28T09:12:00+09:00");
/** データの取り込み日時。受付の前日の夜 */
const IMPORTED_AT = Date.parse("2026-11-27T21:00:00+09:00");

const OPERATOR = { sub: "123456789012345678", name: "受付スタッフ A" };
const VIEWPORT = { width: 390, height: 720 };

// 合成の参加者。名前は作ったもので、実在の参加者ではない。種別名とフォーム項目名は、設定ファイルのものに合わせる
const SLUG = "yapc-tokyo-2026";
const GENERAL = "【カンファレンス本編】一般チケット";
const SPEAKER = "【カンファレンス本編】スピーカーチケット";
const EVE = "【前夜祭】前夜祭チケット";
const PARTY = "【懇親会】懇親会チケット";
const TSHIRT = "Tシャツのサイズ";
const SPEAKER_NAME = "スピーカー名札に記載するお名前";

const EVENTS = {
  main: {
    slug: SLUG,
    seed: "guide-main",
    formFields: [TSHIRT, SPEAKER_NAME],
    attendees: [
      { ticketType: GENERAL, ticketNo: "A-101", userName: "camel-taro", issued: "2026/10/01 12:00", name: "らくだ 太郎", answers: { [TSHIRT]: "M" } },
      { ticketType: GENERAL, ticketNo: "A-102", userName: "perl-hanako", issued: "2026/10/01 12:05", name: "ぱーる 花子", answers: { [TSHIRT]: "S" } },
      { ticketType: GENERAL, ticketNo: "A-103", userName: "camel-yuki", issued: "2026/10/02 09:00", name: "らくだ ゆき", answers: { [TSHIRT]: "L" } },
      { ticketType: GENERAL, ticketNo: "A-104", userName: "raku-saburo", issued: "2026/10/02 10:00", name: "らく 三郎", answers: { [TSHIRT]: "M" } },
      { ticketType: SPEAKER, ticketNo: "S-7", userName: "onion-jiro", issued: "2026/10/03 18:00", name: "たまねぎ 次郎", answers: { [TSHIRT]: "L", [SPEAKER_NAME]: "onion" } },
    ],
  },
  eve: {
    slug: SLUG,
    seed: "guide-eve",
    formFields: [],
    attendees: [{ ticketType: EVE, ticketNo: "E-21", userName: "camel-taro", issued: "2026/10/01 12:01", name: "らくだ 太郎" }],
  },
  party: {
    slug: SLUG,
    seed: "guide-party",
    formFields: [],
    attendees: [
      { ticketType: PARTY, ticketNo: "P-11", userName: "camel-taro", issued: "2026/10/01 12:02", name: "らくだ 太郎" },
      // 懇親会のチケットだけを持つ。本編受付で読み取ると、切替提案になる
      { ticketType: PARTY, ticketNo: "P-12", userName: "llama-shiro", issued: "2026/10/05 20:00", name: "りゃま 四郎" },
    ],
  },
  nursery: {
    slug: SLUG,
    seed: "guide-nursery",
    formFields: [],
    attendees: [{ ticketType: "託児所利用チケット", ticketNo: "N-1", userName: "alpaca-go", issued: "2026/10/06 08:00", name: "あるぱか 五郎" }],
  },
} as const satisfies Record<string, SyntheticEvent>;

type EventKey = keyof typeof EVENTS;
const qr = (event: EventKey, ticketNo: string): string => `fortee:${ticketTokenOf(EVENTS[event], ticketNo)}`;

const bin = (name: string): string => join(PROJECT_ROOT, "node_modules", ".bin", name);
const silent = (): void => {};

/** 設定の写しを作り、合成の参加者を取り込んで公開する。毎回、空から作る */
async function prepare(): Promise<void> {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(join(DIR, "zips"), { recursive: true });
  const source = await readFile(SOURCE_CONFIG, "utf8");
  const local = source.replace('environment = "yapc-tokyo-2026"', 'environment = "local"');
  if (local === source) throw new Error("設定ファイルの environment を書き換えられなかった");
  await writeFile(CONFIG, local);

  configureJapaneseMessages();
  const deps = { now: () => IMPORTED_AT, log: silent, warn: silent };
  await migrate(TARGET, silent);
  const config = await readConfigFile(CONFIG, "local");
  for (const key of Object.keys(EVENTS) as EventKey[]) {
    const zip = join(DIR, "zips", `${key}.zip`);
    await writeFile(zip, toZip(syntheticZipParts(EVENTS[key])));
    await importZip(TARGET, config, { event: key, zip }, deps);
  }
  await publish(TARGET, config, deps);
}

/**
 * 偽のカメラに流す映像（1 コマの Y4M）を作る。机の上のスマートフォンに QR が出ている絵にする。
 * QR の中身はチケットではないので、受付アプリは判定に進まず、読み取り中（S03）のまま撮れる
 */
async function writeCameraVideo(): Promise<void> {
  const width = 640;
  const height = 480;
  const code = qrcode(0, "M");
  code.addData("https://example.com/guide");
  code.make();
  const count = code.getModuleCount();
  const cell = 6;
  const size = count * cell;
  const left = Math.floor((width - size) / 2);
  const top = Math.floor((height - size) / 2);
  const luma = new Uint8Array(width * height).fill(96);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // スマートフォンの枠（黒）と、その画面（白）
      const inBody = Math.abs(x - width / 2) < size / 2 + 40 && Math.abs(y - height / 2) < size / 2 + 76;
      const inScreen = Math.abs(x - width / 2) < size / 2 + 30 && Math.abs(y - height / 2) < size / 2 + 66;
      if (inBody) luma[y * width + x] = inScreen ? 235 : 24;
      const row = Math.floor((y - top) / cell);
      const col = Math.floor((x - left) / cell);
      if (row >= 0 && row < count && col >= 0 && col < count && code.isDark(row, col)) luma[y * width + x] = 16;
    }
  }
  const chroma = new Uint8Array((width * height) / 2).fill(128);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\nFRAME\n`);
  await writeFile(VIDEO, Buffer.concat([header, luma, chroma]));
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const ok = await fetch(`${BASE_URL}/`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`ポート ${PORT} のサーバが応えない`);
}

function startServer(): ChildProcess {
  return spawn(
    bin("wrangler"),
    [
      "dev",
      "--config",
      join(PROJECT_ROOT, "dist", "checkin_local", "wrangler.json"),
      "--persist-to",
      TARGET.persistTo ?? "",
      "--port",
      String(PORT),
      "--inspector-port",
      "9341",
      "--var",
      `SESSION_SECRET:${E2E_SESSION_SECRET}`,
      "--show-interactive-dev-session=false",
    ],
    { cwd: PROJECT_ROOT, stdio: "inherit" },
  );
}

async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`撮った: ${name}`);
}

const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });
const dialog = (page: Page) => page.getByRole("dialog");
const resultTitle = (page: Page) => page.getByRole("heading", { level: 1 });

async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, locale: "ja-JP", baseURL: BASE_URL, ...options });
  // 時計は止めない。確認の確定ボタンの 0.5 秒や、バナーの 2 秒は、ふつうに進む
  await context.clock.install({ time: NOW });
  // 端末のデータの保持（navigator.storage.persist()）が認められた端末として撮る。認められないと、メニューに
  // 注意の文が出る。撮影用のブラウザでは認められないが、スタッフの端末では、ホーム画面に追加したアプリで
  // 認められる見込みである（画面設計書 6.1）
  await context.addInitScript(() => {
    navigator.storage.persist = () => Promise.resolve(true);
    navigator.storage.persisted = () => Promise.resolve(true);
  });
  return context;
}

async function login(page: Page): Promise<void> {
  await addSessionCookie(page.context(), BASE_URL, OPERATOR);
  await page.goto("/?login=ok");
  await button(page, "QR コード読み取り").waitFor();
  await page.getByRole("img", { name: "同期済み" }).first().waitFor();
}

/** 読み取り中（S03）にして、QR の文字列を、いま読み取ったものとして渡す */
async function scan(page: Page, text: string): Promise<void> {
  if (await button(page, "QR コード読み取り").isVisible()) await button(page, "QR コード読み取り").click();
  await button(page, "終了").waitFor();
  await page.evaluate((value) => window.__checkinTest?.scan(value), text);
}

/** 読み取って、確認で「続ける」を押し、結果を出す */
async function checkin(page: Page, text: string): Promise<void> {
  await scan(page, text);
  await dialog(page).getByRole("button", { name: "続ける" }).click();
  await resultTitle(page).waitFor();
}

/** iOS の Safari のタブで開いたときの案内（S00） */
async function captureAddToHome(): Promise<void> {
  const browser = await webkit.launch();
  const context = await newContext(browser, {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByText("ホーム画面に追加して開いてください").waitFor();
  await shot(page, "setup-add-to-home");
  await browser.close();
}

/** カメラを使えないときの読み取り中（S03）。Playwright の WebKit は、カメラを開始できない */
async function captureCameraDenied(): Promise<void> {
  const browser = await webkit.launch();
  const page = await (await newContext(browser)).newPage();
  await login(page);
  await button(page, "QR コード読み取り").click();
  await page.getByText("カメラを使えません").waitFor();
  await shot(page, "trouble-camera");
  await browser.close();
}

async function captureMain(): Promise<void> {
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${VIDEO}`],
  });
  const context = await newContext(browser, { permissions: ["camera"] });
  const page = await context.newPage();

  // 準備: ログイン、ホーム、メニュー
  await page.goto("/");
  await button(page, "Discord でログイン").waitFor();
  await shot(page, "setup-login");
  await login(page);
  await shot(page, "home");
  await button(page, "メニュー").click();
  await button(page, "ログアウト").waitFor();
  await shot(page, "setup-menu");
  await button(page, "戻る").click();

  // 受付: 読み取り、確認、結果、参考情報
  await button(page, "QR コード読み取り").click();
  await page.getByText("チケットの QR ではありません").waitFor();
  await shot(page, "trouble-not-ticket");
  await page.getByText("チケットの QR ではありません").waitFor({ state: "hidden" });
  await shot(page, "checkin-scan");
  await scan(page, qr("main", "A-102"));
  await dialog(page).getByText("この人の受付を続けますか？").waitFor();
  await shot(page, "checkin-confirm");
  await dialog(page).getByRole("button", { name: "続ける" }).click();
  await resultTitle(page).waitFor();
  await shot(page, "checkin-success");
  await button(page, "参考情報").click();
  await shot(page, "checkin-reference");
  await button(page, "閉じる").click();
  await button(page, "次へ").click();

  // もう 1 人受け付けて、直近の記録を 2 件にする
  await checkin(page, qr("main", "S-7"));
  await button(page, "次へ").click();

  // 黄と赤の結果
  await page.waitForTimeout(3200);
  await scan(page, qr("main", "A-102"));
  await resultTitle(page).waitFor();
  await shot(page, "result-done");
  await button(page, "次へ").click();
  await scan(page, qr("party", "P-12"));
  await resultTitle(page).waitFor();
  await shot(page, "result-other-reception");
  await button(page, "切り替えずに次へ").click();
  await scan(page, qr("nursery", "N-1"));
  await resultTitle(page).waitFor();
  await shot(page, "result-out-of-scope");
  await button(page, "次へ").click();
  await scan(page, `fortee:${"0".repeat(32)}`);
  await resultTitle(page).waitFor();
  await shot(page, "result-not-found");
  await button(page, "次へ").click();

  // 検索からのチェックイン
  await button(page, "検索").click();
  await page.getByRole("textbox", { name: "検索" }).fill("camel");
  await button(page, /camel-taro/).waitFor();
  await shot(page, "search-results");
  await button(page, /camel-taro/).click();
  await button(page, "検索からチェックイン").waitFor();
  await shot(page, "search-detail");
  await button(page, "検索からチェックイン").click();
  // 確定ボタンは、開いてから 0.5 秒間は押せない。押せるようになってから撮る
  await page.waitForTimeout(600);
  await shot(page, "search-confirm");
  await button(page, "チェックイン").click();
  await resultTitle(page).waitFor();
  await shot(page, "search-success");
  await button(page, "次へ").click();
  await button(page, "終了").click();

  // 取り消し
  await page.getByText("直近の記録").waitFor();
  await page.getByRole("img", { name: "同期済み" }).first().waitFor();
  await shot(page, "undo-home");
  await button(page, /camel-taro/).click();
  await button(page, "取り消す").waitFor();
  await shot(page, "undo-record");
  await button(page, "取り消す").click();
  await page.getByRole("radio", { name: "誤操作" }).check();
  await shot(page, "undo-confirm");
  await page.waitForTimeout(600);
  await button(page, "取り消す").last().click();
  await page.getByText("取り消しました").waitFor();
  await shot(page, "undo-done");
  await page.getByText("取り消しました").waitFor({ state: "hidden" });
  await button(page, "戻る").click();

  // リハーサルモード
  await button(page, "メニュー").click();
  await page.getByRole("switch", { name: "リハーサルモード", exact: true }).click();
  await page.waitForTimeout(600);
  await dialog(page).getByRole("button", { name: "切り替える" }).click();
  await button(page, "戻る").click();
  await button(page, "QR コード読み取り").waitFor();
  await shot(page, "rehearsal-home");

  await browser.close();
}

await prepare();
await writeCameraVideo();
execFileSync(bin("vite"), ["build"], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  env: { ...process.env, CHECKIN_CONFIG: CONFIG, CHECKIN_TEST_HOOK: "1" },
});
await mkdir(OUT, { recursive: true });

const server = startServer();
try {
  await waitForServer();
  await captureAddToHome();
  await captureMain();
  await captureCameraDenied();
} finally {
  server.kill("SIGTERM");
}
