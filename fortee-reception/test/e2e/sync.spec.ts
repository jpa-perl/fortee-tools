import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { exportRecords } from "../../src/cli/commands/export.ts";
import { profileUrlTokenOf, ticketTokenOf } from "../cli/synthetic-zip.ts";
import { login, next, type Operator, resultTitle, scan, scanButton, startScanning } from "./helpers.ts";
import { E2E_ENVIRONMENTS, E2E_EVENTS, qr } from "./setup/data.ts";
import { importAndPublish } from "./setup/prepare.ts";

// アプリ、サーバ、別の端末、管理 CLI の書き出しを、1 本で通す（PRD の AC-1 のローカル版）。
// ほかの spec は記録をサーバに送らないので、この経路は、ここでだけ通る。
// 専用のサーバとデータ（setup/data.ts の sync）を使い、Chromium だけで、直列に走らせる（playwright.config.ts）。
// 端末は、ブラウザのコンテキストで分ける。コンテキストごとに IndexedDB が別なので、端末 ID も別になる

const ENVIRONMENT = E2E_ENVIRONMENTS.sync;
const OPERATOR_A: Operator = { sub: "111111111111111111", name: "受付 A" };
const OPERATOR_B: Operator = { sub: "222222222222222222", name: "受付 B" };

async function openDevice(browser: Browser, baseURL: string | undefined, operator: Operator): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, baseURL, { offline: false, operator });
  return page;
}

const status = (page: Page, name: string) => page.getByRole("banner").getByRole("img", { name, exact: true });

/**
 * ヘッダの同期の状態を押して同期し、終わるのを待つ。もとから「同期済み」の端末でも、押した後の同期が
 * 終わるのを待てるように、同期の応答を待つ
 */
async function sync(page: Page): Promise<void> {
  const done = page.waitForResponse((response) => response.url().endsWith("/api/sync") && response.ok());
  await page
    .getByRole("banner")
    .getByRole("button")
    .filter({ has: page.getByRole("img", { name: /^(同期済み|未同期あり|同期の失敗)$/ }) })
    .click();
  await done;
  await expect(status(page, "同期済み")).toBeVisible();
}

/** 読み取り中や検索から、停止中（S02）に戻る */
async function toIdle(page: Page): Promise<void> {
  await startScanning(page);
  await page.getByRole("button", { name: "終了" }).click();
  await expect(scanButton(page)).toBeVisible();
}

async function checkIn(page: Page, ticketNo: string): Promise<void> {
  await scan(page, qr("main", ticketNo));
  await expect(resultTitle(page)).toHaveText("チェックインしました");
  await next(page);
}

/** S09 の行の値 */
const menuValue = (page: Page, label: string) => page.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd");

