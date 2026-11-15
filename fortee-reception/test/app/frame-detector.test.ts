import jsQR from "jsqr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF_TEST_TEXT, selfTestPixels } from "../../src/app/services/detector-self-test.ts";
import { createFrameDetector } from "../../src/app/services/frame-detector.ts";

// ブラウザの検出器（BarcodeDetector）が使えるかの判定（Design Doc 6.8）。
// 検出器は偽物にする。本物の検出器が確認用の画像を読めることは、Chromium で別に確かめる（test/e2e/frame-detector.spec.ts）。

type Found = { rawValue: string; cornerPoints: { x: number; y: number }[] };

const VISIBLE = { x: 0, y: 0, width: 640, height: 480 };
const CORNERS = [
  { x: 100, y: 100 },
  { x: 200, y: 100 },
  { x: 200, y: 200 },
  { x: 100, y: 200 },
];

/** detect は、確認用の画像（ImageData）か、映像のコマを受け取る */
function stubDetector(formats: string[], detect: (source: unknown) => Promise<Found[]>): void {
  vi.stubGlobal(
    "ImageData",
    class {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
  vi.stubGlobal(
    "BarcodeDetector",
    class {
      static getSupportedFormats = async () => formats;
      detect = detect;
    },
  );
}

const isSelfTest = (source: unknown): boolean => source instanceof (globalThis as { ImageData: new (...args: never[]) => unknown }).ImageData;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("確認用の QR の画像", () => {
  it("内容は SELF_TEST_TEXT で、デコーダで読める", () => {
    const { data, width, height } = selfTestPixels();
    expect(data.byteLength).toBe(width * height * 4);
    expect(jsQR(data, width, height)?.data).toBe(SELF_TEST_TEXT);
  });
});

describe("検出器が使えるかの判定", () => {
  it("BarcodeDetector がなければ、使わない", async () => {
    expect(await createFrameDetector()).toBeNull();
  });

  it("QR に対応していなければ、使わない", async () => {
    stubDetector(["ean_13"], async () => [{ rawValue: SELF_TEST_TEXT, cornerPoints: CORNERS }]);
    expect(await createFrameDetector()).toBeNull();
  });

  it("確認用の画像を読めれば使い、映像のコマの結果を返す", async () => {
    stubDetector(["qr_code"], async (source) =>
      isSelfTest(source) ? [{ rawValue: SELF_TEST_TEXT, cornerPoints: CORNERS }] : [{ rawValue: "fortee:a", cornerPoints: CORNERS }],
    );
    const detect = await createFrameDetector();
    expect(detect).not.toBeNull();
    expect(await detect?.({} as HTMLVideoElement, VISIBLE)).toBe("fortee:a");
  });

  it("QR に対応していても、空の結果しか返さなければ、使わない（検出器が端末に入っていない Android）", async () => {
    let calls = 0;
    stubDetector(["qr_code"], async () => {
      calls++;
      return [];
    });
    expect(await createFrameDetector()).toBeNull();
    expect(calls).toBe(1);
  });

  it("確認用の画像から別の内容を返す検出器は、使わない", async () => {
    stubDetector(["qr_code"], async () => [{ rawValue: "fortee:a", cornerPoints: CORNERS }]);
    expect(await createFrameDetector()).toBeNull();
  });

  it("確認の読み取りが失敗したら、使わない", async () => {
    stubDetector(["qr_code"], async () => {
      throw new Error("検出器が止まった");
    });
    expect(await createFrameDetector()).toBeNull();
  });
});
