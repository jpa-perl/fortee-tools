import { Hono } from "hono";
import type { Env } from "./env.ts";
import { errorResponse, handleError } from "./errors.ts";
import { createApiRoutes } from "./routes/api.ts";
import { createAuthRoutes } from "./routes/auth.ts";

// Worker の入口（Design Doc 7 章）。/api/ と /auth/ 以下だけが、静的アセットより先にここへ届く。
// Worker は認証と、端末と DB のあいだの受け渡しだけを行い、記録と配布物の中身を解釈しない。

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.route("/api", createApiRoutes());
  app.route("/auth", createAuthRoutes());

  // 一致する静的アセットがない要求も Worker に届く（Design Doc 7.1）。知らないパスには 404 を返す
  app.notFound((c) => errorResponse(c, "not_found"));
  app.onError(handleError);

  return app;
}
