import * as z from "zod/mini";
import { epochMsSchema, eventIdSchema, identifierSchema } from "./fields.ts";
import { DISTRIBUTION_FORMAT } from "./versions.ts";

// 設定（Design Doc 4.2、FR-1〜4）。
//
// 設定ファイル（TOML）を読むのは CLI だけで、CLI が検証して JSON に変換し、公開する。
// ここに置くのは、公開する設定の形と、設定ファイルの [conference] の形である。
// 設定ファイル全体の形と検証（Design Doc 4.2 の検証の表）は、CLI の validate とともに足す。

/** 設定ファイルの [conference]。公開する設定でも同じ形 */
export const conferenceSchema = z.object({
  /** fortee のカンファレンスのスラッグ */
  slug: z.string().check(z.minLength(1)),
  /** 表示名 */
  name: z.string().check(z.minLength(1)),
  /** 受付の期間の判定と表示に使う IANA のタイムゾーン名 */
  timezone: z.string().check(z.minLength(1)),
  /** 公開先の環境名（Design Doc 3.6）。CLI の --env と一致しなければ止める */
  environment: z.string().check(z.minLength(1)),
});
export type Conference = z.infer<typeof conferenceSchema>;

/** 設定ファイルのうち、どのコマンドとビルドも読む部分 */
export const configFileHeadSchema = z.object({
  conference: conferenceSchema,
});
export type ConfigFileHead = z.infer<typeof configFileHeadSchema>;

const eventSchema = z.object({
  /** fortee のイベント ID */
  id: eventIdSchema,
  name: z.string(),
  /** テンプレートと設定の中でイベントを指す短い名前。省略すると id で指す */
  key: z.optional(identifierSchema),
});

/** 期間。開始を含み、終了を含まない（FR-3） */
const periodSchema = z.object({
  start: epochMsSchema,
  end: epochMsSchema,
});

// 公開する設定では、イベントの参照（accept など）は id に解決済みである

const receptionSchema = z.object({
  /** 記録に残す識別子。表示名を変えても記録は壊れない */
  id: identifierSchema,
  name: z.string(),
  periods: z.array(periodSchema),
  /** 読み取りを受け付けるイベント */
  accept: z.array(eventIdSchema),
  /** 所持が必須のイベント */
  require: z.array(eventIdSchema),
  /** チェックインするイベント。accept に含まれる（FR-2） */
  checkin: z.array(eventIdSchema),
  rejectMessage: z.string(),
});
export type Reception = z.infer<typeof receptionSchema>;

/** アンケートの項目。イベントと項目名の組で指す（FR-1） */
const answerRefSchema = z.object({
  event: eventIdSchema,
  /** fortee のフォーム項目名そのもの（CSV の列名） */
  field: z.string(),
  /** テンプレートから参照する名前。省略すると field で参照する */
  key: z.optional(z.string()),
});

const ticketTypeGroupSchema = z.object({
  event: eventIdSchema,
  /** fortee のチケット種別名そのもの */
  types: z.array(z.string()),
  /** テンプレートから typeIs.{key} で参照する名前 */
  key: z.string(),
});

/** 公開する設定。受付アプリはこの JSON だけを読み、Worker は中身を解釈せずに配る */
export const publishedConfigSchema = z.object({
  /** 形式の版（Design Doc 9.5） */
  format: z.literal(DISTRIBUTION_FORMAT),
  /** 公開の版。公開した時刻。同じか違うかだけを見る */
  version: epochMsSchema,
  conference: conferenceSchema,
  events: z.array(eventSchema),
  receptions: z.array(receptionSchema),
  search: z.object({
    /** 検索対象にするスナップショットの項目。既定の値を埋めて公開する */
    columns: z.array(z.enum(["ticketNo", "userName", "name"])),
    answers: z.array(answerRefSchema),
  }),
  display: z.object({
    answers: z.array(answerRefSchema),
    ticketTypes: z.array(ticketTypeGroupSchema),
  }),
  template: z.object({
    /** 参考情報テンプレート（Design Doc 4.6） */
    reference: z.string(),
  }),
});
export type PublishedConfig = z.infer<typeof publishedConfigSchema>;
