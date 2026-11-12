import { describe, expect, it } from "vitest";
import type { CheckinRecord } from "../../src/core/record.ts";
import { config, jst } from "../core/helpers.ts";
import { allTickets, dump, finish, publishedWorld, qr, ready, republish, resultKind, scan } from "./fixtures.ts";
import { type Instance, settle, until } from "./harness.ts";

// レビューの指摘から入れた修正（FR-6、FR-8、FR-29、FR-36）を確かめる。
// どのテストも、修正の前の動きでは通らない主張を 1 つ以上持つ

/** 時計を進めて、1 秒ごとの処理を 1 回動かす。始まった定期の同期と、列の処理の終わりを待つ */
async function tickAt(app: Instance, time: number): Promise<void> {
  app.world.now = time;
  app.session.tick();
  await settle();
  await until(() => !app.model.syncInFlight.value, "同期の終わり");
  await settle();
}

describe("手動の上書きが残る配布物の差し替え（FR-8、Design Doc 6.7）", () => {
  /** 本編受付の終了と懇親会受付の開始が重なる境界（11/28 17:30） */
  const OLD_BOUNDARY = jst(2026, 11, 28, 17, 30);

  /** 11/28 17:30 の境界を、すべての受付で to に動かした設定 */
  const moveBoundary =
    (to: number) =>
    (base: typeof config): typeof config => ({
      ...base,
      receptions: base.receptions.map((reception) => ({
        ...reception,
        periods: reception.periods.map((period) => ({
          start: period.start === OLD_BOUNDARY ? to : period.start,
          end: period.end === OLD_BOUNDARY ? to : period.end,
        })),
      })),
    });

  /** 本編受付の期間中（10:00）に、終了した前夜祭受付へ手動で切り替える。上書きは 17:30 まで */
  async function overridden(): Promise<{ app: Instance; world: Instance["world"]; tickets: ReturnType<typeof allTickets> }> {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.commands.openReceptionSheet();
    app.commands.chooseReception("eve");
    await app.commands.confirmReceptionChange();
    expect(app.model.override.value).toEqual({ receptionId: "eve", until: OLD_BOUNDARY });
    expect((await dump()).meta.override).toEqual({ receptionId: "eve", until: OLD_BOUNDARY });
    return { app, world, tickets: allTickets(people) };
  }

  it("境界を後ろにずらした設定では、古い境界を過ぎても上書きが続き、新しい境界で切れる", async () => {
    const { app, world, tickets } = await overridden();
    const newBoundary = jst(2026, 11, 28, 18, 30);
    const next = republish(world, tickets, 1, moveBoundary(newBoundary));
    await app.sync.runSync();
    await settle();

    // 差し替えた時点で、持続の終わりを新しい設定の次の境界に付け直し、保存する
    expect(app.model.config.value?.version).toBe(next.version);
    expect(app.model.override.value).toEqual({ receptionId: "eve", until: newBoundary });
    expect((await dump()).meta.override).toEqual({ receptionId: "eve", until: newBoundary });
    // 受付は変わらないので、知らせはデータの更新だけ
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "eve" }, manual: true });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "dataUpdated" }]);

    // 古い境界（17:30）を過ぎても、上書きは続く
    await tickAt(app, jst(2026, 11, 28, 17, 45));
    expect(app.model.override.value).toEqual({ receptionId: "eve", until: newBoundary });
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "eve" }, manual: true });
    expect((await dump()).meta.override).toEqual({ receptionId: "eve", until: newBoundary });

    // 新しい境界の直前まで続き、境界で切れて自動の選択（18:30 からの懇親会受付）に戻る
    await tickAt(app, newBoundary - 1000);
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "eve" }, manual: true });
    await tickAt(app, newBoundary);
    expect(app.model.override.value).toBeNull();
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "party" }, manual: false });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "receptionChanged", name: "懇親会受付" }]);
    expect((await dump()).meta.override).toBeNull();
  });

  it("境界を前にずらした設定では、新しい境界を跨いだ時点で上書きが切れる", async () => {
    const { app, world, tickets } = await overridden();
    const newBoundary = jst(2026, 11, 28, 16, 30);
    const next = republish(world, tickets, 1, moveBoundary(newBoundary));
    await app.sync.runSync();
    await settle();

    expect(app.model.config.value?.version).toBe(next.version);
    expect(app.model.override.value).toEqual({ receptionId: "eve", until: newBoundary });
    expect((await dump()).meta.override).toEqual({ receptionId: "eve", until: newBoundary });

    // 新しい境界の直前までは続く
    await tickAt(app, newBoundary - 1000);
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "eve" }, manual: true });

    // 新しい境界で切れる。古い境界（17:30）までは続かない
    await tickAt(app, newBoundary);
    expect(app.model.override.value).toBeNull();
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "party" }, manual: false });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "receptionChanged", name: "懇親会受付" }]);
    expect((await dump()).meta.override).toBeNull();
  });
});

