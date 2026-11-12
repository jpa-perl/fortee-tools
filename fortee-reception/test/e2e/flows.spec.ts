import { expect, type Page, test } from "@playwright/test";
import {
  expectNoA11yViolations,
  goOffline,
  login,
  next,
  OPERATOR_NAME,
  resultTitle,
  scan,
  scanButton,
  settle,
  shot,
  startScanning,
} from "./helpers.ts";
import { qr } from "./setup/data.ts";

// 画面の流れ（Design Doc 11 章の app の行）。WebKit と Chromium、幅 390px と 360px で通す。
// 各画面で axe-core を走らせる。カメラは使わず、QR の文字列を、テスト用の入口から判定に渡す。
// 設定は test/e2e/fixtures/e2e.toml。現在の受付は、本編受付（期間中）になる

const sheet = (page: Page) => page.getByRole("dialog");

/** 確認のシートの確定ボタンを押す。開いてから 0.5 秒間は押せないので、押せるようになるのを待つ */
async function confirm(page: Page, label: string): Promise<void> {
  await sheet(page).getByRole("button", { name: label, exact: true }).click();
}

/**
 * ボタンを押して、0.1 秒後に、確定ボタンが押せない状態かを返す。押してから調べるまでを、ページの中で
 * 続けて行う。テストの側で待つと、調べるまでに 0.5 秒が過ぎることがある
 */
function disabledJustAfter(page: Page, open: string, confirmLabel: string): Promise<boolean | null> {
  return page.evaluate(
    async ([openName, confirmName]) => {
      const byText = (root: ParentNode, text: string) =>
        Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes(text as string));
      byText(document.querySelector("dialog") ?? document, openName as string)?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const dialog = document.querySelector("dialog");
      return dialog === null ? null : (byText(dialog, confirmName as string)?.disabled ?? null);
    },
    [open, confirmLabel],
  );
}

/** カメラを開始できたか。Chromium は偽のカメラで開始でき、WebKit は開始できない（playwright.config.ts） */
const hasCamera = (page: Page): boolean => page.context().browser()?.browserType().name() === "chromium";

test("S01: 未ログインでは、カンファレンス名と「Discord でログイン」を出す", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("YAPC::Tokyo 2026（ローカル）");
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  // Android のブラウザではないので、ホーム画面への追加は勧めない
  await expect(page.getByText("ホーム画面に追加して使ってください")).toHaveCount(0);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s01");
});

test("S02: データの準備が済むと、ホームの停止中に着く", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL, { offline: false });
  const card = page.getByRole("button", { name: "受付を切り替える" });
  await expect(card).toContainText("本編受付");
  await expect(card).toContainText("自動");
  // 期間。年は出さない
  await expect(card).toContainText("1/1 00:00〜1/1 00:00");
  await expect(page.getByRole("img", { name: "同期済み" })).toBeVisible();
  // 記録が 1 件もないので、直近の記録は見出しも出さない
  await expect(page.getByText("直近の記録")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "履歴をすべて見る" })).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s02-empty");
});

