import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Page, type TestInfo } from "@playwright/test";
import { E2E_SESSION_SECRET } from "./setup/data.ts";

// 画面のテストの補助。
//
// - ログインは、Discord に通信せずに済ませる。src/worker/session.ts と同じ形式（base64url(JSON) と、その
//   HMAC-SHA256 を「.」でつないだもの）のセッションの Cookie を、テスト用のサーバの秘密で署名して置き、
//   Discord から戻った URL（/?login=ok）を開く。サーバは本物のローカルの Worker で、page.route では差し替えない
//   （Playwright の WebKit は、Service Worker がページを制御した後の /api/ を横取りしない）
// - データの準備が済んだら、セッションの Cookie を消して、オフラインにする。作った記録はサーバに送られないので、
//   1 つのサーバを共有するほかのテストにも、次の実行にも、記録が届かない。受付は、オフラインのまま続けられる
//   （FR-40）。Cookie も消すのは、オフラインにするだけでは、テストが終わった後に、記録がサーバに届くためである。
//   確かめたのは次の 3 つである。テストの本体の間は、ページに online のイベントも、同期の要求も出ない。
//   テストが終わった後のサーバには、記録がある。テストの終わりにページを about:blank に移すと、届かない。
//   ここから、Playwright がコンテキストを片付ける途中でオフラインの模擬を外し、まだ開いているページが
//   オンラインを検知して未送信の記録を送る（FR-40 のとおりの動作）と見ている。片付けの中は観測していない。
//   受付アプリは、オフラインの間は同期を始めない（commands/sync.ts の runSync）ので、受付アプリの誤りではない。
//   Cookie がなければ、同期の要求が届いても 401 で、記録は保存されない

export const OPERATOR_NAME = "受付 E2E";

/** 操作者。sub は Discord のユーザ ID、name は表示名 */
export type Operator = { sub: string; name: string };
export const OPERATOR: Operator = { sub: "123456789012345678", name: OPERATOR_NAME };

function sessionToken(operator: Operator): string {
  const payload = Buffer.from(JSON.stringify({ ...operator, exp: Date.now() + 24 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", E2E_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** HTTPS のテスト用オリジンに、本番と同じ __Host- / Secure 属性のセッション Cookie を置く */
export async function addSessionCookie(context: BrowserContext, baseURL: string, operator = OPERATOR): Promise<void> {
  const cookie = { name: "__Host-session", value: sessionToken(operator), httpOnly: true, secure: true, sameSite: "Lax" as const };
  await context.addCookies([{ ...cookie, url: new URL("/", baseURL).href }]);
}

export const scanButton = (page: Page) => page.getByRole("button", { name: "QR コード読み取り" });

/** セッションの Cookie を消し、オフラインにして、ヘッダの同期の状態がオフラインになるのを待つ */
export async function goOffline(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.context().setOffline(true);
  await expect(page.getByRole("img", { name: /^オフライン/ }).first()).toBeVisible();
}

/**
 * 高速受付を、テスト用の入口でオンにする。高速受付の既定はオフ（通常受付）で、オフでは読み取りのたびに
 * 確認（S03-D1）が挟まる。確認を確かめないテストが、ログインの後に呼ぶ。設定は端末に残り、読み込み直しても続く
 */
export async function enableFastCheckin(page: Page): Promise<void> {
  await page.evaluate(() => window.__checkinTest?.setFastCheckin(true));
}

/**
 * ログインして、データの準備を済ませ、ホームの停止中（S02）に着く。その後、オフラインにする。
 * 高速受付は、既定でオンにする。通常受付の確認を確かめるテストは fastCheckin: false を渡す
 */
export async function login(
  page: Page,
  baseURL: string | undefined,
  options: { offline?: boolean; operator?: Operator; fastCheckin?: boolean } = {},
): Promise<void> {
  if (baseURL === undefined) throw new Error("baseURL がない");
  await addSessionCookie(page.context(), baseURL, options.operator);
  await page.goto("/?login=ok");
  await expect(scanButton(page)).toBeVisible();
  if (options.fastCheckin !== false) await enableFastCheckin(page);
  if (options.offline !== false) await goOffline(page);
}

/**
 * 読み取り中（S03）にする。停止中（S02）からは「QR コード読み取り」を押す。カメラを開始できないブラウザ
 * （WebKit）では、結果の主ボタンが S05 に移る（画面設計書 S04）ので、「戻る」で停止中に戻ってから押す
 */
export async function startScanning(page: Page): Promise<void> {
  const exit = page.getByRole("button", { name: "終了" });
  await expect(exit.or(scanButton(page)).or(page.getByRole("textbox", { name: "検索" }))).toBeVisible();
  if (await page.getByRole("textbox", { name: "検索" }).isVisible()) await page.getByRole("button", { name: "戻る" }).click();
  if (await scanButton(page).isVisible()) await scanButton(page).click();
  await expect(exit).toBeVisible();
}

/** カメラを使わずに、QR の文字列を、いまデコードしたものとして判定に渡す（Design Doc 11 章のテスト用の入口） */
export async function scan(page: Page, text: string): Promise<void> {
  await startScanning(page);
  await page.evaluate((value) => window.__checkinTest?.scan(value), text);
}

/** 結果（S04）の下部の主ボタンを押す */
export async function next(page: Page, label = "次へ"): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
}

/** 結果の帯の結果名 */
export const resultTitle = (page: Page) => page.getByRole("heading", { level: 1 });

/**
 * axe-core で、コントラストとアクセシブルな名前の抜けを検査する（Design Doc 6.12）。
 * 「ページに h1 がある」の規則だけは外す。画面設計書は、見出しに当たる文言を持たない画面（S02、S03、S05、
 * S07、S09）を定めており、画面に出す文言は画面設計書に書いたものに限る（画面設計書 1.3）
 */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).disableRules(["page-has-heading-one"]).analyze();
  expect(violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.html) }))).toEqual([]);
}

/** シートとダイアログの出入りの動き（0.2 秒）が終わるのを待つ */
export const settle = (page: Page): Promise<void> => page.waitForTimeout(300);

/**
 * 見た目を確かめるためのスクリーンショット。環境変数 E2E_SHOTS に出力先を渡したときだけ、幅 390px の
 * Chromium で撮る。ふだんのテストでは何もしない
 */
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS;
  // 幅 360px でも見たいときは、E2E_SHOTS_PROJECT にプロジェクト名を渡す
  const project = process.env.E2E_SHOTS_PROJECT || "chromium-390";
  if (dir === undefined || dir === "" || testInfo.project.name !== project) return;
  mkdirSync(dir, { recursive: true });
  await settle(page);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

declare global {
  interface Window {
    // src/app/commands/test-hook.ts の TestHook と同じ形
    __checkinTest?: { scan(text: string): void; setFastCheckin(enabled: boolean): Promise<void> };
  }
}
