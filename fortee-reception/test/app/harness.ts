import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";
import type { PublishedConfig } from "../../src/core/config.ts";
import type { CheckinRecord, ServerRecord } from "../../src/core/record.ts";
import type { Snapshot } from "../../src/core/snapshot.ts";
import type { SyncRequest, SyncResponse, Versions } from "../../src/core/sync.ts";
import type { FetchLike } from "../../src/app/services/network.ts";
import type { AppShell, FeedbackKind, Ports } from "../../src/app/services/ports.ts";

// 受付アプリを、通信・ロック・時計を偽物に置き換えて動かす（Design Doc 11 章）。
// 記憶域は fake-indexeddb で、ネットワークのサービスは本物を、偽の fetch の上で動かす。
//
// 画面（実体）ごとに、モジュールを読み込み直して、状態を分ける。1 つのテストで 2 つの実体を動かせる。
// 実体のあいだで共有するのは、IndexedDB、ロックの表、サーバである。
// このファイルとテストは、src/app の状態を持つモジュールを、静的には import しない（型だけ）。

// ビルドが埋め込む値（build/app-shell.ts）。テストでは、ここで置く
Object.assign(globalThis, { __APP_RELEASE__: "test-release", __CONFERENCE_NAME__: "テスト" });

/** 手で解決する Promise */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 反映の列と、IndexedDB の処理が進むのを待つ */
export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 条件が真になるまで待つ */
export async function until(condition: () => boolean, what = "条件"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${what} が成り立たない`);
}

// ───────── サーバ ─────────

export class FakeServer {
  generation = "gen-1";
  records: ServerRecord[] = [];
  versions: Versions | null = null;
  config: PublishedConfig | null = null;
  snapshots = new Map<string, Snapshot>();
  operator = { operatorId: "123456789012345678", operatorName: "staff" };
  /** 受けた同期の要求 */
  syncRequests: SyncRequest[] = [];
  /** 受けた要求のパス */
  paths: string[] = [];
  /** 次の同期の要求に返す状態。空なら 200 */
  syncStatuses: number[] = [];
  /** すべての /api/ の要求に返す状態。null なら通常の応答 */
  apiStatus: number | null = null;
  /** 通信の失敗にする */
  down = false;
  /** 応答を返す前に待つ門。同期の要求ごとに、先頭から 1 つずつ使う */
  syncGates: Promise<void>[] = [];
  private receivedAt = 1_764_300_000_000;

  publish(config: PublishedConfig, snapshots: Snapshot[]): void {
    this.config = config;
    this.snapshots = new Map(snapshots.map((snapshot) => [snapshot.eventId, snapshot]));
    this.versions = {
      config: config.version,
      events: Object.fromEntries(snapshots.map((snapshot) => [snapshot.eventId, snapshot.version])),
    };
  }

  /** ほかの端末の記録として、サーバに置く */
  add(record: CheckinRecord): ServerRecord {
    const existing = this.records.find((candidate) => candidate.recordId === record.recordId);
    if (existing !== undefined) return existing;
    const stored = { ...record, seq: this.records.length + 1, receivedAt: this.receivedAt++ } as ServerRecord;
    this.records.push(stored);
    return stored;
  }

  /** DB を戻した後の復旧。記録を捨て、世代を変える */
  restore(generation: string, records: CheckinRecord[] = []): void {
    this.generation = generation;
    this.records = [];
    for (const record of records) this.add(record);
  }

  private sync(request: SyncRequest): SyncResponse {
    for (const record of request.records) this.add(record);
    const limit = request.limit ?? 200;
    if (request.cursor !== null && request.cursor.generation !== this.generation) {
      return { generation: this.generation, nextSeq: 0, hasMore: false, records: [], versions: this.versions };
    }
    const from = request.cursor?.seq ?? 0;
    const rest = this.records.filter((record) => record.seq > from);
    const page = rest.slice(0, limit);
    return {
      generation: this.generation,
      nextSeq: page.at(-1)?.seq ?? from,
      hasMore: rest.length > page.length,
      records: page,
      versions: this.versions,
    };
  }

  fetch: FetchLike = async (path, init) => {
    this.paths.push(path);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const abortable = <T>(work: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        work.then(resolve, reject);
      });
    if (path === "/auth/logout") return json({});
    if (path === "/api/sync") {
      const request = JSON.parse(String(init?.body)) as SyncRequest;
      this.syncRequests.push(request);
      const gate = this.syncGates.shift();
      if (gate !== undefined) await abortable(gate);
    }
    if (this.down) throw new TypeError("fetch failed");
    if (this.apiStatus !== null) return json({ error: "x" }, this.apiStatus);
    if (path === "/api/sync") {
      const status = this.syncStatuses.shift();
      if (status !== undefined && status !== 200) return json({ error: "x" }, status);
      return json(this.sync(this.syncRequests.at(-1) as SyncRequest));
    }
    if (path === "/api/me") return json(this.operator);
    const config = /^\/api\/config\/(\d+)$/.exec(path);
    if (config !== null) {
      return this.config !== null && String(this.config.version) === config[1] ? json(this.config) : json({}, 404);
    }
    const snapshot = /^\/api\/snapshot\/([^/]+)\/(\d+)$/.exec(path);
    if (snapshot !== null) {
      const found = this.snapshots.get(decodeURIComponent(snapshot[1] as string));
      return found !== undefined && String(found.version) === snapshot[2] ? json(found) : json({}, 404);
    }
    return json({ error: "not_found" }, 404);
  };
}

// ───────── 実体のあいだで共有するもの ─────────

export type World = {
  server: FakeServer;
  /** ロックを持っている実体。なければ null */
  lockHolder: object | null;
  /** 端末の時計 */
  now: number;
};

/** IndexedDB を空にして、新しい世界を作る。テストごとに呼ぶ */
export function createWorld(now: number): World {
  globalThis.indexedDB = new IDBFactory();
  return { server: new FakeServer(), lockHolder: null, now };
}

// ───────── 実体 ─────────

export type LaunchOptions = {
  /** URL のクエリの login= の値 */
  login?: string | null;
  /** 有効な Service Worker があるか。既定は真 */
  shellActive?: boolean;
  /** waitActive() の結果。既定は真 */
  shellInstalls?: boolean;
  iosSafariTab?: boolean;
  /** 更新の待機で止めた印 */
  blockedFlag?: boolean;
  /** ロックの照会の結果を差し替える（照会の後に、別の画面がロックを取る筋書き） */
  isHeld?: () => Promise<boolean>;
  /** ロックを取る前に待つ門 */
  beforeAcquire?: Promise<void>;
  databaseVersion?: number;
  openTimeoutMs?: number;
  /** 起動の終わりを待たない */
  noWait?: boolean;
};

type Modules = {
  commands: typeof import("../../src/app/commands/index.ts");
  session: typeof import("../../src/app/commands/session.ts");
  scan: typeof import("../../src/app/commands/scan.ts");
  sync: typeof import("../../src/app/commands/sync.ts");
  runtime: typeof import("../../src/app/commands/runtime.ts");
  model: typeof import("../../src/app/state/model.ts");
  derived: typeof import("../../src/app/state/derived.ts");
  views: typeof import("../../src/app/state/views.ts");
  shellState: typeof import("../../src/app/state/app-shell.ts");
};

export type Instance = Modules & {
  world: World;
  /** boot() の終わり */
  booted: Promise<void>;
  /** 偽物の操作と、記録 */
  fake: {
    reloads: number;
    loginNavigations: number;
    blockedFlag: boolean;
    visible: boolean;
    sounds: FeedbackKind[];
    cameraStarts: number;
    cameraStops: number;
    cameraResult: "streaming" | "denied";
    armed: boolean;
    wakeLock: boolean;
    shellActivations: number;
    shellWaiting: boolean;
    setOnline(online: boolean): void;
    setVisible(visible: boolean): void;
    /** 新しい版の Service Worker が待機に入った */
    shellUpdateFound(): void;
    controllerChange(hadController: boolean): void;
    /** Android の戻る操作 */
    back(): void;
    /** after() で予約された処理を、すべて実行する */
    runTimers(): void;
  };
};

/** 受付アプリの実体を 1 つ起動する。モジュールを読み込み直すので、状態はほかの実体と分かれる */
export async function launch(world: World, options: LaunchOptions = {}): Promise<Instance> {
  vi.resetModules();
  const modules: Modules = {
    commands: await import("../../src/app/commands/index.ts"),
    session: await import("../../src/app/commands/session.ts"),
    scan: await import("../../src/app/commands/scan.ts"),
    sync: await import("../../src/app/commands/sync.ts"),
    runtime: await import("../../src/app/commands/runtime.ts"),
    model: await import("../../src/app/state/model.ts"),
    derived: await import("../../src/app/state/derived.ts"),
    views: await import("../../src/app/state/views.ts"),
    shellState: await import("../../src/app/state/app-shell.ts"),
  };
  const { createNetwork } = await import("../../src/app/services/network.ts");

  const me = {};
  let online = true;
  let onlineListener: (online: boolean) => void = () => {};
  let visibilityListener: (visible: boolean) => void = () => {};
  let waitingListener: () => void = () => {};
  let controllerListener: (hadController: boolean) => void = () => {};
  let backListener: () => void = () => {};
  let timers: (() => void)[] = [];
  let login = options.login ?? null;
  let uuid = 0;
  const instanceNo = ++instances;

  const fake: Instance["fake"] = {
    reloads: 0,
    loginNavigations: 0,
    blockedFlag: options.blockedFlag ?? false,
    visible: true,
    sounds: [],
    cameraStarts: 0,
    cameraStops: 0,
    cameraResult: "streaming",
    armed: false,
    wakeLock: false,
    shellActivations: 0,
    shellWaiting: false,
    setOnline(value) {
      online = value;
      onlineListener(value);
    },
    setVisible(value) {
      fake.visible = value;
      visibilityListener(value);
    },
    shellUpdateFound() {
      fake.shellWaiting = true;
      waitingListener();
    },
    controllerChange: (hadController) => controllerListener(hadController),
    back: () => backListener(),
    runTimers() {
      const due = timers;
      timers = [];
      for (const timer of due) timer();
    },
  };

  const appShell: AppShell = {
    enabled: () => true,
    register: () => {},
    hasActive: async () => options.shellActive ?? true,
    waitActive: async () => options.shellInstalls ?? true,
    hasWaiting: async () => fake.shellWaiting,
    activateWaiting: async () => {
      fake.shellActivations++;
    },
    update: () => {},
    isOfflineReady: async () => true,
    requestPrecache: () => {},
    onWaiting: (listener) => {
      waitingListener = listener;
    },
    onControllerChange: (listener) => {
      controllerListener = listener;
    },
    onPrecached: () => {},
  };

  const ports: Ports = {
    platform: {
      now: () => world.now,
      // 実体ごとに違う、UUID の形の値
      randomUUID: () => `${instanceNo.toString(16).padStart(8, "0")}-0000-4000-8000-${(++uuid).toString(16).padStart(12, "0")}`,
      random: () => 0.5,
      isIosSafariTab: () => options.iosSafariTab ?? false,
      isBrowserTab: () => false,
      online: () => online,
      onOnlineChange: (listener) => {
        onlineListener = listener;
      },
      visible: () => fake.visible,
      onVisibilityChange: (listener) => {
        visibilityListener = listener;
      },
      loginParam: () => login,
      clearQuery: () => {
        login = null;
      },
      goToLogin: () => {
        fake.loginNavigations++;
      },
      reload: () => {
        fake.reloads++;
      },
      blockedFlag: () => fake.blockedFlag,
      setBlockedFlag: (on) => {
        fake.blockedFlag = on;
      },
      requestPersist: () => {},
      persisted: async () => true,
      startTicker: () => () => {},
      after: (_ms, listener) => {
        timers.push(listener);
        return () => {
          timers = timers.filter((timer) => timer !== listener);
        };
      },
      mark: () => {},
    },
    network: createNetwork(world.server.fetch),
    locks: {
      isHeld: options.isHeld ?? (async () => world.lockHolder !== null),
      async acquire() {
        await options.beforeAcquire;
        if (world.lockHolder !== null) return null;
        world.lockHolder = me;
        return () => {
          if (world.lockHolder === me) world.lockHolder = null;
        };
      },
    },
    feedback: {
      unlock: () => {},
      play: (kind) => {
        fake.sounds.push(kind);
      },
      vibrate: () => {},
      canVibrate: () => true,
    },
    camera: {
      attach: () => {},
      start: async () => {
        fake.cameraStarts++;
        return fake.cameraResult;
      },
      pauseDecoding: () => {},
      stop: () => {
        fake.cameraStops++;
      },
    },
    wakeLock: {
      set: (on) => {
        fake.wakeLock = on;
      },
    },
    historyGuard: {
      init: (onBack) => {
        backListener = onBack;
      },
      setArmed: (armed) => {
        fake.armed = armed;
      },
    },
    appShell,
  };

  const booted = modules.session.boot(ports, {
    databaseVersion: options.databaseVersion,
    openTimeoutMs: options.openTimeoutMs,
  });
  const instance: Instance = { ...modules, world, booted, fake };
  if (options.noWait !== true) {
    await booted;
    await settle();
  }
  return instance;
}

let instances = 0;

/** 再読み込みか、ページの破棄を模して、実体を捨てる。接続を閉じ、ロックを外す */
export function discard(instance: Instance): void {
  instance.sync.abortSync();
  instance.runtime.rt.db?.close();
  instance.runtime.rt.db = null;
  instance.runtime.rt.releaseLock?.();
  instance.runtime.rt.releaseLock = null;
}
