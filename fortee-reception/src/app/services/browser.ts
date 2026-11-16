import { createAppShell } from "./app-shell.ts";
import { createCamera } from "./camera.ts";
import { createFeedback } from "./feedback.ts";
import { createFrameDetector } from "./frame-detector.ts";
import { createHistoryGuard } from "./history-guard.ts";
import { createNetwork } from "./network.ts";
import { createLocks, createPlatform, createWakeLock } from "./platform.ts";
import type { Ports } from "./ports.ts";
import { warmUpQrDecoder, zxingQrDecoder } from "./qr-decoder.ts";

/** ブラウザの実装を組み立てる。起動で 1 回だけ呼ぶ */
export function createBrowserPorts(): Ports {
  const platform = createPlatform();
  return {
    platform,
    network: createNetwork((input, init) => fetch(input, init)),
    locks: createLocks(),
    feedback: createFeedback(),
    // デコーダを替えるときは、ここで別の実装を渡す（Design Doc 6.8）。ブラウザの検出器が使える環境では、
    // デコーダの代わりに検出器で読み取る。検出器が使えないと分かったら、デコーダの WASM の取得と初期化を
    // 最初の読み取りより前に始める。検出器が使える端末では、使えるかの確認が 1 秒以内に済めば、WASM を読み込まない
    // （確認が済むまで、カメラのサービスが、デコーダにコマを渡すのを待つ）
    camera: createCamera(zxingQrDecoder, platform.mark, async () => {
      const detector = await createFrameDetector();
      if (detector === null) warmUpQrDecoder();
      return detector;
    }),
    wakeLock: createWakeLock(),
    historyGuard: createHistoryGuard(history, (listener) => window.addEventListener("popstate", listener)),
    appShell: createAppShell(),
  };
}
