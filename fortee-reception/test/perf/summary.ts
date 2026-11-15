import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";

// 計測（run.ts）の結果を、ラベルごとに並べて出す。
//
//   node test/perf/summary.ts before-1 after-1 ...
//
// 値は「中央値 [最小〜最大]」。回をまたぐ値（押してからの時間など）は、すべての回の値を合わせて数える。

type Json = Record<string, unknown>;

const labels = process.argv.slice(2);
const files = labels.map((label) => JSON.parse(readFileSync(join(PROJECT_ROOT, "test-results", "perf", `${label}.json`), "utf8")) as Json);

function spread(values: number[]): string {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const round = (value: number): number => Math.round(value * 10) / 10;
  return `${round(median)} [${round(sorted[0] ?? 0)}〜${round(sorted.at(-1) ?? 0)}]`;
}

/** 各回の結果から、path の値を集める。配列の値は、ならして合わせる */
function collect(file: Json, scenario: string, path: string[]): number[] {
  const runs = (file[scenario] as Json[] | undefined) ?? [];
  return runs.flatMap((run) => {
    let value: unknown = run;
    for (const key of path) value = (value as Json | undefined)?.[key];
    return Array.isArray(value) ? (value as number[]) : typeof value === "number" ? [value] : [];
  });
}

const rows: [string, string, string[]][] = [
  ["ホームで待機: メインスレッドの処理時間 ms / 窓", "idle", ["TaskDuration"]],
  ["ホームで待機: スクリプト ms / 窓", "idle", ["ScriptDuration"]],
  ["履歴を開いたまま待機: 処理時間 ms / 窓", "history", ["idle", "TaskDuration"]],
  ["履歴: DOM の要素数", "history", ["idle", "Nodes"]],
  ["履歴: ヒープ MB", "history", ["idle", "JSHeapUsedMB"]],
  ["履歴を開く ms", "history", ["openMs"]],
  ["履歴を開く: スクリプト ms", "history", ["openBreakdown", "script"]],
  ["履歴を開く: スタイル ms", "history", ["openBreakdown", "style"]],
  ["履歴を開く: レイアウト ms", "history", ["openBreakdown", "layout"]],
  ["履歴を開く（CPU 4 倍遅）ms", "history", ["openMsX4"]],
  ["履歴の絞り込みの入力 ms", "history", ["keystrokes"]],
  ["履歴の絞り込みの入力（CPU 4 倍遅）ms", "history", ["keystrokesX4"]],
  ["検索の入力 ms", "search", ["keystrokes"]],
  ["検索の入力（CPU 4 倍遅）ms", "search", ["keystrokesX4"]],
  ["読み取り中（QR なし）: 処理時間 ms / 窓", "scanNoQr", ["TaskDuration"]],
  ["読み取り中に「終了」: 処理開始までの待ち（CPU 4 倍遅）ms", "scanTap", ["delay"]],
  ["読み取り中に「終了」: 次の描画まで（CPU 4 倍遅）ms", "scanTap", ["duration"]],
  ["受付の繰り返し 20 回: 処理時間 ms", "checkinLoop", ["TaskDuration"]],
  ["受付の繰り返し: 読み取りから結果 ms", "checkinLoop", ["hookToResult"]],
  ["カメラの QR: 取り出しから結果 ms（NFR-1）", "cameraLoop", ["scanToResult"]],
  ["カメラの QR: 「次へ」から結果 ms", "cameraLoop", ["tapToResult"]],
  ["1 回の読み取り（いまの手順）: 中央値 ms", "pipeline", ["current", "totalMedian"]],
  ["1 回の読み取り（キャンバスを使い回す）: 中央値 ms", "pipeline", ["reuse", "totalMedian"]],
  ["  うち drawImage ms", "pipeline", ["current", "steps", "drawImage"]],
  ["  うち getImageData ms", "pipeline", ["current", "steps", "getImageData"]],
  ["  うち jsQR ms", "pipeline", ["current", "steps", "decode"]],
  ["  うち大きさの入れ直しと文脈の取得 ms", "pipeline", ["current", "steps", "resize"]],
];

console.log(["指標", ...labels].join(" | "));
for (const [name, scenario, path] of rows) {
  console.log([name, ...files.map((file) => spread(collect(file, scenario, path)))].join(" | "));
}