/** CSV を、見出しの行を除いた行の配列にする。このテストの値は、引用符も改行も含まない */
async function readCsv(path: string): Promise<{ header: string[]; rows: string[][] }> {
  const lines = (await readFile(path, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line !== "");
  const [header, ...rows] = lines.map((line) => line.split(","));
  return { header: header ?? [], rows };
}

test("チェックイン、同期、別の端末での済みと取り消し、再チェックイン、書き出し、公開し直し", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(240_000);

  // ───── 端末 A: オンラインのままチェックインして、同期する（FR-40） ─────
  const a = await openDevice(browser, baseURL, OPERATOR_A);
  await checkIn(a, "A-5");
  await checkIn(a, "A-12");
  await toIdle(a);
  await expect(status(a, "未同期あり")).toBeVisible();
  await sync(a);
  await a.getByRole("button", { name: "メニュー" }).click();
  const deviceA = (await menuValue(a, "端末").textContent()) ?? "";
  expect(deviceA).toMatch(/^端末 [0-9A-Z]{4}$/);
  await a.getByRole("button", { name: "戻る" }).click();

  // ───── 端末 B: ログインして同期すると、A の記録が履歴に出る（FR-28） ─────
  const b = await openDevice(browser, baseURL, OPERATOR_B);
  await b.getByRole("button", { name: "メニュー" }).click();
  const deviceB = (await menuValue(b, "端末").textContent()) ?? "";
  expect(deviceB).not.toBe(deviceA);
  await b.getByRole("button", { name: "戻る" }).click();
  // この端末で行った操作はないので、停止中の直近の記録には出ない
  await expect(b.getByText("直近の記録")).toHaveCount(0);
  await b.getByRole("button", { name: "履歴をすべて見る" }).click();
  const historyB = b.getByRole("main").getByRole("button");
  await expect(historyB).toHaveCount(2);
  await expect(historyB.nth(0)).toContainText("test-frank");
  await expect(historyB.nth(0)).toContainText("A-12");
  await expect(historyB.nth(0)).toContainText(OPERATOR_A.name);
  // 同期済みの記録には、未同期のアイコンを付けない
  await expect(b.getByRole("img", { name: "未同期" })).toHaveCount(0);
  await b.getByRole("button", { name: "戻る" }).click();

  // B が同じチケットを読むと、済みになる。根拠は A の記録（FR-16）
  await scan(b, qr("main", "A-5"));
  await expect(resultTitle(b)).toHaveText("チェックイン済み");
  await expect(b.getByText(/^\d{2}:\d{2} 本編受付$/)).toBeVisible();
  await expect(b.getByText(`${OPERATOR_A.name}・${deviceA}`)).toBeVisible();
  await next(b);
  await toIdle(b);

  // ───── 端末 B: A の記録から取り消す（FR-29）。A-5 は誤操作、A-12 はその他 ─────
  const cancelOnB = async (user: string, reason: "誤操作" | "その他", text?: string) => {
    await b.getByRole("button", { name: "履歴をすべて見る" }).click();
    await b.getByRole("textbox", { name: "履歴を検索" }).fill(user);
    await b.getByRole("main").getByRole("button", { name: /チェックイン/ }).first().click();
    // 他端末の記録の詳細。操作者と端末は、A のもの
    await expect(b.getByRole("definition").nth(2)).toHaveText(OPERATOR_A.name);
    await expect(b.getByRole("definition").nth(3)).toHaveText(deviceA);
    await b.getByRole("button", { name: "取り消す" }).click();
    const dialog = b.getByRole("dialog");
    await dialog.getByRole("radio", { name: reason }).check();
    if (text !== undefined) await dialog.getByRole("textbox", { name: "理由" }).fill(text);
    await dialog.getByRole("button", { name: "取り消す" }).click();
    await expect(b.getByRole("status")).toContainText("取り消しました");
    await expect(b.getByText("取り消し済み")).toBeVisible();
    await b.getByRole("button", { name: "戻る" }).click();
    await b.getByRole("button", { name: "戻る" }).click();
  };
  await cancelOnB("test-carol", "誤操作");
  await cancelOnB("test-frank", "その他", "受付の練習で読み取った");
  await sync(b);

  // ───── 端末 A: 同期の後、取り消されたチケットは未に戻り、再チェックインできる（FR-30） ─────
  await sync(a);
  await a.getByRole("button", { name: "履歴をすべて見る" }).click();
  const historyA = a.getByRole("main").getByRole("button");
  await expect(historyA).toHaveCount(4);
  await expect(historyA.filter({ hasText: "取り消し" })).toHaveCount(2);
  await expect(historyA.filter({ hasText: "取り消し" }).first()).toContainText(OPERATOR_B.name);
  // 自分のチェックインの記録は、取り消し済みになり、「取り消す」は出ない
  await a.getByRole("textbox", { name: "履歴を検索" }).fill("test-carol");
  await a.getByRole("main").getByRole("button", { name: /チェックイン/ }).first().click();
  await expect(a.getByText("取り消し済み")).toBeVisible();
  await expect(a.getByRole("main").getByText("未", { exact: true })).toBeVisible();
  await expect(a.getByRole("button", { name: "取り消す" })).toHaveCount(0);
  await a.getByRole("button", { name: "戻る" }).click();
  await a.getByRole("button", { name: "戻る" }).click();
  await checkIn(a, "A-5");
  await toIdle(a);
  await sync(a);

  // B にも、A の再チェックインが届く。検索の候補に、済みと出る（FR-25）
  await sync(b);
  await b.getByRole("button", { name: "検索", exact: true }).click();
  await b.getByRole("textbox", { name: "検索" }).fill("test-carol");
  await expect(b.getByRole("main").getByRole("button").first()).toContainText("A-5 済");
  await b.getByRole("textbox", { name: "検索" }).fill("test-frank");
  await expect(b.getByRole("main").getByRole("button").first()).toContainText("A-12 未");
  await b.getByRole("button", { name: "戻る" }).click();

  // ───── 管理 CLI の書き出し（FR-45、PRD 7.3） ─────
  const out = testInfo.outputPath("export");
  await exportRecords(ENVIRONMENT.target, { out }, { now: () => Date.now(), release: "e2e", log: () => {} });

  // 一括チェックイン CSV。済みのチケットを、profile_url_token と、オフセット付きの ISO 8601 の時刻で 1 行ずつ
  const bulk = await readCsv(join(out, "bulk-checkin-1.csv"));
  expect(bulk.header).toEqual(["profile_url_token", "checkined_at"]);
  expect(bulk.rows).toHaveLength(1);
  expect(bulk.rows[0]?.[0]).toBe(profileUrlTokenOf(E2E_EVENTS.main, "A-5"));
  expect(bulk.rows[0]?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+09:00$/);

  // 取り消し一覧。取り消したままのチケットを、理由つきで
  const cancelled = await readCsv(join(out, "cancelled.csv"));
  expect(cancelled.rows).toHaveLength(1);
  const cell = (name: string) => cancelled.rows[0]?.[cancelled.header.indexOf(name)];
  expect(cell("ticket_token")).toBe(ticketTokenOf(E2E_EVENTS.main, "A-12"));
  expect(cell("ticket_no")).toBe("A-12");
  expect(cell("user_name")).toBe("test-frank");
  expect(cell("cancelled_reception")).toBe("main");
  expect(cell("cancelled_reason_kind")).toBe("その他");
  expect(cell("cancelled_reason_text")).toBe("受付の練習で読み取った");
  expect(cell("cancelled_operator_name")).toBe(OPERATOR_B.name);
  expect(cell("cancelled_device_name")).toBe(deviceB);

  // 端末の一覧。2 台
  const devices = await readCsv(join(out, "devices.csv"));
  expect(devices.rows.map((row) => row[devices.header.indexOf("device_name")]).sort()).toEqual([deviceA, deviceB].sort());

  // ───── 公開し直し。端末は、次の同期で新しい版を受け取る（FR-42） ─────
  await a.getByRole("button", { name: "メニュー" }).click();
  const before = (await menuValue(a, "データ").textContent()) ?? "";
  await a.getByRole("button", { name: "戻る" }).click();
  // 取り込み日時を 1 時間先にして、画面に出る版（分まで）が、前の版と必ず変わるようにする
  await importAndPublish(ENVIRONMENT, Date.now() + 60 * 60 * 1000);
  await sync(a);
  await expect(a.getByRole("status")).toContainText("データを更新しました");
  await a.getByRole("button", { name: "メニュー" }).click();
  await expect(menuValue(a, "データ")).not.toHaveText(before);
  await expect(menuValue(a, "データ")).toContainText("テスト本編");
  await a.getByRole("button", { name: "戻る" }).click();

  // 差し替えた後も、記録はそのままで、読み取りを続けられる
  await checkIn(a, "A-12");

  await a.context().close();
  await b.context().close();
});
