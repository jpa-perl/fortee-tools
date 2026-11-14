import { expect, type Page, test } from "@playwright/test";
import {
  expectNoA11yViolations,
  login,
  next,
  resultTitle,
  scan,
  scanButton,
  settle,
  shot,
  startScanning,
} from "./helpers.ts";
import { qr } from "./setup/data.ts";

// 通常受付の確認（S03-D1）、高速受付とリハーサルモードの切り替え（S09、S09-D2）、リハーサルモードの帯と知らせ（S04-D1）

const dialog = (page: Page) => page.getByRole("dialog");
const menuSwitch = (page: Page, name: string) => page.getByRole("switch", { name, exact: true });

/** ダイアログのボタンを押す。確認の確定ボタンは、開いてから 0.5 秒間は押せないので、押せるようになるのを待つ */
async function press(page: Page, label: string): Promise<void> {
  await dialog(page).getByRole("button", { name: label, exact: true }).click();
}

test("通常受付: 読み取りの後に名前を確かめ、「やめる」で読み取りに戻り、「続ける」でチェックインする", async ({
  page,
  baseURL,
}, testInfo) => {
  await login(page, baseURL, { fastCheckin: false });

  await scan(page, qr("main", "A-5"));
  await expect(dialog(page)).toContainText("test-carol");
  await expect(dialog(page)).toContainText("A-5 テスト本編一般チケット");
  await expect(dialog(page)).toContainText("この人の受付を続けますか？");
  // ダイアログの出る動きが終わってから検査する。動きの途中は、文字が透けている
  await settle(page);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s03-d1");

  // やめると、記録を作らずに読み取り中に戻る
  await press(page, "やめる");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "終了" })).toBeVisible();
  await expect(page.getByText("直近の記録")).toHaveCount(0);

  // 直後の 3 秒間は、同じチケットを無視する
  await page.waitForTimeout(3200);
  await scan(page, qr("main", "A-5"));
  await press(page, "続ける");
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await expect(page.getByRole("main").getByText("test-carol")).toBeVisible();

  // 済みのチケットは、確かめずに結果を出す
  await next(page);
  await page.waitForTimeout(3200);
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックイン済み");
  await expect(dialog(page)).toHaveCount(0);
});

test("高速受付: オンにするときだけ確かめる。オンでは、読み取りの後にすぐチェックインする", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL, { fastCheckin: false });
  await page.getByRole("button", { name: "メニュー" }).click();
  await expect(menuSwitch(page, "高速受付")).toHaveAttribute("aria-checked", "false");
  await expect(menuSwitch(page, "リハーサルモード")).toHaveAttribute("aria-checked", "false");
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s09-modes");

  await menuSwitch(page, "高速受付").click();
  await expect(dialog(page)).toContainText("高速受付に切り替えますか？");
  await expect(dialog(page)).toContainText("即座に受け付けが完了します");
  await shot(page, testInfo, "s09-d2-fast");
  await press(page, "やめる");
  await expect(menuSwitch(page, "高速受付")).toHaveAttribute("aria-checked", "false");

  await menuSwitch(page, "高速受付").click();
  await press(page, "切り替える");
  await expect(menuSwitch(page, "高速受付")).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "戻る" }).click();
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);

  // 設定は、読み込み直しても残る。オフに戻すときは確かめない
  await page.context().setOffline(false);
  await page.reload();
  await expect(scanButton(page)).toBeVisible();
  await page.getByRole("button", { name: "メニュー" }).click();
  await expect(menuSwitch(page, "高速受付")).toHaveAttribute("aria-checked", "true");
  await menuSwitch(page, "高速受付").click();
  await expect(menuSwitch(page, "高速受付")).toHaveAttribute("aria-checked", "false");
  await expect(dialog(page)).toHaveCount(0);
});

