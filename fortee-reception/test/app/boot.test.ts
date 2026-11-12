import { describe, expect, it } from "vitest";
import type { CheckinRecord } from "../../src/core/record.ts";
import { DATABASE_NAME } from "../../src/app/storage/db.ts";
import { checkin, DEVICE_B } from "../core/helpers.ts";
import { dump, finish, IN_MAIN, publishedWorld, ready, resultKind, scan } from "./fixtures.ts";
import { createWorld, deferred, discard, launch, settle, until } from "./harness.ts";

// 起動、ログイン、ログアウト、2 つの画面の重なり、版上げの重なり、再読み込み（Design Doc 6.3、6.4、6.11、6.13）

const wire = (record: object): CheckinRecord => {
  const { receivedAt: _receivedAt, ...rest } = record as CheckinRecord & { receivedAt?: unknown };
  return rest;
};

describe("起動とログイン（Design Doc 6.4）", () => {
  it("iOS の Safari のタブでは、S00 を出して進まない。IndexedDB を開かない", async () => {
    const world = createWorld(IN_MAIN);
    const app = await launch(world, { iosSafariTab: true, login: "ok" });
    expect(app.model.screen.value).toEqual({ id: "S00", reason: "safariTab" });
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain(DATABASE_NAME);
    expect(world.server.paths).toEqual([]);
  });

  it("未ログインでは、S01 の「未ログイン」を出し、接続を閉じる。ロックを取らず、通信もしない", async () => {
    const world = createWorld(IN_MAIN);
    const app = await launch(world);
    expect(app.model.screen.value).toEqual({ id: "S01", phase: "idle" });
    expect(app.runtime.rt.db).toBeNull();
    expect(world.lockHolder).toBeNull();
    expect(world.server.paths).toEqual([]);
    // 端末 ID だけは保存する
    expect(Object.keys((await dump()).meta)).toEqual(["deviceId"]);
    // 戻る操作に割り当てがないので、番人を積まない
    expect(app.fake.armed).toBe(false);

    app.commands.startLogin();
    expect(app.fake.loginNavigations).toBe(1);
  });

  it("Discord から失敗かロールなしで戻ったら、その状態を出す。クエリは消す", async () => {
    const world = createWorld(IN_MAIN);
    const failed = await launch(world, { login: "failed" });
    expect(failed.model.screen.value).toEqual({ id: "S01", phase: "idle", loginFailed: true, canGoBack: false });
    const noRole = await launch(world, { login: "no-role" });
    expect(noRole.model.screen.value).toEqual({ id: "S01", phase: "noRole", canGoBack: false });
    expect(world.server.paths).toEqual([]);
  });

  it("ログインの後、操作者の情報を取得できなければ、「未ログイン」にログインの失敗を添える", async () => {
    const world = createWorld(IN_MAIN);
    world.server.apiStatus = 500;
    const app = await launch(world, { login: "ok" });
    expect(app.model.screen.value).toEqual({ id: "S01", phase: "idle", loginFailed: true, canGoBack: false });
    expect((await dump()).meta.operator).toBeUndefined();
    expect(world.lockHolder).toBeNull();
  });

  it("ログインに成功したら、ロックを取ってから操作者を保存し、配布物を取得してホームに進む", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    expect(world.lockHolder).not.toBeNull();
    expect(app.model.operator.value).toEqual(world.server.operator);
    const stored = await dump();
    expect(stored.meta.operator).toEqual(world.server.operator);
    expect(stored.data.config?.version).toBe(world.server.config?.version);
    expect(stored.data.snapshots).toHaveLength(3);
    expect(app.model.confirmedReception.value).toMatchObject({ reception: { id: "main" }, manual: false });
    // 初回の取得は、差し替えではないので知らせない
    expect(app.model.notice.value).toBeNull();

    // 次の起動は、端末のデータだけで進む。配布物の取得はしない
    discard(app);
    const before = world.server.paths.length;
    const again = await launch(world);
    expect(again.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    await until(() => !again.model.syncInFlight.value);
    expect(world.server.paths.slice(before)).toEqual(["/api/sync"]);
  });

  it("オフラインで、端末のデータがあれば、ホームに進む（NFR-2）", async () => {
    const { world, people } = publishedWorld();
    const first = await ready(world);
    discard(first);
    world.server.down = true;
    const app = await launch(world);
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    await until(() => !app.model.syncInFlight.value);
    expect(app.derived.syncStatus.value).toBe("failed");
    await scan(app, people.alice);
    expect(resultKind(app)).toBe("success");
  });

  it("S01 の初回の取得で 401 を受けたら、「取得失敗」ではなく「再ログインが必要」にする", async () => {
    const { world } = publishedWorld();
    world.server.syncStatuses.push(401);
    const app = await launch(world, { login: "ok" });
    expect(app.model.screen.value).toEqual({ id: "S01", phase: "needsLogin" });
    // この状態からのログインも、端末のデータを消さない
    app.commands.startLogin();
    expect(app.fake.loginNavigations).toBe(1);
    expect((await dump()).meta.operator).toEqual(world.server.operator);
  });

  it("配布物を取得できなければ「取得失敗」にし、「再試行」でやり直す。まだ公開していないときも同じ", async () => {
    const { world } = publishedWorld();
    const versions = world.server.versions;
    world.server.versions = null;
    const app = await launch(world, { login: "ok" });
    expect(app.model.screen.value).toEqual({ id: "S01", phase: "fetchFailed", failed: { data: true, app: false } });

    world.server.versions = versions;
    world.server.down = true;
    await app.commands.retryPrepare();
    expect(app.model.screen.value).toMatchObject({ phase: "fetchFailed", failed: { data: true } });

    world.server.down = false;
    await app.commands.retryPrepare();
    expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
  });

  it("配布物がそろっても、有効な Service Worker がなければ進まない。起動のたびに確かめる", async () => {
    const { world } = publishedWorld();
    const app = await launch(world, { login: "ok", shellActive: false, shellInstalls: false });
    expect(app.model.screen.value).toEqual({ id: "S01", phase: "fetchFailed", failed: { data: false, app: true } });
    // 配布物は、Service Worker を待たずに、そろった時点で保存されている
    expect((await dump()).data.config).not.toBeNull();
    discard(app);

    // 「再試行」ではなく再読み込みしても、配布物がそろっているとして S02 に進まない
    const before = world.server.paths.length;
    const reloaded = await launch(world, { shellActive: false, shellInstalls: false });
    expect(reloaded.model.screen.value).toMatchObject({ phase: "fetchFailed", failed: { data: false, app: true } });
    // このとき、配布物の取得は行わない
    expect(world.server.paths.slice(before)).toEqual([]);
    discard(reloaded);

    const recovered = await launch(world, { shellActive: false, shellInstalls: true });
    expect(recovered.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
  });

  it("端末の記憶域の値の形が合わなければ、S99 に移る", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    discard(app);
    const request = indexedDB.open(DATABASE_NAME);
    await new Promise((resolve) => (request.onsuccess = resolve));
    const tx = request.result.transaction("records", "readwrite");
    tx.objectStore("records").put({ recordId: "broken" });
    await new Promise((resolve) => (tx.oncomplete = resolve));
    request.result.close();

    const broken = await launch(world);
    expect(broken.model.screen.value.id).toBe("S99");
    expect(broken.runtime.rt.db).toBeNull();
  });
});

