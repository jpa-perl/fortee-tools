import { SELF_TEST_TEXT, selfTestPixels } from "./detector-self-test.ts";
import type { FrameDetector } from "./ports.ts";
import { type DetectedCode, pickVisibleCode } from "./scan-region.ts";

// ブラウザの BarcodeDetector による QR の検出（Design Doc 6.8）。
//
// BarcodeDetector は、OS の検出器（Android は Google Play 開発者サービス）を使う。JavaScript のデコーダ（jsQR）は、
// 読み取り中の処理時間の 8 割強を占める（開発環境の構築 4.4 の計測）ので、使える環境ではこちらを使う。
// iOS の Safari にはなく、Android でも、検出器が端末にまだ入っていないとき（オフラインでの初回など）は使えない。
// 使えないときは null を返し、カメラのサービスが、これまでどおりキャンバスと QrDecoder で読み取る。
//
// 検出器が端末に入っているかは、対応する形式の一覧からは分からない。Android の Chrome は、一覧を固定で返し、
// 入っていないあいだは、detect() が失敗せずに空の結果を返す。QR が写っていないコマと区別できず、失敗や
// 時間切れでの切り替え（camera.ts）も働かない。そこで、内容の分かっている QR の画像を 1 回読ませて、
// 読めたときだけ使う。読めなかった端末は、ページを読み込み直すまで、キャンバスと QrDecoder で読み取る
// （検出器は、最初に使われたときに取得が始まるので、通信できれば、次に読み込んだときから使える）。

// TypeScript の DOM の型に、まだない
type NativeDetector = {
  detect(source: HTMLVideoElement | ImageData): Promise<{ rawValue: string; cornerPoints: { x: number; y: number }[] }[]>;
};
type NativeDetectorClass = {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
};

/** この端末で使えれば、検出の関数を返す。使えなければ null。呼び出し側が、ページの読み込みごとに 1 回だけ呼ぶ */
export async function createFrameDetector(): Promise<FrameDetector | null> {
  const Detector = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (Detector === undefined) return null;
  try {
    // クラスがあっても、QR に対応していない環境がある（一部のデスクトップ）
    if (!(await Detector.getSupportedFormats()).includes("qr_code")) return null;
    const detector = new Detector({ formats: ["qr_code"] });
    // 対応していても、読めるとは限らない（検出器が端末に入っていない Android）。実際に読ませて確かめる
    const sample = selfTestPixels();
    const read = await detector.detect(new ImageData(sample.data, sample.width, sample.height));
    if (!read.some((code) => code.rawValue === SELF_TEST_TEXT)) return null;
    return async (video, visible) => {
      const found = await detector.detect(video);
      const codes: DetectedCode[] = found.map((code) => ({ text: code.rawValue, corners: code.cornerPoints }));
      return pickVisibleCode(codes, visible);
    };
  } catch {
    return null;
  }
}
