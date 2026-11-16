import type { FeedbackKind } from "../services/ports.ts";
import { soundEnabled, vibrationEnabled } from "../state/model.ts";
import { enqueue, rt } from "./runtime.ts";

// 端末の設定（S09。FR-23）。音と振動は、端末ごとに無効にできる。ログアウトしても残す。

/** S09 の「音」の切り替え */
export async function setSoundEnabled(enabled: boolean): Promise<void> {
  await enqueue(async (store) => {
    await store.writeMeta("sound", enabled);
    soundEnabled.value = enabled;
  });
}

/** S09 の「振動」の切り替え */
export async function setVibrationEnabled(enabled: boolean): Promise<void> {
  await enqueue(async (store) => {
    await store.writeMeta("vibration", enabled);
    vibrationEnabled.value = enabled;
  });
}

/** 「音を試す」で、次の音までの間隔。どの音も 0.5 秒以内に鳴り終わる */
const TEST_SOUND_GAP_MS = 700;

/** S09 の「音を試す」。成功・注意・拒否の順に鳴らす。音がオフでも鳴らす。タップの処理の中で呼ぶ */
export function testSound(): void {
  const { feedback, platform } = rt.ports;
  feedback.unlock();
  // 鳴らす予定は、この 3 つだけ。先に知らせておけば、最後の音が鳴り終わった後に、音の出力が休む。
  // 鳴らしている途中で読み取りを始めても、残りの音が、読み取り中の音の出力を休ませることはない
  feedback.rest();
  const kinds: FeedbackKind[] = ["success", "caution", "reject"];
  kinds.forEach((kind, i) => {
    if (i === 0) feedback.play(kind);
    else platform.after(TEST_SOUND_GAP_MS * i, () => feedback.play(kind));
  });
}