describe("読み取りを受理する前の、受付の確かめ直し（FR-6、FR-7）", () => {
  it("1 秒ごとの処理より先に境界を跨いだ読み取りは、新しい受付のルールと id で判定し、記録する", async () => {
    // 本編受付の終了（17:30）の直前。17:30 から懇親会受付
    const { world, people } = publishedWorld(jst(2026, 11, 28, 17, 29, 59));
    const app = await ready(world);
    app.commands.startScan();
    await settle();
    expect(app.model.confirmedReception.value.reception?.id).toBe("main");

    // 1 秒ごとの処理が走る前に、境界を跨いだ時刻で、懇親会のチケットを読む
    world.now = jst(2026, 11, 28, 17, 30);
    app.scan.handleDecoded(qr(people.dave));
    await settle();

    // 終わった本編受付なら切り替えの提案になり、記録を作らない。懇親会受付で成功にする
    expect(app.model.screen.value).toMatchObject({
      id: "home",
      mode: { kind: "result", reception: { id: "party" }, judgement: { kind: "success" } },
    });
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "party" }, manual: false });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "receptionChanged", name: "懇親会受付" }]);
    expect(app.model.records.value).toMatchObject([
      { op: "checkin", ticketToken: people.dave.ticketToken, reception: "party", deviceTime: world.now },
    ]);
    expect((await dump()).data.records).toMatchObject([{ ticketToken: people.dave.ticketToken, reception: "party" }]);
    expect(app.fake.sounds).toEqual(["success"]);
  });

  it("境界を跨いだ読み取りで、終わった受付のチケットは、終わった受付の記録にしない", async () => {
    const { world, people } = publishedWorld(jst(2026, 11, 28, 17, 29, 59));
    const app = await ready(world);
    app.commands.startScan();
    await settle();

    // 本編のチケット。本編受付ならチェックインになるが、懇親会受付は受け付けない
    world.now = jst(2026, 11, 28, 17, 30);
    app.scan.handleDecoded(qr(people.alice));
    await settle();

    // 本編受付は翌日の期間が残るので、切り替えを提案する（FR-9）
    expect(app.model.screen.value).toMatchObject({
      id: "home",
      mode: { kind: "result", reception: { id: "party" }, judgement: { kind: "suggestSwitch", reception: { id: "main" } } },
    });
    expect(app.model.records.value).toHaveLength(0);
    expect((await dump()).data.records).toHaveLength(0);
  });

  it("境界を跨いで受付なしになった読み取りは、記録を作らずに停止中に戻す", async () => {
    // 本編受付の 2 日目の終了（18:00）の直前。その後の受付はない
    const { world, people } = publishedWorld(jst(2026, 11, 29, 17, 59, 59));
    const app = await ready(world);
    app.commands.startScan();
    await settle();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "scanning", camera: "streaming" } });
    const stops = app.fake.cameraStops;

    world.now = jst(2026, 11, 29, 18, 0);
    app.scan.handleDecoded(qr(people.alice));
    // 受理しない。その場で停止中に戻る
    expect(app.model.judging.value).toBe(false);
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    await settle();

    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    expect(app.model.judging.value).toBe(false);
    expect(app.model.confirmedReception.value).toEqual({ reception: null, manual: false });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "receptionChanged", name: null }]);
    expect(app.model.records.value).toHaveLength(0);
    expect((await dump()).data.records).toHaveLength(0);
    expect(app.fake.sounds).toEqual([]);
    expect(app.fake.cameraStops).toBeGreaterThan(stops);
    expect(app.fake.wakeLock).toBe(false);
  });
});

