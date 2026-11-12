import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../../src/worker/env.ts";

// テストの中の `env` と `exports`（cloudflare:workers）の型。
// vitest.config.ts が渡すバインディングと、Worker のエントリの型を加える
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../../src/worker/index.ts");
    }
  }
}
