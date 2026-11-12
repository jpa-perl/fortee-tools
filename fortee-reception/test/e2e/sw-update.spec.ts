import { expect, type Page, test as base } from "@playwright/test";
import { addSessionCookie, resultTitle, scan, scanButton } from "./helpers.ts";
import { qr } from "./setup/data.ts";
import { serveShell, SHELL_VERSION_META, type ShellSite } from "./setup/shell-server.ts";

// 版を替えた Service Worker の配り直し（Design Doc 6.11、6.13、11 章）。
// 本番のビルドの出力を、テストごとに立てるサーバ（setup/shell-server.ts）から配り、途中で別の版に切り替える。
// Chromium と WebKit の両方で確かめる。幅で結果が変わらないので、幅 390px のプロジェクトだけで走らせる

const test = base.extend<{ site: ShellSite }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright は、最初の引数を分割代入の形で受ける
  site: async ({}, use) => {
    const site = await serveShell();
    await use(site);
    await site.close();
  },
});

// eslint-disable-next-line no-empty-pattern -- Playwright は、最初の引数を分割代入の形で受ける
test.beforeEach(({}, testInfo) => {
  test.skip(!testInfo.project.name.endsWith("-390"), "幅 390px のプロジェクトで確かめる");
});

/** ページが動いている殻の版。印のない殻が 1 */
// 読み込み直しの最中は、ページの中の評価が失敗する。失敗は、まだ決まっていない値として返し、呼び出し側が待つ
const shellVersion = (page: Page): Promise<number> =>
  page
    .evaluate((name) => Number(document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? 1), SHELL_VERSION_META)
    .catch(() => Number.NaN);

const cacheNames = (page: Page): Promise<string[] | null> => page.evaluate(() => caches.keys()).catch(() => null);

/** ブラウザに、新しい版の Service Worker を探させる。受付アプリも、1 時間ごとと、S01 と S99 に入ったときに探す */
const checkForUpdate = (page: Page): Promise<void> =>
  // 受付アプリも、S01 の取得失敗と S99 では自分で更新を確かめ、新しい版が届くと読み込み直す（Design Doc 6.11）。
  // その読み込み直しがこの update() の途中に重なると、WebKit では sw.js の取得が中断されて、update() が
  // 失敗で終わる（"Script .../sw.js load failed"）。失敗を捨てると、後ろに否定の確認しかないテストが、
  // 更新を一度も確かめないまま通る。update() が 1 回、成功で終わるまで、やり直す
  expect
    .poll(() =>
      page
        .evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          if (registration === undefined) return false;
          await registration.update();
          return true;
        })
        .catch(() => false),
    )
    .toBe(true);

/** 待機中の版があるか */
const hasWaiting = (page: Page): Promise<boolean | null> =>
  page.evaluate(async () => ((await navigator.serviceWorker.getRegistration())?.waiting ?? null) !== null).catch(() => null);

/** 読み込み直されると消える印を置く */
const mark = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as { __marker: string }).__marker = "kept";
  });
const marked = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as { __marker?: string }).__marker === "kept");

/**
 * ログインして停止中に着く。その後、セッションの Cookie を消す。記録はサーバに送られない（helpers.ts）。
 * 新しい版を取りに行けるように、オフラインにはしない
 */
async function loginTo(page: Page, site: ShellSite): Promise<void> {
  await addSessionCookie(page.context(), site.origin);
  await page.goto(`${site.origin}/?login=ok`);
  await expect(scanButton(page)).toBeVisible();
  await page.context().clearCookies();
}