test("読み取りから結果: 成功、直後の読み直しの無視、済み", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL);

  await startScanning(page);
  if (hasCamera(page)) {
    // 読み取り中。偽のカメラの映像が出て、検索は全幅にしない
    await expect(page.locator("video")).toBeVisible();
    const search = await page.getByRole("button", { name: "検索" }).boundingBox();
    expect(search?.width).toBeLessThan(200);
  } else {
    // カメラを使えない。手順と「検索で続ける」を出し、下部の「検索」は置かない（FR-27）
    await expect(page.getByText("カメラを使えません")).toBeVisible();
    await expect(page.getByRole("button", { name: "検索で続ける" })).toBeVisible();
    await expect(page.getByRole("button", { name: "検索", exact: true })).toHaveCount(0);
  }
  await expectNoA11yViolations(page);

  // 成功。本編、前夜祭、懇親会のチケットを 1 枚ずつ持つ人の、本編のチケット
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await expect(page.getByText("test-carol")).toBeVisible();
  // 今回済みの行には、回答を最初から出す。ほかのイベントのチケットは未
  await expect(page.getByText("今回")).toBeVisible();
  await expect(page.getByText("A-5 テスト本編一般チケット")).toBeVisible();
  await expect(page.getByText("参加する")).toBeVisible();
  await expect(page.getByText("M-2 テスト前夜祭チケット")).toBeVisible();
  // 結果には、戻る操作を置かない（FR-22）
  await expect(page.getByRole("button", { name: /^(戻る|終了)$/ })).toHaveCount(0);
  // NFR-1 の計測の印
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName("checkin:result").length)).toBe(1);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-success");

  // 参考情報のシート。テンプレートの描画結果を、HTML として出す
  await page.getByRole("button", { name: "参考情報" }).click();
  await expect(sheet(page)).toContainText("test-carol さん");
  await expect(sheet(page)).toContainText("受付: 本編受付");
  // テンプレートに書いたタグは、要素になる
  await expect(sheet(page).locator("b")).toHaveText("本編受付");
  await expect(sheet(page)).toContainText("本編 A-5 テスト本編一般チケット（済");
  await settle(page);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-m1");
  await sheet(page).getByRole("button", { name: "閉じる" }).click();
  await expect(sheet(page)).toHaveCount(0);

  // 次へ。読み取り中に戻る。カメラを使えない端末では、検索に移る
  await next(page);
  if (hasCamera(page)) {
    await expect(page.getByRole("button", { name: "終了" })).toBeVisible();
    await shot(page, testInfo, "s03");
  } else {
    await expect(page.getByRole("textbox", { name: "検索" })).toHaveValue("");
  }

  // 直後の 3 秒間は、直前に判定したチケットを読み取っても無視する
  await scan(page, qr("main", "A-5"));
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: "終了" })).toBeVisible();
  // 読み取り中にも、直近の記録を出す
  await expect(page.getByText("直近の記録")).toBeVisible();

  // 3 秒たてば、済みになる
  await page.waitForTimeout(3000);
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックイン済み");
  // 帯の 1 行は、済みの根拠の記録の時刻と受付名。その下に、操作者と端末名
  await expect(page.getByText(/^\d{2}:\d{2} 本編受付$/)).toBeVisible();
  await expect(page.getByText(new RegExp(`^${OPERATOR_NAME}・端末 `))).toBeVisible();
  await expect(page.getByText(/^済 \d{2}:\d{2}$/)).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-done");

  // 済みの行の回答は閉じてあり、行を押すと開く
  const row = page.getByRole("button", { name: /A-5 テスト本編一般チケット/ });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("参加する")).toHaveCount(0);
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("参加する")).toBeVisible();
});

test("読み取りから結果: 見つからない、対象外、QR 形式外", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL);

  // QR 形式外。結果にせず、読み取り中のままバナーを出す。バナーは 2 秒で消える
  await scan(page, "https://example.com/not-a-ticket");
  await expect(page.getByRole("button", { name: "終了" })).toBeVisible();
  if (hasCamera(page)) {
    await expect(page.getByText("チケットの QR ではありません")).toBeVisible();
    await expectNoA11yViolations(page);
    await shot(page, testInfo, "s03-banner");
    await expect(page.getByText("チケットの QR ではありません")).toHaveCount(0);
  }

  // 見つからない。ユーザ名、チケットの一覧、「参考情報」は出さず、データの取得日時を出す
  await scan(page, `fortee:${"0".repeat(32)}`);
  await expect(resultTitle(page)).toHaveText("データにないチケット");
  await expect(page.getByText("キャンセル済みか、データ取得後の購入です")).toBeVisible();
  await expect(page.getByRole("heading", { name: "データの取得日時" })).toBeVisible();
  await expect(page.getByText(/^テスト本編 \d{2}:\d{2}$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "参考情報" })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-notfound");
  await next(page);

  // 対象外。どの受付も受け付けないイベント（託児所）のチケット
  await scan(page, qr("nursery", "K-1"));
  await expect(resultTitle(page)).toHaveText("対象外のチケット");
  await expect(page.getByText("test-ivan")).toBeVisible();
  await expect(page.getByText("K-1 テスト託児所チケット")).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-out-of-scope");
  await next(page);

  // どれも、記録を作らない
  await startScanning(page);
  await expect(page.getByText("直近の記録")).toHaveCount(0);
});

