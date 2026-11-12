import { expect, type Page, test } from "@playwright/test";
import { DATABASE_NAME, DATABASE_VERSION } from "../../src/app/storage/db.ts";
import { addSessionCookie, login, next, resultTitle, scan, scanButton, startScanning } from "./helpers.ts";
import { qr } from "./setup/data.ts";

// IndexedDB の版を上げる受付アプリの更新と、2 つの画面の重なり（Design Doc 6.3、6.4、11 章）。
//
// 版を上げたビルドを別に配る代わりに、テスト用の入口で、開く版を指定する（src/app/commands/test-hook.ts）。
// localStorage の値は同じオリジンの画面で共有されるので、値を置いた後に読み込んだ画面は、どれも新しい版になる。
// 受付アプリの更新が配られた後の端末と同じである。値を置く前に読み込んだ画面は、古い版のまま動いている

const NEW_VERSION = DATABASE_VERSION + 1;
const VERSION_KEY = "__checkinTest:databaseVersion";
const OTHER_INSTANCE = "別の画面で開いています";

/** これから読み込む画面を、新しい版の受付アプリにする */
async function deployNewVersion(page: Page): Promise<void> {
  await page.addInitScript(([key, version]) => localStorage.setItem(key as string, String(version)), [VERSION_KEY, NEW_VERSION]);
}

/** いまのデータベースの版。まだなければ null */
const databaseVersion = (page: Page): Promise<number | null> =>
  page.evaluate(async (name) => (await indexedDB.databases()).find((db) => db.name === name)?.version ?? null, DATABASE_NAME);

/**
 * ログインして停止中に着き、セッションの Cookie を消す。記録はサーバに送られない（helpers.ts）。
 * 読み込み直しを伴うので、オフラインにはしない
 */
async function loginIsolated(page: Page, baseURL: string | undefined): Promise<void> {
  await login(page, baseURL, { offline: false });
  await page.context().clearCookies();
}

/** 受付アプリを通さずに、データベースを開く。開いた接続は、window に置いて持ち続ける */
const openRaw = (page: Page, version?: number): Promise<void> =>
  page.evaluate(
    ([name, v]) => {
      const state = { blocked: false, opened: false };
      (window as unknown as { __raw: typeof state }).__raw = state;
      const request = v === null ? indexedDB.open(name as string) : indexedDB.open(name as string, v as number);
      request.onblocked = () => {
        state.blocked = true;
      };
      request.onsuccess = () => {
        state.opened = true;
        (window as unknown as { __connection: IDBDatabase }).__connection = request.result;
      };
    },
    [DATABASE_NAME, version ?? null] as const,
  );
const rawState = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __raw: { blocked: boolean; opened: boolean } }).__raw }));

test("旧版の画面が結果を出している間に開いた新版の画面は、S00 に止まり、旧版の画面は動き続ける", async ({ page, context, baseURL }) => {
  await loginIsolated(page, baseURL);
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");

  // 新版の画面を開く。ロックをほかの画面が持っているので、IndexedDB を開かずに止まる。版を上げる要求を、
  // 受付に使っている画面の接続の後ろに残さない
  const second = await context.newPage();
  await deployNewVersion(second);
  await second.goto("/");
  await expect(second.getByRole("heading", { level: 1 })).toHaveText(OTHER_INSTANCE);
  expect(await databaseVersion(second)).toBe(DATABASE_VERSION);
  // 自動では進まず、「再読み込み」でも、ほかの画面が動いている間は進まない
  await second.getByRole("button", { name: "再読み込み" }).click();
  await expect(second.getByRole("heading", { level: 1 })).toHaveText(OTHER_INSTANCE);

  // 旧版の画面は、止まらずに動き続ける。結果は出たままで、次の読み取りもできる
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);
  await scan(page, qr("main", "A-12"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();
  expect(await databaseVersion(page)).toBe(DATABASE_VERSION);

  // 旧版の画面が読み込み直されると、新版になり、自分で移行して、ロックを取り直す。記録は残る。
  // 1 つの画面だけの更新なので、S00 にはならない（S00 の画面は、接続もロックも持たない）
  await page.reload();
  await expect(scanButton(page)).toBeVisible();
  expect(await databaseVersion(page)).toBe(NEW_VERSION);
  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  await expect(page.getByRole("main").getByRole("button", { name: /test-/ })).toHaveCount(2);
  await page.getByRole("button", { name: "戻る" }).click();

  // 後から開いた画面は、先の画面が閉じてから「再読み込み」を押すと、進む
  await second.getByRole("button", { name: "再読み込み" }).click();
  await expect(second.getByRole("heading", { level: 1 })).toHaveText(OTHER_INSTANCE);
  await page.close();
  await second.getByRole("button", { name: "再読み込み" }).click();
  await expect(scanButton(second)).toBeVisible();
  await second.goto("about:blank");
});

test("ロックを持たない画面（未ログインの S01、S00）は、接続を持たず、更新を待たせない", async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error("baseURL がない");

  // 未ログインの S01。起動時の読み書きを終えたら、接続を閉じている
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  expect(await databaseVersion(page)).toBe(DATABASE_VERSION);

  // 新版の画面がログインする。待たされずに移行して、停止中に着く
  const second = await context.newPage();
  await deployNewVersion(second);
  await addSessionCookie(context, baseURL);
  await second.goto("/?login=ok");
  await expect(scanButton(second)).toBeVisible();
  expect(await databaseVersion(second)).toBe(NEW_VERSION);
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();

  // S00 の画面も、接続を持たない。S00 の画面を残したまま、ログイン済みの画面を読み込み直せる
  const third = await context.newPage();
  await third.goto("/");
  await expect(third.getByRole("heading", { level: 1 })).toHaveText(OTHER_INSTANCE);
  await second.reload();
  await expect(scanButton(second)).toBeVisible();
});

