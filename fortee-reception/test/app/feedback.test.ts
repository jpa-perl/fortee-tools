import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedback } from "../../src/app/services/feedback.ts";

// 音の出力（AudioContext）を休ませる時点（services/feedback.ts）。AudioContext は偽物にして、休ませた回数と
// 戻した回数を数える。操作（commands）が unlock() と rest() を対で呼ぶことは、idle-work.test.ts で確かめる。

let suspends = 0;
let resumes = 0;

class FakeAudioContext {
  state: "running" | "suspended" = "running";
  readonly sampleRate = 8000;
  readonly destination = {};
  /** 本物と同じく、状態は、休ませる処理が済んだときに変わる。呼んだ直後は「動いている」のまま */
  async suspend(): Promise<void> {
    suspends++;
    await Promise.resolve();
    this.state = "suspended";
  }
  async resume(): Promise<void> {
    resumes++;
    this.state = "running";
  }
  createBuffer(_channels: number, length: number): { getChannelData: () => Float32Array } {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBufferSource(): { buffer: unknown; connect: () => void; start: () => void } {
    return { buffer: null, connect: () => {}, start: () => {} };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  suspends = 0;
  resumes = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("音の出力を休ませる時点", () => {
  it("鳴らす予定がある間（unlock() から rest() まで）は、音を鳴らした後も休ませない", async () => {
    const feedback = createFeedback();
    feedback.unlock();
    feedback.play("success");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(suspends).toBe(0);
  });

  it("rest() の 1 秒後に休ませ、次の unlock() で戻す", async () => {
    const feedback = createFeedback();
    feedback.unlock();
    feedback.play("success");
    feedback.rest();
    await vi.advanceTimersByTimeAsync(900);
    expect(suspends).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(suspends).toBe(1);
    const before = resumes;
    feedback.unlock();
    expect(resumes).toBe(before + 1);
  });

  it("休ませている途中（状態は、まだ動いている）の unlock() でも、戻す", () => {
    const feedback = createFeedback();
    feedback.unlock();
    feedback.rest();
    // 休ませるタイマーだけを動かす。suspend() は呼ばれたが、まだ済んでいない
    vi.advanceTimersByTime(1000);
    expect(suspends).toBe(1);
    const before = resumes;
    feedback.unlock();
    expect(resumes).toBe(before + 1);
  });

  it("rest() の後に鳴らした音は、鳴り終わる時間を待ち直してから休ませる", async () => {
    const feedback = createFeedback();
    feedback.unlock();
    feedback.rest();
    await vi.advanceTimersByTimeAsync(700);
    feedback.play("caution");
    await vi.advanceTimersByTimeAsync(900);
    expect(suspends).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(suspends).toBe(1);
  });

  it("rest() の後の遅らせた音が、その間に始めた読み取り（unlock()）の音の出力を休ませない", async () => {
    const feedback = createFeedback();
    // 「音を試す」: 3 つの音を、0.7 秒おきに鳴らす
    feedback.unlock();
    feedback.rest();
    feedback.play("success");
    // 鳴らしている途中で、読み取りを始める
    await vi.advanceTimersByTimeAsync(500);
    feedback.unlock();
    await vi.advanceTimersByTimeAsync(200);
    feedback.play("caution");
    await vi.advanceTimersByTimeAsync(700);
    feedback.play("reject");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(suspends).toBe(0);
    // 読み取り中を終えたら、休ませる
    feedback.rest();
    await vi.advanceTimersByTimeAsync(1000);
    expect(suspends).toBe(1);
  });

  it("一度も鳴らせる状態にしていなければ、rest() は何もしない", async () => {
    const feedback = createFeedback();
    feedback.rest();
    await vi.advanceTimersByTimeAsync(2000);
    expect(suspends).toBe(0);
  });
});