test("読み取りから結果: 切替提案から、受付を切り替えて判定し直す", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL);

  // 懇親会のチケットだけを持つ人。本編受付は受け付けないが、懇親会受付（これから）なら受け付ける
  await scan(page, qr("party", "I-3"));
  await expect(resultTitle(page)).toHaveText("別の受付のチケット");
  await expect(page.getByText("懇親会受付で受け付けます")).toBeVisible();
  await expect(page.getByText("懇親会受付は期間外です")).toBeVisible();
  await expect(page.getByRole("button", { name: "切り替えずに次へ" })).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-suggest");

  // 注意を要する操作。確認のシートで確定する（FR-32、33）
  await page.getByRole("button", { name: "懇親会受付に切り替えて判定" }).click();
  await expect(sheet(page)).toContainText("この端末の受付を 懇親会受付 に固定して、このチケットを判定し直します");
  await expect(sheet(page)).toContainText("懇親会受付は期間外です");
  await settle(page);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-m2");

  // やめると、何もせずに閉じる
  await sheet(page).getByRole("button", { name: "やめる" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(resultTitle(page)).toHaveText("別の受付のチケット");

  // 確定すると、同じチケットを新しい受付で判定し直して、結果を差し替える
  await page.getByRole("button", { name: "懇親会受付に切り替えて判定" }).click();
  await confirm(page, "切り替える");
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText("I-3 テスト懇親会チケット")).toBeVisible();
  // ヘッダの受付は、手動の上書き
  await expect(page.getByRole("banner")).toContainText("懇親会受付");
  await expect(page.getByRole("banner")).toContainText("手動");
  await expectNoA11yViolations(page);
});

test("受付の切り替え: 手動で切り替えて、拒否と、続けて読み取りを出し、自動に戻す", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL);
  const card = page.getByRole("button", { name: "受付を切り替える" });

  // 一覧。現在の受付の行は「現在」と書き、選べない
  await card.click();
  await expect(sheet(page).getByText("現在")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: /本編受付/ })).toHaveCount(0);
  await expect(sheet(page).getByRole("button", { name: /前夜祭受付.*終了/ })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: /懇親会受付.*これから/ })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "自動に戻す" })).toHaveCount(0);
  await settle(page);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s02-m1");

  // 確認。期間外の受付は、2 行目に断る
  await sheet(page).getByRole("button", { name: /前夜祭受付/ }).click();
  await expect(sheet(page)).toContainText(
    "この端末の受付を 前夜祭受付 に固定します。解除するか、次の期間の境目までこのままです",
  );
  await expect(sheet(page)).toContainText("前夜祭受付は期間外です");
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s02-m1-confirm");

  // 「やめる」と戻る操作（Esc キー）は、シートを閉じずに、一覧に戻る
  await sheet(page).getByRole("button", { name: "やめる" }).click();
  await expect(sheet(page).getByText("現在")).toBeVisible();
  await sheet(page).getByRole("button", { name: /前夜祭受付/ }).click();
  await expect(sheet(page).getByRole("button", { name: "切り替える" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page).getByText("現在")).toBeVisible();

  // 確定ボタンは、確認に切り替わってから 0.5 秒間は押せない。一覧を開いてからの時間ではない（画面設計書 2.5）
  await page.waitForTimeout(600);
  expect(await disabledJustAfter(page, "前夜祭受付", "切り替える")).toBe(true);
  await expect(sheet(page).getByRole("button", { name: "切り替える" })).toBeEnabled();

  // 確定すると、シートを閉じて、受付のカードを更新する。自分で切り替えたので、知らせは出さない
  await confirm(page, "切り替える");
  await expect(sheet(page)).toHaveCount(0);
  await expect(card).toContainText("前夜祭受付");
  await expect(card).toContainText("手動");
  await expect(card).toContainText("期間外");
  await expect(page.getByText("前夜祭受付になりました")).toHaveCount(0);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s02-manual");

  // 拒否。前夜祭受付は、前夜祭のチケットの所持が必須。本編のチケットだけを持つ人
  await scan(page, qr("main", "A-6"));
  await expect(resultTitle(page)).toHaveText("受け付けられません");
  await expect(page.getByText("前夜祭チケットがありません。本編の受付は明日からです")).toBeVisible();
  await expect(page.getByText("test-dave")).toBeVisible();
  await expect(page.getByText("デイブ")).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-reject");
  await next(page);

  // 続けて読み取り。本編のチケットを 2 枚持つ人の、前夜祭のチケット。前夜祭は済みになり、本編が残る
  await scan(page, qr("eve", "M-1"));
  await expect(resultTitle(page)).toHaveText("続けて読み取り");
  await expect(page.getByText("テスト本編のチケットを 1 枚読み取ってください")).toBeVisible();
  await expect(page.getByRole("img", { name: "済みにできなかったイベント" })).toBeVisible();
  await expect(page.getByText("今回")).toHaveCount(1);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-continue");
  await next(page, "続けて読み取る");

  // 残りのチケットを読み取ると、成功になる
  await scan(page, qr("main", "A-2"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);

  // 自動に戻す。手動で上書きしているときだけ、一覧の上に出る
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();
  await card.click();
  await settle(page);
  await shot(page, testInfo, "s02-m1-manual");
  await sheet(page).getByRole("button", { name: "自動に戻す" }).click();
  await expect(sheet(page)).toContainText("自動の選択に戻します。受付は 本編受付 になります");
  await confirm(page, "戻す");
  await expect(sheet(page)).toHaveCount(0);
  await expect(card).toContainText("本編受付");
  await expect(card).toContainText("自動");
});