describe("ログアウト（Design Doc 6.4、6.13、FR-37）", () => {
  it("端末のデータを消し、接続を閉じ、ロックを外す。列にあった処理と、後から届いた応答は、何も書かない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    await finish(app);
    const deviceId = app.model.deviceId.value;
    await app.commands.setSoundEnabled(false);

    // 同期の応答を待たせる。応答には、他端末の記録が載る
    const gate = deferred();
    world.server.syncGates.push(gate.promise);
    const syncing = app.sync.runSync();
    await until(() => world.server.syncGates.length === 0);
    world.server.add(wire(checkin(1, people.bob1.ticketToken, IN_MAIN, { deviceId: DEVICE_B })));

    app.commands.openMenu();
    app.commands.openLogoutConfirm();
    expect(app.model.overlay.value).toEqual({ id: "S09-D1" });
    const loggingOut = app.commands.logout();
    gate.resolve();
    await loggingOut;
    expect(await syncing).toBe("aborted");
    await settle();

    expect(app.model.screen.value).toEqual({ id: "S01", phase: "idle" });
    expect(app.model.overlay.value).toBeNull();
    expect(app.model.records.value).toEqual([]);
    expect(app.model.operator.value).toBeNull();
    expect(app.model.syncInFlight.value).toBe(false);
    expect(app.runtime.rt.db).toBeNull();
    expect(world.lockHolder).toBeNull();
    expect(world.server.paths).toContain("/auth/logout");
    // 端末 ID、音と振動の設定、ログインの番号だけを残す
    const stored = await dump();
    expect(stored.meta).toEqual({ deviceId, sound: false, loginEpoch: 1 });
    expect(stored.data).toEqual({ config: null, snapshots: [], records: [] });

    // 定期の処理は止まっている
    const before = world.server.paths.length;
    world.now += 60_000;
    app.session.tick();
    await settle();
    expect(world.server.paths.length).toBe(before);
  });

  it("応答を受け取った直後（列に入った後）のログアウトでも、古い応答が記録を書き戻さない", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    world.server.add(wire(checkin(1, people.bob1.ticketToken, IN_MAIN, { deviceId: DEVICE_B })));
    app.commands.openMenu();
    app.commands.openLogoutConfirm();
    // 読み取りの受理と同期が進んでいる最中に、確定する
    const syncing = app.sync.runSync();
    const loggingOut = app.commands.logout();
    await Promise.all([syncing, loggingOut]);
    await settle();
    expect((await dump()).data.records).toEqual([]);
    expect((await dump()).meta.cursor).toBeUndefined();
  });

  it("オフラインでもログアウトできる", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    world.server.down = true;
    app.fake.setOnline(false);
    app.commands.openMenu();
    app.commands.openLogoutConfirm();
    await app.commands.logout();
    expect(app.model.screen.value).toEqual({ id: "S01", phase: "idle" });
    expect((await dump()).data.config).toBeNull();
  });
});

