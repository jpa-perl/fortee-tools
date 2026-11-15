// 計測（run.ts）が、ページの中で実行する関数。page.evaluate() に渡すので、どの関数も、引数だけで閉じている
// （このファイルのほかの値と、import を参照しない）。

import type { QrMatrix } from "../e2e/qr-matrix.ts";

export type { QrMatrix };

/** デコーダに渡す画像の長辺。640 がいまの上限（Design Doc 6.5）。小さい値は、解像度を下げる案の比較のため */
export const DECODER_SIDES = [640, 480, 320];

/**
 * 端末の記憶域に、合成のチケットと記録を置く。公開されたスナップショットの 1 つ（本編）に参加者を足し、
 * 記録を、半分はこの端末、半分は別の端末のものとして置く。どれも送信済みにする。呼んだ後に読み込み直す
 */
export async function seedDatabase(input: { tickets: number; records: number; now: number }): Promise<void> {
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
}

type JsQr = (data: Uint8ClampedArray, width: number, height: number, options: { inversionAttempts: string }) => { data: string } | null;

/**
 * 読み取りの 1 回の処理（services/camera.ts の grab()）の内訳。読み取り中の映像の要素から、同じ切り出しと
 * 縮小で取り出す。current は、毎回キャンバスの大きさを入れ直して文脈を取り直す手順、reuse は、大きさが
 * 同じなら入れ直さず、文脈を持ち回る手順。2 つを交互に、50 ms おきに行う。値は 1 回あたりの ms
 */
export async function pipelineBench(input: { iterations: number }): Promise<Record<string, unknown>> {
  const jsQR = (window as unknown as { jsQR: JsQr }).jsQR;
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

  const steps = ["resize", "getContext", "mark", "drawImage", "getImageData", "decode"] as const;
  const blank = (): Record<string, number> => Object.fromEntries(steps.map((step) => [step, 0]));
  const sums = { current: blank(), reuse: blank() };
  const totals: { current: number[]; reuse: number[] } = { current: [], reuse: [] };
  const canvases = { current: document.createElement("canvas"), reuse: document.createElement("canvas") };
  let reused: CanvasRenderingContext2D | null = null;

  const once = (variant: "current" | "reuse"): void => {
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
    jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
    lap("decode");
    totals[variant].push(performance.now() - start);
  };

  for (let i = 0; i < input.iterations; i++) {
    once(i % 2 === 0 ? "current" : "reuse");
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
  };
}

/**
 * デコーダ（jsQR）だけの時間と成功率。合成の画像を、条件（QR なし、大きい QR、小さい QR、暗い、反射、ぼけ、
 * 手ぶれ）ごとに、位置と傾きと雑音を変えて iterations 枚ずつ作り、長辺を sides の各値に縮めて渡す
 */
export function decoderBench(input: { matrix: QrMatrix; sides: number[]; iterations: number }): Record<string, unknown> {
  const jsQR = (window as unknown as { jsQR: JsQr }).jsQR;
  const BASE_W = 1280;
  const BASE_H = 920;
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
    for (const side of input.sides) {
      times[side] = [];
      hits[side] = 0;
    }
    for (let i = 0; i < input.iterations; i++) {
      const source = draw(variant);
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
      }
    }
    output[variant.name] = Object.fromEntries(
      input.sides.map((side) => {
        const sorted = [...(times[side] ?? [])].sort((a, b) => a - b);
        return [
          side,
          {
            medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
            p95Ms: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
            success: `${hits[side] ?? 0}/${input.iterations}`,
          },
        ];
      }),
    );
  }
  return output;
}
