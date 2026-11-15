import { describe, expect, it } from "vitest";
import { jst } from "../core/helpers.ts";
import { IN_MAIN, publishedWorld, ready, scan } from "./fixtures.ts";
import { settle } from "./harness.ts";

// 1 秒ごとの時計の更新（commands/session.ts の tick()）が、表示の変わらない画面を描き直さないこと。
// 画面は、表示用の値（state/views.ts）を描画の中で読み、読んだ Signal が変わると描き直される。ここでは、同じ読み方を
// effect で行い、実行された回数を数える。

/** 表示用の値を読む処理が、何回実行されたかを数える。画面の描画の代わり */
async function watch<T>(read: () => T): Promise<{ runs: () => number; value: () => T }> {
  // 起動（launch()）がモジュールを読み込み直した後に読み込む。受付アプリの状態と同じ Signal の実装になる
  const { effect } = await import("@preact/signals");
  let runs = 0;
  let value: T;
  effect(() => {
    value = read();
    runs++;
  });
  return { runs: () => runs, value: () => value };
}

describe("時計の更新と描き直し", () => {
  it("時刻の表示は、秒が進んでも描き直さず、日付が変わったときに描き直す", async () => {
    const { world } = publishedWorld(jst(2026, 11, 28, 23, 59, 50));
    const app = await ready(world);
    const at = jst(2026, 11, 28, 10, 0);
    const clock = await watch(() => app.views.formatClock(at));
    expect(clock.value()).toBe("10:00");
    expect(clock.runs()).toBe(1);

    for (let i = 0; i < 5; i++) {
      world.now += 1000;
      app.session.tick();
    }
    expect(app.model.now.value).toBe(jst(2026, 11, 28, 23, 59, 55));
    expect(clock.runs()).toBe(1);

    // 設定のタイムゾーン（日本時間）で日付が変わる。当日ではなくなるので、月日が付く
    world.now = jst(2026, 11, 29, 0, 0, 0);
    app.session.tick();
    expect(clock.value()).toBe("11/28 10:00");
    expect(clock.runs()).toBe(2);
    world.now += 1000;
    app.session.tick();
    expect(clock.runs()).toBe(2);
  });

  it("受付のカードは、秒が進んでも描き直さず、期間の境界で描き直す", async () => {
    // 本編受付の期間は 11/28 9:30〜17:30
    const { world } = publishedWorld(jst(2026, 11, 28, 17, 29, 55));
    const app = await ready(world);
    const card = await watch(() => app.views.receptionCard());
    expect(card.value()).toMatchObject({
      reception: { id: "main" },
      period: { start: jst(2026, 11, 28, 9, 30), end: jst(2026, 11, 28, 17, 30) },
    });
    expect(card.runs()).toBe(1);

    for (let i = 0; i < 4; i++) {
      world.now += 1000;
      app.session.tick();
    }
    expect(card.runs()).toBe(1);

    // 終了の時刻は、期間に含まない
    world.now = jst(2026, 11, 28, 17, 30, 0);
    app.session.tick();
    expect(card.runs()).toBeGreaterThan(1);
    expect(card.value().reception?.id).not.toBe("main");
  });

  it("手動で切り替えた受付の期間外では、期間を出さず、秒が進んでも描き直さない", async () => {
    const { world } = publishedWorld(IN_MAIN);
    const app = await ready(world);
    app.commands.openReceptionSheet();
    app.commands.chooseReception("party");
    await app.commands.confirmReceptionChange();
    const card = await watch(() => app.views.receptionCard());
    expect(card.value()).toMatchObject({ reception: { id: "party" }, manual: true, period: null });
    const runs = card.runs();
    world.now += 1000;
    app.session.tick();
    expect(card.runs()).toBe(runs);
  });

  it("参考情報のシート（S04-M1）は、秒が進んでも描画し直さず、日付が変わったときに描画し直す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    const html = await watch(() => app.views.referenceHtml());
    expect(html.value()).not.toBeNull();
    expect(html.runs()).toBe(1);

    for (let i = 0; i < 5; i++) {
      world.now += 1000;
      app.session.tick();
    }
    expect(html.runs()).toBe(1);

    // 翌日になる
    world.now += 24 * 60 * 60 * 1000;
    app.session.tick();
    expect(html.runs()).toBe(2);
  });
});

describe("S99 に移るとき", () => {
  it("読み取り中なら、カメラを止める", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    app.commands.startScan();
    await settle();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "scanning", camera: "streaming" } });
    const stops = app.fake.cameraStops;

    app.runtime.fatal(new Error("想定外のエラー"));
    expect(app.model.screen.value.id).toBe("S99");
    expect(app.fake.cameraStops).toBe(stops + 1);
  });
});
