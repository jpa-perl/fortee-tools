import { createAppShell } from "./app-shell.ts";
import { createCamera, jsQrDecoder } from "./camera.ts";
import { createFeedback } from "./feedback.ts";
import { createFrameDetector } from "./frame-detector.ts";
import { createHistoryGuard } from "./history-guard.ts";
import { createNetwork } from "./network.ts";
import { createLocks, createPlatform, createWakeLock } from "./platform.ts";
import type { Ports } from "./ports.ts";

/** ブラウザの実装を組み立てる。起動で 1 回だけ呼ぶ */
export function createBrowserPorts(): Ports {
  const platform = createPlatform();
  return {
    platform,
    network: createNetwork((input, init) => fetch(input, init)),
    locks: createLocks(),
    feedback: createFeedback(),
    // デコーダを替えるときは、ここで別の実装を渡す（Design Doc 6.8）。ブラウザの検出器が使える環境では、
    // デコーダの代わりに検出器で読み取る
    camera: createCamera(jsQrDecoder, platform.mark, createFrameDetector),
    wakeLock: createWakeLock(),
    historyGuard: createHistoryGuard(history, (listener) => window.addEventListener("popstate", listener)),
    appShell: createAppShell(),
  };
}
