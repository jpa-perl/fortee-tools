import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { PNG } from "pngjs";
import qrcode from "qrcode-generator";

// 合成の fortee のダウンロード ZIP を作る。テストのフィクスチャと、ローカルの開発（config/local.toml）で使う。
//
// これは、fortee の Sandbox からダウンロードした本物の ZIP ではない。リポジトリに Sandbox の ZIP はなく、
// ZIP と CSV の形は docs/research/fortee/ の記述（data-sources.md、data-model.md、qr-code.md、constraints.md 4 章）から
// 合成している。記述から決まるのは、次のことである。
//
// - ZIP はイベント単位で、CSV 1 本、参加者ごとの QR 画像 2 枚（qr-profile/、qr-feedback/）、avatar/ ディレクトリが入る
// - CSV は UTF-8（BOM 付き）。列は data-sources.md の表のとおりで、Ticket url の後ろに、フォーム項目の列が項目名で並ぶ
// - 未発券の行は User name と Issued が空で、チケットトークンと profile_url_token は持つ
// - qr-profile/ の画像は https://fortee.jp/{conf}/attendee/{profile_url_token}/go-profile、
//   qr-feedback/ の画像は https://fortee.jp/{conf}/attendee/{チケットトークン} の QR で、
//   482×482 の PNG、バージョン 6（41×41 モジュール）、誤り訂正 M
// - 画像のファイル名は qr-profile-{種別名}-{チケット番号}.png で、エントリ名は UTF-8
//
// 記述から決まらず、ここで仮に決めたもの（本物の ZIP で確かめていない）:
//
// - ZIP の中の CSV のファイル名（attendees.csv にした）と、エントリの階層（ZIP の直下にした）
// - 列の並び順（data-sources.md の表の順にした）と、行の終わり（CRLF にした）
// - Order、Order #、Ticket id、Twitter、Serial code、Sponsor logo の値（空にした）
// - テスト本編スタッフチケットと、テスト懇親会のイベント（Sandbox にあるのは、テスト本編とテスト前夜祭）

/** data-sources.md の表の列。この後ろに、フォーム項目の列が並ぶ */
export const BASE_COLUMNS = [
  "Ticket type",
  "Ticket no",
  "User name",
  "Issued",
  "Order",
  "Order #",
  "Ticket id",
  "Avatar filename",
  "QR profile filename",
  "QR feedback filename",
  "Name",
  "Twitter",
  "Serial code",
  "Sponsor logo",
  "checked_in",
  "Ticket url",
] as const;

export type SyntheticAttendee = {
  ticketType: string;
  ticketNo: string;
  /** fortee のハンドル名。未発券の行は空 */
  userName: string;
  /** 発券日時（2026/11/07 16:12 の形）。未発券の行は空 */
  issued: string;
  name?: string;
  checkedIn?: boolean;
  /** フォーム項目の回答。項目名 → 値 */
  answers?: Record<string, string>;
};

export type SyntheticEvent = {
  /** カンファレンスのスラッグ */
  slug: string;
  /** トークンを作る種。イベントごとに変える */
  seed: string;
  /** フォーム項目の名前。CSV の列になる */
  formFields: readonly string[];
  attendees: readonly SyntheticAttendee[];
};

