import { describe, expect, it } from "vitest";
import type { CheckinRecord } from "../../src/core/record.ts";
import { checkin, DEVICE_B, jst } from "../core/helpers.ts";
import { AFTER_ALL, dump, finish, IN_MAIN, publishedWorld, ready, scan } from "./fixtures.ts";
import { deferred, discard, launch, settle, until } from "./harness.ts";

// 同期（Design Doc 4.5、6.6、6.13）。通信を偽物に置き換え、応答の届く順序を入れ替えて確かめる

const wire = (record: object): CheckinRecord => {
  const { receivedAt: _receivedAt, ...rest } = record as CheckinRecord & { receivedAt?: unknown };
  return rest;
};

describe("同期の結果とローカルの操作（Design Doc 6.13）", () => {
  it("要求を作った後に作った記録には、sent を付けない。その記録は、同じ同期の次の要求で送る", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    const first = app.model.records.value[0] as CheckinRecord;

    const gate1 = deferred();
    const gate2 = deferred();
    world.server.syncGates.push(gate1.promise, gate2.promise);
    const before = world.server.syncRequests.length;
    const syncing = app.sync.runSync();
    await until(() => world.server.syncRequests.length === before + 1);
    expect(world.server.syncRequests.at(-1)?.records.map((record) => record.recordId)).toEqual([first.recordId]);

    // 応答を待っている間に、次の記録を作る
    app.commands.nextFromResult();
    await settle();
    app.scan.handleDecoded(`fortee:${people.bob1.ticketToken}`);
    await settle();
    const second = app.model.records.value.find((record) => record.recordId !== first.recordId);
    expect(second).toBeDefined();

    gate1.resolve();
    await until(() => world.server.syncRequests.length === before + 2);
    const sent = () => new Map(app.model.records.value.map((record) => [record.recordId, record.sent]));
    expect(sent().get(first.recordId)).toBe(true);
    expect(sent().get(second?.recordId ?? "")).toBe(false);
    expect((await dump()).data.records.filter((record) => record.sent).map((record) => record.recordId)).toEqual([
      first.recordId,
    ]);
    // hasMore が偽でも、未送信の記録が残っているので、続けて要求する
    expect(world.server.syncRequests.at(-1)?.records.map((record) => record.recordId)).toEqual([second?.recordId]);

    gate2.resolve();
    expect(await syncing).toBe("ok");
    expect([...sent().values()]).toEqual([true, true]);
    expect(app.derived.syncStatus.value).toBe("synced");
    expect(app.model.lastSyncAt.value).toBe(world.now);
  });

  it("応答の records に自分の記録が含まれていれば、seq と receivedAt を書き込む", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await app.sync.runSync();
    // 送った要求の応答には、その記録が含まれる（受信位置より後の記録）
    expect(app.model.records.value[0]).toMatchObject({ sent: true, seq: 1 });
    expect(app.model.records.value[0]?.receivedAt).not.toBeNull();
    expect(app.model.cursor.value).toEqual({ generation: "gen-1", seq: 1 });
  });

  it("受け取る記録が 1 回の応答に収まらなければ、hasMore の間、続けて要求する", async () => {
    const { world, people } = publishedWorld();
    for (const [i, target] of people.crowd.entries()) {
      world.server.add(wire(checkin(100 + i, target.ticketToken, IN_MAIN - 1000 + i, { deviceId: DEVICE_B })));
    }
    const app = await ready(world);
    expect(app.model.records.value).toHaveLength(people.crowd.length);
    expect(app.model.cursor.value?.seq).toBe(people.crowd.length);
  });
});

