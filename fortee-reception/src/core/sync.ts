import * as z from "zod/mini";
import { epochMsSchema, eventIdSchema, NAME_MAX_LENGTH, operatorIdSchema, uuidSchema } from "./fields.ts";
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
  /** Discord の表示名 */
  operatorName: z.string().check(z.maxLength(NAME_MAX_LENGTH)),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
