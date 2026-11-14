import { describe, expect, it } from "vitest";
import { SCAN_TIMEOUT_MS } from "../../src/app/commands/scan.ts";
import { AFTER_ALL, dump, finish, publishedWorld, qr, ready, resultKind, scan } from "./fixtures.ts";
import { deferred, discard, type Instance, launch, settle } from "./harness.ts";

// 通常受付の確認（S03-D1）と高速受付、リハーサルモード（S09-D2、S04-D1）

/** S09 を開いて、切り替えの確認（S09-D2）を確定する */
async function switchMode(app: Instance, request: () => void): Promise<void> {
  app.commands.openMenu();
  request();
  await app.commands.confirmModeChange();
  await settle();
  app.commands.goBack();
}

const startRehearsal = (app: Instance) => switchMode(app, () => app.commands.requestRehearsal(true));

/** 通常受付の確認（S03-D1）を出していれば、読み取ったチケット */
function confirming(app: Instance): unknown {
  const current = app.model.screen.value;
  return current.id === "home" && current.mode.kind === "confirming" ? current.mode.ticket : null;
}

/** 「リハーサルモードです」を閉じる */
function dismissNotice(app: Instance): void {
  expect(app.model.overlay.value).toEqual({ id: "S04-D1" });
  app.commands.closeOverlay();
}

describe("通常受付の確認（S03-D1）", () => {
  it("高速受付がオフなら、記録を作る前に確認を出し、「続ける」で記録を作って結果を出す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world, { fastCheckin: "stored" });
    expect(app.model.fastCheckin.value).toBe(false);
    await scan(app, people.alice);

    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "confirming", ticket: people.alice } });
    expect(app.model.overlay.value).toBeNull();
    expect(app.views.qrConfirmView(people.alice)).toMatchObject({ userName: "alice", name: "Alice" });
    expect(app.model.judging.value).toBe(false);
    expect(app.fake.wakeLock).toBe(true);
    expect(app.fake.armed).toBe(true);
    expect(app.derived.midOperation.value).toBe(true);
    expect(app.model.records.value).toHaveLength(0);
    expect(app.fake.sounds).toEqual([]);
    // 確認を出している間は、カメラを止める
    expect(app.fake.cameraStops).toBeGreaterThan(0);

    await app.commands.confirmQrCheckin();
    expect(resultKind(app)).toBe("success");
    expect(app.model.records.value).toHaveLength(1);
    expect((await dump()).data.records).toHaveLength(1);
    expect(app.fake.sounds).toEqual(["success"]);
  });

  it("「やめる」で、記録を作らずに読み取り中に戻り、直後の 3 秒間は同じチケットを無視する", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world, { fastCheckin: false });
    await scan(app, people.alice);
    const starts = app.fake.cameraStarts;

    app.commands.cancelQrCheckin();
    await settle();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "scanning", camera: "streaming" } });
    expect(app.fake.cameraStarts).toBe(starts + 1);
    expect(app.model.records.value).toHaveLength(0);

    world.now += 2000;
    app.scan.handleDecoded(qr(people.alice));
    await settle();
    expect(confirming(app)).toBeNull();
    // ほかのチケットは、すぐに受理する
    app.scan.handleDecoded(qr(people.bob1));
    await settle();
    expect(confirming(app)).toEqual(people.bob1);
    // 戻る操作も「やめる」と同じ
    app.fake.back();
    await settle();
    expect(app.model.screen.value).toMatchObject({ id: "home", mode: { kind: "scanning" } });

    world.now += 3000;
    app.scan.handleDecoded(qr(people.alice));
    await settle();
    expect(confirming(app)).toEqual(people.alice);
  });

  it("記録を作らない判定（済み、対象外、見つからない）は、確認せずに結果を出す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world, { fastCheckin: false });
    await scan(app, people.alice);
    await app.commands.confirmQrCheckin();
    await finish(app);

    world.now += 5000;
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("alreadyDone");
    await finish(app);

    await scan(app, people.dave);
    expect(resultKind(app)).not.toBeNull();
    await finish(app);

    app.commands.startScan();
    await settle();
    app.scan.handleDecoded(`fortee:${"z".repeat(32)}`);
    await settle();
    expect(resultKind(app)).toBe("notFound");
  });

  it("確認を出している間は、次の読み取り、「終了」、2 分の経過、バックグラウンドへの移行で閉じない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world, { fastCheckin: false });
    await scan(app, people.alice);
    const before = app.model.screen.value;

    app.scan.handleDecoded(qr(people.bob1));
    app.commands.stopScan();
    world.now += SCAN_TIMEOUT_MS + 1000;
    app.scan.scanTick(world.now);
    app.fake.setVisible(false);
    app.fake.setVisible(true);
    await settle();
    expect(app.model.screen.value).toBe(before);
    expect(confirming(app)).toEqual(people.alice);
    // メニューや検索にも移れない
    app.commands.openSearch();
    app.commands.openMenu();
    expect(app.model.screen.value).toBe(before);
    expect(app.model.overlay.value).toBeNull();

    // 「やめる」で戻った読み取り中は、2 分を数え直す
    app.commands.cancelQrCheckin();
    await settle();
    app.scan.scanTick(world.now + 1000);
    expect(app.model.screen.value).toMatchObject({ id: "home", mode: { kind: "scanning" } });
  });

  it("確認を出している間に受付なしになったら、「やめる」で停止中に戻る（FR-7）", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world, { fastCheckin: false });
    await scan(app, people.alice);

    // 受付操作の途中なので、受付の切り替えは保留する
    world.now = AFTER_ALL;
    app.session.tick();
    await settle();
    expect(app.model.confirmedReception.value.reception).not.toBeNull();

    app.commands.cancelQrCheckin();
    await settle();
    expect(app.model.confirmedReception.value.reception).toBeNull();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    expect(app.model.records.value).toHaveLength(0);
  });

  it("確定は、その時点の記録で判定し直す。確認の間にほかの端末が済みにしていたら、記録を作らない", async () => {
    const { world, people } = publishedWorld();
    const other = await ready(world);
    await scan(other, people.alice);
    await other.sync.runSync();
    discard(other);

    const app = await ready(world, { fastCheckin: false });
    // 端末の記録を、ほかの端末の記録が届く前の状態にして読み取る
    const received = app.model.records.value;
    app.model.records.value = [];
    await scan(app, people.alice);
    expect(confirming(app)).toEqual(people.alice);
    app.model.records.value = received;

    await app.commands.confirmQrCheckin();
    expect(resultKind(app)).toBe("alreadyDone");
    expect(app.model.records.value).toHaveLength(1);
  });
});

