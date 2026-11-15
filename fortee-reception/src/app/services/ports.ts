import type { PublishedConfig } from "../../core/config.ts";
import type { Snapshot } from "../../core/snapshot.ts";
import type { MeResponse, SyncRequest, SyncResponse } from "../../core/sync.ts";

// 外の世界との接点（Design Doc 6.1 の services）の型。
// 操作（commands）は、この型だけを知る。ブラウザの実装は browser.ts が組み立て、
// テストは偽物を渡す（Design Doc 3.3: テストは引数で渡せば足りる）。

/** 通信の結果。失敗の理由を区別する（Design Doc 6.13） */
export type NetResult<T> =
  | { kind: "ok"; value: T }
  /** 失敗の応答 */
  | { kind: "http"; status: number }
  /** 応答が届かない（通信の失敗） */
  | { kind: "network" }
  | { kind: "timeout" }
  /** 呼び出し側の中断（ログアウト、再読み込み） */
  | { kind: "aborted" }
  /** 応答の形か、形式の版が読めない（Design Doc 4.1、6.7） */
  | { kind: "invalid" };

export type Network = {
  sync(request: SyncRequest, signal: AbortSignal): Promise<NetResult<SyncResponse>>;
  fetchConfig(version: number, signal: AbortSignal): Promise<NetResult<PublishedConfig>>;
  fetchSnapshot(eventId: string, version: number, signal: AbortSignal): Promise<NetResult<Snapshot>>;
  fetchMe(): Promise<NetResult<MeResponse>>;
  /** 失敗してよい（Design Doc 6.4） */
  logout(): Promise<void>;
};

/** このオリジンに 1 つのロック（Design Doc 6.4、NFR-9） */
export type Locks = {
  /** ほかの画面がロックを持っているか */
  isHeld(): Promise<boolean>;
  /** ifAvailable で取る。取れたら手放す関数を、取れなければ null を返す */
  acquire(): Promise<(() => void) | null>;
};

export type FeedbackKind = "success" | "caution" | "reject";

export type Feedback = {
  /**
   * 音を鳴らせる状態にする。タップの処理の中で呼ぶ（端末の挙動 11.3）。rest() を呼ぶまで、音の出力は休まない。
   * 呼んだ操作は、音を鳴らす予定がなくなったら（結果を出した、読み取り中を終えた、何も鳴らさずに終わった）、
   * 必ず rest() を呼ぶ
   */
  unlock(): void;
  play(kind: FeedbackKind): void;
  /**
   * 音を鳴らす予定がなくなった（結果を出した、読み取り中を終えた）。鳴っている音が終わるのを待ってから、音の出力を休ませる。
   * 次の unlock() で、鳴らせる状態に戻る
   */
  rest(): void;
  vibrate(kind: FeedbackKind): void;
  canVibrate(): boolean;
};

/** 「画像を受け取り文字列か null を返す」関数（Design Doc 6.8 の継ぎ目） */
export type QrDecoder = (image: ImageData) => string | null;

export type Camera = {
  /** 映像を出す要素を渡す。外すときは null */
  attach(video: HTMLVideoElement | null): void;
  /** 背面カメラを開始し、読み取った文字列を onText に渡し続ける */
  start(onText: (text: string) => void): Promise<"streaming" | "denied">;
  /** デコードだけを止める（読み取りを受理した後）。映像は止めない */
  pauseDecoding(): void;
  stop(): void;
};

export type WakeLock = {
  /** 画面のスリープを止めるか。ページが表示に戻ったときの取り直しは、内側で行う */
  set(on: boolean): void;
};

export type HistoryGuard = {
  /** 基点のエントリを置き、戻る操作を受け取り始める */
  init(onBack: () => void): void;
  /** 番人のエントリを積んでおくか（Design Doc 6.9） */
  setArmed(armed: boolean): void;
};

export type AppShell = {
  /** このビルドが Service Worker を持つか。開発サーバでは偽 */
  enabled(): boolean;
  /** 起動のたびに呼ぶ。登録がなければインストールが始まる */
  register(): void;
  /** 有効な Service Worker（登録の active）があるか */
  hasActive(): Promise<boolean>;
  /** 有効になるのを待つ。ready は拒否されないので、時間で打ち切る（Design Doc 6.4） */
  waitActive(timeoutMs: number): Promise<boolean>;
  /** 待機中の版があるか */
  hasWaiting(): Promise<boolean>;
  /** 待機中の版へ SKIP_WAITING を送る */
  activateWaiting(): Promise<void>;
  /** 更新を確かめる。登録がなければ register() からやり直す */
  update(): void;
  /** オフラインで起動できるか（Design Doc 6.11） */
  isOfflineReady(): Promise<boolean>;
  /** 殻の取り直しを、有効な Service Worker に求める */
  requestPrecache(): void;
  onWaiting(listener: () => void): void;
  /** hadController が偽なら、初回のインストールで controller が付いた */
  onControllerChange(listener: (hadController: boolean) => void): void;
  onPrecached(listener: () => void): void;
};

export type Platform = {
  now(): number;
  randomUUID(): string;
  /** 0 以上 1 未満 */
  random(): number;
  /** iOS で、Safari のタブで開いているか（NFR-8） */
  isIosSafariTab(): boolean;
  /** ブラウザのタブで開いているか（display-mode: browser） */
  isBrowserTab(): boolean;
  online(): boolean;
  onOnlineChange(listener: (online: boolean) => void): void;
  visible(): boolean;
  onVisibilityChange(listener: (visible: boolean) => void): void;
  /** URL のクエリの login= の値。なければ null */
  loginParam(): string | null;
  /** クエリを history.replaceState で消す */
  clearQuery(): void;
  /** 同じ画面のまま GET /auth/discord/start に移動する */
  goToLogin(): void;
  reload(): void;
  /** 更新の待機で止めた印（sessionStorage。Design Doc 6.4 の 2） */
  blockedFlag(): boolean;
  setBlockedFlag(on: boolean): void;
  /** 記憶域の永続化を要求する。結果を待たずに起動を進める */
  requestPersist(): void;
  persisted(): Promise<boolean>;
  /** 1 秒ごとに呼ぶ。止める関数を返す */
  startTicker(listener: () => void): () => void;
  /** 取り消す関数を返す */
  after(ms: number, listener: () => void): () => void;
  /** 計測の印（Design Doc 11 章の実機の行） */
  mark(name: string): void;
};

export type Ports = {
  platform: Platform;
  network: Network;
  locks: Locks;
  feedback: Feedback;
  camera: Camera;
  wakeLock: WakeLock;
  historyGuard: HistoryGuard;
  appShell: AppShell;
};