test("検索からのチェックイン", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL);

  await page.getByRole("button", { name: "検索", exact: true }).click();
  const input = page.getByRole("textbox", { name: "検索" });
  // 画面を開いたら、すぐに入力できる。入力の前は、本文に何も出さない
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", "チケット番号・ユーザ名・Name・お名前");
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s05");

  await input.fill("どこにもいない人");
  await expect(page.getByText("該当なし")).toBeVisible();
  await shot(page, testInfo, "s05-none");

  await input.fill("test-");
  await expect(page.getByRole("main").getByRole("button").first()).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s05-results");

  // 完全に一致した候補が、最初に来る
  await input.fill("test-alice");
  const candidate = page.getByRole("main").getByRole("button").first();
  await expect(candidate).toContainText("test-alice");
  await expect(candidate).toContainText("A-1 未");
  await candidate.click();

  // 候補の詳細。本編のチケットが 2 枚あるので、1 枚を選ぶまで押せない
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("test-alice");
  const checkin = page.getByRole("button", { name: "検索からチェックイン" });
  await expect(checkin).toBeDisabled();
  const tickets = page.getByRole("radiogroup", { name: "テスト本編" }).getByRole("radio");
  await expect(tickets).toHaveCount(2);
  // 選べるチケットの行には、回答を最初から出す。本人の申告と突き合わせる
  await expect(tickets.nth(0)).toContainText("テスト株式会社");
  // 選択の対象にならないチケット（前夜祭）は、選べない
  await expect(page.getByText("M-1 テスト前夜祭チケット")).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s06");

  await tickets.nth(1).click();
  await expect(tickets.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(tickets.nth(0)).toHaveAttribute("aria-checked", "false");
  await expect(checkin).toBeEnabled();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s06-selected");

  // 「戻る」で検索に戻ると、入力は残る
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(input).toHaveValue("test-alice");
  await page.getByRole("main").getByRole("button").first().click();
  await page.getByRole("radiogroup", { name: "テスト本編" }).getByRole("radio").nth(1).click();

  // 確認のシート
  await checkin.click();
  await expect(sheet(page)).toContainText("test-alice の A-2 を、本編受付 で、検索からチェックインします");
  await settle(page);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s06-m1");
  await sheet(page).getByRole("button", { name: "チェックイン", exact: true }).click();

  // 選んだチケットを読み取ったチケットとみなして判定し、結果に進む
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await expect(page.getByText("今回")).toHaveCount(1);
  await expect(page.getByText("A-2 テスト本編一般チケット")).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expectNoA11yViolations(page);

  // 選べるチケットがない人には、チェックインの操作を出さない
  await next(page);
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await input.fill("test-grace");
  await page.getByRole("main").getByRole("button").first().click();
  await expect(page.getByText("テスト本編のチケットがありません")).toBeVisible();
  await expect(checkin).toHaveCount(0);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s06-out-of-scope");
});