describe("高速受付の設定（S09、S09-D2）", () => {
  it("オンにするときは確認を挟み、オフに戻すときは挟まない。再読み込みとログアウトの後も残る", async () => {
    const { world, people } = publishedWorld();
    let app = await ready(world, { fastCheckin: "stored" });
    app.commands.openMenu();
    app.commands.requestFastCheckin(true);
    expect(app.model.overlay.value).toEqual({ id: "S09-D2", change: "fastCheckinOn" });
    expect(app.model.fastCheckin.value).toBe(false);
    // 「やめる」では変わらない
    app.commands.closeOverlay();
    expect(app.model.fastCheckin.value).toBe(false);

    app.commands.requestFastCheckin(true);
    await app.commands.confirmModeChange();
    expect(app.model.overlay.value).toBeNull();
    expect(app.model.fastCheckin.value).toBe(true);
    expect((await dump()).meta.fastCheckin).toBe(true);

    discard(app);
    app = await ready(world, { login: null, fastCheckin: "stored" });
    expect(app.model.fastCheckin.value).toBe(true);
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("success");
    await finish(app);

    app.commands.openMenu();
    app.commands.openLogoutConfirm();
    await app.commands.logout();
    expect((await dump()).meta.fastCheckin).toBe(true);

    discard(app);
    app = await ready(world, { fastCheckin: "stored" });
    app.commands.openMenu();
    app.commands.requestFastCheckin(false);
    await settle();
    expect(app.model.overlay.value).toBeNull();
    expect(app.model.fastCheckin.value).toBe(false);
    expect((await dump()).meta.fastCheckin).toBe(false);
  });
});

