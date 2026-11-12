import { signal } from "@preact/signals";
import type { PublishedConfig, Reception } from "../../core/config.ts";
import type { Judgement, JudgeInput } from "../../core/judge.ts";
import type { CheckinRecord } from "../../core/record.ts";
import type { RecordOperator } from "../../core/records.ts";
import type { Snapshot } from "../../core/snapshot.ts";
import type { SyncCursor } from "../../core/sync.ts";

// 状態（Design Doc 6.2）。画面（ui）は、ここの Signal と、derived.ts、views.ts の導出を読む。
// 書き換えるのは操作（commands）だけである。画面から .value に代入しない。

// ───────── 画面とシート ─────────

export type CameraState = "requesting" | "streaming" | "denied";

/** ホーム（S02〜S04）の状態。停止中が S02、読み取り中が S03、見つからないと結果が S04 */
export type HomeMode =
  | { kind: "idle" }
  | { kind: "scanning"; camera: CameraState }
  /** 見つからない（FR-17）。判定を呼ばずに移る。token は、直後の読み直しを無視する照合に使う */
  | { kind: "notFound"; token: string }
  | {
      kind: "result";
      input: JudgeInput;
      judgement: Judgement;
      /** この判定で作った記録。成功と続けて読み取りのほかは空 */
      records: CheckinRecord[];
      /** 判定した受付。参考情報（S04-M1）の「済みにした受付」と、帯の表示に使う */
      reception: Reception;
    };

export type S01Phase = "idle" | "loggingIn" | "noRole" | "fetching" | "fetchFailed" | "needsLogin";

export type Screen =
  /** 起動の最初の判定（ロックの照会と meta の読み出し）が終わるまで。何も出さない */
  | { id: "boot" }
  /** 開き方の案内。iOS の Safari のタブか、別の画面で開いているか */
  | { id: "S00"; reason: "safariTab" | "otherInstance" }
  | {
      id: "S01";
      phase: S01Phase;
      /** 「未ログイン」に「ログインできませんでした」を添える */
      loginFailed?: boolean;
      /** 取得失敗の内訳。配布物（data）か、Service Worker の殻（app）か */
      failed?: { data: boolean; app: boolean };
      /** 再ログインのとき（端末にデータがあるとき）。左上に「戻る」を出す */
      canGoBack?: boolean;
    }
  | { id: "home"; mode: HomeMode }
  | { id: "S05"; query: string }
  /** selected はイベント ID → 選んだチケットトークン。query は S05 の入力で、戻るときに残す */
  | { id: "S06"; userName: string; selected: Record<string, string>; query: string }
  | { id: "S07"; filter: string }
  /** filter は from が S07 のときの S07 の検索欄の値で、戻るときに残す */
  | { id: "S08"; opId: string; from: "home" | "S07"; filter?: string }
  | { id: "S09" }
  | { id: "S99"; error: string };

/** S02-M1 の確認で、確定すること */
export type ReceptionChange = { kind: "switch"; receptionId: string } | { kind: "reset" };

export type Overlay =
  | null
  | { id: "S02-M1"; step: { kind: "list" } | { kind: "confirm"; change: ReceptionChange } }
  | { id: "S04-M1" }
  | { id: "S04-M2" }
  | { id: "S06-M1" }
  /** 選んだチケットと理由は、シートの中の入力として画面が持ち、確定のときに操作に渡す */
  | { id: "S08-M1" }
  | { id: "S09-D1" };

export const screen = signal<Screen>({ id: "boot" });
export const overlay = signal<Overlay>(null);

/** 読み取りを受理してから結果を出すまで（Design Doc 6.13）。受付操作の途中に含める */
export const judging = signal(false);

/** 確定の処理が進んでいる。S04-M2、S06-M1、S08-M1、S02-M1、S09-D1 の確定ボタンを押せなくする */
export const busy = signal(false);

// ───────── 永続の状態（IndexedDB から読み戻す） ─────────

/** 端末に置く記録。記録に、送信済みの印と、サーバから受け取った連番と受信時刻を加えたもの（Design Doc 6.3） */
export type DeviceRecord = CheckinRecord & { sent: boolean; seq: number | null; receivedAt: number | null };

/** 受付の手動の上書き。until は上書きした時刻の次の境界。この先に境界がなければ null */
export type ReceptionOverride = { receptionId: string; until: number | null };

export const deviceId = signal<string | null>(null);
export const operator = signal<RecordOperator | null>(null);
export const soundEnabled = signal(true);
export const vibrationEnabled = signal(true);
export const cursor = signal<SyncCursor | null>(null);
export const override = signal<ReceptionOverride | null>(null);
/** 最終同期の時刻。同期と、その同期が必要にした配布物の取得の両方が成功した時刻 */
export const lastSyncAt = signal<number | null>(null);
export const config = signal<PublishedConfig | null>(null);
export const snapshots = signal<readonly Snapshot[]>([]);
export const records = signal<readonly DeviceRecord[]>([]);

// ───────── 揮発の状態 ─────────

/** 現在時刻。1 秒ごとに更新する */
export const now = signal(0);

/**
 * 確定している受付（Design Doc 6.2）。受付操作の途中は更新を止める。
 * manual は、手動の上書きで選ばれているか（ヘッダと受付のカードの「手動」）
 */
export const confirmedReception = signal<{ reception: Reception | null; manual: boolean }>({
  reception: null,
  manual: false,
});

/** 同期の進行（Design Doc 6.6）。ヘッダの表示は derived.ts の syncStatus を読む */
export const syncInFlight = signal(false);
export const online = signal(true);
export const needsLogin = signal(false);
export const lastSyncFailed = signal(false);

/** 画面の下の知らせ（画面設計書 2.7、S08）の 1 行 */
export type NoticeLine =
  /** 「{受付名}になりました」。name が null なら「受付なしになりました」 */
  | { kind: "receptionChanged"; name: string | null }
  /** 「データを更新しました」 */
  | { kind: "dataUpdated" }
  /** 「取り消しました」 */
  | { kind: "cancelled" }
  /** 「{チケット番号} は他の端末で操作されたため、取り消しませんでした」 */
  | { kind: "cancelSkipped"; ticketNos: string[] };

/** 画面の下の知らせ。数秒で消える。lines を上から順に並べて同時に出す。id は出し直しの区別に使う */
export const notice = signal<{ id: number; lines: NoticeLine[] } | null>(null);

/** S03 の「チケットの QR ではありません」のバナーを出しているか */
export const scanBanner = signal(false);

/** ブラウザのタブで開いているか。S00 の文言と、S01 の Android のバナーに使う */
export const browserTab = signal(false);
/** 振動に対応した端末か。S09 の「振動」の行を置くか */
export const canVibrate = signal(false);
/** 記憶域の永続化が認められているか。S09 を開いたときに判定する。まだなら null */
export const storagePersisted = signal<boolean | null>(null);
/** 新しい版の受付アプリが待機中か */
export const updateWaiting = signal(false);
