import type { Feedback, FeedbackKind } from "./ports.ts";

// 音と振動（Design Doc 6.8、端末の挙動 11.3、画面設計書 2.4）。
//
// 音は Web Audio API で、成功・注意・拒否の 3 種類の波形を初回に AudioBuffer に作って使い回す。
// どれも 0.5 秒以内に鳴り終わる。振動は、対応した端末（Android）でだけ使う。

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
      try {
        context ??= new AudioContext();
        if (context.state !== "running") void context.resume().catch(() => {});
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
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start();
      } catch {
        // 同上
      }
    },
    vibrate(kind) {
      if (typeof navigator.vibrate === "function") navigator.vibrate(VIBRATIONS[kind]);
    },
    canVibrate: () => typeof navigator.vibrate === "function",
  };
}