/** 合成の ZIP の中身。テストは、これを書き換えてから toZip に渡す */
export type SyntheticZipParts = {
  csvName: string;
  header: string[];
  rows: string[][];
  /** CSV のほかのエントリ。名前 → 中身 */
  files: Record<string, Uint8Array>;
};

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 種から決まる、英数字 32 文字のトークン。実行のたびに同じ値になる */
export function syntheticToken(seed: string): string {
  const hash = createHash("sha256").update(seed).digest();
  return Array.from(hash.subarray(0, 32), (byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join("");
}

export const ticketTokenOf = (event: Pick<SyntheticEvent, "seed">, ticketNo: string): string =>
  syntheticToken(`ticket:${event.seed}:${ticketNo}`);
export const profileUrlTokenOf = (event: Pick<SyntheticEvent, "seed">, ticketNo: string): string =>
  syntheticToken(`profile:${event.seed}:${ticketNo}`);

const MODULE_PX = 10;
const MARGIN_PX = 36;

/** 文字列の QR を、PNG にする。バージョン 6（41×41 モジュール）、誤り訂正 M、482×482（constraints.md 4 章） */
export function qrPng(text: string): Uint8Array {
  const qr = qrcode(6, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = count * MODULE_PX + MARGIN_PX * 2;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor((y - MARGIN_PX) / MODULE_PX);
      const col = Math.floor((x - MARGIN_PX) / MODULE_PX);
      const dark = row >= 0 && row < count && col >= 0 && col < count && qr.isDark(row, col);
      const offset = (y * size + x) * 4;
      const value = dark ? 0 : 255;
      png.data[offset] = value;
      png.data[offset + 1] = value;
      png.data[offset + 2] = value;
      png.data[offset + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

export const profileUrl = (slug: string, profileUrlToken: string): string =>
  `https://fortee.jp/${slug}/attendee/${profileUrlToken}/go-profile`;
export const ticketUrl = (slug: string, ticketToken: string): string => `https://fortee.jp/${slug}/attendee/${ticketToken}`;

/** イベントの定義から、合成の ZIP の中身を作る */
export function syntheticZipParts(event: SyntheticEvent): SyntheticZipParts {
  const files: Record<string, Uint8Array> = {};
  const rows = event.attendees.map((attendee) => {
    const ticketToken = ticketTokenOf(event, attendee.ticketNo);
    const profileUrlToken = profileUrlTokenOf(event, attendee.ticketNo);
    const qrProfile = `qr-profile-${attendee.ticketType}-${attendee.ticketNo}.png`;
    const qrFeedback = `qr-feedback-${attendee.ticketType}-${attendee.ticketNo}.png`;
    // 未発券の行も、両方のトークンと画像を持つ（data-model.md の「発券済と未発券」）
    files[`qr-profile/${qrProfile}`] = qrPng(profileUrl(event.slug, profileUrlToken));
    files[`qr-feedback/${qrFeedback}`] = qrPng(ticketUrl(event.slug, ticketToken));
    return [
      attendee.ticketType,
      attendee.ticketNo,
      attendee.userName,
      attendee.issued,
      "",
      "",
      "",
      "default-avatar.png",
      qrProfile,
      qrFeedback,
      attendee.name ?? "",
      "",
      "",
      "",
      attendee.checkedIn === true ? "true" : "false",
      ticketUrl(event.slug, ticketToken),
      ...event.formFields.map((field) => attendee.answers?.[field] ?? ""),
    ];
  });
  // 取り込みが捨てるエントリ。avatar/ は、Sandbox ではアバター未設定のため空だった（data-sources.md）
  files["avatar/"] = new Uint8Array(0);
  return { csvName: "attendees.csv", header: [...BASE_COLUMNS, ...event.formFields], rows, files };
}

const csvField = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** CSV の文字列にする。UTF-8 の BOM を先頭に付ける */
export function toCsvText(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return `\ufeff${[header, ...rows].map((row) => `${row.map(csvField).join(",")}\r\n`).join("")}`;
}

/** ZIP にする。エントリ名に ASCII でない文字があれば、fflate が UTF-8 のフラグ（汎用ビット 11）を立てる */
export function toZip(parts: SyntheticZipParts): Uint8Array {
  return zipSync({ [parts.csvName]: strToU8(toCsvText(parts.header, parts.rows)), ...parts.files }, { mtime: new Date(2026, 10, 7, 16, 12, 0) });
}

// ここから、ローカルの開発（config/local.toml）とテストで使う、合成のイベント。
// 種別名「テスト本編一般チケット」「テスト前夜祭チケット」と接頭辞 A、M、フォーム項目「お名前」「所属」「懇親会参加」は、
// 調査のときの Sandbox の値（data-sources.md、data-model.md）である。ユーザ名と回答は、作った値である。

export const SYNTHETIC_SLUG = "yapc-tokyo-2026-sandbox";

/** config/local.toml のイベント ID。合成の値で、Sandbox の本物のイベント ID ではない */
export const SYNTHETIC_EVENT_IDS = {
  main: "00000000-0000-4000-8000-000000000001",
  eve: "00000000-0000-4000-8000-000000000002",
  party: "00000000-0000-4000-8000-000000000003",
} as const;

const GENERAL = "テスト本編一般チケット";
const STAFF = "テスト本編スタッフチケット";
const EVE = "テスト前夜祭チケット";
const PARTY = "テスト懇親会チケット";

export const SYNTHETIC_EVENTS: Record<keyof typeof SYNTHETIC_EVENT_IDS, SyntheticEvent> = {
  main: {
    slug: SYNTHETIC_SLUG,
    seed: "main",
    formFields: ["お名前", "所属", "懇親会参加"],
    attendees: [
      // 同じユーザが、同じイベントのチケットを 2 枚持つ（FR-15）。前夜祭のチケットも持つ
      { ticketType: GENERAL, ticketNo: "A-1", userName: "test-alice", issued: "2026/11/07 16:12", answers: { お名前: "テスト 太郎", 所属: "テスト株式会社", 懇親会参加: "参加する" } },
      { ticketType: GENERAL, ticketNo: "A-2", userName: "test-alice", issued: "2026/11/07 16:20", answers: { お名前: "テスト 花子", 所属: "", 懇親会参加: "参加しない" } },
      // 未発券の行。取り込みで除かれる
      { ticketType: GENERAL, ticketNo: "A-3", userName: "", issued: "" },
      // fortee 側でだけ済み。懇親会のチケットも持つ
      { ticketType: GENERAL, ticketNo: "A-4", userName: "test-bob", issued: "2026/11/07 17:05", checkedIn: true, answers: { お名前: "試験 次郎", 所属: "サンプル合同会社", 懇親会参加: "参加する" } },
      // 本編、前夜祭、懇親会のチケットを 1 枚ずつ持つ
      { ticketType: GENERAL, ticketNo: "A-5", userName: "test-carol", issued: "2026/11/08 09:00", answers: { お名前: "見本 三郎", 所属: "", 懇親会参加: "参加する" } },
      // Name が入っている。回答に、カンマ、引用符、改行を含む
      { ticketType: GENERAL, ticketNo: "A-6", userName: "test-dave", issued: "2026/11/08 09:30", name: "デイブ", answers: { お名前: "例示 四郎", 所属: '"引用符" と, カンマ\nと改行の株式会社', 懇親会参加: "" } },
      { ticketType: GENERAL, ticketNo: "A-12", userName: "test-frank", issued: "2026/11/09 12:00", answers: { お名前: "ＦＲＡＮＫ\u3000全角", 所属: " 前後に空白 ", 懇親会参加: "参加しない" } },
      // スタッフ。前夜祭のチケットも持つ
      { ticketType: STAFF, ticketNo: "Z-1", userName: "test-erin", issued: "2026/11/08 10:00", answers: { お名前: "係 五郎", 所属: "実行委員会", 懇親会参加: "" } },
    ],
  },
  eve: {
    slug: SYNTHETIC_SLUG,
    seed: "eve",
    formFields: [],
    attendees: [
      { ticketType: EVE, ticketNo: "M-1", userName: "test-alice", issued: "2026/11/07 16:30" },
      { ticketType: EVE, ticketNo: "M-2", userName: "test-carol", issued: "2026/11/08 09:05" },
      { ticketType: EVE, ticketNo: "M-3", userName: "test-erin", issued: "2026/11/08 10:05" },
      // 前夜祭のチケットだけを持つ
      { ticketType: EVE, ticketNo: "M-4", userName: "test-grace", issued: "2026/11/09 08:00", name: "グレース" },
    ],
  },
  party: {
    slug: SYNTHETIC_SLUG,
    seed: "party",
    formFields: [],
    attendees: [
      { ticketType: PARTY, ticketNo: "I-1", userName: "test-carol", issued: "2026/11/08 09:10" },
      { ticketType: PARTY, ticketNo: "I-2", userName: "test-bob", issued: "2026/11/07 17:10" },
      // 懇親会のチケットだけを持つ
      { ticketType: PARTY, ticketNo: "I-3", userName: "test-heidi", issued: "2026/11/09 08:30" },
    ],
  },
};
