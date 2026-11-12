// ビルドが埋め込む値（build/app-shell.ts、Design Doc 6.11）

/** リリース名。同期の要求の appVersion として送る */
declare const __APP_RELEASE__: string;
/** カンファレンスの表示名。公開された設定を取得する前（S01 の「未ログイン」）にも出すために埋め込む */
declare const __CONFERENCE_NAME__: string;
