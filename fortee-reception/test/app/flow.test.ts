import { describe, expect, it } from "vitest";
import type { CheckinRecord } from "../../src/core/record.ts";
import { cancel, checkin, config, DEVICE_B, jst, MAIN, snapshotsOf, ticket, uuid } from "../core/helpers.ts";
import {
  AFTER_ALL,
  allTickets,
  dump,
  finish,
  IN_MAIN,
  publishedWorld,
  qr,
  ready,
  republish,
  resultKind,
  scan,
} from "./fixtures.ts";
import { deferred, settle, until } from "./harness.ts";

// 読み取りと判定、検索からのチェックイン、取り消し、受付操作の途中の保留（Design Doc 6.2、6.5、6.13）

const wire = (record: object): CheckinRecord => {
  const { receivedAt: _receivedAt, ...rest } = record as CheckinRecord & { receivedAt?: unknown };
  return rest;
};

describe("QR の読み取りと記録の作成（Design Doc 6.13）", () => {
  it("読み取りを受理したら、結果を出すまで、次のデコードの結果を捨てる", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.commands.startScan();
    await settle();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "scanning", camera: "streaming" } });

    // デコードは 150 ms ごとに結果を返す。記録を書き終える前に、同じ QR がもう一度届く
    app.scan.handleDecoded(qr(people.alice));
    expect(app.model.judging.value).toBe(true);
    app.scan.handleDecoded(qr(people.alice));
    app.scan.handleDecoded(qr(people.bob1));
    await settle();

    expect(resultKind(app)).toBe("success");
    expect(app.model.judging.value).toBe(false);
    expect(app.model.records.value).toHaveLength(1);
    expect((await dump()).data.records).toHaveLength(1);
    expect(app.fake.sounds).toEqual(["success"]);
    // 結果ではカメラを止め、画面のスリープは止めたままにする
    expect(app.fake.cameraStops).toBeGreaterThan(0);
    expect(app.fake.wakeLock).toBe(true);
  });

  it("結果から読み取り中に戻った直後の 3 秒間は、直前に判定したチケットを無視する", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    app.commands.nextFromResult();
    await settle();

    world.now += 2000;
    app.scan.handleDecoded(qr(people.alice));
    await settle();
    expect(app.model.screen.value).toMatchObject({ mode: { kind: "scanning" } });

    world.now += 1500;
    app.scan.handleDecoded(qr(people.alice));
    await settle();
    expect(resultKind(app)).toBe("alreadyDone");
    expect(app.model.records.value).toHaveLength(1);
    expect(app.fake.sounds).toEqual(["success", "caution"]);
  });

  it("QR 形式外は、結果にせずバナーを出す。同じ内容を写し続けている間は出し直さず、2 分を数え直さない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.commands.startScan();
    await settle();

    app.scan.handleDecoded("https://example.com/");
    expect(app.model.scanBanner.value).toBe(true);
    app.fake.runTimers();
    expect(app.model.scanBanner.value).toBe(false);
    world.now += 1000;
    app.scan.handleDecoded("https://example.com/");
    expect(app.model.scanBanner.value).toBe(false);
    expect(app.model.records.value).toHaveLength(0);

    // 形式外の QR が写り続けていても、2 分で停止中に戻す
    world.now += 119_000;
    app.scan.handleDecoded("https://example.com/");
    app.session.tick();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    expect(app.fake.wakeLock).toBe(false);
    void people;
  });

  it("索引にないトークンは、判定を呼ばずに、見つからないを出す。記録を作らない", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    app.commands.startScan();
    await settle();
    app.scan.handleDecoded(`fortee:${"Z".repeat(32)}`);
    await settle();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "notFound", token: "Z".repeat(32) } });
    expect(app.fake.sounds).toEqual(["reject"]);
    expect(app.model.records.value).toHaveLength(0);
  });

  it("受理の後は、「終了」、バックグラウンドへの移行、戻る操作で停止中に戻さない。結果でも戻る操作は何もしない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.commands.startScan();
    await settle();
    app.scan.handleDecoded(qr(people.alice));
    app.commands.stopScan();
    app.fake.setVisible(false);
    app.fake.back();
    await settle();
    expect(resultKind(app)).toBe("success");

    app.fake.back();
    app.commands.goBack();
    expect(resultKind(app)).toBe("success");
    expect(app.fake.armed).toBe(true);
  });

  it("判定と書き込みのあいだに、同期の結果が入らない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.commands.startScan();
    await settle();

    // 同期の応答を待たせ、他端末が同じチケットを先にチェックインした記録を、その応答に載せる
    const gate = deferred();
    world.server.syncGates.push(gate.promise);
    const syncing = app.sync.runSync();
    await until(() => world.server.syncGates.length === 0);
    world.server.add(wire(checkin(1, people.alice.ticketToken, IN_MAIN - 60_000, { deviceId: DEVICE_B })));

    // 読み取りを受理した直後に、応答が届く。判定は、書き込みと同じ列の処理なので、届いた記録は判定の後に合流する
    app.scan.handleDecoded(qr(people.alice));
    gate.resolve();
    await syncing;
    await settle();

    expect(resultKind(app)).toBe("success");
    expect(app.model.records.value).toHaveLength(2);
    // 結果の一覧は、判定した時点の状態のまま。帯は成功で、一覧は「今回」
    expect(app.views.resultView()?.groups[0]?.tickets[0]?.status).toBe("new");
    // 集約では、他端末の先の記録が根拠になる（FR-41）
    const state = app.derived.ticketStates.value.get(people.alice.ticketToken);
    expect(state?.done && state.basis.deviceId).toBe(DEVICE_B);
  });

  it("同期の結果が先に反映されていれば、その記録で判定する", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    world.server.add(wire(checkin(1, people.alice.ticketToken, IN_MAIN - 60_000, { deviceId: DEVICE_B })));
    await app.sync.runSync();
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("alreadyDone");
    expect(app.model.records.value).toHaveLength(1);
  });

  it("記録を作るときの検証を通らなければ、保存せずに S99 に移る", async () => {
    const { world, people } = publishedWorld();
    // チケット番号が、記録に写せる長さ（100 文字）を超えている。取り込みが止めるはずの値
    const broken = ticket({ eventId: MAIN, userName: "long", ticketNo: "X".repeat(101) });
    world.server.publish(config, snapshotsOf([...allTickets(people), broken]));
    const app = await ready(world);
    await scan(app, broken);
    expect(app.model.screen.value.id).toBe("S99");
    expect((await dump()).data.records).toHaveLength(0);
    // S99 では、接続を閉じる
    expect(app.runtime.rt.db).toBeNull();
  });
});

