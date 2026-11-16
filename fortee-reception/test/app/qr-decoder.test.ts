import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// デコーダ（zxing-wasm）の、WASM の取得と初期化が終わらないときの扱い（Design Doc 6.8）。
// ライブラリは偽物にして、初期化の完了を手で操る。偽物は、ライブラリと同じく、初期化の結果（終わっていないものも）を
// 持ち続け、purgeZXingModule() で捨てた後の初期化だけが、取得からやり直す。本物の WASM での読み取りと、取得の
// 失敗からの復帰は、画面のテスト（test/e2e/qr-decoder.spec.ts）で確かめる。

const zxing = vi.hoisted(() => {
  const state = {
    /** 取得からやり直した初期化。1 回の取得につき 1 つ */
    loads: [] as { resolve: () => void; reject: (error: Error) => void }[],
    cached: null as Promise<void> | null,
    load(): Promise<void> {
      state.cached ??= new Promise<void>((resolve, reject) => {
        state.loads.push({ resolve, reject });
      });
      return state.cached;
    },
  };
  return state;
});

vi.mock("zxing-wasm/reader/zxing_reader.wasm?url", () => ({ default: "/zxing_reader.wasm" }));
vi.mock("zxing-wasm/reader", () => ({
  prepareZXingModule: (options: { fireImmediately?: boolean }) => (options.fireImmediately === true ? zxing.load() : undefined),
  purgeZXingModule: () => {
    zxing.cached = null;
  },
  readBarcodes: async () => {
    await zxing.load();
    const corner = (x: number, y: number) => ({ x, y });
    return [{ text: "fortee:a", position: { topLeft: corner(10, 10), topRight: corner(50, 10), bottomRight: corner(50, 50), bottomLeft: corner(10, 50) } }];
  },
}));

const IMAGE = { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4) } as ImageData;

async function load(): Promise<typeof import("../../src/app/services/qr-decoder.ts")> {
  return import("../../src/app/services/qr-decoder.ts");
}

/** 結果が届いたかを、待たずに見る */
function watch(result: Promise<string | null>): { settled: () => boolean; value: () => string | null | undefined } {
  let settled = false;
  let value: string | null | undefined;
  void result.then((text) => {
    settled = true;
    value = text;
  });
  return { settled: () => settled, value: () => value };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  zxing.loads.length = 0;
  zxing.cached = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("WASM の取得と初期化", () => {
  it("初期化が済めば、読み取った文字列を返す。初期化は 1 回だけ", async () => {
    const { zxingQrDecoder } = await load();
    const first = watch(zxingQrDecoder(IMAGE));
    await vi.advanceTimersByTimeAsync(0);
    zxing.loads[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.value()).toBe("fortee:a");
    expect(await zxingQrDecoder(IMAGE)).toBe("fortee:a");
    expect(zxing.loads).toHaveLength(1);
  });

  it("初期化が終わらなければ、10 秒で見切って null を返し、1 秒後から、取得をやり直して読み取る", async () => {
    const { zxingQrDecoder } = await load();
    const first = watch(zxingQrDecoder(IMAGE));
    await vi.advanceTimersByTimeAsync(9_900);
    expect(first.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(first.settled()).toBe(true);
    expect(first.value()).toBeNull();

    // 見切った直後の 1 秒は試さない
    expect(await zxingQrDecoder(IMAGE)).toBeNull();
    expect(zxing.loads).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    const second = watch(zxingQrDecoder(IMAGE));
    await vi.advanceTimersByTimeAsync(0);
    expect(zxing.loads).toHaveLength(2);
    zxing.loads[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.value()).toBe("fortee:a");
  });

  it("待つ時間は、先に始めた初期化（warmUpQrDecoder）の開始から数える", async () => {
    const { warmUpQrDecoder, zxingQrDecoder } = await load();
    warmUpQrDecoder();
    await vi.advanceTimersByTimeAsync(9_000);
    const first = watch(zxingQrDecoder(IMAGE));
    await vi.advanceTimersByTimeAsync(900);
    expect(first.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(first.value()).toBeNull();
    expect(zxing.loads).toHaveLength(1);
  });

  it.each([
    ["失敗", (first: (typeof zxing.loads)[number]) => first.reject(new Error("遅れて届いた失敗"))],
    ["完了", (first: (typeof zxing.loads)[number]) => first.resolve()],
  ])("見切った初期化が、後から%sしても、やり直した初期化に影響しない", async (_name, settle) => {
    const { zxingQrDecoder } = await load();
    void zxingQrDecoder(IMAGE);
    await vi.advanceTimersByTimeAsync(11_000);
    const second = watch(zxingQrDecoder(IMAGE));
    await vi.advanceTimersByTimeAsync(0);
    expect(zxing.loads).toHaveLength(2);

    const first = zxing.loads[0];
    if (first === undefined) throw new Error("最初の初期化がない");
    settle(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.settled()).toBe(false);
    zxing.loads[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.value()).toBe("fortee:a");
    expect(zxing.loads).toHaveLength(2);
  });

  it("初期化が失敗したら null を返し、1 秒後から、取得をやり直す", async () => {
    const { zxingQrDecoder } = await load();
    const first = watch(zxingQrDecoder(IMAGE));
    await vi.advanceTimersByTimeAsync(0);
    zxing.loads[0]?.reject(new Error("WASM を取得できない"));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.value()).toBeNull();
    expect(await zxingQrDecoder(IMAGE)).toBeNull();
    expect(zxing.loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    void zxingQrDecoder(IMAGE);
    await vi.advanceTimersByTimeAsync(0);
    expect(zxing.loads).toHaveLength(2);
  });
});
