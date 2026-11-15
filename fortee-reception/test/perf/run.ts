import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page, webkit } from "@playwright/test";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";
import { addSessionCookie, goOffline, scanButton } from "../e2e/helpers.ts";
import { type QrMatrix, qrMatrix } from "../e2e/qr-matrix.ts";
import { E2E_ENVIRONMENTS, e2eOrigin } from "../e2e/setup/data.ts";
import { readTlsOptions } from "../e2e/setup/tls.ts";
import { DECODER_SIDES, decoderBench, pipelineBench, seedDatabase } from "./in-page.ts";

// 長時間運用の CPU 負荷の計測（変更の前後を、同じ条件で比べるためのもの）。
//
//   node test/perf/run.ts <ラベル> [--runs 3] [--window 30] [--scale 1] [--only idle,history,...]
//
// 画面のテストと同じサーバ（test/e2e/setup/serve.ts。本番と同じ最適化のビルドに、テスト用の入口だけを足したもの）を
// 起動し、合成のデータ（PRD NFR-1 の規模: チケット 1,500 枚、記録 3,000 件。--scale で倍率）を端末の記憶域に
// 置いてから、状態ごとに、決まった時間のメインスレッドの処理時間を CDP（Performance.getMetrics）で測る。
// 結果は test-results/perf/<ラベル>.json に書く。CI と `npm run test:e2e` からは走らない。
//
// 測れるのは、デスクトップの Chromium のメインスレッドの処理時間と、描画の回数、DOM の要素数、ヒープである。
// 実機のカメラ、GPU、画面、通信の電力は測れない。偽のカメラの映像の取り出し（drawImage）の時間も、実機の値ではない。

const args = process.argv.slice(2);
// ラベルを省いて、オプションから書き始めたときに、オプションの名前をラベルにしない
const label = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : "run";
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const RUNS = Number(option("runs", "3"));
const WINDOW_S = Number(option("window", "30"));
const SCALE = Number(option("scale", "1"));
const ONLY = option("only", "").split(",").filter((name) => name !== "");
const TICKETS = 1500 * SCALE;
const RECORDS = 3000 * SCALE;

const environment = E2E_ENVIRONMENTS.main;
const baseURL = e2eOrigin(environment.port);
const outDir = join(PROJECT_ROOT, "test-results", "perf");
mkdirSync(outDir, { recursive: true });

/** 合成のチケットのトークン。in-page.ts の seedDatabase() と同じ規則 */
const perfToken = (i: number): string => `PERF${String(i).padStart(28, "0")}`;

// ───────── サーバ ─────────

async function reachable(): Promise<boolean> {
  // サーバが毎回作る自己署名の証明書（test/e2e/setup/tls.ts）。作られるまでは、応えていないものとして扱う
  const ca = await readTlsOptions().then((tls) => tls.cert, () => null);
  if (ca === null) return false;
  return new Promise((resolve) => {
    const request = get(baseURL, { ca }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1000, () => request.destroy());
  });
}

