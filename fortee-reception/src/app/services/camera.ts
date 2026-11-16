import type { Camera, FrameDetector, QrDecoder } from "./ports.ts";
import { decodeSize, visibleSourceRect } from "./scan-region.ts";

// カメラと QR のデコード（Design Doc 6.8、端末の挙動 11.2）。
//
// 開始・停止・一時停止は、このサービスの内側に閉じる。画面設計書 6.2 の予備案（結果の間も止めない）に
// 切り替えるときは、ここだけを変える。
//
// QR の読み取りには、2 つの経路がある。
// - 映像のコマをそのまま検出器（FrameDetector。ブラウザの BarcodeDetector）に渡す。使える環境では、こちらを使う
// - 見えている範囲をキャンバスに切り出して縮め、画素の配列を QrDecoder（qr-decoder.ts の zxing-wasm）に渡す。
//   検出器が使えない環境（iOS の Safari、検出器が入っていない Android）と、検出器が失敗した後は、こちらを使う
// デコーダを替えるときは、QrDecoder の別の実装を差し込む。
// どちらの経路も、結果は後から届く。前のコマの結果が届くまで次のコマは渡さず、デコードを止めた後に届いた
// 結果は捨てる。経路が替わるときも同じで、デコーダの結果を待つ間に検出器が使えると分かったら、待っていた
// 結果は捨てて、検出器で読み取り直す。受理しうる結果を待つコマは常に 1 つなので、NFR-1 の計測の開始点
// （checkin:frame）は、受理した結果のコマのものになる。

/** デコードの間隔（Design Doc 6.5） */
const DECODE_INTERVAL_MS = 150;

/**
 * 検出器の結果を待つ時間の上限。超えたのを、150 ms ごとの処理で 2 回続けて見たら、検出器が止まったものと見なして、
 * キャンバスと QrDecoder に切り替える
 */
const DETECT_TIMEOUT_MS = 2000;

/**
 * 検出器が使えるかの確認を待つ時間の上限。確認が済むまでは、デコーダにコマを渡さない。検出器が使える端末で、
 * 最初のコマのためだけにデコーダの WASM を読み込まないためである。確認は、カメラの取得より前に始めるので、
 * ふつうは最初のコマより前に済む。超えたら、確認を待たずに、キャンバスと QrDecoder で読み取り始める
 */
const PROBE_WAIT_MS = 1000;

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
  /** 検出器が使えるかを、確かめ始めたか */
  let probed = false;
  /** 確かめ始めた時刻と、結果が届いたか（使えない、確かめられなかった、も含む） */
  let probeStartedAt = 0;
  let probeSettled = false;
  /** 検出器。使えると分かるまでと、使えないとき、失敗した後は null（キャンバスと QrDecoder で読み取る） */
  let frameDetector: FrameDetector | null = null;
  /** 検出器が、前のコマを調べている最中か。終わるまで、次のコマを渡さない（溜めない） */
  let detecting = false;
  /** 検出器にコマを渡した時刻と、その呼び出しの番号。番号が変わっていたら、その結果は使わない */
  let detectStartedAt = 0;
  let detectId = 0;
  /** 検出器の結果が、待つ時間の上限を超えているのを、前の回に見たか */
  let detectOverdue = false;
  /** デコーダが、前のコマを調べている最中か。終わるまで、次のコマを渡さない（溜めない） */
  let decoding = false;
  /** デコーダの呼び出しの番号。番号が変わっていたら、その結果は使わない */
  let decodeId = 0;
  /** デコードを止めるたびに増える。止めた後に届いた検出とデコードの結果を捨てる */
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
    if (frameDetector !== null && detecting && Date.now() - detectStartedAt >= DETECT_TIMEOUT_MS) {
      if (!detectOverdue) {
        // 上限を超えたのを、初めて見た。メインスレッドがふさがっていた（この処理も遅れた）だけで、結果は
        // もう届いていて、受け取る順番を待っているのかもしれない。次の回まで待って、それでも届かなければ見切る
        detectOverdue = true;
        return;
      }
      // 結果が届かない。待ち続けると、読み取りが止まったままになる。遅れて届いた結果は使わない
      detectId++;
      detecting = false;
      frameDetector = null;
    }
    if (frameDetector !== null) {
      if (!detecting) void detectFrame(frameDetector, video, source);
      return;
    }
    if (decoding) return;
    // 検出器が使えるかが、まだ分からない。分かるのを、上限の時間まで待つ
    if (!probeSettled && Date.now() - probeStartedAt < PROBE_WAIT_MS) return;
    const size = decodeSize(source);
    canvas ??= document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) return;
    // NFR-1 の計測の開始点は、デコードに渡したコマを映像から取り出した時点
    mark("checkin:frame");
    context.drawImage(video, source.x, source.y, source.width, source.height, 0, 0, size.width, size.height);
    void decodeImage(context.getImageData(0, 0, size.width, size.height));
  }

  /** 切り出した画像をデコーダに渡す。結果は後から届くので、その間にデコードを止めていたら捨てる */
  async function decodeImage(image: ImageData) {
    const epoch = decodeEpoch;
    const id = ++decodeId;
    decoding = true;
    let text: string | null = null;
    try {
      text = await decode(image);
    } catch {
      // 読み取れなかったものとして、次のコマを試す
    }
    decoding = false;
    // 待っている間に、検出器での読み取りに替わった。計測の開始点は、検出器に渡したコマのものに替わっている
    if (id !== decodeId) return;
    deliver(epoch, text);
  }

  /** 映像のコマを検出器に渡す。結果は後から届くので、その間にデコードを止めていたら捨てる */
  async function detectFrame(detect: FrameDetector, element: HTMLVideoElement, source: Parameters<FrameDetector>[1]) {
    const epoch = decodeEpoch;
    const id = ++detectId;
    detecting = true;
    detectStartedAt = Date.now();
    detectOverdue = false;
    // NFR-1 の計測の開始点。このコマの結果が届くまで、次のコマは渡さないので、印はこのコマのものである
    mark("checkin:frame");
    let text: string | null = null;
    try {
      text = await detect(element, source);
    } catch {
      // 検出器が失敗した（検出器の停止、対応しない状態の映像）。以後は、キャンバスと QrDecoder で読み取る。
      // デコードを止めた後に届いた失敗は、止めたこと（映像を外した）が原因かもしれないので、数えない
      if (id === detectId && epoch === decodeEpoch) frameDetector = null;
    }
    // 待つ上限を超えて、見切った呼び出し。次の読み取りは、もう始まっている
    if (id !== detectId) return;
    detecting = false;
    deliver(epoch, text);
  }

  /** 読み取った文字列を渡す。コマを渡した後にデコードを止めていたら（epoch が変わっていたら）、渡さない */
  function deliver(epoch: number, text: string | null) {
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
      // 検出器が使えるかを確かめる。カメラの取得は、結果を待たずに進める。結果が届くまで、コマを渡すのを
      // 上限の時間（PROBE_WAIT_MS）だけ待ち、届かなければ、キャンバスと QrDecoder で読み取る。
      // 確かめる処理が終わらなくても、読み取りは始まる
      if (!probed) {
        probed = true;
        probeStartedAt = Date.now();
        void detectorFactory().then(
          (found) => {
            probeSettled = true;
            frameDetector = found;
            // 検出器に替える。デコーダが調べている最中のコマの結果は、届いても使わない
            if (found !== null) decodeId++;
          },
          () => {
            probeSettled = true;
          },
        );
      }
      let acquired: MediaStream;
      try {
        acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
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