test("取り消しと、履歴", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL);

  // 2 人をチェックインする
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);
  await scan(page, qr("main", "A-12"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();

  // 停止中の直近の記録。新しい順
  const recent = page.getByRole("main").getByRole("button", { name: /チェックイン/ });
  await expect(recent).toHaveCount(2);
  await expect(recent.nth(0)).toContainText("test-frank");
  await expect(recent.nth(0)).toContainText("A-12");
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s02");

  // 記録の詳細
  await recent.nth(1).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("チェックイン");
  await expect(page.getByText("test-carol")).toBeVisible();
  const details = page.getByRole("definition");
  await expect(details.nth(0)).toHaveText("本編受付");
  await expect(details.nth(1)).toHaveText("QR");
  await expect(details.nth(2)).toHaveText(OPERATOR_NAME);
  await expect(details.nth(3)).toHaveText(/^端末 /);
  await expect(page.getByText("未同期")).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s08");

  // 取り消しの確認。理由が決まるまで、確定は押せない
  await page.getByRole("button", { name: "取り消す" }).click();
  await expect(sheet(page)).toContainText("test-carol の、下で選んだチケットのチェックインを、本編受付 で取り消します");
  const submit = sheet(page).getByRole("button", { name: "取り消す" });
  const ticket = sheet(page).getByRole("checkbox", { name: "A-5 テスト本編一般チケット" });
  await expect(ticket).toBeChecked();
  await page.waitForTimeout(600);
  await expect(submit).toBeDisabled();
  // 「その他」は、自由記述が必須
  await sheet(page).getByRole("radio", { name: "その他" }).check();
  await expect(submit).toBeDisabled();
  await sheet(page).getByRole("textbox", { name: "理由" }).fill("受付の練習で読み取った");
  await expect(submit).toBeEnabled();
  // チケットを 1 枚も選んでいなければ、押せない
  await ticket.uncheck();
  await expect(submit).toBeDisabled();
  await ticket.check();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s08-m1");
  await submit.click();

  // 確定の後は、記録の詳細にとどまり、状態と注記を更新して、知らせを出す
  await expect(sheet(page)).toHaveCount(0);
  const notice = page.getByRole("status").locator(".notice");
  await expect(notice).toHaveText("取り消しました");
  // 知らせは、ヘッダのすぐ下に、本文に重ねて出す。押しても消えず、数秒で自動的に消える
  const headerBox = await page.getByRole("banner").boundingBox();
  const noticeBox = await notice.boundingBox();
  const headerBottom = (headerBox?.y ?? 0) + (headerBox?.height ?? 0);
  expect(noticeBox?.y).toBeGreaterThanOrEqual(headerBottom);
  expect(noticeBox?.y).toBeLessThan(headerBottom + 16);
  await page.mouse.click((noticeBox?.x ?? 0) + 10, (noticeBox?.y ?? 0) + 10);
  await expect(notice).toBeVisible();
  await expect(page.getByText("取り消し済み")).toBeVisible();
  await expect(page.getByRole("button", { name: "取り消す" })).toHaveCount(0);
  await expect(page.getByRole("main").getByText("未", { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s08-after-cancel");

  // 停止中に戻ると、取り消しの行が先頭に並ぶ。出る件数は、画面の高さで変わる
  await page.getByRole("button", { name: "戻る" }).click();
  const rows = page.getByRole("main").getByRole("button", { name: /test-/ });
  await expect(rows.nth(0)).toContainText("取り消し");
  await expect(rows.nth(0)).toContainText("test-carol");

  // 履歴。1 回の操作を 1 行にまとめ、操作者と、未同期のアイコンを出す
  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(OPERATOR_NAME);
  await expect(rows.nth(0).getByRole("img", { name: "未同期" })).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s07");

  // 検索欄で絞り込む。取り消しの記録も、ユーザ名とチケット番号を持つ
  const filter = page.getByRole("textbox", { name: "履歴を検索" });
  await filter.fill("carol");
  await expect(rows).toHaveCount(2);
  await filter.fill("A-12");
  await expect(rows).toHaveCount(1);

  // 取り消しの記録の詳細。経路の位置に、理由を出す。「その他」は、自由記述を出す。「取り消す」は置かない
  await filter.fill("carol");
  await rows.nth(0).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("取り消し");
  await expect(page.getByRole("term").nth(1)).toHaveText("理由");
  await expect(details.nth(1)).toHaveText("受付の練習で読み取った");
  await expect(page.getByRole("button", { name: "取り消す" })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s08-cancel");

  // 「戻る」で履歴に戻ると、検索欄の入力は残る
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(filter).toHaveValue("carol");
  await filter.fill("どこにもない記録");
  await expect(page.getByText("記録なし")).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s07-empty");

  // 取り消したチケットは、読み取り直せば、また成功になる
  await page.getByRole("button", { name: "戻る" }).click();
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
});

test("メニューと、ログアウト", async ({ page, baseURL, browserName }, testInfo) => {
  await login(page, baseURL, { offline: false });
  await page.getByRole("button", { name: "メニュー" }).click();

  const value = (label: string) => page.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd");
  await expect(value("ユーザ")).toHaveText(OPERATOR_NAME);
  await expect(value("端末")).toHaveText(/^端末 [0-9A-Z]{4}$/);
  await expect(value("データ")).toContainText("テスト本編");
  await expect(value("データ")).toContainText("テスト託児所");
  // Service Worker は Chromium で確かめる（Design Doc 11 章）
  if (browserName === "chromium") await expect(value("アプリ")).toContainText("オフラインで起動できます");
  await expect(value("同期")).toContainText(/\d{2}:\d{2}/);
  await expect(value("同期").getByRole("img", { name: "同期済み" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "音" })).toHaveAttribute("aria-checked", "true");
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s09");

  // 音の切り替えは、端末に保存する
  await page.getByRole("switch", { name: "音" }).click();
  await expect(page.getByRole("switch", { name: "音" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "音を試す" }).click();

  // オフラインでは「今すぐ同期」を押せない
  await expect(page.getByRole("button", { name: "今すぐ同期" })).toBeEnabled();
  await goOffline(page);
  await expect(page.getByRole("button", { name: "今すぐ同期" })).toBeDisabled();

  // ログアウトの確認。オフラインのときは、断りを足す。やめると、何もせずに閉じる
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(sheet(page)).toContainText("この端末のデータを消してログアウトします");
  await expect(sheet(page)).toContainText("オフラインです。再ログインとデータの取得にはネットワークが必要です");
  await expect(sheet(page)).not.toContainText("未同期の記録も消えます");
  await settle(page);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s09-d1");
  await sheet(page).getByRole("button", { name: "やめる" }).click();
  await expect(sheet(page)).toHaveCount(0);

  // 確定すると、端末のデータを消して、S01 の未ログインに進む。確定ボタンは、開いてから 0.5 秒間は押せない
  expect(await disabledJustAfter(page, "ログアウト", "ログアウト")).toBe(true);
  await confirm(page, "ログアウト");
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  await expect(scanButton(page)).toHaveCount(0);
});

test("シート: 下に引くと閉じる。確認のシートは、つまみを出さず、引いても閉じない", async ({ page, baseURL }) => {
  await login(page, baseURL);
  const grip = page.locator(".sheet-grip");

  /** シートの上端を押さえて、下に 150px 引く */
  const pullDown = async () => {
    const box = await sheet(page).boundingBox();
    if (box === null) throw new Error("シートがない");
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 162, { steps: 5 });
    await page.mouse.up();
  };

  // 一覧は、下に引いて閉じられる
  await page.getByRole("button", { name: "受付を切り替える" }).click();
  await settle(page);
  await expect(grip).toBeVisible();
  await pullDown();
  await expect(sheet(page)).toHaveCount(0);

  // 確認は、下に引いても閉じない。入力が消えたり、一覧に戻るのか閉じるのかが紛らわしくなったりしない
  await page.getByRole("button", { name: "受付を切り替える" }).click();
  await sheet(page).getByRole("button", { name: /前夜祭受付/ }).click();
  await settle(page);
  await expect(grip).toHaveCount(0);
  await pullDown();
  await expect(sheet(page).getByRole("button", { name: "切り替える" })).toBeVisible();
});

test("戻る操作: その場で押せる「戻る」「終了」「閉じる」と同じに扱い、結果では何もしない", async ({ page, baseURL }) => {
  // Android の端末の戻る操作（画面設計書 2.1）。ブラウザの履歴を戻して確かめる
  await login(page, baseURL);

  // S05 では「戻る」と同じ
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "検索" })).toBeVisible();
  await page.goBack();
  await expect(scanButton(page)).toBeVisible();

  // 読み取り中では「終了」と同じ
  await startScanning(page);
  await page.goBack();
  await expect(scanButton(page)).toBeVisible();

  // 結果では、何もしない。下部のボタンでだけ抜けられる（FR-22）
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await page.goBack();
  await page.waitForTimeout(300);
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await page.goBack();
  await page.waitForTimeout(300);
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);

  // S08 を S07 から開いたときは S07 へ、S07 からは停止中へ
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();
  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  await page.getByRole("main").getByRole("button").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("チェックイン");
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "履歴を検索" })).toBeVisible();
  await page.goBack();
  await expect(scanButton(page)).toBeVisible();
});

