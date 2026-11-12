import * as z from "zod/mini";
import { epochMsSchema, eventIdSchema, ticketTokenSchema } from "./fields.ts";
import { DISTRIBUTION_FORMAT } from "./versions.ts";

// スナップショット（Design Doc 4.3、PRD 7.1）。イベントごとに 1 つの JSON。
// 参加者の値は CSV の値をそのまま持ち、前後の空白や全角と半角を変えない。

export const attendeeSchema = z.object({
  /** 参加者の識別子 */
  ticketToken: ticketTokenSchema,
  ticketNo: z.string(),
  ticketType: z.string(),
  /** fortee ユーザ名。ユーザの同一性は、この値の完全一致で判定する（FR-12） */
  userName: z.string(),
  /** チケットごとの値（CSV の 1 行ごと） */
  name: z.string(),
  profileUrlToken: z.string(),
  /** fortee 側のチェックイン有無。参考値 */
  forteeCheckedIn: z.boolean(),
  /** そのイベントについて設定で参照する列だけ。鍵は fortee の項目名（CSV の列名） */
  answers: z.record(z.string(), z.string()),
});
export type Attendee = z.infer<typeof attendeeSchema>;

export const snapshotSchema = z.object({
  /** 形式の版（Design Doc 9.5） */
  format: z.literal(DISTRIBUTION_FORMAT),
  eventId: eventIdSchema,
  /** 取り込み日時（FR-44）。同じか違うかだけを見て、大小で新旧を決めない */
  version: epochMsSchema,
  /** answers に取り込んだ列の名前。参加者が 0 人でも設定との整合を確かめられるようにする（Design Doc 9.4） */
  columns: z.array(z.string()),
  attendees: z.array(attendeeSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
