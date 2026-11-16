import type { Feedback, FeedbackKind } from "./ports.ts";

// 音と振動（Design Doc 6.8、端末の挙動 11.3、画面設計書 2.4）。
//
// 音は Web Audio API で、成功・注意・拒否の 3 種類の波形を初回に AudioBuffer に作って使い回す。
// どれも 0.5 秒以内に鳴り終わる。振動は、対応した端末（Android）でだけ使う。
//
// AudioContext は、動いている間、音を出していなくても音の出力を動かし続ける。受付は 1 日続くので、鳴らす予定の
// ない間は休ませる（suspend）。鳴らす予定があるのは、タップの処理で鳴らせる状態にして（unlock()）から、
// 予定がなくなったと知らされる（rest()）までである。その間は、休ませない。音を鳴らした直後でも休ませないのは、
// 休ませた後は、次のタップの処理まで戻せない端末があるためである（読み取り中の結果の音は、タップの外で鳴らす）。
// rest() の後は、音が鳴り終わる時間を待ってから休ませる。予定のない間に鳴らした音も、同じだけ待つ。

/** 休ませるまでの待ち。最も長い音（0.5 秒）が鳴り終わる時間に、余裕を足したもの */
const REST_DELAY_MS = 1000;

type Tone = { frequency: number; start: number; duration: number };

/** 3 種類を聞き分けられるように、音の高さと数を変える。成功は上がる 2 音、注意は同じ高さの 2 音、拒否は低い 1 音 */
const TONES: Record<FeedbackKind, Tone[]> = {
  success: [
    { frequency: 880, start: 0, duration: 0.12 },
    { frequency: 1320, start: 0.12, duration: 0.2 },
  ],
  caution: [
    { frequency: 660, start: 0, duration: 0.12 },
    { frequency: 660, start: 0.2, duration: 0.12 },
  ],
  reject: [{ frequency: 220, start: 0, duration: 0.45 }],
};

/** 成功は短く 1 回、注意は短く 2 回、拒否は長く 1 回 */
const VIBRATIONS: Record<FeedbackKind, number[]> = {
  success: [80],
  caution: [80, 80, 80],
  reject: [400],
};

function render(context: AudioContext, tones: Tone[]): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.ceil(rate * Math.max(...tones.map((tone) => tone.start + tone.duration)));
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (const tone of tones) {
    const from = Math.floor(tone.start * rate);
    const count = Math.floor(tone.duration * rate);
    // 立ち上がりと終わりを 10 ms で滑らかにして、ぷつっという雑音を避ける
    const fade = Math.floor(0.01 * rate);
    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / fade, (count - i) / fade);
      // 拒否の低い音は、小さなスピーカーでも聞こえるように倍音を足す
      const phase = (2 * Math.PI * tone.frequency * i) / rate;
      const wave = tone.frequency < 400 ? Math.sign(Math.sin(phase)) * 0.5 : Math.sin(phase);
      data[from + i] = wave * envelope * 0.6;
    }
  }
  return buffer;
}

export function createFeedback(): Feedback {
  let context: AudioContext | null = null;
  const buffers = new Map<FeedbackKind, AudioBuffer>();
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  /** 音を鳴らす予定があるか（unlock() から rest() まで）。ある間は、休ませない */
  let wanted = false;

  /** 鳴っている音が終わる時間を待ってから、休ませる。待っている間に呼び直されたら、数え直す */
  function restLater() {
    clearTimeout(restTimer);
    restTimer = setTimeout(() => {
      restTimer = undefined;
      if (context?.state === "running") void context.suspend().catch(() => {});
    }, REST_DELAY_MS);
  }

  // iOS では、判定の音を、ほかの再生の上に重ねて鳴らす短い音として扱わせる（Design Doc 6.8）。
  // この API は Android の Chrome にはないので、あるときだけ行う
  const audioSession = (navigator as { audioSession?: { type: string } }).audioSession;
  if (audioSession !== undefined) {
    try {
      audioSession.type = "transient";
    } catch {
      // 指定できなくても、音は鳴らせる
    }
  }

  return {
    unlock() {
      wanted = true;
      clearTimeout(restTimer);
      restTimer = undefined;
      try {
        context ??= new AudioContext();
        // 動いているように見えても、戻す。休ませている途中（suspend() を呼んでから、済むまで）は、状態が
        // まだ「動いている」で、ここで戻さないと、休んだまま読み取り中になる。動いているときに戻しても、害はない
        void context.resume().catch(() => {});
        // 1 サンプルの無音を鳴らす
        const source = context.createBufferSource();
        source.buffer = context.createBuffer(1, 1, context.sampleRate);
        source.connect(context.destination);
        source.start();
      } catch {
        // 音を鳴らせない端末でも、受付は続ける
      }
    },
    play(kind) {
      if (context === null) return;
      try {
        let buffer = buffers.get(kind);
        if (buffer === undefined) {
          buffer = render(context, TONES[kind]);
          buffers.set(kind, buffer);
        }
        // 休ませた後に鳴らすことになったら、戻してから鳴らす。タップの処理の外では戻せない端末があり、
        // そのときは音が欠ける
        if (context.state !== "running") void context.resume().catch(() => {});
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start();
      } catch {
        // 同上
      }
      // 鳴らす予定のない間に鳴らした（rest() の後の、遅らせた音）。鳴り終わるのを待ち直す。予定がある間は、
      // 休ませる時刻を決めない。ここで決めると、読み取り中に休んでしまう
      if (!wanted) restLater();
    },
    rest() {
      wanted = false;
      if (context !== null) restLater();
    },
    vibrate(kind) {
      if (typeof navigator.vibrate === "function") navigator.vibrate(VIBRATIONS[kind]);
    },
    canVibrate: () => typeof navigator.vibrate === "function",
  };
}
