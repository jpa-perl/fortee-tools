import type { Page } from "@playwright/test";
import { SELF_TEST_TEXT, selfTestPixels } from "../../src/app/services/detector-self-test.ts";

// ページのブラウザの検出器（BarcodeDetector）が、受付アプリの条件で「使える」かを確かめる。
// 画面のテスト（frame-detector.spec.ts）と、計測（test/perf/run.ts）が、同じ手順を使う。
//
// 手順は、受付アプリの createFrameDetector()（src/app/services/frame-detector.ts）と同じである。QR に対応していて、
// 確認用の画像（detector-self-test.ts）を読めた検出器だけを「使える」とする。ページの中で動かすので、受付アプリの
// 関数は呼べず、ここに書いている。画像と期待する内容は、受付アプリのものをそのまま渡す。
// createFrameDetector() の条件を変えたら、ここも合わせる

/** none は検出器がない、no qr_code は QR に対応していない、not operational は確認用の画像を読めない */
export type DetectorState = "none" | "no qr_code" | "qr_code" | "qr_code (not operational)";

/** 検出器は、安全なコンテキストでだけ使える。https のページを開いてから呼ぶ */
export async function detectorState(page: Page): Promise<DetectorState> {
  const sample = selfTestPixels();
  return page.evaluate(
    async ({ base64, width, height, expected }) => {
      type Detector = { detect(source: ImageData): Promise<{ rawValue: string }[]> };
      type DetectorClass = { new (options: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> };
      const Detector = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
      if (Detector === undefined) return "none";
      if (!(await Detector.getSupportedFormats()).includes("qr_code")) return "no qr_code";
      const pixels = Uint8ClampedArray.from(atob(base64), (char) => char.charCodeAt(0));
      const found = await new Detector({ formats: ["qr_code"] }).detect(new ImageData(pixels, width, height));
      return found.some((code) => code.rawValue === expected) ? "qr_code" : "qr_code (not operational)";
    },
    { base64: Buffer.from(sample.data).toString("base64"), width: sample.width, height: sample.height, expected: SELF_TEST_TEXT },
  );
}