describe("検索からのチェックイン（Design Doc 6.5）", () => {
  it("イベントごとに選んだチケットを、経路を検索にして判定する", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.commands.openSearch();
    app.commands.setSearchQuery("bob");
    expect(app.views.searchCandidates("bob").map((candidate) => candidate.userName)).toEqual(["bob"]);
    app.commands.openCandidate("bob");

    // 本編のチケットが 2 枚あり、どちらも済みでないので、最初は選ばれていない
    expect(app.views.candidateView()).toMatchObject({ complete: false, blocked: null });
    app.commands.selectTicket(MAIN, people.bob2.ticketToken);
    expect(app.views.candidateView()).toMatchObject({ complete: true, selectedTicketNos: [people.bob2.ticketNo] });

    app.commands.openSearchCheckinConfirm();
    await app.commands.confirmSearchCheckin();
    expect(resultKind(app)).toBe("success");
    expect(app.model.overlay.value).toBeNull();
    expect(app.model.records.value).toMatchObject([{ ticketToken: people.bob2.ticketToken, route: "search" }]);

    // 戻ると、S06 は入力を残して S05 へ。S05 からは停止中へ
    await finish(app);
    app.commands.openSearch();
    app.commands.setSearchQuery("bob");
    app.commands.openCandidate("bob");
    // 済みのチケットがあれば、それを最初から選んでおく
    expect(app.model.screen.value).toMatchObject({ selected: { [MAIN]: people.bob2.ticketToken }, query: "bob" });
    app.fake.back();
    expect(app.model.screen.value).toEqual({ id: "S05", query: "bob" });
    app.fake.back();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    expect(app.fake.armed).toBe(false);
  });

  it("カメラの使用が拒否されている端末では、結果の主ボタンで S05 に移り、入力欄を空にする", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.fake.cameraResult = "denied";
    app.commands.startScan();
    await settle();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "scanning", camera: "denied" } });
    app.commands.openSearch();
    app.commands.setSearchQuery("alice");
    app.commands.openCandidate("alice");
    app.commands.openSearchCheckinConfirm();
    await app.commands.confirmSearchCheckin();
    expect(resultKind(app)).toBe("success");
    app.commands.nextFromResult();
    expect(app.model.screen.value).toEqual({ id: "S05", query: "" });
    void people;
  });
});

