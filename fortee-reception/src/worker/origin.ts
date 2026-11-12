import { createMiddleware } from "hono/factory";
import { errorResponse } from "./errors.ts";

// 同じオリジンからの要求だけを通す（Design Doc 7.1、9.3）。
//
// セッションの Cookie の SameSite=Lax は、ほかのサイトからの POST には付かないが、
// 同じサイトの別のホスト（workers.dev の同じアカウントのほかの Worker）からの要求には付く。
// Cookie の __Host- 接頭辞が防ぐのは Cookie を置かれることで、Cookie の付いた要求を送られることではない。
//
// Sec-Fetch-Site と Origin は、ブラウザが付けるヘッダで、ページのスクリプトからは書き換えられない。
// どちらも付いていない要求（ブラウザでないクライアント）は通す。CSRF は、ブラウザを介した攻撃である。

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export const requireSameOrigin = createMiddleware(async (c, next) => {
  const site = c.req.header("Sec-Fetch-Site");
  if (site !== undefined) {
    // none は、アドレスバーへの入力など、利用者が直接開いた要求。状態を変えない要求に限って通す
    const allowed = site === "same-origin" || (site === "none" && SAFE_METHODS.has(c.req.method));
    if (!allowed) return errorResponse(c, "forbidden");
  } else {
    const origin = c.req.header("Origin");
    if (origin !== undefined && origin !== new URL(c.req.url).origin) return errorResponse(c, "forbidden");
  }
  await next();
});

/**
 * 本文を受ける要求（GET と HEAD のほか）に、Content-Type: application/json を求める。
 * 本文を JSON として解析するだけでは、フォームから text/plain で送った JSON も通る
 */
export const requireJsonBody = createMiddleware(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const mediaType = (c.req.header("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return errorResponse(c, "bad_request");
  }
  await next();
});