test("受付の変化: 期間の境界で受付が変わると、知らせを出して、受付のカードを強調する", async ({ page, baseURL }, testInfo) => {
  // 本編受付の期間の終わり（2030-01-01 00:00。懇親会受付の期間の始まり）の 30 秒前から始める
  await page.clock.install({ time: new Date("2029-12-31T23:59:30+09:00") });
  await login(page, baseURL);
  const card = page.getByRole("button", { name: "受付を切り替える" });
  await expect(card).toContainText("本編受付");
  await expect(card).not.toHaveClass(/emphasis/);

  // 境界を越える。スタッフの操作によらない変化なので、知らせを出し、受付のカードをしばらく強調する
  await page.clock.fastForward(40_000);
  await expect(page.getByRole("status")).toContainText("懇親会受付になりました");
  await expect(card).toContainText("懇親会受付");
  await expect(card).toContainText("自動");
  await expect(card).toHaveClass(/emphasis/);
  await expect(card).toHaveCSS("background-color", "rgb(249, 231, 166)");
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s02-reception-changed");

  // 知らせは数秒で消え、強調も終わる
  await page.clock.fastForward(5000);
  await expect(page.getByRole("status")).toBeEmpty();
  await expect(card).not.toHaveClass(/emphasis/);

  // ほかの画面では、ヘッダの受付を強調する。受付操作の途中（結果）では、変化を保留する
  await page.clock.setSystemTime(new Date("2030-01-01T23:59:30+09:00"));
  await page.clock.fastForward(1000);
  await scan(page, qr("party", "I-3"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await page.clock.fastForward(40_000);
  await expect(page.getByRole("banner")).toContainText("懇親会受付");
  await expect(page.getByRole("status")).toBeEmpty();
  // 結果を離れた時点で反映する。どの受付の期間にも当たらないので、受付なしになる
  await next(page);
  await expect(page.getByRole("status")).toContainText("受付なしになりました");
  // 受付なしでは、読み取り中にならず、停止中にとどまる（FR-7）。カメラを使えない端末は、検索に移っている
  if (!hasCamera(page)) await page.getByRole("button", { name: "戻る" }).click();
  await expect(page.getByRole("button", { name: "受付を切り替える" })).toContainText("受付なし");
  await expect(scanButton(page)).toBeDisabled();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s02-none");
});

test("読み取りから結果: チケットなし", async ({ page, baseURL }, testInfo) => {
  await login(page, baseURL);

  // ラウンジ受付は、本編と懇親会を受け付け、本編の所持が必須で、懇親会だけをチェックインする。手動で切り替える
  await page.getByRole("button", { name: "受付を切り替える" }).click();
  await sheet(page).getByRole("button", { name: /ラウンジ受付.*これから/ }).click();
  await confirm(page, "切り替える");
  await expect(page.getByRole("button", { name: "受付を切り替える" })).toContainText("ラウンジ受付");

  // 本編のチケットだけを持つ人。所持が必須の条件は満たすが、チェックインするイベントのチケットを持たない（FR-16）。
  // 拒否と同じ色と結果名で、帯の 1 行には、拒否メッセージではなく、足りないチケットのイベント名を出す
  await scan(page, qr("main", "A-6"));
  await expect(resultTitle(page)).toHaveText("受け付けられません");
  await expect(page.getByText("テスト懇親会のチケットがありません")).toBeVisible();
  await expect(page.getByText("本編チケットがありません")).toHaveCount(0);
  await expect(page.getByText("test-dave")).toBeVisible();
  await expect(page.getByText("今回")).toHaveCount(0);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s04-no-ticket");
  await next(page);

  // 記録は残さない
  await startScanning(page);
  await expect(page.getByText("直近の記録")).toHaveCount(0);

  // 懇親会のチケットも持つ人は、懇親会だけが済みになる
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await expect(page.getByText("今回")).toHaveCount(1);
  await expect(page.locator(".ticket-row", { hasText: "今回" })).toContainText("I-1 テスト懇親会チケット");
});

test("S99: 端末の記憶域への書き込みに失敗すると、エラーの画面に移り、「再読み込み」で戻る", async ({ page, baseURL }, testInfo) => {
  // 記録は作られないので、オンラインのままにする
  await login(page, baseURL, { offline: false });

  // IndexedDB への書き込みを、失敗させる
  await page.evaluate(() => {
    const fail = () => {
      throw new DOMException("書き込めない", "QuotaExceededError");
    };
    IDBObjectStore.prototype.add = fail;
    IDBObjectStore.prototype.put = fail;
  });

  // 判定の結果を表示する前に記録を書く。書けなければ、結果を出さずに S99 に移る
  await scan(page, qr("main", "A-5"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("エラーが発生しました");
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s99");

  // 「再読み込み」で、アプリを読み込み直す。書けなかった記録は、残っていない
  await page.getByRole("button", { name: "再読み込み" }).click();
  await expect(scanButton(page)).toBeVisible();
  await expect(page.getByText("直近の記録")).toHaveCount(0);
});

test("再ログイン: セッションが切れても受付は続けられ、S05 と S07 のヘッダからも再ログインに移れる", async ({ page, context, baseURL }) => {
  await login(page, baseURL, { offline: false });
  const header = page.getByRole("banner");
  const relogin = header.getByRole("button").filter({ has: page.getByRole("img", { name: "再ログインが必要" }) });

  // セッションの Cookie をなくして同期すると、401 が返り、ヘッダが「再ログインが必要」になる（FR-36）
  await context.clearCookies();
  await header.getByRole("button").filter({ has: page.getByRole("img", { name: "同期済み" }) }).click();
  await expect(relogin).toBeVisible();

  // S05 のヘッダから。S01 に移り、「戻る」で、ログインせずに停止中に戻る
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await relogin.click();
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(scanButton(page)).toBeVisible();

  // S07 のヘッダから
  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  await relogin.click();
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(scanButton(page)).toBeVisible();

  // 受付操作の途中（S06）では、押しても S01 に移らない（画面設計書 2.3）
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await page.getByRole("textbox", { name: "検索" }).fill("test-carol");
  await page.getByRole("main").getByRole("button").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("test-carol");
  await relogin.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("test-carol");
  await page.getByRole("button", { name: "戻る" }).click();
  await page.getByRole("button", { name: "戻る" }).click();

  // 読み取りは続けられる
  await scan(page, qr("main", "A-5"));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();

  await page.getByRole("button", { name: "メニュー" }).click();

  // S09 の「今すぐ同期」からも、再ログインに移れる
  await page.getByRole("button", { name: "今すぐ同期" }).click();
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(scanButton(page)).toBeVisible();
});
