// 版の値（Design Doc 9.5）。役割の違う値を 1 つの番号にまとめない。
//
// v1 より前（開発期間）は、どちらも 0 を使う。v1 のリリースで 1 にする（Design Doc 9.6）。
// v1 は、v1 より前に使ったどの値とも違う値にしなければならない。開発中に 0 だけを使っていれば、
// v1 の値は Design Doc の例のとおり 1 になる。開発中に互換性を壊す変更をしても、0 のまま上げない。

/** 同期プロトコルの版。同期の要求の `v`（Design Doc 4.5） */
export const SYNC_PROTOCOL_VERSION = 0;

/** 形式の版。公開する設定とスナップショットの `format`（Design Doc 4.2、4.3） */
export const DISTRIBUTION_FORMAT = 0;
