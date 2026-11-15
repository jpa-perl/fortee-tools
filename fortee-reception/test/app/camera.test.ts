import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCamera } from "../../src/app/services/camera.ts";
import type { FrameDetector } from "../../src/app/services/ports.ts";
import { deferred } from "./harness.ts";

// カメラのサービスの、読み取りの経路の切り替えと、遅れて届いた結果の扱い（Design Doc 6.8、6.13）。
// 映像、キャンバス、カメラの取得は偽物にして、150 ms ごとの処理を、偽の時計で進める。

const VIDEO = { readyState: 4, videoWidth: 640, videoHeight: 480, clientWidth: 390, clientHeight: 280, srcObject: null, play: async () => {} };

type Setup = {
  camera: ReturnType<typeof createCamera>;
  texts: string[];
  /** キャンバスと QrDecoder の経路で読み取った回数 */
  decodes: () => number;
  stoppedTracks: () => number;
};

async function setup(detector: FrameDetector | null | "never", decoded: string | null = null): Promise<Setup> {
  let decodes = 0;
  let stoppedTracks = 0;
  vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) }),
    }),
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [
          {
            stop: () => {
              stoppedTracks++;
            },
          },
        ],
      }),
    },
  });
  const texts: string[] = [];
  const camera = createCamera(
    () => {
      decodes++;
      return decoded;
    },
    () => {},
    detector === "never" ? () => new Promise(() => {}) : async () => detector,
  );
  camera.attach(VIDEO as unknown as HTMLVideoElement);
  expect(await camera.start((text) => texts.push(text))).toBe("streaming");
  // 検出器が使えるかの結果が届くのを待つ
  await vi.advanceTimersByTimeAsync(0);
  return { camera, texts, decodes: () => decodes, stoppedTracks: () => stoppedTracks };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("検出器（BarcodeDetector）での読み取り", () => {
  it("検出器が使えれば、キャンバスと QrDecoder を使わずに、検出器の結果を渡す", async () => {
    const { texts, decodes } = await setup(async () => "fortee:a");
    await vi.advanceTimersByTimeAsync(150);
    expect(texts).toEqual(["fortee:a"]);
    expect(decodes()).toBe(0);
  });

  it("前のコマの結果が届くまで、次のコマを渡さない", async () => {
    const gate = deferred<string | null>();
    let calls = 0;
    const { texts } = await setup(() => {
      calls++;
      return gate.promise;
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toBe(1);
    gate.resolve(null);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(2);
    expect(texts).toEqual([]);
  });

  it("デコードを止めた後に届いた結果は、捨てる", async () => {
    const gate = deferred<string | null>();
    const { camera, texts } = await setup(() => gate.promise);
    await vi.advanceTimersByTimeAsync(150);
    camera.pauseDecoding();
    gate.resolve("fortee:late");
    await vi.advanceTimersByTimeAsync(300);
    expect(texts).toEqual([]);
  });

  it("カメラを止めて始め直した後に届いた、前の読み取りの結果は、捨てる", async () => {
    const gates = [deferred<string | null>(), deferred<string | null>()];
    let calls = 0;
    const { camera, texts, stoppedTracks } = await setup(() => (gates[calls++] ?? deferred<string | null>()).promise);
    await vi.advanceTimersByTimeAsync(150);
    camera.stop();
    expect(stoppedTracks()).toBe(1);
    const again: string[] = [];
    await camera.start((text) => again.push(text));
    gates[0]?.resolve("fortee:old");
    await vi.advanceTimersByTimeAsync(150);
    expect(texts).toEqual([]);
    expect(again).toEqual([]);
    gates[1]?.resolve("fortee:new");
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toEqual(["fortee:new"]);
  });

  it("検出器が失敗したら、以後は、キャンバスと QrDecoder で読み取る", async () => {
    let calls = 0;
    const { texts, decodes } = await setup(async () => {
      calls++;
      throw new Error("検出器が止まった");
    }, "fortee:canvas");
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(1);
    expect(decodes()).toBe(2);
    expect(texts).toEqual(["fortee:canvas", "fortee:canvas"]);
  });

  it("検出器の結果が 2 秒届かなければ、見切って、キャンバスと QrDecoder に切り替える。遅れて届いた結果は使わない", async () => {
    const gate = deferred<string | null>();
    const { texts, decodes } = await setup(() => gate.promise, "fortee:canvas");
    await vi.advanceTimersByTimeAsync(2100);
    expect(decodes()).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(decodes()).toBeGreaterThan(0);
    gate.resolve("fortee:late");
    await vi.advanceTimersByTimeAsync(300);
    expect(texts).not.toContain("fortee:late");
  });

  it("メインスレッドがふさがって 2 秒を超えただけなら、見切らない。その後に届いた結果を使い、検出器を使い続ける", async () => {
    const gates = [deferred<string | null>(), deferred<string | null>()];
    let calls = 0;
    const { texts, decodes } = await setup(() => (gates[calls++] ?? deferred<string | null>()).promise, "fortee:canvas");
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(1);
    // 時計だけが 3 秒進む（その間、150 ms ごとの処理も、結果の受け取りも動かない）
    vi.setSystemTime(Date.now() + 3000);
    // ふさがりが解けて、150 ms ごとの処理が、結果の受け取りより先に動く
    await vi.advanceTimersByTimeAsync(150);
    gates[0]?.resolve("fortee:a");
    await vi.advanceTimersByTimeAsync(150);
    expect(texts).toEqual(["fortee:a"]);
    expect(calls).toBe(2);
    expect(decodes()).toBe(0);
  });

  it("デコードを止めた後に届いた検出器の失敗では、検出器を見切らない", async () => {
    let reject: (error: Error) => void = () => {};
    let calls = 0;
    const { camera, decodes } = await setup(() => {
      calls++;
      return calls === 1 ? new Promise<string | null>((_, r) => (reject = r)) : Promise.resolve(null);
    }, "fortee:canvas");
    await vi.advanceTimersByTimeAsync(150);
    camera.stop();
    reject(new Error("映像が外れた"));
    await camera.start(() => {});
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(3);
    expect(decodes()).toBe(0);
  });
});

describe("検出器が使えないとき", () => {
  it("検出器がなければ、キャンバスと QrDecoder で読み取る", async () => {
    const { texts, decodes } = await setup(null, "fortee:canvas");
    await vi.advanceTimersByTimeAsync(300);
    expect(decodes()).toBe(2);
    expect(texts).toEqual(["fortee:canvas", "fortee:canvas"]);
  });

  it("検出器が使えるかの確認が終わらなくても、読み取りは始まる", async () => {
    const { texts, decodes } = await setup("never", "fortee:canvas");
    await vi.advanceTimersByTimeAsync(150);
    expect(decodes()).toBe(1);
    expect(texts).toEqual(["fortee:canvas"]);
  });
});