test("待機中の版は、停止中に有効になり、読み込み直して、古いキャッシュを消す", async ({ page, site }) => {
  await loginTo(page, site);
  expect(await shellVersion(page)).toBe(1);
  expect(await cacheNames(page)).toEqual([site.cacheName(1)]);
  await mark(page);

  site.version = 2;
  await checkForUpdate(page);

  // 新しい版の事前のキャッシュが終わると、受付アプリが有効にして、読み込み直す。記録を作る途中ではないためである
  await expect.poll(() => shellVersion(page)).toBe(2);
  await expect(scanButton(page)).toBeVisible();
  expect(await marked(page)).toBe(false);
  await expect.poll(() => cacheNames(page)).toEqual([site.cacheName(2)]);
  expect(await hasWaiting(page)).toBe(false);

  // 新しい版で、オフラインで起動できる
  await page.context().setOffline(true);
  await page.reload();
  await expect(scanButton(page)).toBeVisible();
  expect(await shellVersion(page)).toBe(2);
});

test("受付操作の途中（結果）は、新しい版を有効にせず、読み込み直しを延ばす", async ({ page, site }) => {
  await loginTo(page, site);
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await mark(page);

  site.version = 2;
  await checkForUpdate(page);
  await expect.poll(() => hasWaiting(page)).toBe(true);

  // 結果を出している間は、待機中のままにする。判定の結果が、読み込み直しで消えない
  await page.waitForTimeout(1500);
  expect(await hasWaiting(page)).toBe(true);
  expect(await marked(page)).toBe(true);
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  expect(await cacheNames(page)).toEqual(expect.arrayContaining([site.cacheName(1), site.cacheName(2)]));

  // 結果を離れた後も、停止中に戻るまでは有効にしない。カメラを開始できるブラウザ（Chromium）は読み取り中に、
  // 開始できないブラウザ（WebKit）は検索に移っている。停止中に戻ると、有効にして読み込み直す
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByRole("button", { name: /^(終了|戻る)$/ })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await marked(page)).toBe(true);
  await page.getByRole("button", { name: /^(終了|戻る)$/ }).click();
  await expect.poll(() => shellVersion(page)).toBe(2);
  await expect(scanButton(page)).toBeVisible();
  await expect.poll(() => cacheNames(page)).toEqual([site.cacheName(2)]);
  // 書いた記録は残っている
  await expect(page.getByRole("main").getByRole("button", { name: /test-carol/ })).toBeVisible();
  await page.goto("about:blank");
});

test("事前のキャッシュの途中で取得に失敗した新しい版は有効にならず、古い版のまま動き、次の確認で入り直す", async ({ page, site }) => {
  await loginTo(page, site);
  await mark(page);

  // 新しい版の殻のファイルを、1 つ取得できない
  site.version = 2;
  site.failPrecache = true;
  await checkForUpdate(page);
  // インストールに失敗した版は捨てられる。待機中にもならず、キャッシュも作られない
  await expect
    .poll(() => page.evaluate(async () => ((await navigator.serviceWorker.getRegistration())?.installing ?? null) === null))
    .toBe(true);
  expect(await hasWaiting(page)).toBe(false);
  expect(await cacheNames(page)).toEqual([site.cacheName(1)]);
  expect(await marked(page)).toBe(true);
  expect(await shellVersion(page)).toBe(1);

  // 古い版のまま、オフラインで起動できる
  await page.context().setOffline(true);
  await page.reload();
  await expect(scanButton(page)).toBeVisible();
  expect(await shellVersion(page)).toBe(1);
  await page.context().setOffline(false);

  // 取得できるようになった後の、次の更新の確認で、新しい版が入る
  site.failPrecache = false;
  await checkForUpdate(page);
  await expect.poll(() => shellVersion(page)).toBe(2);
  await expect(scanButton(page)).toBeVisible();
  await expect.poll(() => cacheNames(page)).toEqual([site.cacheName(2)]);
});