describe("取り消し（Design Doc 6.2、FR-29）", () => {
  it("確定した時点の、打ち消されていないチェックインの記録をすべて指す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await finish(app);
    const mine = app.model.records.value[0] as CheckinRecord;

    // 他端末が同じチケットを後からチェックインした記録（FR-41 の重複）が届く
    const duplicate = world.server.add(wire(checkin(2, people.alice.ticketToken, IN_MAIN + 60_000, { deviceId: DEVICE_B })));
    await app.sync.runSync();

    app.commands.openOperation(mine.opId);
    expect(app.views.operationView(mine.opId)?.cancellable).toMatchObject([{ ticketToken: people.alice.ticketToken }]);
    app.commands.openCancelConfirm();
    await app.commands.confirmCancel([people.alice.ticketToken], { kind: "mistake" });

    const created = app.model.records.value.find((record) => record.op === "cancel");
    expect(created).toMatchObject({ reasonKind: "mistake", reception: "main", userName: "alice", sent: false });
    expect([...(created?.targetRecordIds ?? [])].sort()).toEqual([mine.recordId, duplicate.recordId].sort());
    expect(app.derived.ticketStates.value.get(people.alice.ticketToken)?.done).toBe(false);
    // S08 にとどまり、知らせを出す
    expect(app.model.screen.value).toMatchObject({ id: "S08", opId: mine.opId });
    expect(app.model.overlay.value).toBeNull();
    expect(app.model.notice.value?.lines).toEqual([{ kind: "cancelled" }]);
    expect(app.views.operationView(mine.opId)).toMatchObject({ notes: [{ kind: "allCancelled" }], cancellable: [] });
  });

  it("確認を開いた後に届いた再チェックインは指さない。根拠でなくなったチケットは取り消さない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await finish(app);
    await app.sync.runSync();
    const mine = app.model.records.value[0] as CheckinRecord;
    app.commands.openOperation(mine.opId);
    app.commands.openCancelConfirm();

    // 確認を開いている間に、他端末の「同じチケットを取り消して再チェックイン」が届く
    world.server.add({
      ...wire(cancel(10, people.alice.ticketToken, IN_MAIN + 1000, [], { deviceId: DEVICE_B })),
      targetRecordIds: [mine.recordId],
    } as CheckinRecord);
    const again = world.server.add(wire(checkin(11, people.alice.ticketToken, IN_MAIN + 2000, { deviceId: DEVICE_B })));
    await app.sync.runSync();
    // 他端末の記録の合流は、受付操作の途中でも保留しない
    expect(app.model.records.value).toHaveLength(3);

    await app.commands.confirmCancel([people.alice.ticketToken], { kind: "wrong_person" });
    expect(app.model.records.value).toHaveLength(3);
    expect(app.model.notice.value?.lines).toEqual([{ kind: "cancelSkipped", ticketNos: [people.alice.ticketNo] }]);
    const state = app.derived.ticketStates.value.get(people.alice.ticketToken);
    expect(state?.done && state.basis.recordId).toBe(again.recordId);
    expect(app.views.operationView(mine.opId)).toMatchObject({
      notes: [{ kind: "allCancelled" }],
      cancellable: [],
    });
  });

  it("上限を超える自由記述を持つ記録は、保存しない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await finish(app);
    const mine = app.model.records.value[0] as CheckinRecord;
    app.commands.openOperation(mine.opId);
    app.commands.openCancelConfirm();
    await app.commands.confirmCancel([people.alice.ticketToken], { kind: "other", text: "あ".repeat(2001) });
    expect(app.model.screen.value.id).toBe("S99");
    expect((await dump()).data.records.map((record) => record.op)).toEqual(["checkin"]);
  });

  it("受付なしのときも取り消せる。記録の受付は null になる", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await finish(app);
    world.now = AFTER_ALL;
    app.session.tick();
    expect(app.model.confirmedReception.value.reception).toBeNull();
    const mine = app.model.records.value[0] as CheckinRecord;
    app.commands.openOperation(mine.opId);
    app.commands.openCancelConfirm();
    await app.commands.confirmCancel([people.alice.ticketToken], { kind: "other", text: "理由" });
    expect(app.model.records.value.at(-1)).toMatchObject({ op: "cancel", reception: null, reasonText: "理由" });
    void uuid;
  });
});

