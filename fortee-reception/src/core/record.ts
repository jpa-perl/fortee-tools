import * as z from "zod/mini";
import {
  epochMsSchema,
  identifierSchema,
  NAME_MAX_LENGTH,
  operatorIdSchema,
  ticketTokenSchema,
  uuidSchema,
} from "./fields.ts";

// 記録（Design Doc 4.4、FR-39）。追記型のイベントで、削除も更新もしない（PRD 7.2）。
// v1 以後は項目を足すことしかせず、値の集合と上限も変えない（Design Doc 9.6）。
// スキーマが確かめるのは形だけで、取り消しが指す ID の先が何であるかは確かめない。

export const REASON_TEXT_MAX_LENGTH = 2000;
/** 1 件の取り消しの記録が指せるチェックインの記録 ID の数。超えるときは同じ操作 ID で記録を分ける */
export const TARGET_RECORD_IDS_MAX = 50;

const name = z.string().check(z.maxLength(NAME_MAX_LENGTH));

const commonFields = {
  /** 端末が生成する。再送の重複排除に使う */
  recordId: uuidSchema,
  /** 1 回の操作で作られた記録に共通 */
  opId: uuidSchema,
  ticketToken: ticketTokenSchema,
  /** チケットの fortee ユーザ名。記録した時点の値の写し */
  userName: name,
  /** チケット番号。記録した時点の値の写し */
  ticketNo: name,
  /** 端末の時刻 */
  deviceTime: epochMsSchema,
  deviceId: uuidSchema,
  /** Discord のユーザ ID */
  operatorId: operatorIdSchema,
  /** Discord の表示名 */
  operatorName: name,
};

const checkinFields = {
  ...commonFields,
  op: z.literal("checkin"),
  /** 受付の id。チェックインは受付なしでは行えない（FR-7） */
  reception: identifierSchema,
  route: z.enum(["qr", "search"]),
  reasonKind: z.null(),
  reasonText: z.null(),
  targetRecordIds: z.null(),
};

const cancelFields = {
  ...commonFields,
  op: z.literal("cancel"),
  /** 受付の id。受付なしのときに行った取り消しでは null */
  reception: z.nullable(identifierSchema),
  route: z.null(),
  reasonKind: z.enum(["mistake", "wrong_person", "other"]),
  /** reasonKind が "other" のときの自由記述。それ以外は null */
  reasonText: z.nullable(z.string().check(z.maxLength(REASON_TEXT_MAX_LENGTH))),
  /** 打ち消すチェックインの記録 ID。重複させない */
  targetRecordIds: z.array(uuidSchema).check(
    z.minLength(1),
    z.maxLength(TARGET_RECORD_IDS_MAX),
    z.refine((ids) => new Set(ids).size === ids.length, "targetRecordIds に重複がある"),
  ),
};

/** reasonText は、reasonKind が "other" のときだけ持つ */
function reasonTextMatchesKind(r: { reasonKind: string; reasonText: string | null }): boolean {
  return (r.reasonKind === "other") === (r.reasonText !== null);
}
const REASON_TEXT_MESSAGE = "reasonText は reasonKind が other のときだけ持つ";

const serverFields = {
  /** サーバが付ける連番。受信位置に使う */
  seq: z.int().check(z.gte(1)),
  /** サーバの受信時刻 */
  receivedAt: epochMsSchema,
};

/** 端末が作る記録 */
export const checkinRecordSchema = z.discriminatedUnion("op", [
  z.object(checkinFields),
  z.object(cancelFields).check(z.refine(reasonTextMatchesKind, REASON_TEXT_MESSAGE)),
]);
export type CheckinRecord = z.infer<typeof checkinRecordSchema>;

/** サーバが返す記録。端末が作る記録に、連番と受信時刻を加えたもの */
export const serverRecordSchema = z.discriminatedUnion("op", [
  z.object({ ...checkinFields, ...serverFields }),
  z.object({ ...cancelFields, ...serverFields }).check(z.refine(reasonTextMatchesKind, REASON_TEXT_MESSAGE)),
]);
export type ServerRecord = z.infer<typeof serverRecordSchema>;