describe("2 つの画面の重なり（Design Doc 6.4、NFR-9）", () => {
  it("ロックを持つ画面がある状態で、別の画面が login=ok で戻ったら、操作者を書かずに S00 に止まる", async () => {
    const { world } = publishedWorld();
    const first = await ready(world);
    const original = { ...world.server.operator };
    world.server.operator = { operatorId: "999", operatorName: "other" };
    const before = world.server.paths.length;

    const second = await launch(world, { login: "ok" });
    expect(second.model.screen.value).toEqual({ id: "S00", reason: "otherInstance" });
    // IndexedDB を開く前に止まる。通信もしない
    expect(second.runtime.rt.db).toBeNull();
    expect(world.server.paths.slice(before)).toEqual([]);
    expect((await dump()).meta.operator).toEqual(original);
    // 先の画面は動き続ける
    expect(first.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
    expect(first.model.operator.value).toEqual(original);
  });

  it("照会の後に別の画面がロックを取っていたら、取得した操作者を保存せず、接続を閉じて S00 に止まる", async () => {
    const { world } = publishedWorld();
    const first = await ready(world);
    const original = { ...world.server.operator };
    world.server.operator = { operatorId: "999", operatorName: "other" };
    // 照会の時点では、どの画面もロックを持っていなかった
    const second = await launch(world, { login: "ok", isHeld: async () => false });
    expect(second.model.screen.value).toEqual({ id: "S00", reason: "otherInstance" });
    expect(second.runtime.rt.db).toBeNull();
    expect((await dump()).meta.operator).toEqual(original);
    void first;
  });

  it("ロックを持つ画面のログアウトの直後に、別の画面が戻ったら、消去の後に操作者が保存される", async () => {
    const { world } = publishedWorld();
    const first = await ready(world);
    first.commands.openMenu();
    first.commands.openLogoutConfirm();
    await first.commands.logout();

    world.server.operator = { operatorId: "999", operatorName: "other" };
    const second = await ready(world);
    const stored = await dump();
    expect(stored.meta.operator).toEqual({ operatorId: "999", operatorName: "other" });
    expect(stored.meta.loginEpoch).toBe(1);
    expect(stored.data.config).not.toBeNull();
    expect(second.model.operator.value).toEqual({ operatorId: "999", operatorName: "other" });
  });

  it("meta の操作者を読んだ後、ロックを取る前に、別の画面がログアウトしたら、ロックを外して「未ログイン」に戻る", async () => {
    const { world } = publishedWorld();
    const first = await ready(world);

    // 後の画面は、照会の時点ではロックを見ず、meta の操作者を読んで、ロックを取りに行く
    const gate = deferred();
    const second = await launch(world, { isHeld: async () => false, beforeAcquire: gate.promise, noWait: true });
    await settle();
    expect(second.model.screen.value).toEqual({ id: "boot" });

    // そのあいだに、ロックを持つ画面がログアウトする。POST /auth/logout が失敗して、Cookie は残っている
    first.commands.openMenu();
    first.commands.openLogoutConfirm();
    await first.commands.logout();
    const before = world.server.paths.length;

    gate.resolve();
    await second.booted;
    await settle();
    expect(second.model.screen.value).toEqual({ id: "S01", phase: "idle" });
    expect(second.model.operator.value).toBeNull();
    expect(second.runtime.rt.db).toBeNull();
    expect(world.lockHolder).toBeNull();
    // 同期と配布物の取得に進まない
    expect(world.server.paths.slice(before)).toEqual([]);
    expect((await dump()).meta.operator).toBeUndefined();
  });

  it("再ログインに失敗して戻った画面は、「戻る」で、端末のデータのまま S02 に戻る", async () => {
    const { world, people } = publishedWorld();
    const first = await ready(world);
    await scan(first, people.alice);
    discard(first);

    const back = await launch(world, { login: "failed" });
    expect(back.model.screen.value).toEqual({ id: "S01", phase: "idle", loginFailed: true, canGoBack: true });
    expect(back.runtime.rt.db).toBeNull();
    back.commands.goBack();
    await until(() => back.model.screen.value.id === "home");
    expect(back.model.records.value).toHaveLength(1);
    expect(world.lockHolder).not.toBeNull();
  });
});

describe("版を上げる要求と、ほかの画面の重なり（Design Doc 6.3）", () => {
  const openNewer = () => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    const state = { blocked: false, opened: false };
    request.onblocked = () => {
      state.blocked = true;
    };
    request.onsuccess = () => {
      state.opened = true;
      request.result.close();
    };
    return state;
  };

  it("接続を持つ画面は、versionchange の場では閉じず、受付操作の途中が終わってから閉じて再読み込みする", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);

    // より新しい版の受付アプリが、ほかの画面で開かれた
    const newer = openNewer();
    await settle();
    expect(newer).toEqual({ blocked: true, opened: false });
    expect(app.fake.reloads).toBe(0);
    expect(app.runtime.rt.db).not.toBeNull();

    // 途中の間は、動き続ける
    app.commands.openReference();
    app.commands.closeOverlay();
    expect(app.fake.reloads).toBe(0);

    app.commands.nextFromResult();
    await settle();
    expect(app.fake.reloads).toBe(1);
    expect(app.runtime.rt.db).toBeNull();
    expect(newer.opened).toBe(true);
    // 記録は残っている
    expect((await dump()).data.records).toHaveLength(1);
  });

  it("受付操作の途中でなければ、列が空になった時点で、接続を閉じて再読み込みする", async () => {
    const { world } = publishedWorld();
    const app = await ready(world);
    const newer = openNewer();
    await settle();
    expect(app.fake.reloads).toBe(1);
    expect(newer.opened).toBe(true);
  });

  it("開こうとした画面は、blocked を受けたら、印を置いて読み込み直す。読み込み直した画面は、開かずに S00 に止まる", async () => {
    const world = createWorld(IN_MAIN);
    // 先に開いていた画面（旧版）の接続。versionchange を受けても閉じない
    const holding = indexedDB.open(DATABASE_NAME, 1);
    let versionChanges = 0;
    await new Promise<void>((resolve) => {
      holding.onupgradeneeded = () => {
        for (const store of ["meta", "config", "snapshots", "records"]) holding.result.createObjectStore(store);
      };
      holding.onsuccess = () => {
        holding.result.onversionchange = () => versionChanges++;
        resolve();
      };
    });

    const opener = await launch(world, { login: "ok", databaseVersion: 2, openTimeoutMs: 5000 });
    expect(versionChanges).toBe(1);
    expect(opener.fake.blockedFlag).toBe(true);
    expect(opener.fake.reloads).toBe(1);
    expect(opener.runtime.rt.db).toBeNull();
    expect(world.server.paths).toEqual([]);

    // 読み込み直した画面。印があるので、IndexedDB を開かない。開く要求を残さない
    const reloaded = await launch(world, { login: "ok", blockedFlag: true, databaseVersion: 2 });
    expect(reloaded.model.screen.value).toEqual({ id: "S00", reason: "otherInstance" });
    expect(versionChanges).toBe(1);

    // S00 の「再読み込み」は、印を消してから読み込み直す
    reloaded.commands.reloadFromGuide();
    expect(reloaded.fake.blockedFlag).toBe(false);
    expect(reloaded.fake.reloads).toBe(1);
    holding.result.close();
  });
});

