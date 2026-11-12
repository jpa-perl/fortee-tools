import { ja } from "zod/locales";
import * as z from "zod/mini";

/**
 * スキーマの検証の文言を日本語にする。
 *
 * zod/mini は既定の文言を持たず、設定しなければ、どの誤りも "Invalid input" になる。
 * 誤りを人が読む管理 CLI とビルドが、入口で 1 回だけ呼ぶ。
 * 受付アプリと Worker は、検証の成否と誤りの場所だけを使い、文言を使わないので呼ばない。
 * 呼ばなければ、このモジュールは受付アプリのバンドルに入らない
 */
export function configureJapaneseMessages(): void {
  z.config(ja());
}
