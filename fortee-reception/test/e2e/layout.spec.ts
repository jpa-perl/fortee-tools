import { expect, type Locator, type Page, test, type TestInfo } from "@playwright/test";
import { login, next, resultTitle, scan, scanButton, settle, shot, startScanning } from "./helpers.ts";
import { qr } from "./setup/data.ts";

// 配置（Design Doc 6.12、画面設計書 1.2 と S02〜S04）。
// 上部固定、本文、下部固定が重ならず、操作を押せて、内容をスクロールで見られることを確かめる。
// 横向きの大きさ（幅 844px、高さ 390px）では、ホームが、高さが足りないときの見え方になることも確かめる

const hasCamera = (page: Page): boolean => page.context().browser()?.browserType().name() === "chromium";

/** 上部固定、本文、下部固定が、この順に重ならずに並び、表示領域に収まっている。ページそのものはスクロールしない */
async function expectFrameIntact(page: Page): Promise<void> {
  const frame = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      header: rect("header"),
      main: rect("main"),
      footer: rect("footer"),
      height: window.innerHeight,
      width: window.innerWidth,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      pageWide: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  expect(frame.pageScrolls).toBe(false);
  expect(frame.pageWide).toBe(false);
  if (frame.main === null) throw new Error("本文がない");
  expect(frame.main.bottom).toBeLessThanOrEqual(frame.height + 1);
  if (frame.header !== null) expect(frame.header.bottom).toBeLessThanOrEqual(frame.main.top + 1);
  if (frame.footer !== null) {
    expect(frame.main.bottom).toBeLessThanOrEqual(frame.footer.top + 1);
    expect(frame.footer.bottom).toBeLessThanOrEqual(frame.height + 1);
  }
  // 固定の要素のボタンは、ほかの要素に隠れておらず、押せる
  for (const button of await page.locator("header button:visible:enabled, footer button:visible:enabled").all()) {
    await button.click({ trial: true });
  }
}