describe("世代の変化（Design Doc 4.5、6.13）", () => {
  it("初期化のトランザクションの前で止まっても、送り直しは失われない", async () => {
    const { world, people } = publishedWorld();
    const first = await ready(world);
    await scan(first, people.alice);
    await finish(first);
    await first.sync.runSync();
    const record = first.model.records.value[0] as CheckinRecord;
    expect(world.server.records).toHaveLength(1);

    // DB を戻した。サーバは記録を失い、世代が変わる
    world.server.restore("gen-2");
    // 応答が届く前に、再読み込みされる
    world.server.syncGates.push(new Promise(() => {}));
    void first.sync.runSync();
    await settle();
    discard(first);
    expect((await dump()).meta.cursor).toEqual({ generation: "gen-1", seq: 1 });

    // 次の起動の同期で、もう一度世代の違いを知り、初期化して送り直す
    world.server.syncGates = [];
    const second = await launch(world);
    await until(() => !second.model.syncInFlight.value && second.model.lastSyncAt.value !== null);
    expect(world.server.records.map((stored) => stored.recordId)).toEqual([record.recordId]);
    expect(second.model.cursor.value).toEqual({ generation: "gen-2", seq: 1 });
    expect(second.model.records.value).toMatchObject([{ recordId: record.recordId, sent: true, seq: 1 }]);
  });

  it("初期化のトランザクションの後で止まっても、送り直しは失われない", async () => {
    const { world, people } = publishedWorld();
    const first = await ready(world);
    await scan(first, people.alice);
    await finish(first);
    // 他端末の記録も受け取っている
    world.server.add(wire(checkin(1, people.bob1.ticketToken, IN_MAIN - 1000, { deviceId: DEVICE_B })));
    await first.sync.runSync();
    expect(first.model.records.value.every((record) => record.sent)).toBe(true);

    world.server.restore("gen-2");
    // 初期化の後の、送り直しの要求の応答が届く前に、再読み込みされる
    const before = world.server.syncRequests.length;
    world.server.syncGates.push(Promise.resolve(), new Promise(() => {}));
    void first.sync.runSync();
    await until(() => world.server.syncRequests.length === before + 2);
    // 初期化だけを行う。すべての記録の sent を偽、seq を null にし、受信位置を初期化する。
    // その応答の records と nextSeq、送った記録への sent は使わない
    const stored = await dump();
    expect(stored.meta.cursor).toEqual({ generation: "gen-2", seq: 0 });
    expect(stored.data.records).toHaveLength(2);
    expect(stored.data.records.every((record) => !record.sent && record.seq === null)).toBe(true);
    // 続けて、新しい受信位置で、端末が持つすべての記録を送り直す
    expect(world.server.syncRequests.at(-1)).toMatchObject({ cursor: { generation: "gen-2", seq: 0 } });
    expect(world.server.syncRequests.at(-1)?.records).toHaveLength(2);
    discard(first);

    // サーバが、その要求の記録を保存していなかったとしても、次の起動の同期で送り直す
    world.server.restore("gen-2");
    world.server.syncGates = [];
    const second = await launch(world);
    await until(() => !second.model.syncInFlight.value && second.model.lastSyncAt.value !== null);
    expect(world.server.records).toHaveLength(2);
    expect(second.model.records.value.every((record) => record.sent && record.seq !== null)).toBe(true);
  });
});