async function startServer(): Promise<ChildProcess> {
  const server = spawn("node", ["test/e2e/setup/serve.ts"], { cwd: PROJECT_ROOT, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 1800; i++) {
    if (await reachable()) return server;
    if (server.exitCode !== null) throw new Error("サーバが起動しなかった");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server.kill("SIGTERM");
  throw new Error("サーバが応えない");
}

// ───────── QR の映像 ─────────

/** 白地の中央に QR を置いた 640×480 の映像（Y4M）。Chromium の偽のカメラに渡す */
function writeQrVideo(path: string, matrix: QrMatrix): void {
  const width = 640;
  const height = 480;
  const modulePx = 5;
  const size = matrix.length * modulePx;
  const left = Math.floor((width - size) / 2);
  const top = Math.floor((height - size) / 2);
  const luma = Buffer.alloc(width * height, 235);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (matrix[Math.floor(y / modulePx)]?.[Math.floor(x / modulePx)] === true) luma[(top + y) * width + left + x] = 16;
    }
  }
  const chroma = Buffer.alloc((width * height) / 2, 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), luma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`);
  writeFileSync(path, Buffer.concat([header, ...Array.from({ length: 30 }, () => frame)]));
}

// ───────── 計測 ─────────

type Metrics = Record<string, number>;

async function metricsOf(cdp: CDPSession): Promise<Metrics> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

const WINDOW_KEYS = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"];

/** 決まった時間の間の、処理時間（ms）と回数の増分。終わりの時点の DOM の要素数とヒープも添える */
async function measureWindow(page: Page, cdp: CDPSession, seconds: number): Promise<Metrics> {
  const before = await metricsOf(cdp);
  await page.waitForTimeout(seconds * 1000);
  const after = await metricsOf(cdp);
  const result: Metrics = { seconds };
  for (const key of WINDOW_KEYS) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    result[key] = key.endsWith("Duration") ? Math.round(delta * 1000 * 10) / 10 : delta;
  }
  result.Nodes = after.Nodes ?? 0;
  result.JSHeapUsedMB = Math.round(((after.JSHeapUsedSize ?? 0) / 1024 / 1024) * 10) / 10;
  return result;
}

/** 操作から、その結果を描いた後までの時間（ms）。操作は、ページの中で同期に行う */
function interaction(page: Page, action: string): Promise<number> {
  return page.evaluate(async (source) => {
    const run = new Function(source) as () => void;
    const start = performance.now();
    run();
    // 状態の変更の後の描画（Preact の再描画は、次のフレームより前に済む）を待ち、その次のタスクで測る
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    return Math.round((performance.now() - start) * 10) / 10;
  }, action);
}

/** 操作の時間に、その間のスクリプト、スタイル、レイアウトの処理時間（ms）を添える */
async function interactionBreakdown(page: Page, cdp: CDPSession, action: string): Promise<Metrics> {
  const before = await metricsOf(cdp);
  const total = await interaction(page, action);
  const after = await metricsOf(cdp);
  const delta = (key: string): number => Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000 * 10) / 10;
  return { total, script: delta("ScriptDuration"), style: delta("RecalcStyleDuration"), layout: delta("LayoutDuration") };
}

const clickByText = (text: string): string =>
  `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click();`;
const typeInto = (value: string): string =>
  `const input = document.querySelector("input"); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event("input", { bubbles: true }));`;

type Session = { context: BrowserContext; page: Page; cdp: CDPSession };

/** ログインして、合成のデータを置き、オフラインで停止中（S02）に着く */
async function open(browser: Browser): Promise<Session> {
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    locale: "ja-JP",
    viewport: { width: 390, height: 844 },
    permissions: ["camera"],
    serviceWorkers: "allow",
  });
  const page = await context.newPage();
  await addSessionCookie(context, baseURL);
  await page.goto("/?login=ok");
  await scanButton(page).waitFor();
  await page.evaluate(() => window.__checkinTest?.setFastCheckin(true));
  await goOffline(page);
  await page.evaluate(seedDatabase, { tickets: TICKETS, records: RECORDS, now: Date.now() });
  await page.reload();
  await scanButton(page).waitFor();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  return { context, page, cdp };
}

const resultMark = (page: Page): Promise<number> =>
  page.evaluate(() => performance.getEntriesByName("checkin:result")[0]?.startTime ?? 0);

async function waitResult(page: Page, previous: number): Promise<number> {
  await page.waitForFunction((mark) => (performance.getEntriesByName("checkin:result")[0]?.startTime ?? 0) > mark, previous);
  return resultMark(page);
}

const scenarios: Record<string, (browser: Browser, qrBrowser: Browser) => Promise<unknown>> = {
  /** ログイン済みで、ホームの停止中に待機している */
  async idle(browser) {
    const { context, page, cdp } = await open(browser);
    await page.waitForTimeout(2000);
    const result = await measureWindow(page, cdp, WINDOW_S);
    await context.close();
    return result;
  },

  /** 履歴（S07）を開く、絞り込む、開いたまま待つ */
  async history(browser) {
    const { context, page, cdp } = await open(browser);
    const open_ = await interactionBreakdown(page, cdp, clickByText("履歴をすべて見る"));
    const openMs = open_.total;
    await page.getByRole("textbox", { name: "履歴を検索" }).waitFor();
    await page.waitForTimeout(2000);
    const idle = await measureWindow(page, cdp, WINDOW_S);
    const keystrokes: number[] = [];
    for (const value of ["p", "pe", "per", "perf-user-12", "perf-user-123", ""]) keystrokes.push(await interaction(page, typeInto(value)));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const keystrokesX4: number[] = [];
    for (const value of ["p", "pe", "per", "perf-user-12", "perf-user-123", ""]) keystrokesX4.push(await interaction(page, typeInto(value)));
    const backMs = await interaction(page, clickByText("戻る"));
    const openMsX4 = await interaction(page, clickByText("履歴をすべて見る"));
    await context.close();
    return { openMs, openBreakdown: open_, openMsX4, backMsX4: backMs, keystrokes, keystrokesX4, idle };
  },

  /** 検索（S05）の入力 */
  async search(browser) {
    const { context, page, cdp } = await open(browser);
    await interaction(page, clickByText("検索"));
    await page.getByRole("textbox", { name: "検索" }).waitFor();
    const keystrokes: number[] = [];
    for (const value of ["p", "pe", "perf", "perf-user-12", "合成", "P-14", ""]) keystrokes.push(await interaction(page, typeInto(value)));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const keystrokesX4: number[] = [];
    for (const value of ["p", "pe", "perf", "perf-user-12", "合成", "P-14", ""]) keystrokesX4.push(await interaction(page, typeInto(value)));
    await context.close();
    return { keystrokes, keystrokesX4 };
  },

  /** カメラを起動しているが、QR が映っていない（Chromium の偽のカメラの、動く模様） */
  async scanNoQr(browser) {
    const { context, page, cdp } = await open(browser);
    await scanButton(page).click();
    await page.waitForFunction(() => (document.querySelector("video")?.videoWidth ?? 0) > 0);
    await page.waitForTimeout(2000);
    const result = await measureWindow(page, cdp, WINDOW_S);
    await context.close();
    return result;
  },

  /**
   * 読み取り中に「終了」を押してから、停止中を描くまで。CPU を 4 倍に遅くして、実際のポインタの入力で測る
   * （Event Timing。押した時刻から、処理を始めるまでの待ちと、次の描画まで）。デコードがメインスレッドを
   * ふさいでいる間に押した入力は、その分だけ待たされる
   */
  async scanTap(browser) {
    const { context, page, cdp } = await open(browser);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.evaluate(() => {
      const taps: { delay: number; duration: number }[] = [];
      (window as unknown as { __perfTaps: typeof taps }).__perfTaps = taps;
      const exits = new Set<number>();
      document.addEventListener(
        "click",
        (event) => {
          if ((event.target as Element | null)?.closest("button")?.textContent?.trim() === "終了") exits.add(event.timeStamp);
        },
        { capture: true },
      );
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEventTiming[]) {
          // 押したボタンは、描き直しで外れている（target は null）。「終了」を押した時刻（下の listener）と突き合わせる
          if (entry.name !== "click" || !exits.has(entry.startTime)) continue;
          taps.push({ delay: Math.round(entry.processingStart - entry.startTime), duration: Math.round(entry.duration) });
        }
        // durationThreshold は、TypeScript の DOM の型にまだない
      }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
    });
    for (let i = 0; i < 15; i++) {
      await scanButton(page).click();
      await page.waitForFunction(() => (document.querySelector("video")?.videoWidth ?? 0) > 0);
      // 押す時機を、150 ms の周期の中でずらす
      await page.waitForTimeout(600 + ((i * 37) % 150));
      await page.getByRole("button", { name: "終了" }).click();
      await scanButton(page).waitFor();
    }
    await page.waitForTimeout(300);
    const taps = await page.evaluate(() => (window as unknown as { __perfTaps: { delay: number; duration: number }[] }).__perfTaps);
    await context.close();
    return { delay: taps.map((tap) => tap.delay), duration: taps.map((tap) => tap.duration) };
  },

  /** 一定のペースで受付を繰り返す。チケットは毎回別（記録の保存を通る）。読み取りは、テスト用の入口から渡す */
  async checkinLoop(browser) {
    const { context, page, cdp } = await open(browser);
    const before = await metricsOf(cdp);
    const started = Date.now();
    const hookToResult: number[] = [];
    await scanButton(page).click();
    for (let i = 0; i < 20; i++) {
      await page.waitForFunction(() => (document.querySelector("video")?.videoWidth ?? 0) > 0);
      // 来場者を待つ時間
      await page.waitForTimeout(1500);
      const previous = await resultMark(page);
      const at = await page.evaluate((text) => {
        const now = performance.now();
        window.__checkinTest?.scan(text);
        return now;
      }, `fortee:${perfToken(TICKETS - 1 - i)}`);
      hookToResult.push(Math.round(((await waitResult(page, previous)) - at) * 10) / 10);
      // 結果を出したまま、次の操作を待つ時間
      await page.waitForTimeout(1000);
      await page.getByRole("button", { name: "次へ", exact: true }).click();
    }
    const after = await metricsOf(cdp);
    await context.close();
    return {
      wallSeconds: Math.round((Date.now() - started) / 100) / 10,
      TaskDuration: Math.round(((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000),
      ScriptDuration: Math.round(((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000),
      hookToResult,
    };
  },

  /** カメラの映像の QR を、本物の経路（取り出し、デコード、判定、結果）で読み取る。同じチケットを繰り返す */
  async cameraLoop(_browser, qrBrowser) {
    const { context, page } = await open(qrBrowser);
    const scanToResult: number[] = [];
    const tapToResult: number[] = [];
    await scanButton(page).click();
    let tapped = Date.now();
    let previous = 0;
    for (let i = 0; i < 8; i++) {
      previous = await waitResult(page, previous);
      tapToResult.push(Date.now() - tapped);
      scanToResult.push(
        await page.evaluate(() => Math.round((performance.getEntriesByName("checkin:scan-to-result")[0]?.duration ?? -1) * 10) / 10),
      );
      await page.waitForTimeout(1000);
      // 直後の 3 秒間は、同じチケットを無視する（画面設計書 2.6）。受理は、その後になる
      await page.getByRole("button", { name: "次へ", exact: true }).click();
      tapped = Date.now();
    }
    await context.close();
    return { scanToResult, tapToResult };
  },

  /** 読み取りの 1 回の処理の内訳。実際の映像の要素から、アプリと同じ手順で取り出す */
  async pipeline(browser) {
    const { context, page } = await open(browser);
    await scanButton(page).click();
    await page.waitForFunction(() => (document.querySelector("video")?.videoWidth ?? 0) > 0);
    await page.addScriptTag({ content: readFileSync(join(PROJECT_ROOT, "node_modules", "jsqr", "dist", "jsQR.js"), "utf8") });
    const result = await page.evaluate(pipelineBench, { iterations: 200 });
    await context.close();
    return result;
  },
};

/** デコーダだけの時間と成功率。合成の画像を、ページの中で作って渡す。iOS の JavaScriptCore に近い WebKit でも測る */
async function decoder(): Promise<unknown> {
  const matrix = qrMatrix(`fortee:${perfToken(0)}`);
  const script = readFileSync(join(PROJECT_ROOT, "node_modules", "jsqr", "dist", "jsQR.js"), "utf8");
  const result: Record<string, unknown> = {};
  for (const [name, type] of [["chromium", chromium], ["webkit", webkit]] as const) {
    const browser = await type.launch();
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ content: script });
    result[name] = await page.evaluate(decoderBench, { matrix, sides: DECODER_SIDES, iterations: 30 });
    await browser.close();
  }
  return result;
}

// ───────── 実行 ─────────

const wanted = (name: string): boolean => ONLY.length === 0 || ONLY.includes(name);
const results: Record<string, unknown> = { label, runs: RUNS, windowSeconds: WINDOW_S, tickets: TICKETS, records: RECORDS };

if (wanted("decoder")) {
  results.decoder = await decoder();
  console.error("decoder: done");
}

const names = Object.keys(scenarios).filter(wanted);
if (names.length > 0) {
  const server = await startServer();
  const qrVideo = join(outDir, "qr.y4m");
  writeQrVideo(qrVideo, qrMatrix(`fortee:${perfToken(0)}`));
  const launchArgs = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--ignore-certificate-errors"];
  // 起動に失敗したときも、サーバのプロセスと、起動できたほうのブラウザを残さない
  const browsers: Browser[] = [];
  try {
    const browser = await chromium.launch({ args: launchArgs });
    browsers.push(browser);
    const qrBrowser = await chromium.launch({ args: [...launchArgs, `--use-file-for-fake-video-capture=${qrVideo}`] });
    browsers.push(qrBrowser);
    for (const name of names) results[name] = [];
    // 状態の順を、回ごとに逆にする。先に測った状態の影響（温度、JIT、キャッシュ）が、同じ状態に偏らないようにする
    for (let run = 0; run < RUNS; run++) {
      for (const name of run % 2 === 0 ? names : [...names].reverse()) {
        const scenario = scenarios[name];
        if (scenario === undefined) continue;
        (results[name] as unknown[]).push(await scenario(browser, qrBrowser));
        console.error(`${name} #${run + 1}: done`);
      }
    }
  } finally {
    await Promise.allSettled(browsers.map((launched) => launched.close()));
    server.kill("SIGTERM");
  }
}

const out = join(outDir, `${label}.json`);
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(out);
