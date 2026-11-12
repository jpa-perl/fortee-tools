// 時刻（Design Doc 4.7、画面設計書 2.9、PRD 7.3）。
//
// 内部の時刻はすべて UTC のエポックミリ秒の整数で持ち、タイムゾーンは表示と設定の解釈のときにだけ使う。
// 端末のタイムゾーン設定は使わない。タイムゾーンの解釈は Intl.DateTimeFormat だけで行う
// （core は実行環境の API を使わない）。現在時刻は呼び出し側が引数で渡す。

/** あるタイムゾーンでの暦の値。month は 1〜12 */
export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

// Intl.DateTimeFormat の生成は遅いので、タイムゾーンごとに 1 つだけ作る。結果は引数だけで決まる
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** IANA のタイムゾーン名として解釈できるか（Design Doc 4.2 の検証の表） */
export function isValidTimezone(timezone: string): boolean {
  if (timezone === "") return false;
  try {
    formatterOf(timezone);
    return true;
  } catch {
    return false;
  }
}

/** 時刻を、タイムゾーンでの暦の値にする。タイムゾーンは検証済みの値を渡す */
export function zonedParts(epochMs: number, timezone: string): ZonedParts {
  const parts: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterOf(timezone).formatToParts(epochMs)) {
    switch (part.type) {
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second":
        parts[part.type] = Number(part.value);
        break;
      default:
        break;
    }
  }
  return parts;
}

/** その時刻での、タイムゾーンの UTC からの差（ミリ秒。東が正）。名前（timeZoneName）に頼らず、暦の値との差から求める */
export function offsetMsAt(epochMs: number, timezone: string): number {
  const p = zonedParts(epochMs, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * 画面に出す時刻（画面設計書 2.9）。設定のタイムゾーンで、当日（now と同じ日付）は「08:30」、
 * それ以外の日は「11/28 08:30」にする。時と分は 2 桁にそろえ、秒は出さない。月と日は桁をそろえない。
 * 年は出さない。年をまたぐ催しでの利用は想定せず、書式を増やさない
 */
export function formatTime(epochMs: number, now: number, timezone: string): string {
  const at = zonedParts(epochMs, timezone);
  const today = zonedParts(now, timezone);
  const time = `${pad2(at.hour)}:${pad2(at.minute)}`;
  const sameDay = at.year === today.year && at.month === today.month && at.day === today.day;
  return sameDay ? time : `${at.month}/${at.day} ${time}`;
}

/**
 * 一括チェックイン CSV の日時（PRD 7.3）。設定のタイムゾーンのオフセット付き ISO 8601 で、
 * 秒まで書く（例: 2025-01-23T04:56:00+09:00）。ミリ秒は切り捨てる
 */
export function formatOffsetIso(epochMs: number, timezone: string): string {
  const p = zonedParts(epochMs, timezone);
  const offsetMinutes = Math.trunc(offsetMsAt(epochMs, timezone) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const year = String(p.year).padStart(4, "0");
  return (
    `${year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** ローカル日時の文字列の形。オフセットを持たない `YYYY-MM-DDTHH:mm:ss`（小数の秒は 3 桁まで） */
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

export type LocalDateTimeResult =
  | { ok: true; epochMs: number }
  | {
      ok: false;
      /**
       * - format: `YYYY-MM-DDTHH:mm:ss` の形でない（オフセット付きの日時、日付だけの値を含む）
       * - invalidDate: 暦にない日付か時刻（2 月 30 日、25 時など）
       * - nonexistent: 夏時間の切り替えで、そのタイムゾーンに存在しない時刻
       * - ambiguous: 夏時間の切り替えで、そのタイムゾーンに 2 回ある時刻
       */
      reason: "format" | "invalidDate" | "nonexistent" | "ambiguous";
    };

/**
 * ローカル日時の形と暦だけを確かめる。タイムゾーンを使わない。
 * 通れば、その日時を UTC とみなしたエポックミリ秒を返す
 */
function parseLocalDateTime(local: string): { ok: true; asUtc: number } | { ok: false; reason: "format" | "invalidDate" } {
  const match = LOCAL_DATE_TIME_PATTERN.exec(local);
  if (match === null) return { ok: false, reason: "format" };
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((i) => Number(match[i])) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  const asUtc = date.getTime();
  // 繰り上がり（2/30 → 3/2、24:00 → 翌日）が起きていれば、暦にない値である
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return valid ? { ok: true, asUtc } : { ok: false, reason: "invalidDate" };
}

/** ローカル日時の文字列が、形と暦のうえで正しいか。タイムゾーンは見ない */
export function checkLocalDateTime(local: string): "ok" | "format" | "invalidDate" {
  const parsed = parseLocalDateTime(local);
  return parsed.ok ? "ok" : parsed.reason;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 設定の期間のローカル日時（TOML のローカル日時を文字列にしたもの。`2026-11-27T17:30:00`）を、
 * タイムゾーンで解釈してエポックミリ秒にする（Design Doc 4.2、4.7）。タイムゾーンは検証済みの値を渡す。
 *
 * 夏時間の切り替えで存在しない時刻と、2 回ある時刻は、どちらの時刻を採るかを黙って選ばず、誤りにする
 */
export function localDateTimeToEpochMs(local: string, timezone: string): LocalDateTimeResult {
  const parsed = parseLocalDateTime(local);
  if (!parsed.ok) return parsed;
  const { asUtc } = parsed;

  // 前後 1 日の時点の差を候補にして、暦の値に戻したときに元の日時になる時刻だけを残す。
  // 差の切り替えは 1 日より短い間隔では起きないので、前後 1 日の差のどちらかが正しい差である
  const candidates = new Set<number>();
  for (const probe of [asUtc - DAY_MS, asUtc, asUtc + DAY_MS]) {
    const epochMs = asUtc - offsetMsAt(probe, timezone);
    if (epochMs + offsetMsAt(epochMs, timezone) === asUtc) candidates.add(epochMs);
  }
  if (candidates.size === 0) return { ok: false, reason: "nonexistent" };
  if (candidates.size > 1) return { ok: false, reason: "ambiguous" };
  const [epochMs] = candidates;
  return { ok: true, epochMs: epochMs as number };
}