describe("同期の失敗（Design Doc 4.5、6.6）", () => {
  it("失敗の応答を受けたら、送る記録の件数と limit を半分にし、200 のたびに倍にして戻す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    for (const target of people.crowd) {
      await scan(app, target);
      app.commands.nextFromResult();
    }
    await finish(app);
    expect(app.model.records.value).toHaveLength(30);
    const last = () => world.server.syncRequests.at(-1);

    world.server.syncStatuses.push(500);
    expect(await app.sync.runSync()).toBe("failed");
    expect(last()).toMatchObject({ limit: 200 });
    expect(last()?.records).toHaveLength(30);
    expect(app.derived.syncStatus.value).toBe("failed");
    // 端末のデータは変えない
    expect(app.model.records.value.every((record) => !record.sent)).toBe(true);

    world.server.syncStatuses.push(503);
    expect(await app.sync.runSync()).toBe("failed");
    expect(last()).toMatchObject({ limit: 100 });
    expect(last()?.records).toHaveLength(25);

    // 429 と、応答が届かない失敗では減らさない
    world.server.syncStatuses.push(429);
    expect(await app.sync.runSync()).toBe("failed");
    expect(last()).toMatchObject({ limit: 50 });
    expect(last()?.records).toHaveLength(12);
    world.server.down = true;
    expect(await app.sync.runSync()).toBe("failed");
    expect(last()).toMatchObject({ limit: 50 });
    world.server.down = false;

    // 成功で倍にして戻す。1 回の同期の中で、未送信を送り切る
    const before = world.server.syncRequests.length;
    expect(await app.sync.runSync()).toBe("ok");
    const requests = world.server.syncRequests.slice(before);
    expect(requests.map((request) => [request.limit, request.records.length])).toEqual([
      [50, 12],
      [100, 18],
    ]);
    expect(app.model.records.value.every((record) => record.sent)).toBe(true);
    expect(app.derived.syncStatus.value).toBe("synced");
    await app.sync.runSync();
    expect(last()).toMatchObject({ limit: 200 });
  });

  it("413 を受けたら、送る件数を半分にして送り直す。この間は失敗にしない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    for (const target of people.crowd.slice(0, 4)) {
      await scan(app, target);
      app.commands.nextFromResult();
    }
    await finish(app);
    world.server.syncStatuses.push(413);
    const before = world.server.syncRequests.length;
    expect(await app.sync.runSync()).toBe("ok");
    expect(world.server.syncRequests.slice(before).map((request) => request.records.length)).toEqual([4, 2, 2]);
    expect(app.model.lastSyncFailed.value).toBe(false);
  });

  it("401 は「再ログインが必要」、400 は「同期の失敗」にする。記録は消さない。次の成功で戻す", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await finish(app);

    world.server.syncStatuses.push(401);
    expect(await app.sync.runSync()).toBe("unauthorized");
    expect(app.derived.syncStatus.value).toBe("needsLogin");
    // 受付操作の途中でなければ、タップで S01 に移り、「戻る」で S02 に戻れる
    app.commands.tapSync();
    expect(app.model.screen.value).toEqual({ id: "S01", phase: "idle", canGoBack: true });
    expect(app.fake.armed).toBe(true);
    app.fake.back();
    await settle();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });

    world.server.syncStatuses.push(400);
    expect(await app.sync.runSync()).toBe("rejected");
    expect(app.model.records.value).toHaveLength(1);
    expect(app.model.lastSyncFailed.value).toBe(true);

    expect(await app.sync.runSync()).toBe("ok");
    expect(app.derived.syncStatus.value).toBe("synced");
  });

  it("受付操作の途中は、「再ログインが必要」をタップしても S01 に移らない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    world.server.syncStatuses.push(401);
    await app.sync.runSync();
    await scan(app, people.alice);
    app.commands.tapSync();
    expect(app.model.screen.value.id).toBe("home");
  });

  it("オフラインでは同期を始めず、オンラインを検知したら自動で同期する", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    app.fake.setOnline(false);
    await scan(app, people.alice);
    await finish(app);
    expect(app.derived.syncStatus.value).toBe("offline");
    expect(app.derived.hasUnsent.value).toBe(true);
    expect(await app.sync.runSync()).toBe("skipped");
    app.commands.tapSync();

    const before = world.server.syncRequests.length;
    app.fake.setOnline(true);
    await until(() => world.server.syncRequests.length > before && !app.model.syncInFlight.value);
    await settle();
    expect(app.derived.syncStatus.value).toBe("synced");
  });

  it("形の合わない応答は、同期の失敗として扱い、端末のデータを変えない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    // 知らない op を持つ記録が、応答に含まれる
    world.server.records.push({
      ...wire(checkin(1, people.alice.ticketToken, IN_MAIN, { deviceId: DEVICE_B })),
      op: "unknown",
      seq: 1,
      receivedAt: 1,
    } as never);
    expect(await app.sync.runSync()).toBe("failed");
    expect(app.model.records.value).toHaveLength(0);
    expect(app.model.cursor.value?.seq).toBe(0);
  });
});

