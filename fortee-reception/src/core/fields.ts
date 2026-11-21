import * as z from "zod/mini";

// 複数の契約（記録、同期、設定、スナップショット）で使う項目の形。
// 上限は Design Doc 7.3 と 9.3 による。文字数は JavaScript の文字列の長さで数える。

/** UUID の形。端末が crypto.randomUUID() で作る小文字の表記に限る（Design Doc 9.1） */
export const uuidSchema = z.string().check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/));

/** チケットトークン。fortee が発行する英数字 32 文字（PRD 7.1）。URL の正規表現に埋め込むための、前後の固定のない形 */
export const TICKET_TOKEN_SOURCE = "[0-9A-Za-z]{32}";
/** チケットトークンの全体に一致する正規表現。fortee の profile_url_token も同じ形である */
export const TICKET_TOKEN_PATTERN = new RegExp(`^${TICKET_TOKEN_SOURCE}$`);
export const ticketTokenSchema = z.string().check(z.regex(TICKET_TOKEN_PATTERN));

/** 受付の id と、イベントの key。英数字、`-`、`_` の 1〜32 文字（Design Doc 4.2） */
export const identifierSchema = z.string().check(z.regex(/^[0-9A-Za-z_-]{1,32}$/));

/**
 * fortee のイベント ID の形。英数字、`-`、`_` の 1〜64 文字（fortee の値は UUID）。
 * KV のキー（snapshot:{eventId}:{version}）と配布の URL に入るので、区切りになる文字を許さない（Design Doc 7.1、7.5）
 */
export const EVENT_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;
export const eventIdSchema = z.string().check(z.regex(EVENT_ID_PATTERN));

/** Date が表せる時刻の端。ECMAScript の時刻の値は、±8.64e15 ミリ秒（1970 年の前後 1 億日）の範囲にある */
export const EPOCH_MS_MAX = 8.64e15;

/**
 * 時刻。UTC のエポックミリ秒の整数で、Date が表せる範囲に限る（Design Doc 4.7）。
 * 範囲の外の値は、Intl.DateTimeFormat が RangeError で拒む。画面と書き出しは、スキーマを通った時刻を
 * 確かめ直さずに整形するので、範囲の外の時刻を持つ記録が 1 件あると、それを受け取った端末で記録の時刻を出す
 * 画面の描画と、書き出しが、例外で失敗する
 */
export const epochMsSchema = z.int().check(z.gte(-EPOCH_MS_MAX), z.lte(EPOCH_MS_MAX));

/** 操作者の ID。Discord のユーザ ID で、数字の 32 文字まで（Design Doc 7.3） */
export const operatorIdSchema = z.string().check(z.regex(/^[0-9]{1,32}$/));

/**
 * D1 に保存して読み戻すと変わる文字。対になっていないサロゲートは UTF-8 にできず、読み戻すと 1 つが
 * 3 つの U+FFFD になる（ローカルの D1 で確かめた）。u フラグの下では、対になったサロゲートは 1 文字として
 * 扱われるので、\p{Cs} は対になっていないものだけに当たる
 */
export const UNSTORABLE = /\p{Cs}/u;

/** 記録に写すユーザ名、チケット番号と、操作者の表示名の上限 */
export const NAME_MAX_LENGTH = 100;

/**
 * 記録に写すユーザ名、チケット番号と、操作者の表示名（Design Doc 4.4、7.3）。
 * 保存して読み戻すと変わる文字を通さない。読み戻した値が長くなって 100 文字を超えると、
 * その記録を受け取る全端末の同期と、書き出しが止まる
 */
export const nameSchema = z.string().check(
  z.maxLength(NAME_MAX_LENGTH),
  z.refine((text) => !UNSTORABLE.test(text), "名前に、保存できない文字がある"),
);