describe("起動がロックを待つ間に変わった設定", () => {
  it("ロックを取った後に読み直した設定で動く。待つ間にオフに戻された高速受付は、オフになる", async () => {
    const { world, people } = publishedWorld();
    const first = await ready(world, { fastCheckin: "stored" });
    first.commands.openMenu();
    first.commands.requestFastCheckin(true);
    await first.commands.confirmModeChange();
    expect((await dump()).meta.fastCheckin).toBe(true);
    discard(first);

    // 2 つ目の画面は、ロックを取る手前で待つ。この時点で読んだ設定は、高速受付がオン
    const gate = deferred();
    const waiting = await launch(world, {
      isHeld: async () => false,
      beforeAcquire: gate.promise,
      noWait: true,
      fastCheckin: "stored",
    });
    await settle();
    expect(waiting.model.fastCheckin.value).toBe(true);

    // その間に、別の画面が高速受付をオフに戻して、閉じる
    const other = await ready(world, { login: null, fastCheckin: "stored" });
    other.commands.openMenu();
    other.commands.requestFastCheckin(false);
    await settle();
    expect((await dump()).meta.fastCheckin).toBe(false);
    discard(other);

    gate.resolve();
    await waiting.booted;
    await settle();
    expect(waiting.model.fastCheckin.value).toBe(false);
    await scan(waiting, people.alice);
    expect(confirming(waiting)).toEqual(people.alice);
    expect(waiting.model.records.value).toHaveLength(0);
  });
});