describe("S01 から、再ログインせずにホームに戻る（FR-36、FR-6、FR-40）", () => {
  const backs: [string, (app: Instance) => Promise<void> | void][] = [
    ["goBack()", (app) => app.commands.goBack()],
    ["backFromLogin()", (app) => app.session.backFromLogin()],
  ];

  it.each(backs)("移動が成立しなかった「Discord でログイン」の後、%s で戻ると、1 秒ごとの処理が再開される", async (_name, back) => {
    // 本編受付の期間中。17:30 から懇親会受付
    const { world } = publishedWorld(jst(2026, 11, 28, 17, 0));
    const app = await ready(world);
    app.session.startRelogin();
    expect(app.model.screen.value).toEqual({ id: "S01", phase: "idle", canGoBack: true });

    // 「Discord でログイン」。移動は偽物なので成立せず、S01 に残る
    app.session.startLogin();
    expect(app.fake.loginNavigations).toBe(1);
    expect(app.model.screen.value.id).toBe("S01");

    // 前提の確認。S01 にいる間は、1 秒ごとの処理が止まっていて、定期の同期は動かない
    const before = world.server.syncRequests.length;
    world.now += 31_000;
    app.session.tick();
    await settle();
    expect(world.server.syncRequests).toHaveLength(before);

    await back(app);
    await settle();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    expect(app.model.confirmedReception.value.reception?.id).toBe("main");
    expect(app.model.notice.value).toBeNull();

    // ホームに戻った後に境界を跨ぐ。受付の自動の切り替えと、定期の同期が動く
    await tickAt(app, jst(2026, 11, 28, 17, 30));
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "party" }, manual: false });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "receptionChanged", name: "懇親会受付" }]);
    expect(world.server.syncRequests.length).toBeGreaterThan(before);
    expect(app.derived.syncStatus.value).toBe("synced");

    // 読み取り中の 2 分の計時も動く
    app.commands.startScan();
    await settle();
    expect(app.model.screen.value).toMatchObject({ mode: { kind: "scanning" } });
    await tickAt(app, world.now + 120_000);
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
  });
});

describe("取り消しの確定の前提（FR-29、画面設計書 S08-M1）", () => {
  /** alice をチェックインして、その操作の S08-M1 を開く */
  async function cancelSheet(): Promise<{ app: Instance; mine: CheckinRecord; people: ReturnType<typeof publishedWorld>["people"] }> {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("success");
    await finish(app);
    const mine = app.model.records.value[0] as CheckinRecord;
    app.commands.openOperation(mine.opId);
    app.commands.openCancelConfirm();
    expect(app.model.overlay.value).toEqual({ id: "S08-M1" });
    expect(app.model.notice.value).toBeNull();
    return { app, mine, people };
  }

  const blanks: [string, string][] = [
    ["空", ""],
    ["半角の空白", "   "],
    ["改行とタブ", "\n\t\r\n"],
    ["全角の空白", "　　"],
  ];

  it.each(blanks)("「その他」で自由記述が%sなら、確定せず、シートを閉じず、記録を作らない", async (_name, text) => {
    const { app, mine, people } = await cancelSheet();
    await app.commands.confirmCancel([people.alice.ticketToken], { kind: "other", text });

    expect(app.model.overlay.value).toEqual({ id: "S08-M1" });
    expect(app.model.screen.value).toMatchObject({ id: "S08", opId: mine.opId });
    expect(app.model.busy.value).toBe(false);
    expect(app.model.notice.value).toBeNull();
    expect(app.model.records.value.map((record) => record.op)).toEqual(["checkin"]);
    expect((await dump()).data.records.map((record) => record.op)).toEqual(["checkin"]);
    expect(app.derived.ticketStates.value.get(people.alice.ticketToken)?.done).toBe(true);

    // 同じシートで、自由記述を入れれば確定できる
    await app.commands.confirmCancel([people.alice.ticketToken], { kind: "other", text: " 二重に読み取った " });
    expect(app.model.overlay.value).toBeNull();
    expect(app.model.records.value.at(-1)).toMatchObject({ op: "cancel", reasonKind: "other" });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "cancelled" }]);
    expect((await dump()).data.records.map((record) => record.op).sort()).toEqual(["cancel", "checkin"]);
  });

  it("選んだトークンがその操作の記録に 1 つもなければ、記録を作らず、知らせも出さない", async () => {
    const { app, mine, people } = await cancelSheet();
    // bob のチケットは、alice の操作の記録にない。索引にないトークンも同じ
    await app.commands.confirmCancel([people.bob1.ticketToken, "Z".repeat(32)], { kind: "mistake" });

    expect(app.model.notice.value).toBeNull();
    expect(app.model.busy.value).toBe(false);
    expect(app.model.screen.value).toMatchObject({ id: "S08", opId: mine.opId });
    expect(app.model.records.value.map((record) => record.op)).toEqual(["checkin"]);
    expect((await dump()).data.records.map((record) => record.op)).toEqual(["checkin"]);
    expect(app.derived.ticketStates.value.get(people.alice.ticketToken)?.done).toBe(true);
    expect(app.views.operationView(mine.opId)?.cancellable).toMatchObject([{ ticketToken: people.alice.ticketToken }]);
  });
});