test("接続を持つ画面は、versionchange を受けても、受付操作の途中が終わるまで閉じず、終わると読み込み直す", async ({ page, context, baseURL }) => {
  // ロックを調べてから開くまでの間に、別の画面が起動した場合の備え（Design Doc 6.3 の表）。
  // 新版の画面の「版を上げて開く要求」を、受付アプリを通さずに出して、起こす
  await loginIsolated(page, baseURL);
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await page.evaluate(() => {
    (window as unknown as { __marker: string }).__marker = "kept";
  });

  const other = await context.newPage();
  await deployNewVersion(other);
  await other.goto("/icon-192.png");
  await openRaw(other, NEW_VERSION);

  // 結果を出している間は、接続を閉じない。版を上げる要求は、待たされたままになる
  await expect.poll(async () => (await rawState(other)).blocked).toBe(true);
  await page.waitForTimeout(500);
  expect(await rawState(other)).toEqual({ blocked: true, opened: false });
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe("kept");

  // 結果を離れると、接続を閉じて読み込み直す。読み込み直した画面は新版で、ロックを取り直して、停止中に着く
  await next(page);
  await expect.poll(async () => (await rawState(other)).opened).toBe(true);
  await expect(scanButton(page)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBeUndefined();
  expect(await databaseVersion(page)).toBe(NEW_VERSION);
  // 書いた記録は残っている
  await expect(page.getByRole("main").getByRole("button", { name: /test-carol/ })).toBeVisible();
  await page.goto("about:blank");
});

test("版を上げる要求がほかの画面の接続に待たされたら、要求を捨てて S00 に止まる", async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error("baseURL がない");

  // データベースを作ってから、受付アプリを通さない接続を 1 つ持つ。ロックは持たない。
  // 背景で凍結されて、versionchange を処理しない画面に当たる
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  await page.goto("/icon-192.png");
  await openRaw(page);
  await expect.poll(async () => (await rawState(page)).opened).toBe(true);

  // 新版の画面が、Discord から戻った。開く要求が待たされるので、要求を捨てて、S00 に止まる
  const second = await context.newPage();
  await deployNewVersion(second);
  await addSessionCookie(context, baseURL);
  await second.goto("/?login=ok");
  await expect(second.getByRole("heading", { level: 1 })).toHaveText(OTHER_INSTANCE);
  expect(await databaseVersion(second)).toBe(DATABASE_VERSION);

  // 接続を持つ画面が閉じた後に「再読み込み」を押すと、起動をやり直して、停止中に着く
  await page.close();
  await second.getByRole("button", { name: "再読み込み" }).click();
  await expect(scanButton(second)).toBeVisible();
  expect(await databaseVersion(second)).toBe(NEW_VERSION);
});
