import type { PublishedConfig, Reception } from "../../src/core/config.ts";
import type { CheckinRecord } from "../../src/core/record.ts";
import type { OrderedRecord } from "../../src/core/records.ts";
import type { Snapshot, Ticket } from "../../src/core/snapshot.ts";
import { DISTRIBUTION_FORMAT } from "../../src/core/versions.ts";

// core のテストで使う値。設定は Design Doc 4.2 の例（PRD 11 章の YAPC::Tokyo 2026）による

export const MAIN = "8b2e79c9-9301-4dca-ac12-7b686a1ec85e";
export const EVE = "87e485da-0d45-432b-9943-4a5a3728bb2b";
export const PARTY = "78db606a-1e93-41b9-a531-7791dd68eee0";
export const NURSERY = "64478c06-1fb2-4286-a7ab-32d0b2c9f350";

/** 日本時間（UTC+9）の日時のエポックミリ秒 */
export const jst = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number =>
  Date.UTC(year, month - 1, day, hour - 9, minute, second);

export const eveReception: Reception = {
  id: "eve",
  name: "前夜祭受付",
  periods: [{ start: jst(2026, 11, 27, 17, 30), end: jst(2026, 11, 27, 21, 0) }],
  accept: [EVE, MAIN],
  require: [EVE],
  checkin: [EVE, MAIN],
  rejectMessage: "前夜祭チケットがありません。本編の受付は明日からです",
};

export const mainReception: Reception = {
  id: "main",
  name: "本編受付",
  periods: [
    { start: jst(2026, 11, 28, 9, 30), end: jst(2026, 11, 28, 17, 30) },
    { start: jst(2026, 11, 29, 9, 30), end: jst(2026, 11, 29, 18, 0) },
  ],
  accept: [MAIN],
  require: [MAIN],
  checkin: [MAIN],
  rejectMessage: "本編チケットがありません",
};

export const partyReception: Reception = {
  id: "party",
  name: "懇親会受付",
  periods: [{ start: jst(2026, 11, 28, 17, 30), end: jst(2026, 11, 28, 20, 30) }],
  accept: [PARTY],
  require: [PARTY],
  checkin: [PARTY],
  rejectMessage: "懇親会チケットがありません",
};

export const config: PublishedConfig = {
  format: DISTRIBUTION_FORMAT,
  version: 1764100000000,
  conference: {
    slug: "yapc-tokyo-2026",
    name: "YAPC::Tokyo 2026",
    timezone: "Asia/Tokyo",
    environment: "yapc-tokyo-2026",
  },
  events: [
    { id: MAIN, name: "本編", key: "main" },
    { id: EVE, name: "前夜祭", key: "eve" },
    { id: PARTY, name: "懇親会", key: "party" },
    { id: NURSERY, name: "託児所", key: "nursery" },
  ],
  receptions: [eveReception, mainReception, partyReception],
  search: {
    columns: ["ticketNo", "userName", "name"],
    answers: [{ event: MAIN, field: "スピーカー名札に記載するお名前" }],
  },
  display: {
    answers: [{ event: MAIN, field: "Tシャツのサイズ", key: "tshirt" }],
    ticketTypes: [
      {
        event: MAIN,
        types: ["【カンファレンス本編】一般チケット", "【カンファレンス本編】一般チケット（特別請求）"],
        key: "general",
      },
      { event: MAIN, types: ["【カンファレンス本編】スタッフチケット"], key: "staff" },
    ],
  },
  template: { reference: "{{user.userName}} さん\n" },
};

export const EVENT_IDS = config.events.map((event) => event.id);

/** 番号から、チケットトークンの形（英数字 32 文字）の値を作る */
export const token = (n: number): string => `T${String(n).padStart(31, "0")}`;

/** 番号から、UUID の形の値を作る */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

let nextToken = 1;

export function ticket(fields: Partial<Ticket> & Pick<Ticket, "eventId" | "userName">): Ticket {
  const n = nextToken++;
  return {
    ticketToken: token(n),
    ticketNo: `A-${n}`,
    ticketType: "【カンファレンス本編】一般チケット",
    name: "",
    profileUrlToken: `p${n}`,
    forteeCheckedIn: false,
    answers: {},
    ...fields,
  };
}

/** チケットを、イベントごとのスナップショットにまとめる */
export function snapshotsOf(tickets: readonly Ticket[]): Snapshot[] {
  const byEvent = new Map<string, Snapshot>();
  for (const { eventId, ...attendee } of tickets) {
    let snapshot = byEvent.get(eventId);
    if (snapshot === undefined) {
      snapshot = { format: DISTRIBUTION_FORMAT, eventId, version: 1764200000000, columns: [], attendees: [] };
      byEvent.set(eventId, snapshot);
    }
    snapshot.attendees.push(attendee);
  }
  return [...byEvent.values()];
}

export const DEVICE_A = uuid(0xa);
export const DEVICE_B = uuid(0xb);

const base = {
  userName: "karupanerura",
  ticketNo: "A-12",
  deviceId: DEVICE_A,
  operatorId: "123456789012345678",
  operatorName: "staff",
};

type RecordFields = Partial<Pick<CheckinRecord, "userName" | "ticketNo" | "deviceId" | "opId">> & {
  receivedAt?: number | null;
};

/** チェックインの記録。id は記録 ID の番号 */
export function checkin(id: number, ticketToken: string, deviceTime: number, fields: RecordFields = {}): OrderedRecord {
  return {
    ...base,
    recordId: uuid(id),
    opId: uuid(0x1000 + id),
    op: "checkin",
    ticketToken,
    reception: "main",
    route: "qr",
    reasonKind: null,
    reasonText: null,
    targetRecordIds: null,
    deviceTime,
    ...fields,
  };
}

/** 取り消しの記録。targets は、打ち消す記録 ID の番号 */
export function cancel(
  id: number,
  ticketToken: string,
  deviceTime: number,
  targets: readonly number[],
  fields: RecordFields = {},
): OrderedRecord {
  return {
    ...base,
    recordId: uuid(id),
    opId: uuid(0x1000 + id),
    op: "cancel",
    ticketToken,
    reception: "main",
    route: null,
    reasonKind: "mistake",
    reasonText: null,
    targetRecordIds: targets.map(uuid),
    deviceTime,
    ...fields,
  };
}