describe("同期の契機（Design Doc 6.6）", () => {
  const requests = (world: { server: { syncRequests: unknown[] } }) => world.server.syncRequests.length;
  /** 30 秒を過ぎた後の 1 秒ごとの処理で、定期の同期が動いたか */
  async function periodic(app: Awaited<ReturnType<typeof ready>>): Promise<boolean> {
    const before = requests(app.world);
    app.world.now += 31_000;
    app.session.tick();
    await settle();
    await until(() => !app.model.syncInFlight.value);
    return requests(app.world) > before;
  }

  it("受付の期間の中では、30 秒ごとに同期する。画面が隠れている間はしない", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    world.now += 29_000;
    app.session.tick();
    await settle();
    const before = requests(world);
    world.now += 1000;
    app.session.tick();
    await settle();
    expect(requests(world)).toBe(before + 1);

    app.fake.setVisible(false);
    expect(await periodic(app)).toBe(false);
    app.fake.setVisible(true);
    expect(await periodic(app)).toBe(true);
  });

  it("受付の期間の外で、未送信の記録があれば定期の同期が動き、送り終えると止まる", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await finish(app);
    await app.sync.runSync();
    world.now = AFTER_ALL;
    app.session.tick();
    await settle();
    expect(app.model.confirmedReception.value.reception).toBeNull();
    expect(await periodic(app)).toBe(false);

    // 期間の外で行った取り消し（FR-7）
    const opId = app.model.records.value[0]?.opId ?? "";
    app.commands.openOperation(opId);
    app.commands.openCancelConfirm();
    await app.commands.confirmCancel([people.alice.ticketToken], { kind: "mistake" });
    app.commands.goBack();
    expect(app.derived.hasUnsent.value).toBe(true);

    expect(await periodic(app)).toBe(true);
    expect(app.derived.hasUnsent.value).toBe(false);
    expect(await periodic(app)).toBe(false);
  });

  it("受付の期間の外で、手動の上書きが有効な間も定期の同期が動き、上書きを解除すると止まる", async () => {
    const { world } = publishedWorld(jst(2026, 11, 20, 10, 0));
    const app = await ready(world);
    expect(app.model.confirmedReception.value.reception).toBeNull();
    expect(await periodic(app)).toBe(false);

    // 受付の期間より前に、スタッフのチケットを受け付ける。受付を手動で切り替える
    app.commands.openReceptionSheet();
    app.commands.chooseReception("main");
    await app.commands.confirmReceptionChange();
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "main" }, manual: true });
    expect(await periodic(app)).toBe(true);
    expect(await periodic(app)).toBe(true);

    app.commands.openReceptionSheet();
    app.commands.chooseAutoReception();
    // 確認では、戻る操作で一覧に戻る
    app.commands.closeOverlay();
    expect(app.model.overlay.value).toEqual({ id: "S02-M1", step: { kind: "list" } });
    app.commands.chooseAutoReception();
    await app.commands.confirmReceptionChange();
    expect(app.model.confirmedReception.value).toEqual({ reception: null, manual: false });
    expect(await periodic(app)).toBe(false);
  });

  it("失敗の後は、間隔を延ばして再試行する。期間の外で未送信の記録がなくても再試行する", async () => {
    const { world } = publishedWorld(AFTER_ALL);
    const app = await ready(world);
    expect(await periodic(app)).toBe(false);

    world.server.syncStatuses.push(500);
    expect(await app.sync.runSync()).toBe("failed");
    // 1 回目の失敗の後は 60 秒（乱数が 0.5 のとき）。31 秒では動かない
    expect(await periodic(app)).toBe(false);
    expect(await periodic(app)).toBe(true);
    expect(app.model.lastSyncFailed.value).toBe(false);
    expect(await periodic(app)).toBe(false);

    // 401 と 400 で終わった同期は、未送信の記録がなければ再試行しない
    world.server.syncStatuses.push(401);
    await app.sync.runSync();
    world.now += 20 * 60_000;
    expect(await periodic(app)).toBe(false);
    // 手動の同期は、直近の失敗を理由に止めない
    expect(await app.sync.runSync()).toBe("ok");
  });

  it("失敗の後の間隔は、30 秒から倍々に延ばし、上限は 10 分。乱数で散らす", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    const { backoffDelay } = app.sync;
    expect(backoffDelay(1, 0.5)).toBe(60_000);
    expect(backoffDelay(2, 0.5)).toBe(120_000);
    expect(backoffDelay(5, 0.5)).toBe(600_000);
    expect(backoffDelay(50, 0.5)).toBe(600_000);
    expect(backoffDelay(1, 0)).toBe(45_000);
    expect(backoffDelay(1, 0.999)).toBeLessThan(75_000);
  });

  it("1 回の要求に載せる記録は、件数とバイト数の両方で区切る", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    const { pickBatch } = app.sync;
    const big = (i: number) => ({
      ...wire(checkin(i, "T".repeat(32), IN_MAIN + i)),
      op: "cancel" as const,
      route: null,
      reasonKind: "other" as const,
      // 2,000 文字の自由記述。UTF-8 で約 6 KB
      reasonText: "あ".repeat(2000),
      targetRecordIds: [],
      sent: i === 0,
      seq: null,
      receivedAt: null,
    });
    const all = Array.from({ length: 60 }, (_, i) => big(i)) as never[];
    const batch = pickBatch(all, 50);
    const bytes = new TextEncoder().encode(JSON.stringify(batch)).length;
    // 2,000 文字の自由記述を持つ取り消しが 50 件あれば、本文は 300 KB を超える。200 KiB で区切る
    expect(batch.length).toBeLessThan(50);
    expect(bytes).toBeLessThanOrEqual(200 * 1024);
    // 未送信のものだけを、作った順に載せる
    expect(batch[0]?.deviceTime).toBe(IN_MAIN + 1);
    expect(pickBatch(all, 3)).toHaveLength(3);
  });
});
