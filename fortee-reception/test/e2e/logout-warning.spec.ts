import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers.ts";

// ログアウトの確認（S09-D1）の、同期の失敗の警告（FR-37）。
// 警告は、ヘッダの同期の状態の表示からではなく、オフラインかと、直前の同期に失敗しているかから選ぶ
// （画面設計書 S09-D1）。ヘッダは「同期中」と「再ログインが必要」を同期の失敗より先に出すので、
// ヘッダの表示が同期の失敗でない間も、警告が出ることを確かめる。
// 同期の応答を差し替えるので、Chromium で確かめる（Playwright の WebKit は、Service Worker がページを
// 制御した後の /api/ を横取りしない）。記録は作らないので、サーバには何も残らない

test.skip(({ browserName }) => browserName !== "chromium", "応答の差し替えは Chromium で確かめる");

const FAILED = "同期に失敗しています。同期できるようになるまで、再ログインとデータの取得ができないおそれがあります";

const headerStatus = (page: Page, name: string) => page.getByRole("banner").getByRole("img", { name, exact: true });

/** ログアウトの確認を開き、警告を確かめて、「やめる」で閉じる。ログアウトは確定しない */
async function expectLogoutWarning(page: Page, expected: boolean): Promise<void> {
  await page.getByRole("button", { name: "ログアウト" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("この端末のデータを消してログアウトします");
  if (expected) await expect(dialog).toContainText(FAILED);
  else await expect(dialog).not.toContainText("同期に失敗しています");
  // 未同期の記録はないので、その警告は出ない。オフラインでもない
  await expect(dialog).not.toContainText("未同期の記録も消えます");
  await expect(dialog).not.toContainText("オフラインです");
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(dialog).toHaveCount(0);
}

test("同期に失敗していれば、再試行の間と、再ログインが必要の間も、ログアウトの確認で警告する（FR-37）", async ({ page, baseURL }) => {
  await login(page, baseURL, { offline: false });
  await page.getByRole("button", { name: "メニュー" }).click();

  // 同期できているときは、警告しない
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect(headerStatus(page, "同期済み")).toBeVisible();
  await expectLogoutWarning(page, false);

  // サーバに届くが、失敗の応答が返る
  await page.route("**/api/sync", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) }),
  );
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect(headerStatus(page, "同期の失敗")).toBeVisible();
  await expectLogoutWarning(page, true);

  // 再試行の応答を待っている間。ヘッダは「同期中」だが、直前の同期は失敗しているので、警告する
  await page.unroute("**/api/sync");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sync", async (route) => {
    await held;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) });
  });
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect(headerStatus(page, "同期中")).toBeVisible();
  await expectLogoutWarning(page, true);
  release();
  await expect(headerStatus(page, "同期の失敗")).toBeVisible();

  // ログインの期限が切れた。ヘッダは「再ログインが必要」だが、同期できていないので、警告する
  await page.unroute("**/api/sync");
  await page.route("**/api/sync", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) }),
  );
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect(headerStatus(page, "再ログインが必要")).toBeVisible();
  await expectLogoutWarning(page, true);

  await page.unroute("**/api/sync");
  await page.context().clearCookies();
});