/** 本文（かシート）の中のボタンは、スクロールすれば押せる。横にはみ出さない */
async function expectReachable(container: Locator): Promise<void> {
  for (const button of await container.locator("button:visible:enabled").all()) {
    await button.scrollIntoViewIfNeeded();
    await button.click({ trial: true });
  }
  expect(await container.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

/** シートとダイアログは、表示領域に収まり、収まらない中身は、中をスクロールして見られる */
async function expectSheetIntact(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await settle(page);
  // 開く動き（200ms）が終わってから測る。遅い環境では、シートが出るのが遅れ、settle の待ち時間の後も動きの途中に
  // あって、下端が表示領域の外にあることがある
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const box = await dialog.evaluate((element) => {
    const { top, bottom, left, right } = element.getBoundingClientRect();
    const overflows = element.scrollHeight > element.clientHeight + 1;
    return { top, bottom, left, right, overflows, overflowY: getComputedStyle(element).overflowY };
  });
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("表示領域の大きさがない");
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(viewport.height + 1);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(viewport.width + 1);
  if (box.overflows) expect(box.overflowY).toBe("auto");
  await expectReachable(dialog);
}

/** 4 人をチェックインして、停止中に戻る */
async function checkInFour(page: Page): Promise<void> {
  for (const [event, ticketNo] of [["main", "A-5"], ["main", "A-6"], ["main", "A-12"], ["main", "Z-1"]] as const) {
    await scan(page, qr(event, ticketNo));
    await expect(resultTitle(page)).toHaveText("チェックインしました");
    await next(page);
  }
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();
  await expect(scanButton(page)).toBeVisible();
}

const recentRows = (page: Page) => page.getByRole("main").getByRole("button", { name: /チェックイン/ });

/** 見えている行（収まらない行は、場所は取るが、見せない） */
const visibleCount = (rows: Locator): Promise<number> =>
  rows.evaluateAll((elements) => elements.filter((element) => element.checkVisibility({ visibilityProperty: true })).length);

/** ホームのほかの画面とシートを順に開いて、固定の要素が本文と重ならず、操作を押せて、内容をスクロールで見られることを確かめる */
async function walkScreens(page: Page, testInfo: TestInfo, prefix: string): Promise<void> {
  await checkInFour(page);
  const main = page.getByRole("main");
  const dialog = page.getByRole("dialog");

  // S02-M1 の一覧と確認
  await page.getByRole("button", { name: "受付を切り替える" }).click();
  await expectSheetIntact(page);
  await shot(page, testInfo, `${prefix}-s02-m1`);
  await dialog.getByRole("button", { name: /前夜祭受付/ }).click();
  await expectSheetIntact(page);
  await dialog.getByRole("button", { name: "やめる" }).click();
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(dialog).toHaveCount(0);

  // S05、S06、S06-M1
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await page.getByRole("textbox", { name: "検索" }).fill("test-");
  await expect(main.getByRole("button").first()).toBeVisible();
  await expectFrameIntact(page);
  await expectReachable(main);
  await page.getByRole("textbox", { name: "検索" }).fill("test-alice");
  await main.getByRole("button").first().click();
  await expectFrameIntact(page);
  await expectReachable(main);
  await shot(page, testInfo, `${prefix}-s06`);
  await main.getByRole("radio").first().click();
  await page.getByRole("button", { name: "検索からチェックイン" }).click();
  await expectSheetIntact(page);
  await dialog.getByRole("button", { name: "やめる" }).click();
  await page.getByRole("button", { name: "戻る" }).click();
  await page.getByRole("button", { name: "戻る" }).click();

  // S07、S08、S08-M1
  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  await expectFrameIntact(page);
  await expectReachable(main);
  await main.getByRole("button").first().click();
  await expectFrameIntact(page);
  await expectReachable(main);
  await page.getByRole("button", { name: "取り消す" }).click();
  await dialog.getByRole("radio", { name: "その他" }).check();
  await expectSheetIntact(page);
  await shot(page, testInfo, `${prefix}-s08-m1`);
  await dialog.getByRole("button", { name: "やめる" }).click();
  await page.getByRole("button", { name: "戻る" }).click();
  await page.getByRole("button", { name: "戻る" }).click();

  // S09、S09-D1
  await page.getByRole("button", { name: "メニュー" }).click();
  await expectFrameIntact(page);
  await expectReachable(main);
  await shot(page, testInfo, `${prefix}-s09`);
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expectSheetIntact(page);
  await shot(page, testInfo, `${prefix}-s09-d1`);
}

test.describe("縦向き", () => {
  test("ホーム: 上の領域は、どの状態でも同じ位置と高さで、直近の記録は収まる件数だけ出す", async ({ page, baseURL }) => {
    await login(page, baseURL);
    const top = () => page.locator(".home-top").boundingBox();
    const idle = await top();
    await checkInFour(page);
    await expectFrameIntact(page);

    // 停止中。本文はスクロールさせず、「履歴をすべて見る」は、スクロールしなくても見えている
    const main = page.getByRole("main");
    expect(await main.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    const history = page.getByRole("button", { name: "履歴をすべて見る" });
    await expect(history).toBeInViewport({ ratio: 1 });
    const shown = await visibleCount(recentRows(page));
    expect(shown).toBeGreaterThan(0);
    // 見えている行は、どれも「履歴をすべて見る」より上に、欠けずに収まっている
    const historyTop = (await history.boundingBox())?.y ?? 0;
    for (let i = 0; i < shown; i++) {
      const row = await recentRows(page).nth(i).boundingBox();
      expect((row?.y ?? 0) + (row?.height ?? 0)).toBeLessThanOrEqual(historyTop);
    }
    // 高さ 640px では、4 件は収まらない
    if ((page.viewportSize()?.height ?? 0) <= 640) expect(shown).toBeLessThan(4);

    // 読み取り中と結果でも、上の領域の位置と高さは変わらない
    await startScanning(page);
    if (hasCamera(page)) expect(await top()).toEqual(idle);
    await expectFrameIntact(page);
    await scan(page, qr("eve", "M-4"));
    await expect(resultTitle(page)).toHaveText("別の受付のチケット");
    expect(await top()).toEqual(idle);
    await expectFrameIntact(page);

    // 結果では、上の領域（帯）を止めて、その下だけをスクロールさせる
    expect(await main.evaluate((element) => getComputedStyle(element).overflowY)).not.toBe("auto");
    expect(await main.locator(":scope > div").last().evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    await expectReachable(main);
    expect(await top()).toEqual(idle);
  });
});

test.describe("縦向き", () => {
  test("ほかの画面とシート: 幅 390px と 360px で、はみ出さず、操作を押せる", async ({ page, baseURL }, testInfo) => {
    await login(page, baseURL);
    await walkScreens(page, testInfo, `portrait-${page.viewportSize()?.width}`);
  });
});

test.describe("横向き（幅 844px、高さ 390px）", () => {
  // 幅 390px のプロジェクトで、表示領域を横向きの大きさにして確かめる。幅 360px のプロジェクトでは、同じことの繰り返しになる
  // eslint-disable-next-line no-empty-pattern -- Playwright は、最初の引数を分割代入の形で受ける
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.project.name.endsWith("-390"), "横向きは、幅 390px のプロジェクトで確かめる");
  });
  test.use({ viewport: { width: 844, height: 390 } });

  test("ホーム: 高さが足りないときの、状態ごとの見え方", async ({ page, baseURL }, testInfo) => {
    await login(page, baseURL);
    await checkInFour(page);
    const main = page.getByRole("main");
    const scrolls = () => main.evaluate((element) => element.scrollHeight > element.clientHeight + 1);

    // 停止中。直近の記録を 3 件まで出し、その下に「履歴をすべて見る」を置く。上の領域も一緒にスクロールする
    await expectFrameIntact(page);
    await expect(recentRows(page)).toHaveCount(3);
    expect(await visibleCount(recentRows(page))).toBe(3);
    expect(await scrolls()).toBe(true);
    const card = page.getByRole("button", { name: "受付を切り替える" });
    const before = await card.boundingBox();
    await page.getByRole("button", { name: "履歴をすべて見る" }).scrollIntoViewIfNeeded();
    expect((await card.boundingBox())?.y).toBeLessThan(before?.y ?? 0);
    await expectReachable(main);
    await shot(page, testInfo, "landscape-s02");

    // 読み取り中。直近の記録を出さない
    await startScanning(page);
    await expectFrameIntact(page);
    await expect(page.getByText("直近の記録")).toBeHidden();
    if (hasCamera(page)) {
      // 本文をカメラの映像だけにして、スクロールさせない。映像が、画面の外に出ない
      expect(await scrolls()).toBe(false);
      await expect(page.locator("video")).toBeInViewport({ ratio: 1 });
    } else {
      // カメラを使えないときは、手順とボタンが見えなくならないように、収まらなければスクロールする
      await expectReachable(main);
    }
    await shot(page, testInfo, "landscape-s03");

    // 結果。帯が見える状態から始まり、帯も、その下と一緒にスクロールする
    await scan(page, qr("party", "I-1"));
    await expect(resultTitle(page)).toHaveText("別の受付のチケット");
    await expectFrameIntact(page);
    await expect(resultTitle(page)).toBeInViewport({ ratio: 1 });
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await scrolls()).toBe(true);
    await shot(page, testInfo, "landscape-s04");
    await main.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(resultTitle(page)).not.toBeInViewport();
    await expectReachable(main);

    // 確認のシートと、参考情報のシート
    await page.getByRole("button", { name: "懇親会受付に切り替えて判定" }).click();
    await expectSheetIntact(page);
    await page.getByRole("dialog").getByRole("button", { name: "やめる" }).click();
    await page.getByRole("button", { name: "参考情報" }).click();
    await expectSheetIntact(page);
    await shot(page, testInfo, "landscape-s04-m1");
    await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();

    // 次の結果を出したときも、先頭から表示する
    await main.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await next(page, "切り替えずに次へ");
    await scan(page, qr("party", "I-2"));
    await expect(resultTitle(page)).toBeInViewport({ ratio: 1 });
  });

  test("ほかの画面とシート: 固定の要素が本文と重ならず、操作を押せて、内容をスクロールで見られる", async ({ page, baseURL }, testInfo) => {
    await login(page, baseURL);
    await walkScreens(page, testInfo, "landscape");
  });
});
