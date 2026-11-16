import { zxingQrDecoder } from "../services/qr-decoder.ts";
import { setFastCheckin } from "./modes.ts";
import { handleDecoded } from "./scan.ts";
import type { BootOptions } from "./session.ts";

// 画面のテスト（Playwright）のための入口（Design Doc 11 章）。カメラを使わずに、QR の文字列を判定に渡す。
//
// 渡した文字列は、カメラのデコードの結果と同じ経路（handleDecoded）を通る。読み取り中（S03）でなければ
// 何も起きず、形式の検証、直後の読み直しの無視、受理の 1 回限りも、カメラからの読み取りと同じに働く。
// 本番のビルドには置かない。QR の文字列の手入力は提供しない（FR-27）ためである。開発サーバと、画面のテストの
// ビルド（test/e2e/setup/serve.ts）にだけ入る。切り替えは、ビルドが埋め込む __TEST_HOOK__（build/app-shell.ts）
// で行い、本番のビルドでは、この関数の呼び出しごと出力から落ちる。
// カメラの許可待ちと、拒否された状態でも受け付ける（WebKit のテストでは、カメラを開始できない）。
//
// 高速受付の切り替えも置く。確認のダイアログ（S09-D2）を通さずに、設定を書く。高速受付の既定はオフで、オフでは
// 読み取りのたびに確認（S03-D1）が挟まるので、確認を確かめないテストが、ログインの後にオンにする。

export type TestHook = {
  /** QR の文字列を、いまデコードしたものとして渡す。例: `fortee:` に英数字 32 文字 */
  scan(text: string): void;
  /**
   * 高速受付を、確認のダイアログ（S09-D2）を通さずに切り替える。高速受付の既定はオフで、オフでは読み取りのたびに
   * 確認（S03-D1）が挟まる。確認を確かめないテストが、準備でオンにする
   */
  setFastCheckin(enabled: boolean): Promise<void>;
  /**
   * 画像を、カメラの読み取りと同じデコーダ（services/qr-decoder.ts）に渡す。scan() はデコーダを通らないので、
   * WASM の読み込みとデコードは、これで確かめる。判定には進まない
   */
  decode(image: ImageData): Promise<string | null>;
};

declare global {
  interface Window {
    __checkinTest?: TestHook;
  }
}

/**
 * 画面のテストが、データベースの版を上げた受付アプリの起動を起こすための値（Design Doc 6.3、11 章）。
 * localStorage のこのキーに数を置くと、その版で IndexedDB を開く。版を上げたビルドを別に配る代わりである
 */
const DATABASE_VERSION_KEY = "__checkinTest:databaseVersion";

/** 起動に渡す値。main.tsx が、テスト用の入口を入れるビルドでだけ呼ぶ */
export function testBootOptions(): BootOptions {
  try {
    const version = Number(localStorage.getItem(DATABASE_VERSION_KEY));
    return Number.isInteger(version) && version > 0 ? { databaseVersion: version } : {};
  } catch {
    return {};
  }
}

/** main.tsx が、起動のときに 1 回だけ呼ぶ */
export function installTestHook(): void {
  window.__checkinTest = { scan: handleDecoded, setFastCheckin, decode: zxingQrDecoder };
}
