import * as z from "zod/mini";

// 複数の契約（記録、同期、設定、スナップショット）で使う項目の形。
// 上限は Design Doc 7.3 と 9.3 による。文字数は JavaScript の文字列の長さで数える。

/** UUID の形。端末が crypto.randomUUID() で作る小文字の表記に限る（Design Doc 9.1） */
export const uuidSchema = z.string().check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/));

/** チケットトークン。fortee が発行する英数字 32 文字（PRD 7.1） */
export const ticketTokenSchema = z.string().check(z.regex(/^[0-9A-Za-z]{32}$/));

/** 受付の id と、イベントの key。英数字、`-`、`_` の 1〜32 文字（Design Doc 4.2） */
export const identifierSchema = z.string().check(z.regex(/^[0-9A-Za-z_-]{1,32}$/));

/**
 * fortee のイベント ID の形。英数字、`-`、`_` の 1〜64 文字（fortee の値は UUID）。
 * KV のキー（snapshot:{eventId}:{version}）と配布の URL に入るので、区切りになる文字を許さない（Design Doc 7.1、7.5）
 */
export const EVENT_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;
export const eventIdSchema = z.string().check(z.regex(EVENT_ID_PATTERN));

/** 時刻。UTC のエポックミリ秒の整数（Design Doc 4.7） */
export const epochMsSchema = z.int();

/** 操作者の ID。Discord のユーザ ID で、数字の 32 文字まで（Design Doc 7.3） */
export const operatorIdSchema = z.string().check(z.regex(/^[0-9]{1,32}$/));

/** 記録に写すユーザ名、チケット番号と、操作者の表示名の上限 */
export const NAME_MAX_LENGTH = 100;