test("S01 の取得失敗にいる古い版は、新しい版が届くと、読み込み直して取得をやり直す", async ({ page, site }) => {
  // 古い版の受付アプリが、データを取得できない
  site.failSync = true;
  await addSessionCookie(page.context(), site.origin);
  await page.goto(`${site.origin}/?login=ok`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("データを取得できませんでした");
  expect(await shellVersion(page)).toBe(1);

  // 直した版を配る。「再試行」を押さなくても、新しい版で読み込み直して、取得をやり直す
  site.version = 2;
  site.failSync = false;
  await checkForUpdate(page);
  await expect.poll(() => shellVersion(page)).toBe(2);
  await expect(scanButton(page)).toBeVisible();
  await expect.poll(() => cacheNames(page)).toEqual([site.cacheName(2)]);
});

test("S01 の「再ログインが必要」にいる古い版は、新しい版が届くと、読み込み直して取得をやり直す", async ({ page, site }) => {
  // 古い版の受付アプリの初回の取得で、ログインの期限が切れていると分かった
  site.unauthorizedSync = true;
  await addSessionCookie(page.context(), site.origin);
  await page.goto(`${site.origin}/?login=ok`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ログインの期限が切れました。もう一度ログインしてください");
  expect(await shellVersion(page)).toBe(1);

  // 新しい版を配る。新しい版で読み込み直して、取得をやり直す
  site.version = 2;
  site.unauthorizedSync = false;
  await checkForUpdate(page);
  await expect.poll(() => shellVersion(page)).toBe(2);
  await expect(scanButton(page)).toBeVisible();
  await expect.poll(() => cacheNames(page)).toEqual([site.cacheName(2)]);
});

test("S99 にいる古い版は、新しい版が届くと、読み込み直す", async ({ page, site }) => {
  await loginTo(page, site);
  await page.evaluate(() => {
    const fail = () => {
      throw new DOMException("書き込めない", "QuotaExceededError");
    };
    IDBObjectStore.prototype.add = fail;
    IDBObjectStore.prototype.put = fail;
  });
  await scan(page, qr("main", "A-5"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("エラーが発生しました");
  expect(await shellVersion(page)).toBe(1);

  // 直した版を配る。「再読み込み」を押さなくても、新しい版で起動し直す
  site.version = 2;
  await checkForUpdate(page);
  await expect.poll(() => shellVersion(page)).toBe(2);
  await expect(scanButton(page)).toBeVisible();
  await expect.poll(() => cacheNames(page)).toEqual([site.cacheName(2)]);
});

test("結果を出している間に待機中になった版は、S99 に移ると有効になり、新しい版で起動し直す", async ({ page, site }) => {
  await loginTo(page, site);
  // 結果を出している間に新しい版が届き、待機中になる。切替提案の結果にしておく
  await scan(page, qr("party", "I-3"));
  await expect(resultTitle(page)).toHaveText("別の受付のチケット");
  site.version = 2;
  await checkForUpdate(page);
  await expect.poll(() => hasWaiting(page)).toBe(true);
  expect(await shellVersion(page)).toBe(1);

  // 受付の切り替えの書き込みに失敗して、結果から S99 に移る。S99 では、待機中の版を有効にして読み込み直す
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = () => {
      throw new DOMException("書き込めない", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "懇親会受付に切り替えて判定" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "切り替える" }).click();
  await expect.poll(() => shellVersion(page)).toBe(2);
  await expect(scanButton(page)).toBeVisible();
  await expect.poll(() => cacheNames(page)).toEqual([site.cacheName(2)]);
});

test("初回の準備で殻を取得できなければ、アプリのファイルの取得失敗を出し、読み込み直しても進まず、「再試行」で回復する", async ({ page, site }) => {
  // データは取得できるが、殻のファイルを 1 つ取得できない。Service Worker が有効にならない
  site.failPrecache = true;
  await addSessionCookie(page.context(), site.origin);
  await page.goto(`${site.origin}/?login=ok`);
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("アプリのファイルを取得できませんでした");
  expect(await cacheNames(page)).toEqual([]);

  // 「再試行」ではなく読み込み直しても、停止中には進まない。データはそろっているが、オフラインで起動できない
  // 端末を、受付に進ませない
  let fetched = 0;
  page.on("request", (request) => {
    if (/\/api\/(sync|config|snapshot)/.test(request.url())) fetched++;
  });
  await page.reload();
  await expect(title).toHaveText("アプリのファイルを取得できませんでした");
  await expect(scanButton(page)).toHaveCount(0);
  // 待つのは Service Worker だけで、データは取得し直さない
  expect(fetched).toBe(0);

  // まだ取得できなければ、「再試行」でも取得失敗のまま
  await page.getByRole("button", { name: "再試行" }).click();
  await expect(page.getByText("データを取得中")).toBeVisible();
  await expect(title).toHaveText("アプリのファイルを取得できませんでした");

  // 取得できるようになってから「再試行」を押すと、登録からやり直して、停止中に着く
  site.failPrecache = false;
  await page.getByRole("button", { name: "再試行" }).click();
  await expect(scanButton(page)).toBeVisible();
  expect(await cacheNames(page)).toEqual([site.cacheName(1)]);

  // 有効な Service Worker がある起動では、待たない
  await page.reload();
  await expect(scanButton(page)).toBeVisible();
});

test("登録を残してキャッシュだけが消えた端末は、オンラインで開くと殻を取り直し、S09 の表示が変わる", async ({ page, site }) => {
  await loginTo(page, site);
  const app = page.locator("dt", { hasText: "アプリ" }).locator("xpath=following-sibling::dd");

  // 長く開かなかった端末で、ブラウザがアプリのファイルを消した
  await page.evaluate(async () => {
    for (const key of await caches.keys()) await caches.delete(key);
  });
  await page.getByRole("button", { name: "メニュー" }).click();
  await expect(app).toContainText("オフラインでは起動できません");

  // 開き直すと、S01 では止めずに停止中へ進み、有効な Service Worker に殻を取り直させる
  await page.reload();
  await expect(scanButton(page)).toBeVisible();
  await expect.poll(() => cacheNames(page)).toEqual([site.cacheName(1)]);
  await page.getByRole("button", { name: "メニュー" }).click();
  await expect(app).toContainText("オフラインで起動できます");
});

test("ロックをほかの画面が持つ S99 は、待機中の版を有効にしない", async ({ page, context, site }) => {
  // 画面 A。ログイン済みでロックを持ち、結果を出している（受付操作の途中なので、A も有効にしない）
  await loginTo(page, site);
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await mark(page);

  // 画面 B。起動の最初の判定（ロックの照会）で失敗して、ロックを持たないまま S99 に移る
  const second = await context.newPage();
  await second.addInitScript(() => {
    navigator.locks.query = () => Promise.reject(new Error("ロックを調べられない"));
  });
  await second.goto(site.origin);
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("エラーが発生しました");
  await mark(second);

  // 新しい版が届いて、待機中になる。B は S99 だが、ロックを A が持っているので、有効にしない。
  // 有効にすると、A も読み込み直しになり、受付に使っている画面を止める
  site.version = 2;
  await checkForUpdate(second);
  await expect.poll(() => hasWaiting(second)).toBe(true);
  await second.waitForTimeout(1500);
  expect(await hasWaiting(second)).toBe(true);
  expect(await marked(second)).toBe(true);
  expect(await shellVersion(second)).toBe(1);
  expect(await marked(page)).toBe(true);
  await expect(resultTitle(page)).toHaveText("チェックインしました");

  // B の「再読み込み」も、A が動いている間は、待機中の版を有効にせずに読み込み直すだけである
  await second.getByRole("button", { name: "再読み込み" }).click();
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("エラーが発生しました");
  await expect.poll(() => shellVersion(second)).toBe(1);
  await expect.poll(() => hasWaiting(second)).toBe(true);
  expect(await marked(page)).toBe(true);

  // A が閉じた後は、B の「再読み込み」で、ロックを取って待機中の版を有効にしてから、読み込み直す
  await page.close();
  await second.getByRole("button", { name: "再読み込み" }).click();
  await expect.poll(() => shellVersion(second)).toBe(2);
  await expect.poll(() => cacheNames(second)).toEqual([site.cacheName(2)]);
});