test("リハーサルモード: 帯と知らせを出し、通常モードに戻すと記録が消える", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL);
  const band = page.getByText("リハーサルモード", { exact: true });
  const exit = page.getByRole("button", { name: "通常モードに戻す" });

  await page.getByRole("button", { name: "メニュー" }).click();
  await menuSwitch(page, "リハーサルモード").click();
  await expect(dialog(page)).toContainText("リハーサルモードに切り替えますか？");
  await press(page, "切り替える");
  await expect(menuSwitch(page, "リハーサルモード")).toHaveAttribute("aria-checked", "true");
  await expect(exit).toBeVisible();
  await settle(page);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "rehearsal-s09");

  await page.getByRole("button", { name: "戻る" }).click();
  await shot(page, testInfo, "rehearsal-s02");
  // 札が本文の右上の角に重なる画面
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await page.getByRole("textbox", { name: "検索" }).fill("test");
  await shot(page, testInfo, "rehearsal-s05");
  await page.getByRole("button", { name: "戻る" }).click();
  await startScanning(page);
  await shot(page, testInfo, "rehearsal-s03");
  await scan(page, qr("main", "A-5"));
  await expect(dialog(page)).toContainText("リハーサルモードです");
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await settle(page);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "rehearsal-s04-d1");
  await press(page, "OK");
  await settle(page);
  await shot(page, testInfo, "rehearsal-s04");

  // 帯の「✗」から、通常モードに戻す。ホームの停止中に戻り、リハーサルの記録は消える
  await exit.click();
  await expect(dialog(page)).toContainText("通常モードに戻しますか？");
  await press(page, "戻す");
  await expect(scanButton(page)).toBeVisible();
  await expect(exit).toHaveCount(0);
  await expect(page.getByText("直近の記録")).toHaveCount(0);

  // 通常モードでは、同じチケットは未のままで、チェックインできる
  await page.waitForTimeout(3200);
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await expect(dialog(page)).toHaveCount(0);
  await expect(band).toHaveCount(0);
});

test("リハーサルモード: 読み込み直しても続き、記録は空から始まる", async ({ page, baseURL }) => {
  await login(page, baseURL, { offline: false });
  await page.getByRole("button", { name: "メニュー" }).click();
  await menuSwitch(page, "リハーサルモード").click();
  await press(page, "切り替える");
  await page.getByRole("button", { name: "戻る" }).click();
  await scan(page, qr("main", "A-5"));
  await press(page, "OK");
  await next(page);

  await page.reload();
  await expect(scanButton(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "通常モードに戻す" })).toBeVisible();
  await expect(page.getByText("直近の記録")).toHaveCount(0);
  // リハーサルモードの間は同期しない。同期の状態は、停止中と出る
  await expect(page.getByRole("img", { name: "同期を停止中" })).toBeVisible();
});

test("通常受付とリハーサルモードを合わせると、名前の確認の後に、結果と知らせを出す", async ({ page, baseURL }) => {
  await login(page, baseURL, { fastCheckin: false });
  await page.getByRole("button", { name: "メニュー" }).click();
  await menuSwitch(page, "リハーサルモード").click();
  await press(page, "切り替える");
  await page.getByRole("button", { name: "戻る" }).click();

  // 確認のダイアログが、知らせのダイアログに入れ替わる
  await scan(page, qr("main", "A-5"));
  await expect(dialog(page)).toContainText("この人の受付を続けますか？");
  await press(page, "続ける");
  await expect(dialog(page).filter({ hasText: "リハーサルモードです" })).toBeVisible();
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await dialog(page).filter({ hasText: "リハーサルモードです" }).getByRole("button", { name: "OK" }).click();
  await expect(dialog(page)).toHaveCount(0);
  // 知らせを閉じると、結果の主ボタンが効く。カメラを開始できないブラウザ（WebKit）では、S05 に移る
  await next(page);
  await expect(page.getByRole("button", { name: "終了" }).or(page.getByRole("textbox", { name: "検索" }))).toBeVisible();
});
