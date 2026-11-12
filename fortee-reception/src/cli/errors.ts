/** 利用者に知らせて止まる誤り。main がメッセージだけを出して、終了コード 1 で終わる */
export class CliError extends Error {
  override name = "CliError";
}