describe("受付操作の途中の保留（Design Doc 6.2、6.7、画面設計書 2.7）", () => {
  it("受付操作の途中かどうか", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    const { isMidOperation } = app.derived;
    const result = { kind: "notFound", token: "x" } as const;
    expect(isMidOperation({ id: "home", mode: { kind: "idle" } }, null, false)).toBe(false);
    expect(isMidOperation({ id: "home", mode: { kind: "scanning", camera: "streaming" } }, null, false)).toBe(false);
    // 読み取りを受理してから結果を出すまで
    expect(isMidOperation({ id: "home", mode: { kind: "scanning", camera: "streaming" } }, null, true)).toBe(true);
    expect(isMidOperation({ id: "home", mode: result }, null, false)).toBe(true);
    expect(isMidOperation({ id: "S06", userName: "a", selected: {}, query: "" }, null, false)).toBe(true);
    expect(isMidOperation({ id: "S08", opId: "x", from: "home" }, null, false)).toBe(true);
    expect(isMidOperation({ id: "S05", query: "" }, null, false)).toBe(false);
    expect(isMidOperation({ id: "S07", filter: "" }, null, false)).toBe(false);
    // シートかダイアログが開いている間
    expect(isMidOperation({ id: "home", mode: { kind: "idle" } }, { id: "S02-M1", step: { kind: "list" } }, false)).toBe(true);
    expect(isMidOperation({ id: "S09" }, { id: "S09-D1" }, false)).toBe(true);
  });

  it("配布物の差し替えと、期間の境界での受付の切り替えを、途中が終わるまで保留し、2 行で同時に知らせる", async () => {
    // 本編受付の終了（17:30）の直前。17:30 から懇親会受付
    const { world, people } = publishedWorld(jst(2026, 11, 28, 17, 29));
    const app = await ready(world);
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("success");

    // 結果を出している間に、境界を跨ぎ、新しい配布物が公開される
    const late = ticket({ eventId: MAIN, userName: "late" });
    const nextConfig = republish(world, [...allTickets(people), late], 1);
    world.now = jst(2026, 11, 28, 17, 31);
    // 前の同期から 30 秒を過ぎているので、定期の同期が始まる
    app.session.tick();
    await until(() => world.server.paths.includes(`/api/config/${nextConfig.version}`));
    await settle();
    expect(app.model.syncInFlight.value).toBe(false);
    expect(app.model.confirmedReception.value.reception?.id).toBe("main");
    expect(app.model.config.value?.version).toBe(config.version);
    expect((await dump()).data.config?.version).toBe(config.version);
    expect(app.model.notice.value).toBeNull();
    // 同期は成功している。保留は失敗ではない
    expect(app.derived.syncStatus.value).toBe("synced");

    // 途中が終わった時点で反映する。受付の知らせを上にする
    await finish(app);
    expect(app.model.config.value?.version).toBe(nextConfig.version);
    expect((await dump()).data.config?.version).toBe(nextConfig.version);
    expect(app.derived.snapshotIndex.value?.byToken.has(late.ticketToken)).toBe(true);
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "party" }, manual: false });
    expect(app.model.notice.value?.lines).toEqual([
      { kind: "receptionChanged", name: "懇親会受付" },
      { kind: "dataUpdated" },
    ]);
  });

  it("主ボタンで次の読み取りに進んだときも、次の判定は、差し替えた配布物で行う", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    const late = ticket({ eventId: MAIN, userName: "late" });
    republish(world, [...allTickets(people), late], 1);
    await app.sync.runSync();

    app.commands.nextFromResult();
    app.scan.handleDecoded(qr(late));
    await settle();
    expect(resultKind(app)).toBe("success");
  });

  it("保留している間にさらに新しい版を知ったら、保留したものを捨てて取得し直す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    republish(world, allTickets(people), 1);
    await app.sync.runSync();
    republish(world, allTickets(people), 2);
    await app.sync.runSync();
    await finish(app);
    expect(app.model.config.value?.version).toBe(config.version + 2);
  });

  it("保留している間に、提案から受付を切り替えたら、保留していた自動の切り替えを捨てる", async () => {
    const { world, people } = publishedWorld(jst(2026, 11, 28, 17, 29));
    const app = await ready(world);
    // 本編受付で、懇親会のチケットを読む。懇親会受付（これから）を提案する
    await scan(app, people.dave);
    expect(app.views.resultView()).toMatchObject({
      kind: "suggestSwitch",
      suggestion: { receptionName: "懇親会受付", outOfPeriod: true },
    });

    // 境界を跨いだ後に、切り替えを確定する
    world.now = jst(2026, 11, 28, 17, 31);
    app.session.tick();
    app.commands.openSwitchConfirm();
    await app.commands.confirmSuggestedSwitch();
    // 同じチケットを、新しい受付で判定し直す。音と振動で知らせ直す
    expect(resultKind(app)).toBe("success");
    expect(app.fake.sounds).toEqual(["caution", "success"]);
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "party" }, manual: true });
    // 上書きは、確定した時刻の次の境界まで持続する
    expect(app.model.override.value).toEqual({ receptionId: "party", until: jst(2026, 11, 28, 20, 30) });
    expect((await dump()).meta.override).toEqual({ receptionId: "party", until: jst(2026, 11, 28, 20, 30) });

    // スタッフが自分で切り替えたので、途中が終わっても知らせは出ない
    await finish(app);
    expect(app.model.notice.value).toBeNull();
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "party" }, manual: true });

    // 次の境界で上書きは終わり、自動の選択に戻る
    world.now = jst(2026, 11, 28, 20, 30);
    app.session.tick();
    await settle();
    expect(app.model.override.value).toBeNull();
    expect(app.model.confirmedReception.value).toEqual({ reception: null, manual: false });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "receptionChanged", name: null }]);
    expect((await dump()).meta.override).toBeNull();
  });

  it("差し替えた設定に、手動の上書きが指す受付がなければ、上書きを消して自動の選択に戻す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.commands.openReceptionSheet();
    app.commands.chooseReception("party");
    expect(app.views.receptionChangePreview({ kind: "switch", receptionId: "party" })).toEqual({
      name: "懇親会受付",
      outOfPeriod: true,
    });
    await app.commands.confirmReceptionChange();
    expect(app.model.overlay.value).toBeNull();
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "party" }, manual: true });
    expect(app.model.notice.value).toBeNull();

    republish(world, allTickets(people), 1, (base) => ({
      ...base,
      receptions: base.receptions.filter((reception) => reception.id !== "party"),
    }));
    await app.sync.runSync();
    await settle();
    expect(app.model.override.value).toBeNull();
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "main" }, manual: false });
    expect(app.model.notice.value?.lines).toEqual([
      { kind: "receptionChanged", name: "本編受付" },
      { kind: "dataUpdated" },
    ]);
    expect((await dump()).meta.override).toBeUndefined();
  });

  it("読み取り中に受付なしになったら、停止中に戻す", async () => {
    const { world } = publishedWorld(jst(2026, 11, 29, 17, 59));
    const app = await ready(world);
    app.commands.startScan();
    await settle();
    world.now = jst(2026, 11, 29, 18, 0);
    app.session.tick();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    expect(app.model.notice.value?.lines).toEqual([{ kind: "receptionChanged", name: null }]);
    // 受付なしのときは、読み取りを始めない
    app.commands.startScan();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
  });
});
