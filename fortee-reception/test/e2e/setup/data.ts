import { join } from "node:path";
import { PROJECT_ROOT } from "../../../src/cli/paths.ts";
import type { Target } from "../../../src/cli/target.ts";
import {
  SYNTHETIC_EVENT_IDS,
  SYNTHETIC_EVENTS,
  SYNTHETIC_SLUG,
  type SyntheticEvent,
  ticketTokenOf,
} from "../../cli/synthetic-zip.ts";

// 画面のテスト（Playwright）のデータ。準備（prepare.ts）と、テストの両方が読む。
// 参加者は test/cli/synthetic-zip.ts の合成のイベントで、対象外（FR-10）のための託児所だけを足している。

/**
 * 画面のテストの環境。ローカルの D1 と KV、作業ディレクトリを、環境ごとに別の場所に置く。
 * 開発の .wrangler/state と .work/ には触れない。環境は 2 つある。
 *
 * - main: ふつうの spec が共有する。記録をサーバに送らないので、どのテストも、公開した直後の状態を見る
 * - sync: サーバへの同期を通す spec（sync.spec.ts）だけが使う。記録を送り、公開し直すので、ほかと分ける
 */
export type E2eEnvironment = { name: "main" | "sync"; port: number; dir: string; target: Target };

const environment = (name: E2eEnvironment["name"], port: number): E2eEnvironment => {
  const dir = join(PROJECT_ROOT, ".wrangler", name === "main" ? "e2e" : `e2e-${name}`);
  return {
    name,
    port,
    dir,
    target: { env: "local", local: true, configPath: E2E_CONFIG, workDir: join(dir, "work"), persistTo: join(dir, "state") },
  };
};

export const E2E_CONFIG = join(PROJECT_ROOT, "test", "e2e", "fixtures", "e2e.toml");
export const E2E_ENVIRONMENTS = { main: environment("main", 4173), sync: environment("sync", 4174) } as const;

/**
 * 画面のテストのサーバに渡すセッションの秘密。開発の .dev.vars の値は使わない。
 * ローカルの模擬環境にしか効かない値で、秘密ではない
 */
export const E2E_SESSION_SECRET = "e2e-session-secret-not-a-real-secret";

/** どの受付も受け付けないイベント（fixtures/e2e.toml） */
const NURSERY: SyntheticEvent = {
  slug: SYNTHETIC_SLUG,
  seed: "nursery",
  formFields: [],
  attendees: [{ ticketType: "テスト託児所チケット", ticketNo: "K-1", userName: "test-ivan", issued: "2026/11/09 09:00" }],
};

export const E2E_EVENTS = { ...SYNTHETIC_EVENTS, nursery: NURSERY } as const;
export const E2E_EVENT_IDS = { ...SYNTHETIC_EVENT_IDS, nursery: "00000000-0000-4000-8000-000000000004" } as const;

export type EventKey = keyof typeof E2E_EVENTS;

/** チケット QR の文字列（FR-11）。例: qr("main", "A-5") */
export const qr = (event: EventKey, ticketNo: string): string => `fortee:${ticketTokenOf(E2E_EVENTS[event], ticketNo)}`;
