import jsQR from "jsqr";
import type { Camera, FrameDetector, QrDecoder } from "./ports.ts";
import { decodeSize, visibleSourceRect } from "./scan-region.ts";

// カメラと QR のデコード（Design Doc 6.8、端末の挙動 11.2）。
//
// 開始・停止・一時停止は、このサービスの内側に閉じる。画面設計書 6.2 の予備案（結果の間も止めない）に
// 切り替えるときは、ここだけを変える。
//
// QR の読み取りには、2 つの経路がある。
// - 映像のコマをそのまま検出器（FrameDetector。ブラウザの BarcodeDetector）に渡す。使える環境では、こちらを使う
// - 見えている範囲をキャンバスに切り出して縮め、画素の配列を QrDecoder（jsQR）に渡す。検出器が使えない環境
//   （iOS の Safari、検出器が入っていない Android）と、検出器が失敗した後は、こちらを使う
// デコーダを替えるときは、QrDecoder の別の実装を差し込む。

/** デコードの間隔（Design Doc 6.5） */
const DECODE_INTERVAL_MS = 150;

/** jsQR による実装。白地に黒の QR だけを探す */
export const jsQrDecoder: QrDecoder = (image) => {
  try {
    return jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  } catch {
    // jsQR は保守されていない。例外は捕まえて読み取りを続ける（フロントエンド 6 章）
    return null;
  }
};

/**
 * detectorFactory は、検出器が使えるかを確かめて、使えれば検出の関数を返す（services/frame-detector.ts）。
 * 最初に読み取りを始めるときに 1 回だけ呼ぶ
 */
export function createCamera(
  decode: QrDecoder,
  mark: (name: string) => void,
  detectorFactory: () => Promise<FrameDetector | null> = async () => null,
): Camera {
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let onText: ((text: string) => void) | null = null;
  /** start() の世代。古い start() の結果を捨てる */
  let session = 0;
  let canvas: HTMLCanvasElement | null = null;
  /** 検出器。まだ確かめていなければ undefined、使えなければ null */
  let detector: Promise<FrameDetector | null> | undefined;
  let frameDetector: FrameDetector | null = null;
  /** 検出器が、前のコマを調べている最中か。終わるまで、次のコマを渡さない（溜めない） */
  let detecting = false;
  /** デコードを止めるたびに増える。止めた後に届いた検出の結果を捨てる */
  let decodeEpoch = 0;

  function show() {
    if (video === null) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream !== null) void video.play().catch(() => {});
  }

  function grab() {
    if (video === null || stream === null || onText === null) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    // 上の領域に見えている範囲だけを切り出す（画面設計書 S03）
    const source = visibleSourceRect(
      { width: video.videoWidth, height: video.videoHeight },
      { width: video.clientWidth, height: video.clientHeight },
    );
    if (source === null) return;
    if (frameDetector !== null) {
      if (!detecting) void detectFrame(frameDetector, video, source);
      return;
    }
    const size = decodeSize(source);
    canvas ??= document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) return;
    // NFR-1 の計測の開始点は、デコードに渡したコマを映像から取り出した時点
    mark("checkin:frame");
    context.drawImage(video, source.x, source.y, source.width, source.height, 0, 0, size.width, size.height);
    const text = decode(context.getImageData(0, 0, size.width, size.height));
    if (text !== null) onText(text);
  }

  /** 映像のコマを検出器に渡す。結果は後から届くので、その間にデコードを止めていたら捨てる */
  async function detectFrame(detect: FrameDetector, element: HTMLVideoElement, source: Parameters<FrameDetector>[1]) {
    const epoch = decodeEpoch;
    detecting = true;
    // NFR-1 の計測の開始点。このコマの結果が届くまで、次のコマは渡さないので、印はこのコマのものである
    mark("checkin:frame");
    let text: string | null = null;
    try {
      text = await detect(element, source);
    } catch {
      // 検出器が失敗した（検出器の停止、対応しない状態の映像）。以後は、キャンバスと QrDecoder で読み取る
      frameDetector = null;
      detector = Promise.resolve(null);
    } finally {
      detecting = false;
    }
    if (epoch !== decodeEpoch || onText === null) return;
    if (text !== null) onText(text);
  }

  function pauseDecoding() {
    decodeEpoch++;
    clearInterval(timer);
    timer = undefined;
    onText = null;
  }

  function stop() {
    session++;
    pauseDecoding();
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    if (video !== null) video.srcObject = null;
  }

  return {
    attach(element) {
      video = element;
      show();
    },
    async start(listener) {
      stop();
      const mine = ++session;
      // 検出器が使えるかは、カメラの許可を待つ間に確かめる
      detector ??= detectorFactory().catch(() => null);
      let acquired: MediaStream;
      try {
        acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        frameDetector = await detector;
      } catch {
        // 拒否は NotAllowedError で届く（iOS の Permissions API は拒否を prompt と返す）。
        // カメラがない、ほかのアプリが使っているなど、ほかの失敗も、カメラを使えないものとして同じに扱う
        return "denied";
      }
      if (mine !== session) {
        // 待っている間に止められた
        for (const track of acquired.getTracks()) track.stop();
        return "denied";
      }
      stream = acquired;
      onText = listener;
      show();
      timer = setInterval(grab, DECODE_INTERVAL_MS);
      return "streaming";
    },
    pauseDecoding,
    stop,
  };
}
