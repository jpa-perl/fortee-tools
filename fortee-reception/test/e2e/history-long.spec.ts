import { expect, test } from "@playwright/test";
import { seedDatabase } from "../perf/in-page.ts";
import { login, scanButton } from "./helpers.ts";

// 履歴（S07）の一覧は、先頭の 100 行だけを描き、スクロールに合わせて続きを足す（ui/screens/History.tsx）。
// 並びと中身は、全行を描いたときと同じであること、終わりまでたどれることを確かめる。

const RECORDS = 350;

test.beforeEach(async ({ page, baseURL }) => {
  await login(page, baseURL);
  // 合成の記録を、端末の記憶域に置いて、読み込み直す（オフラインのまま起動する）
  await page.evaluate(seedDatabase, { tickets: 1000, records: RECORDS, now: Date.now() });
  await page.reload();
  await expect(scanButton(page)).toBeVisible();
  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  await expect(page.getByRole("textbox", { name: "履歴を検索" })).toBeVisible();
});

const rows = (page: import("@playwright/test").Page) => page.locator("main li");

test("履歴は、先頭の 100 行を描き、終わりまでスクロールすると、すべての記録が新しい順に並ぶ", async ({ page }) => {
  await expect(rows(page)).toHaveCount(100);
  // 新しい順。合成の記録は、番号の大きいものほど新しく、記録ごとに別の参加者のもの
  await expect(rows(page).first()).toContainText(`perf-user-${RECORDS - 1}`);

  // 終わりまで、一度に飛ぶ。足した後も終わりの近くにいる間は、続けて足される
  await expect(async () => {
    await page.locator("main").evaluate((main) => main.scrollTo(0, main.scrollHeight));
    await expect(rows(page)).toHaveCount(RECORDS, { timeout: 500 });
  }).toPass();
  await expect(rows(page).last()).toContainText("perf-user-0");
});

test("キーボードで行を順にたどっても、最後の行まで着ける", async ({ page }) => {
  // 終わりの近くの行にフォーカスが移ると、その行が見える位置までスクロールされて、続きが足される
  await rows(page).nth(85).getByRole("button").focus();
  await expect.poll(() => rows(page).count()).toBeGreaterThan(100);
  await rows(page).nth(95).getByRole("button").focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  // 100 行目を越えて、続きの行にフォーカスが移っている
  await expect(rows(page).nth(105).getByRole("button")).toBeVisible();
  expect(await rows(page).count()).toBeGreaterThan(100);
});

test("絞り込むと、絞り込んだ結果を先頭から出し、消すと、先頭の 100 行に戻る", async ({ page }) => {
  const field = page.getByRole("textbox", { name: "履歴を検索" });
  await field.fill("perf-user-12");
  // perf-user-12 と、perf-user-120〜129 の記録
  await expect(rows(page).first()).toContainText("perf-user-12");
  expect(await rows(page).count()).toBeLessThan(100);
  await field.fill("");
  await expect(rows(page)).toHaveCount(100);
});
