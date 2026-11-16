import { prepareZXingModule, purgeZXingModule, readBarcodes } from "zxing-wasm/reader";
import readerWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import type { QrDecoder } from "./ports.ts";
import { DECODE_MAX_SIDE, pickVisibleCode } from "./scan-region.ts";
import { ZXING_READER_OPTIONS } from "./zxing-options.ts";

// zxing-wasm による QR のデコード（Design Doc 6.8、zxing-wasm の導入指針）。
//
// - WASM は、受付アプリと同じオリジンから配る。ライブラリの既定の取得先は CDN（jsDelivr）なので、最初の
//   読み取りより前に、取得先を必ず上書きする。取得や初期化に失敗しても、CDN には切り替えない
// - 渡すのは、キャンバスから得た、長辺が上限以下の ImageData だけ。大きさと画素数が合わないものは渡さない
// - 失敗は「読み取れなかった」として返し、次のコマを試せる状態に戻す。取得と初期化が終わらないときも、
//   待つ時間の上限を超えたら失敗として扱う。待ち続けると、カメラのサービスが次のコマを渡せない

/** 失敗の後、次に試すまで空ける時間。WASM を取得できないあいだ、150 ms ごとに取得を繰り返さない */
const RETRY_AFTER_MS = 1000;

const overrides = {
  locateFile(path: string, prefix: string): string {
    if (path === "zxing_reader.wasm") {
      if (new URL(readerWasmUrl, location.href).origin !== location.origin) {
        throw new Error("QR の読み取り用の WASM が、同じオリジンにない");
      }
      return readerWasmUrl;
    }
    if (path.endsWith(".wasm")) throw new Error(`想定外の WASM: ${path}`);
    return prefix + path;
  },
};

// 取得先の上書き。ここでは取得しない
prepareZXingModule({ overrides, equalityFn: Object.is });

/**
 * WASM の取得と初期化を待つ時間の上限。事前にキャッシュしてあるので、ふつうは通信しない。キャッシュになく、
 * 取得の要求に応答が届かないままになると、失敗にもならない。超えたら、失敗として扱い、初期化し直す
 */
const INIT_TIMEOUT_MS = 10_000;

let retryAt = 0;

/** 進行中か、済んだ初期化。始めた時点から待つ時間を数えるので、先に始めた初期化（warmUpQrDecoder）と、読み取りで共有する */
let initializing: Promise<void> | null = null;

/** WASM の取得と初期化を、まだなら始める。失敗するか、待つ時間の上限を超えたら、失敗の後始末をして reject する */
function initialize(): Promise<void> {
  if (initializing !== null) return initializing;
  const mine = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("QR の読み取り用の WASM の初期化が終わらない")), INIT_TIMEOUT_MS);
    prepareZXingModule({ overrides, equalityFn: Object.is, fireImmediately: true })
      .then(() => resolve(), reject)
      .finally(() => clearTimeout(timer));
  }).catch((error: unknown) => {
    // 念のための確認。この初期化が、すでに別の失敗の後始末で捨てられていたら、やり直した初期化を捨てない
    if (initializing === mine) reset();
    throw error;
  });
  initializing = mine;
  return mine;
}

/**
 * 失敗の後始末。ライブラリは、初期化の結果（失敗も、終わっていないものも）を持ち続けるので、捨てて、次の読み取りで
 * 初期化し直す。捨てると取得先が既定（CDN）に戻るので、すぐに上書きし直す。終わっていない取得は止められないが、
 * 後から届いても使わない
 */
function reset(): void {
  initializing = null;
  purgeZXingModule();
  prepareZXingModule({ overrides, equalityFn: Object.is });
  retryAt = Date.now() + RETRY_AFTER_MS;
}

/**
 * WASM の取得と初期化を、最初の読み取りより前に始める。ブラウザの検出器が使えず、このデコーダで読み取ると
 * 分かったときに呼ぶ。呼ばなくても、最初の読み取りが初期化する
 */
export function warmUpQrDecoder(): void {
  void initialize().catch(() => {});
}

function acceptable(image: ImageData): boolean {
  const { width, height, data } = image;
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= DECODE_MAX_SIDE &&
    height <= DECODE_MAX_SIDE &&
    data instanceof Uint8ClampedArray &&
    data.byteLength === width * height * 4
  );
}

/** 複数の QR が写っていれば、画像の中央に最も近いものを返す（検出器での読み取りと同じ選び方） */
export const zxingQrDecoder: QrDecoder = async (image) => {
  if (!acceptable(image) || Date.now() < retryAt) return null;
  try {
    await initialize();
  } catch {
    return null;
  }
  try {
    const found = await readBarcodes(image, ZXING_READER_OPTIONS);
    return pickVisibleCode(
      found.map(({ text, position }) => ({
        text,
        corners: [position.topLeft, position.topRight, position.bottomRight, position.bottomLeft],
      })),
      { x: 0, y: 0, width: image.width, height: image.height },
    );
  } catch {
    reset();
    return null;
  }
};