describe("Service Worker の有効化と再読み込み（Design Doc 6.11、6.13）", () => {
  it("controllerchange の後の再読み込みは、受付操作の途中が終わるまで延ばす", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);
    app.fake.controllerChange(true);
    expect(app.fake.reloads).toBe(0);
    app.commands.nextFromResult();
    expect(app.fake.reloads).toBe(1);
  });

  it("初回のインストールで controller が付いたときは、再読み込みしない", async () => {
    const world = createWorld(IN_MAIN);
    const app = await launch(world);
    app.fake.controllerChange(false);
    await settle();
    expect(app.fake.reloads).toBe(0);
    expect(app.shellState.offlineReady.value).toBe(true);
  });

  it("待機中の版は、停止中で、シートが開いておらず、列が空で、通信が進行中でないときに有効にする", async () => {
    const { world, people } = publishedWorld();
    const app = await ready(world);
    await scan(app, people.alice);

    app.fake.shellUpdateFound();
    await settle();
    expect(app.model.updateWaiting.value).toBe(true);
    expect(app.fake.shellActivations).toBe(0);

    // 読み取り中でも有効にしない
    app.commands.nextFromResult();
    await settle();
    expect(app.fake.shellActivations).toBe(0);

    // 停止中でも、シートが開いている間と、同期の間は有効にしない
    app.commands.stopScan();
    app.commands.openReceptionSheet();
    const gate = deferred();
    world.server.syncGates.push(gate.promise);
    const syncing = app.sync.runSync();
    await settle();
    app.commands.closeOverlay();
    await settle();
    expect(app.fake.shellActivations).toBe(0);

    gate.resolve();
    await syncing;
    await settle();
    expect(app.fake.shellActivations).toBeGreaterThan(0);
  });

  it("S01 の「取得失敗」と、S99 では、有効にする。ログインしていない画面は有効にしない", async () => {
    const { world } = publishedWorld();
    const loggedOut = await launch(world);
    loggedOut.fake.shellUpdateFound();
    await settle();
    expect(loggedOut.fake.shellActivations).toBe(0);

    world.server.down = true;
    const failed = await launch(world, { login: "ok" });
    // 操作者の情報を取得できないので、未ログイン
    expect(failed.model.screen.value).toMatchObject({ id: "S01", phase: "idle" });
    world.server.down = false;
    world.server.versions = null;
    const stuck = await launch(world, { login: "ok" });
    expect(stuck.model.screen.value).toMatchObject({ id: "S01", phase: "fetchFailed" });
    stuck.fake.shellUpdateFound();
    await settle();
    expect(stuck.fake.shellActivations).toBe(1);

    // S99 の「再読み込み」は、待機中の版を有効にしてから読み込み直す
    stuck.commands.reportRenderError(new Error("描画の失敗"));
    expect(stuck.model.screen.value.id).toBe("S99");
    await stuck.commands.reloadFromError();
    expect(stuck.fake.shellActivations).toBeGreaterThan(1);
    stuck.fake.controllerChange(true);
    expect(stuck.fake.reloads).toBe(1);
  });

  it("ロックをほかの画面が持つ S99 では、有効にしない", async () => {
    const { world } = publishedWorld();
    const first = await ready(world);
    const second = await launch(world, { login: "ok" });
    expect(second.model.screen.value.id).toBe("S00");
    second.commands.reportRenderError(new Error("x"));
    second.fake.shellUpdateFound();
    await settle();
    expect(second.fake.shellActivations).toBe(0);
    await second.commands.reloadFromError();
    expect(second.fake.shellActivations).toBe(0);
    expect(second.fake.reloads).toBe(1);
    void first;
  });
});