describe("リハーサルモード", () => {
  it("切り替えは、どちら向きも確認を挟む。メニューの外では切り替えられない", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    app.commands.requestRehearsal(true);
    expect(app.model.overlay.value).toBeNull();

    app.commands.openMenu();
    app.commands.requestRehearsal(true);
    expect(app.model.overlay.value).toEqual({ id: "S09-D2", change: "rehearsalOn" });
    app.commands.closeOverlay();
    expect(app.model.rehearsal.value).toBe(false);

    app.commands.requestRehearsal(true);
    await app.commands.confirmModeChange();
    expect(app.model.rehearsal.value).toBe(true);
    expect(app.model.screen.value).toEqual({ id: "S09" });
    expect((await dump()).meta.rehearsal).toBe(true);

    app.commands.requestRehearsal(false);
    expect(app.model.overlay.value).toEqual({ id: "S09-D2", change: "rehearsalOff" });
    await app.commands.confirmModeChange();
    expect(app.model.rehearsal.value).toBe(false);
    expect(app.model.screen.value).toEqual({ id: "S09" });
    expect((await dump()).meta.rehearsal).toBe(false);
  });

  it("記録を端末にもサーバにも保存せず、結果に「リハーサルモードです」を重ねる。その間は同期しない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await app.sync.runSync();
    await startRehearsal(app);
    const requests = world.server.syncRequests.length;
    expect(app.derived.syncStatus.value).toBe("paused");

    await scan(app, people.alice);
    expect(resultKind(app)).toBe("success");
    expect(app.fake.sounds).toEqual(["success"]);
    // 結果の主ボタンは、知らせを閉じるまで効かない
    app.commands.nextFromResult();
    expect(resultKind(app)).toBe("success");
    dismissNotice(app);

    expect(app.model.records.value).toHaveLength(1);
    expect((await dump()).data.records).toHaveLength(0);
    expect(app.derived.recentOperations.value).toHaveLength(1);

    // リハーサルモードの間は、定期の同期、オンラインの検知、手動の同期のどれも、要求を送らない
    expect(await app.sync.runSync()).toBe("skipped");
    world.now += 60_000;
    app.sync.syncTick(world.now);
    app.fake.setOnline(false);
    app.fake.setOnline(true);
    app.commands.tapSync();
    await settle();
    expect(world.server.syncRequests).toHaveLength(requests);
    expect(world.server.records).toEqual([]);
    expect(app.derived.syncStatus.value).toBe("paused");

    // リハーサルの記録で判定する。同じチケットは済みになる
    await finish(app);
    world.now += 5000;
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("alreadyDone");
    dismissNotice(app);

    // 見つからないと、検索からのチェックインでも知らせる
    await finish(app);
    app.commands.startScan();
    await settle();
    app.scan.handleDecoded(`fortee:${"z".repeat(32)}`);
    await settle();
    expect(resultKind(app)).toBe("notFound");
    dismissNotice(app);
    await finish(app);

    app.commands.openSearch();
    app.commands.openCandidate("bob");
    app.commands.selectTicket(people.bob1.eventId, people.bob1.ticketToken);
    app.commands.openSearchCheckinConfirm();
    await app.commands.confirmSearchCheckin();
    expect(resultKind(app)).toBe("success");
    dismissNotice(app);
    expect(app.model.records.value).toHaveLength(2);
    expect((await dump()).data.records).toHaveLength(0);

    // 通常モードに戻すと同期し直す。リハーサルの記録は、サーバに届かない
    await finish(app);
    await switchMode(app, () => app.commands.requestRehearsal(false));
    await settle();
    expect(world.server.syncRequests.length).toBeGreaterThan(requests);
    expect(world.server.syncRequests.flatMap((request) => request.records)).toEqual([]);
    expect(world.server.records).toEqual([]);
    expect(app.model.records.value).toEqual([]);
  });

  it("本番の未送信の記録は、リハーサルモードの間は送らず、通常モードに戻すと送る", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.fake.setOnline(false);
    await scan(app, people.alice);
    await finish(app);
    expect(app.derived.hasUnsent.value).toBe(true);

    await startRehearsal(app);
    app.fake.setOnline(true);
    await settle();
    expect(world.server.records).toEqual([]);

    await switchMode(app, () => app.commands.requestRehearsal(false));
    await settle();
    expect(world.server.records).toHaveLength(1);
    expect(app.derived.hasUnsent.value).toBe(false);
  });

  it("リハーサルモードに入るときに進行中の同期は中断し、後から届いた応答を反映しない", async () => {
    const { world, people } = publishedWorld();
    const other = await ready(world);
    await scan(other, people.alice);
    await other.sync.runSync();
    discard(other);

    const app = await ready(world);
    // 同期が応答を待っている間に、リハーサルモードに入る
    const gate = deferred();
    world.server.syncGates.push(gate.promise);
    const syncing = app.sync.runSync();
    await settle();
    expect(app.model.syncInFlight.value).toBe(true);
    await startRehearsal(app);
    expect(await syncing).toBe("aborted");
    gate.resolve();
    await settle();

    // ほかの端末の記録は、届いていても反映しない。記録は空から始まる
    expect(app.model.rehearsal.value).toBe(true);
    expect(app.model.syncInFlight.value).toBe(false);
    expect(app.model.records.value).toEqual([]);

    // 通常モードに戻すと、同期して受け取る
    await switchMode(app, () => app.commands.requestRehearsal(false));
    await settle();
    expect(app.model.records.value).toHaveLength(1);
  });

  it("リハーサルの間は本番の記録を見ず、通常モードに戻すとリハーサルの記録が消えて、本番の記録に戻る", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await finish(app);
    expect(app.model.records.value).toHaveLength(1);

    await startRehearsal(app);
    expect(app.derived.operations.value).toHaveLength(0);
    world.now += 5000;
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("success");
    dismissNotice(app);

    // 結果を出したまま、帯の「✗」から戻す。ホームの停止中に戻る
    app.commands.openRehearsalExit();
    expect(app.model.overlay.value).toEqual({ id: "S09-D2", change: "rehearsalOff" });
    await app.commands.confirmModeChange();
    expect(app.model.rehearsal.value).toBe(false);
    expect(app.model.overlay.value).toBeNull();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });

    expect(app.model.records.value).toHaveLength(1);
    expect(app.derived.operations.value).toHaveLength(1);
    expect((await dump()).data.records).toHaveLength(1);
    world.now += 5000;
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("alreadyDone");
    expect(app.model.overlay.value).toBeNull();
  });

  it("リハーサルの記録の取り消しも、保存しない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await startRehearsal(app);
    await scan(app, people.alice);
    dismissNotice(app);
    await finish(app);

    const operation = app.derived.recentOperations.value[0];
    if (operation === undefined) throw new Error("リハーサルの記録が履歴にない");
    app.commands.openOperation(operation.opId);
    app.commands.openCancelConfirm();
    await app.commands.confirmCancel([people.alice.ticketToken], { kind: "mistake" });
    expect(app.model.records.value).toHaveLength(2);
    expect(app.derived.ticketStates.value.get(people.alice.ticketToken)?.done ?? false).toBe(false);
    expect((await dump()).data.records).toHaveLength(0);
  });

  it("読み取り中に帯の「✗」から戻すと、カメラを止めて停止中に戻る。その間の読み取りは受理しない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await startRehearsal(app);
    app.commands.startScan();
    await settle();
    app.commands.openRehearsalExit();
    app.scan.handleDecoded(qr(people.alice));
    await settle();
    expect(app.model.records.value).toEqual([]);
    const stops = app.fake.cameraStops;

    await app.commands.confirmModeChange();
    expect(app.fake.cameraStops).toBe(stops + 1);
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
  });

  it("再読み込みの後もリハーサルモードのままで、記録は空から始まる。ログアウトで通常モードに戻る", async () => {
    const { world, people } = publishedWorld();
    let app = await ready(world);
    await startRehearsal(app);
    await scan(app, people.alice);
    dismissNotice(app);

    discard(app);
    app = await ready(world, { login: null });
    expect(app.model.rehearsal.value).toBe(true);
    expect(app.model.records.value).toEqual([]);
    expect(app.derived.syncStatus.value).toBe("paused");
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("success");
    dismissNotice(app);
    expect((await dump()).data.records).toHaveLength(0);
    await finish(app);

    app.commands.openMenu();
    app.commands.openLogoutConfirm();
    await app.commands.logout();
    expect(app.model.rehearsal.value).toBe(false);
    expect(app.model.records.value).toEqual([]);
    expect((await dump()).meta.rehearsal).toBeUndefined();
  });

  it("リハーサルモードの間の受付の手動の切り替えは保存せず、通常モードに戻すと、入る前の受付に戻る", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    const before = app.model.confirmedReception.value;
    expect(before.manual).toBe(false);
    await startRehearsal(app);

    const other = app.views.receptionChoices().find((choice) => !choice.current);
    if (other === undefined) throw new Error("切り替える先の受付がない");
    app.commands.openReceptionSheet();
    app.commands.chooseReception(other.id);
    await app.commands.confirmReceptionChange();
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: other.id }, manual: true });
    expect((await dump()).meta.override).toBeUndefined();

    await switchMode(app, () => app.commands.requestRehearsal(false));
    await settle();
    expect(app.model.override.value).toBeNull();
    expect(app.model.confirmedReception.value).toEqual(before);
  });

  it("リハーサルモードに入る前の手動の切り替えは、リハーサルモードの間に自動に戻しても、消えない", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    const other = app.views.receptionChoices().find((choice) => !choice.current);
    if (other === undefined) throw new Error("切り替える先の受付がない");
    app.commands.openReceptionSheet();
    app.commands.chooseReception(other.id);
    await app.commands.confirmReceptionChange();
    const saved = (await dump()).meta.override;
    expect(saved).toMatchObject({ receptionId: other.id });

    await startRehearsal(app);
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: other.id }, manual: true });
    app.commands.openReceptionSheet();
    app.commands.chooseAutoReception();
    await app.commands.confirmReceptionChange();
    expect(app.model.confirmedReception.value.manual).toBe(false);
    expect((await dump()).meta.override).toEqual(saved);

    await switchMode(app, () => app.commands.requestRehearsal(false));
    await settle();
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: other.id }, manual: true });
  });

  it("切り替えの確定の直後に始まった同期は、記憶域を替えるときに中断する", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    await app.sync.runSync();
    const gate = deferred();
    world.server.syncGates.push(gate.promise);
    app.commands.openMenu();
    app.commands.requestRehearsal(true);
    const switching = app.commands.confirmModeChange();
    // 切り替えは列で順番を待っていて、まだリハーサルモードではない。ここで定期の同期が始まる
    const syncing = app.sync.runSync();
    await switching;
    expect(await syncing).toBe("aborted");
    gate.resolve();
    await settle();
    expect(app.model.rehearsal.value).toBe(true);
    expect(app.model.syncInFlight.value).toBe(false);
    expect(app.model.records.value).toEqual([]);
  });

  it("通常受付の確認を出している間は、帯の「✗」で通常モードに戻す確認を開かない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world, { fastCheckin: false });
    await startRehearsal(app);
    await scan(app, people.alice);
    expect(confirming(app)).toEqual(people.alice);
    app.commands.openRehearsalExit();
    expect(app.model.overlay.value).toBeNull();
    expect(confirming(app)).toEqual(people.alice);
  });

  it("通常受付とリハーサルモードを合わせると、名前の確認の後に、結果と知らせを出す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world, { fastCheckin: false });
    await startRehearsal(app);
    await scan(app, people.alice);
    expect(confirming(app)).toEqual(people.alice);
    await app.commands.confirmQrCheckin();
    expect(resultKind(app)).toBe("success");
    dismissNotice(app);
    expect(app.model.records.value).toHaveLength(1);
    expect((await dump()).data.records).toHaveLength(0);
  });
});
