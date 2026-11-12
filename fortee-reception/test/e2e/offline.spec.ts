import { expect, type Page, test } from "@playwright/test";
import { goOffline, login, next, resultTitle, scan, scanButton, startScanning } from "./helpers.ts";
import { qr } from "./setup/data.ts";

// ログイン済みの端末を、オフラインで起動し直して、受付を続ける（PRD の AC-2、NFR-2、9 章の 4）。
// 会場では、端末内のデータだけで受付が動く。Service Worker が要る。Chromium と WebKit の両方で確かめる。
// 記録は、ほかの spec と同じく、サーバに送らない（helpers.ts の goOffline。セッションの Cookie も消す）


/** S01 を経ずに、ホームの停止中（S02）に着いている */
async function expectHomeWithoutLogin(page: Page): Promise<void> {
  await expect(scanButton(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "受付を切り替える" })).toContainText("本編受付");
}

async function toIdle(page: Page): Promise<void> {
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();
  await expect(scanButton(page)).toBeVisible();
}

test("ログイン済みの端末は、オフラインで起動し直しても、受付を続けられる", async ({ page, context, baseURL }) => {
  // ───── 端末の準備（ネットワークのある場所で）。データを取得し、オフラインで起動できる状態にする ─────
  await login(page, baseURL, { offline: false });
  await page.getByRole("button", { name: "メニュー" }).click();
  await expect(page.locator("dt", { hasText: "アプリ" }).locator("xpath=following-sibling::dd")).toContainText(
    "オフラインで起動できます",
  );
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.getByRole("button", { name: "戻る" }).click();

  // ───── オフラインにして、読み込み直す。セッションを確かめられなくても、端末のデータで起動する（FR-36） ─────
  await goOffline(page);
  await page.reload();
  await expectHomeWithoutLogin(page);
  await expect(page.getByRole("banner").getByRole("img", { name: "オフライン", exact: true })).toBeVisible();

  // ───── オフラインのまま、読み取り、検索からのチェックイン、履歴の閲覧、取り消し（AC-2） ─────
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await expect(page.getByText("test-carol")).toBeVisible();
  await next(page);
  await toIdle(page);

  await page.getByRole("button", { name: "検索", exact: true }).click();
  await page.getByRole("textbox", { name: "検索" }).fill("test-frank");
  await page.getByRole("main").getByRole("button").first().click();
  await page.getByRole("button", { name: "検索からチェックイン" }).click();
  await expect(page.getByRole("dialog")).toContainText("test-frank の A-12 を、本編受付 で、検索からチェックインします");
  await page.getByRole("dialog").getByRole("button", { name: "チェックイン", exact: true }).click();
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);
  await toIdle(page);

  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  const rows = page.getByRole("main").getByRole("button", { name: /test-/ });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("test-frank");
  await rows.nth(0).click();
  await expect(page.getByRole("definition").nth(1)).toHaveText("検索");
  await page.getByRole("button", { name: "取り消す" }).click();
  await page.getByRole("dialog").getByRole("radio", { name: "誤操作" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "取り消す" }).click();
  await expect(page.getByRole("status")).toContainText("取り消しました");
  await expect(page.getByText("取り消し済み")).toBeVisible();

  // ───── オフラインのまま読み込み直しても、作った記録（未同期）は残っている ─────
  await page.reload();
  await expectHomeWithoutLogin(page);
  await expect(page.getByRole("banner").getByRole("img", { name: "オフライン（未同期あり）" })).toBeVisible();
  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("取り消し");
  await expect(rows.nth(0)).toContainText("test-frank");
  await expect(rows.nth(2)).toContainText("test-carol");
  await expect(page.getByRole("img", { name: "未同期", exact: true })).toHaveCount(3);

  // ───── アプリを完全に閉じてから、開き直す（PRD 9 章の 4 の確かめ方） ─────
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expectHomeWithoutLogin(reopened);
  // 記録は、判定にも使われる。済みのチケットは済み、取り消したチケットは未
  await reopened.getByRole("button", { name: "検索", exact: true }).click();
  await reopened.getByRole("textbox", { name: "検索" }).fill("test-carol");
  await expect(reopened.getByRole("main").getByRole("button").first()).toContainText("A-5 済");
  await reopened.getByRole("textbox", { name: "検索" }).fill("test-frank");
  await expect(reopened.getByRole("main").getByRole("button").first()).toContainText("A-12 未");
  await reopened.getByRole("button", { name: "戻る" }).click();

  // ───── 同期の状態と、ログアウトの確認の警告（FR-37）。ログアウトは確定しない ─────
  await expect(reopened.getByRole("banner").getByRole("img", { name: "オフライン（未同期あり）" })).toBeVisible();
  await reopened.getByRole("button", { name: "メニュー" }).click();
  await expect(reopened.getByRole("button", { name: "今すぐ同期" })).toBeDisabled();
  await expect(reopened.locator("dt", { hasText: "アプリ" }).locator("xpath=following-sibling::dd")).toContainText(
    "オフラインで起動できます",
  );
  await reopened.getByRole("button", { name: "ログアウト" }).click();
  const dialog = reopened.getByRole("dialog");
  await expect(dialog).toContainText("この端末のデータを消してログアウトします");
  await expect(dialog).toContainText("未同期の記録も消えます");
  await expect(dialog).toContainText("オフラインです。再ログインとデータの取得にはネットワークが必要です");
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(dialog).toHaveCount(0);
  await reopened.getByRole("button", { name: "戻る" }).click();
  await expectHomeWithoutLogin(reopened);

  // テストの片付けの間に、未送信の記録を送らないように、ページを先に閉じる（helpers.ts）
  await reopened.goto("about:blank").catch(() => {});
});
