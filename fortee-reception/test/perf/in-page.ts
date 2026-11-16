// 計測（run.ts）が、ページの中で実行する関数。page.evaluate() に渡すので、どの関数も、引数だけで閉じている
// （このファイルのほかの値と、import を参照しない）。

import type { QrMatrix } from "../e2e/qr-matrix.ts";

export type { QrMatrix };

/** デコーダに渡す画像の長辺。640 がいまの上限（Design Doc 6.5）。小さい値は、解像度を下げる案の比較のため */
export const DECODER_SIDES = [640, 480, 320];

/**
 * 端末の記憶域に、合成のチケットと記録を置く。公開されたスナップショットの 1 つ（本編）に参加者を足し、
 * 記録を、半分はこの端末、半分は別の端末のものとして置く。どれも送信済みにする。呼んだ後に読み込み直す。
 * 足した参加者の数を返す。番号の大きいほうの 100 枚は、済みにしていない
 */
export async function seedDatabase(input: { tickets: number; records: number; now: number }): Promise<number> {
  const request = <T>(r: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const db = await request(indexedDB.open("checkin"));
  const tx = db.transaction(["meta", "config", "snapshots", "records"], "readwrite");
  const deviceId = (await request(tx.objectStore("meta").get("deviceId"))) as string;
  const config = (await request(tx.objectStore("config").get("current"))) as {
    receptions: { id: string; checkin: string[] }[];
  };
  const reception = config.receptions.find((candidate) => candidate.id === "main") ?? config.receptions[0];
  if (reception === undefined) throw new Error("受付がない");
  const snapshots = (await request(tx.objectStore("snapshots").getAll())) as {
    eventId: string;
    attendees: Record<string, unknown>[];
  }[];
  const snapshot = snapshots.find((candidate) => reception.checkin.includes(candidate.eventId));
  const template = snapshot?.attendees[0];
  if (snapshot === undefined || template === undefined) throw new Error("スナップショットがない");

  const token = (prefix: string, i: number): string => `${prefix}${String(i).padStart(28, "0")}`;
  const uuid = (group: number, i: number): string =>
    `${String(group).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
  const attendees = [...snapshot.attendees];
  for (let i = 0; attendees.length < input.tickets; i++) {
    attendees.push({
      ...template,
      ticketToken: token("PERF", i),
      profileUrlToken: token("PROF", i),
      ticketNo: `P-${i}`,
      userName: `perf-user-${i}`,
      name: `合成 太郎 ${i}`,
      forteeCheckedIn: false,
    });
  }
  await request(tx.objectStore("snapshots").put({ ...snapshot, attendees }));

  const otherDevice = uuid(9, 1);
  const synthetic = Math.max(1, input.tickets - snapshot.attendees.length);
  // 新しいほうのチケットは、済みにしない。受付を繰り返す計測（run.ts の checkinLoop）が、新たにチェックインする
  const targets = Math.max(1, synthetic - 100);
  const records = tx.objectStore("records");
  for (let i = 0; i < input.records; i++) {
    const ticket = i % targets;
    const deviceTime = input.now - (input.records - i) * 5000;
    void records.put(
      {
        recordId: uuid(1, i),
        opId: uuid(2, i),
        ticketToken: token("PERF", ticket),
        userName: `perf-user-${ticket}`,
        ticketNo: `P-${ticket}`,
        deviceTime,
        deviceId: i % 2 === 0 ? deviceId : otherDevice,
        operatorId: "123456789012345678",
        operatorName: "合成の操作者",
        op: "checkin",
        reception: reception.id,
        route: "qr",
        reasonKind: null,
        reasonText: null,
        targetRecordIds: null,
        sent: true,
        seq: i + 1,
        receivedAt: deviceTime + 1000,
      },
    );
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  return synthetic;
}

type JsQr = (data: Uint8ClampedArray, width: number, height: number, options: { inversionAttempts: string }) => { data: string } | null;
/** zxing-wasm の reader の IIFE 版（window.ZXingWASM）。run.ts が、ページに入れて、WASM の取得先を上書きする */
type ZXing = { readBarcodes(image: ImageData, options: Record<string, unknown>): Promise<{ text: string }[]> };

/**
 * 読み取りの 1 回の処理（services/camera.ts の grab()）の内訳。読み取り中の映像の要素から、同じ切り出しと
 * 縮小で取り出す。current は、毎回キャンバスの大きさを入れ直して文脈を取り直す手順、reuse は、大きさが
 * 同じなら入れ直さず、文脈を持ち回る手順。2 つを交互に、50 ms おきに行う。値は 1 回あたりの ms
 */
export async function pipelineBench(input: { iterations: number; zxingOptions: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const jsQR = (window as unknown as { jsQR: JsQr }).jsQR;
  const zxing = (window as unknown as { ZXingWASM: ZXing }).ZXingWASM;
  // 初期化を、計測の外で済ませる
  await zxing.readBarcodes(new ImageData(8, 8), input.zxingOptions);
  const video = document.querySelector("video");
  if (video === null) throw new Error("映像の要素がない");
  const scale = Math.max(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
  const sw = Math.min(video.videoWidth, video.clientWidth / scale);
  const sh = Math.min(video.videoHeight, video.clientHeight / scale);
  const sx = (video.videoWidth - sw) / 2;
  const sy = (video.videoHeight - sh) / 2;
  const ratio = Math.min(1, 640 / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * ratio));
  const height = Math.max(1, Math.round(sh * ratio));

  // decode は、アプリのデコーダ（zxing-wasm）。jsQR は、置き換える前のデコーダで、比べるために同じ画像を渡す
  const steps = ["resize", "getContext", "mark", "drawImage", "getImageData", "decode", "jsQR"] as const;
  const blank = (): Record<string, number> => Object.fromEntries(steps.map((step) => [step, 0]));
  const sums = { current: blank(), reuse: blank() };
  const totals: { current: number[]; reuse: number[] } = { current: [], reuse: [] };
  const canvases = { current: document.createElement("canvas"), reuse: document.createElement("canvas") };
  let reused: CanvasRenderingContext2D | null = null;

  const once = async (variant: "current" | "reuse"): Promise<void> => {
    const canvas = canvases[variant];
    const sum = sums[variant];
    let t = performance.now();
    const start = t;
    const lap = (step: (typeof steps)[number]): void => {
      const now = performance.now();
      sum[step] = (sum[step] ?? 0) + (now - t);
      t = now;
    };
    if (variant === "current" || canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    lap("resize");
    const context = variant === "current" ? canvas.getContext("2d", { willReadFrequently: true }) : (reused ??= canvas.getContext("2d", { willReadFrequently: true }));
    if (context === null) throw new Error("文脈を取れない");
    lap("getContext");
    performance.clearMarks("perf:frame");
    performance.mark("perf:frame");
    lap("mark");
    context.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
    lap("drawImage");
    const image = context.getImageData(0, 0, width, height);
    lap("getImageData");
    await zxing.readBarcodes(image, input.zxingOptions);
    lap("decode");
    totals[variant].push(performance.now() - start);
    jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
    lap("jsQR");
  };

  // コマのあいだの変化の量の概算（読み取りの頻度を、変化の量で変える案の費用）。映像を 32×24 に縮めて、
  // 前のコマとの明るさの差の平均を取る
  const [tinyW, tinyH] = [32, 24];
  const tiny = document.createElement("canvas");
  tiny.width = tinyW;
  tiny.height = tinyH;
  const tinyContext = tiny.getContext("2d", { willReadFrequently: true });
  if (tinyContext === null) throw new Error("文脈を取れない");
  let previous: Uint8ClampedArray | null = null;
  let signatureMs = 0;
  const changes: number[] = [];
  const signature = (): void => {
    const start = performance.now();
    tinyContext.drawImage(video, sx, sy, sw, sh, 0, 0, tinyW, tinyH);
    const data = tinyContext.getImageData(0, 0, tinyW, tinyH).data;
    if (previous !== null) {
      let sum = 0;
      for (let p = 0; p < data.length; p += 4) sum += Math.abs((data[p + 1] ?? 0) - (previous[p + 1] ?? 0));
      changes.push(sum / (tinyW * tinyH));
    }
    previous = data;
    signatureMs += performance.now() - start;
  };

  for (let i = 0; i < input.iterations; i++) {
    await once(i % 2 === 0 ? "current" : "reuse");
    signature();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const summarize = (variant: "current" | "reuse") => {
    const sorted = [...totals[variant]].sort((a, b) => a - b);
    const count = sorted.length;
    return {
      steps: Object.fromEntries(steps.map((step) => [step, round((sums[variant][step] ?? 0) / count)])),
      totalMedian: round(sorted[Math.floor(count / 2)] ?? 0),
      totalP95: round(sorted[Math.floor(count * 0.95)] ?? 0),
    };
  };
  return {
    video: { width: video.videoWidth, height: video.videoHeight },
    decode: { width, height },
    current: summarize("current"),
    reuse: summarize("reuse"),
    signature: {
      ms: round(signatureMs / input.iterations),
      changeMedian: round([...changes].sort((a, b) => a - b)[Math.floor(changes.length / 2)] ?? 0),
      changeMax: round(Math.max(...changes)),
    },
  };
}

/**
 * デコーダ（アプリが使う zxing-wasm と、置き換える前の jsQR）だけの時間と成功率。合成の画像を、条件（QR なし、大きい QR、小さい QR、暗い、反射、ぼけ、
 * 手ぶれ）ごとに、位置と傾きと雑音を変えて iterations 枚ずつ作り、長辺を sides の各値に縮めて渡す
 */
export async function decoderBench(input: {
  matrix: QrMatrix;
  sides: number[];
  iterations: number;
  zxingOptions: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const jsQR = (window as unknown as { jsQR: JsQr }).jsQR;
  const zxing = (window as unknown as { ZXingWASM: ZXing }).ZXingWASM;
  // 初期化（WASM の取得とコンパイル）にかかる時間。読み取りの時間には含めない
  const initStart = performance.now();
  await zxing.readBarcodes(new ImageData(8, 8), input.zxingOptions);
  const zxingInitMs = performance.now() - initStart;
  const BASE_W = 1280;
  const BASE_H = 920;
  // ブラウザの検出器（BarcodeDetector）。あれば、同じ画像で、成功率と、結果が届くまでの時間を比べる。
  // 縮める前の画像（アプリは、映像のコマをそのまま渡す）と、長辺 640 に縮めた画像の両方を渡す
  type Native = { detect(source: HTMLCanvasElement | ImageData): Promise<{ rawValue: string }[]> };
  const NativeClass = (globalThis as { BarcodeDetector?: { new (options: { formats: string[] }): Native; getSupportedFormats(): Promise<string[]> } })
    .BarcodeDetector;
  const native =
    NativeClass !== undefined && (await NativeClass.getSupportedFormats()).includes("qr_code")
      ? new NativeClass({ formats: ["qr_code"] })
      : null;
  // 乱数は、種から決まる値にする。変更の前後と、ブラウザのあいだで、同じ画像になる
  let seed = 12345;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const canvasOf = (width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("文脈を取れない");
    return [canvas, context];
  };

  type Variant = { name: string; qr: number | null; dark?: boolean; glare?: boolean; blur?: number; motion?: number };
  const variants: Variant[] = [
    { name: "noQr", qr: null },
    { name: "qrLarge", qr: 0.6 },
    { name: "qrSmall", qr: 0.25 },
    { name: "qrDark", qr: 0.6, dark: true },
    { name: "qrGlare", qr: 0.6, glare: true },
    { name: "qrBlur", qr: 0.6, blur: 5 },
    { name: "qrMotion", qr: 0.6, motion: 14 },
  ];

  /** 机や壁、人の服に当たる、明暗のまだらな背景 */
  const background = (context: CanvasRenderingContext2D): void => {
    context.fillStyle = "#9a9a9a";
    context.fillRect(0, 0, BASE_W, BASE_H);
    for (let i = 0; i < 60; i++) {
      const grey = Math.floor(40 + random() * 200);
      context.fillStyle = `rgb(${grey},${grey},${grey})`;
      context.fillRect(random() * BASE_W, random() * BASE_H, 20 + random() * 260, 10 + random() * 180);
    }
    context.fillStyle = "#222";
    context.font = "28px sans-serif";
    for (let i = 0; i < 12; i++) context.fillText("YAPC 受付 0123456789 ABCDEFG", random() * BASE_W * 0.7, random() * BASE_H);
  };

  const draw = (variant: Variant): HTMLCanvasElement => {
    const [canvas, context] = canvasOf(BASE_W, BASE_H);
    background(context);
    if (variant.qr !== null) {
      const count = input.matrix.length;
      const size = BASE_H * variant.qr;
      const modulePx = size / count;
      const quiet = modulePx * 4;
      context.save();
      context.translate(BASE_W / 2 + (random() - 0.5) * BASE_W * 0.3, BASE_H / 2 + (random() - 0.5) * BASE_H * 0.2);
      context.rotate(((random() - 0.5) * 16 * Math.PI) / 180);
      context.fillStyle = "#f4f4f4";
      context.fillRect(-size / 2 - quiet, -size / 2 - quiet, size + quiet * 2, size + quiet * 2);
      context.fillStyle = "#101010";
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (input.matrix[row]?.[col] === true) {
            context.fillRect(-size / 2 + col * modulePx, -size / 2 + row * modulePx, modulePx + 0.5, modulePx + 0.5);
          }
        }
      }
      context.restore();
    }
    if (variant.glare === true) {
      const x = BASE_W / 2 + (random() - 0.5) * 200;
      const y = BASE_H / 2 + (random() - 0.5) * 200;
      const gradient = context.createRadialGradient(x, y, 0, x, y, 260);
      gradient.addColorStop(0, "rgba(255,255,255,0.95)");
      gradient.addColorStop(0.5, "rgba(255,255,255,0.6)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, BASE_W, BASE_H);
    }
    if (variant.dark === true) {
      context.fillStyle = "rgba(0,0,0,0.8)";
      context.fillRect(0, 0, BASE_W, BASE_H);
    }
    let result = canvas;
    if (variant.blur !== undefined) {
      // 縮めてから伸ばして、ぼかす（canvas の filter は、WebKit の版によって使えない）
      const [small, smallContext] = canvasOf(Math.round(BASE_W / variant.blur), Math.round(BASE_H / variant.blur));
      smallContext.drawImage(canvas, 0, 0, small.width, small.height);
      const [blurred, blurredContext] = canvasOf(BASE_W, BASE_H);
      blurredContext.drawImage(small, 0, 0, BASE_W, BASE_H);
      result = blurred;
    }
    if (variant.motion !== undefined) {
      const [moved, movedContext] = canvasOf(BASE_W, BASE_H);
      movedContext.globalAlpha = 1 / variant.motion;
      for (let i = 0; i < variant.motion; i++) movedContext.drawImage(result, i - variant.motion / 2, 0);
      result = moved;
    }
    return result;
  };

  const round = (value: number): number => Math.round(value * 100) / 100;
  const output: Record<string, unknown> = {};
  for (const variant of variants) {
    const times: Record<number, number[]> = {};
    const hits: Record<number, number> = {};
    const nativeTimes: Record<string, number[]> = { full: [], side640: [] };
    const nativeHits: Record<string, number> = { full: 0, side640: 0 };
    const zxingTimes: Record<number, number[]> = {};
    const zxingHits: Record<number, number> = {};
    for (const side of input.sides) {
      times[side] = [];
      hits[side] = 0;
      zxingTimes[side] = [];
      zxingHits[side] = 0;
    }
    for (let i = 0; i < input.iterations; i++) {
      const source = draw(variant);
      if (native !== null) {
        const start = performance.now();
        const found = await native.detect(source);
        nativeTimes.full?.push(performance.now() - start);
        if (found.length > 0) nativeHits.full = (nativeHits.full ?? 0) + 1;
      }
      for (const side of input.sides) {
        const [, context] = canvasOf(side, Math.round((side * BASE_H) / BASE_W));
        context.drawImage(source, 0, 0, context.canvas.width, context.canvas.height);
        const image = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
        // 撮像素子の雑音。暗いときは、明るさに対して大きくなる
        const noise = variant.dark === true ? 14 : 8;
        for (let p = 0; p < image.data.length; p += 4) {
          const delta = (random() - 0.5) * noise;
          image.data[p] = (image.data[p] ?? 0) + delta;
          image.data[p + 1] = (image.data[p + 1] ?? 0) + delta;
          image.data[p + 2] = (image.data[p + 2] ?? 0) + delta;
        }
        const start = performance.now();
        const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        times[side]?.push(performance.now() - start);
        if (found !== null) hits[side] = (hits[side] ?? 0) + 1;
        // Promise を返すが、デコードはメインスレッドで行われる。結果が届くまでの時間が、止まる時間に当たる
        const zxingStart = performance.now();
        const zxingFound = await zxing.readBarcodes(image, input.zxingOptions);
        zxingTimes[side]?.push(performance.now() - zxingStart);
        if (zxingFound.length > 0) zxingHits[side] = (zxingHits[side] ?? 0) + 1;
        if (native !== null && side === 640) {
          const nativeStart = performance.now();
          const nativeFound = await native.detect(image);
          nativeTimes.side640?.push(performance.now() - nativeStart);
          if (nativeFound.length > 0) nativeHits.side640 = (nativeHits.side640 ?? 0) + 1;
        }
      }
    }
    const summarize = (values: number[], count: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        p95Ms: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        success: `${count}/${input.iterations}`,
      };
    };
    output[variant.name] = {
      ...Object.fromEntries(input.sides.map((side) => [`jsqr${side}`, summarize(times[side] ?? [], hits[side] ?? 0)])),
      ...Object.fromEntries(input.sides.map((side) => [`zxing${side}`, summarize(zxingTimes[side] ?? [], zxingHits[side] ?? 0)])),
      ...(native === null
        ? {}
        : {
            nativeFull: summarize(nativeTimes.full ?? [], nativeHits.full ?? 0),
            native640: summarize(nativeTimes.side640 ?? [], nativeHits.side640 ?? 0),
          }),
    };
  }
  output.zxingInitMs = round(zxingInitMs);
  return output;
}

/**
 * zxing-wasm の reader（IIFE 版）に、WASM の中身を直接渡す。ライブラリの既定の取得先（CDN）へ取りに行かせない。
 * run.ts が、IIFE 版のスクリプトをページに入れた後に呼ぶ
 */
export function prepareZxing(wasmBase64: string): void {
  const binary = Uint8Array.from(atob(wasmBase64), (char) => char.charCodeAt(0));
  (window as unknown as { ZXingWASM: { prepareZXingModule(options: unknown): void } }).ZXingWASM.prepareZXingModule({
    overrides: { wasmBinary: binary.buffer },
  });
}
