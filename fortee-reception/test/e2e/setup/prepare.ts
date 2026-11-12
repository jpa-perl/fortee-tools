import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importZip } from "../../../src/cli/commands/import.ts";
import { migrate } from "../../../src/cli/commands/migrate.ts";
import { publish } from "../../../src/cli/commands/publish.ts";
import { readConfigFile } from "../../../src/cli/config-file.ts";
import { configureJapaneseMessages } from "../../../src/core/messages.ts";
import { syntheticZipParts, toZip } from "../../cli/synthetic-zip.ts";
import { E2E_CONFIG, type E2eEnvironment, E2E_EVENTS, type EventKey } from "./data.ts";

// 画面のテスト（Playwright）のデータの準備と、公開のし直し。
//
// 開発の .wrangler/state とは別の場所を空にしてから、マイグレーションを適用し、合成の ZIP を取り込んで、
// fixtures/e2e.toml の設定と一緒に公開する。管理 CLI のコマンドを、保存先だけを替えて呼ぶ
// （test/cli/helpers.ts と同じ分け方）。毎回空から作るので、前の実行の記録は残らない

const silent = (): void => {};

/** 合成の ZIP を取り込んで、公開する。取り込み日時（データの版）は now。省くと、呼んだ時刻になる */
export async function importAndPublish(environment: E2eEnvironment, now: number = Date.now()): Promise<void> {
  const deps = { now: () => now, log: silent, warn: silent };
  configureJapaneseMessages();
  const zips = join(environment.dir, "zips");
  await mkdir(zips, { recursive: true });
  const config = await readConfigFile(E2E_CONFIG, "local");
  for (const key of Object.keys(E2E_EVENTS) as EventKey[]) {
    const zip = join(zips, `${key}.zip`);
    await writeFile(zip, toZip(syntheticZipParts(E2E_EVENTS[key])));
    await importZip(environment.target, config, { event: key, zip }, deps);
  }
  await publish(environment.target, config, deps);
}

/** 環境を空から作る。serve.ts が、サーバを起動する前に呼ぶ */
export async function prepare(environment: E2eEnvironment): Promise<void> {
  await rm(environment.dir, { recursive: true, force: true });
  await mkdir(environment.dir, { recursive: true });
  await migrate(environment.target, silent);
  await importAndPublish(environment);
  console.log(`画面のテストのデータを公開した: ${environment.dir}`);
}
