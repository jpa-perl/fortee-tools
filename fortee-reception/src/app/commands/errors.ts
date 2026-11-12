import { fatal } from "./runtime.ts";

/** 描画中の例外を、Preact のエラー境界から受けて、S99 に移る（Design Doc 6.10） */
export function reportRenderError(error: unknown): void {
  fatal(error);
}
