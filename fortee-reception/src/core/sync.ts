import * as z from "zod/mini";
import { epochMsSchema, eventIdSchema, nameSchema, operatorIdSchema, uuidSchema } from "./fields.ts";
import { checkinRecordSchema, serverRecordSchema } from "./record.ts";
import { SYNC_PROTOCOL_VERSION } from "./versions.ts";

// 同期の要求と応答（Design Doc 4.5）と、/api/me の応答（Design Doc 7.1）。
// 端末と Worker は、同じこのスキーマで検証する。知らない項目は落とす。

/** 1 回の要求で送る記録の件数の上限 */
export const SYNC_RECORDS_MAX = 50;
/** 1 回の応答で受け取る記録の件数の上限。要求の limit の最大で、省略したときの値でもある */
export const SYNC_LIMIT_MAX = 200;
/** 要求の本文の上限。超えれば 413 */
export const SYNC_BODY_MAX_BYTES = 256 * 1024;
/** 端末が 1 回の要求で送る記録のバイト数の上限（Design Doc 6.6） */
export const SYNC_SEND_MAX_BYTES = 200 * 1024;
/** 1 回の応答で返す記録のバイト数の上限（Design Doc 7.3） */
export const SYNC_RECEIVE_MAX_BYTES = 128 * 1024;
export const APP_VERSION_MAX_LENGTH = 64;

/** 受信位置。seq がどの連なりの番号かを generation で示す */
const cursorSchema = z.object({
  generation: z.string(),
  seq: z.int().check(z.gte(0)),
});
export type SyncCursor = z.infer<typeof cursorSchema>;

export const syncRequestSchema = z.object({
  /** プロトコルの版。知らない版は 400 */
  v: z.literal(SYNC_PROTOCOL_VERSION),
  deviceId: uuidSchema,
  /** 端末の現在時刻。時計の差の測定に使う */
  deviceTime: epochMsSchema,
  /** 受付アプリのリリース。ビルド時に埋め込む */
  appVersion: z.string().check(z.maxLength(APP_VERSION_MAX_LENGTH)),
  /** 初回は null */
  cursor: z.nullable(cursorSchema),
  limit: z.optional(z.int().check(z.gte(1), z.lte(SYNC_LIMIT_MAX))),
  records: z.array(checkinRecordSchema).check(z.maxLength(SYNC_RECORDS_MAX)),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/** 設定の版と全イベントの版。D1 の meta.versions の値そのまま（Design Doc 7.5） */
export const versionsSchema = z.object({
  config: epochMsSchema,
  /** イベント ID → スナップショットの版 */
  events: z.record(eventIdSchema, epochMsSchema),
});
export type Versions = z.infer<typeof versionsSchema>;

export const syncResponseSchema = z.object({
  /** DB の世代 */
  generation: z.string(),
  /** 次の受信位置。実際に返した最後の記録の seq */
  nextSeq: z.int().check(z.gte(0)),
  hasMore: z.boolean(),
  records: z.array(serverRecordSchema),
  /** まだ公開していなければ null */
  versions: z.nullable(versionsSchema),
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;

/**
 * セッションの操作者。GET /api/me の応答。
 * 受付アプリは、この値を記録の操作者に写す。記録のスキーマと同じ形にして、
 * ここを通った値で作った記録が、記録の検証で落ちないようにする
 */
export const meResponseSchema = z.object({
  /** Discord のユーザ ID */
  operatorId: operatorIdSchema,
  /** Discord の表示名。記録の操作者名と同じスキーマで確かめる */
  operatorName: nameSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// 同期の状態（画面設計書 2.3）

/**
 * ヘッダに出す同期の状態。
 *
 * - paused: 同期を止めている（リハーサルモード）
 * - syncing: 同期中
 * - offline: オフライン（端末がネットワークにつながっていない）
 * - needsLogin: 再ログインが必要
 * - failed: 同期の失敗
 * - pending: 未同期あり
 * - synced: 同期済み
 */
export type SyncStatus = "paused" | "syncing" | "offline" | "needsLogin" | "failed" | "pending" | "synced";

/** 同期の状態を決める条件。複数が同時に真になりうる */
export type SyncConditions = {
  /** 同期を止めている（リハーサルモード。FR-50） */
  paused: boolean;
  /** 同期の要求を送っている */
  syncing: boolean;
  /** 端末がネットワークにつながっていない */
  offline: boolean;
  /** セッションがないか、期限が切れている（同期が 401 を返した） */
  needsLogin: boolean;
  /** 直前の同期が失敗した */
  failed: boolean;
  /** 未送信の記録がある */
  hasUnsent: boolean;
};

/**
 * 同期の状態の優先順（画面設計書 2.3）。同期の停止、同期中、オフライン、再ログインが必要、同期の失敗、未同期あり、
 * 同期済みの順に見て、最初に当てはまったものを返す。
 * オフラインのときに未同期の記録があるか（アイコンの印）は、呼び出し側が hasUnsent で見る
 */
export function pickSyncStatus(conditions: SyncConditions): SyncStatus {
  if (conditions.paused) return "paused";
  if (conditions.syncing) return "syncing";
  if (conditions.offline) return "offline";
  if (conditions.needsLogin) return "needsLogin";
  if (conditions.failed) return "failed";
  if (conditions.hasUnsent) return "pending";
  return "synced";
}
