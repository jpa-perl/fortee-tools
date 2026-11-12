import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigBody } from "../../src/core/config-file.ts";
import type { ServerRecord } from "../../src/core/record.ts";
import { migrate } from "../../src/cli/commands/migrate.ts";
import { importZip } from "../../src/cli/commands/import.ts";
import { restoreStatements } from "../../src/cli/commands/restore-records.ts";
import { readConfigFile } from "../../src/cli/config-file.ts";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";
import { recordToRow } from "../../src/cli/records-dump.ts";
import type { Target } from "../../src/cli/target.ts";
import { d1Execute, d1ExecuteFile } from "../../src/cli/wrangler.ts";
import { SYNTHETIC_EVENTS, type SyntheticZipParts, syntheticZipParts, toZip } from "./synthetic-zip.ts";

// cli のテストで使う補助。
// ローカルの D1 と KV の状態（wrangler の --persist-to）と、作業ディレクトリは、テストごとの一時ディレクトリに置き、
// 開発の .wrangler/state と .work/ に触れない（test/cli/migrate.test.ts と同じ分け方）。

/** wrangler の起動を何度も伴うテストの、時間の上限 */
export const TIMEOUT = 300_000;

export const silent = (): void => {};

/** ローカルの開発の設定（config/local.toml）。合成の ZIP（synthetic-zip.ts）と対になっている */
export const LOCAL_CONFIG_PATH = join(PROJECT_ROOT, "config", "local.toml");

export const loadLocalConfig = (): Promise<ConfigBody> => readConfigFile(LOCAL_CONFIG_PATH, "local");

export type TestEnvironment = {
  /** 一時ディレクトリ。persistTo と workDir を、この下に置く */
  dir: string;
  target: Target;
  cleanup: () => Promise<void>;
};

/** 一時ディレクトリに向けた、ローカルの環境。D1 と KV は空で、マイグレーションも適用していない */
export async function temporaryEnvironment(): Promise<TestEnvironment> {
  const dir = await mkdtemp(join(tmpdir(), "checkin-cli-test-"));
  const target: Target = {
    env: "local",
    local: true,
    configPath: LOCAL_CONFIG_PATH,
    workDir: join(dir, "work"),
    persistTo: join(dir, "state"),
  };
  return { dir, target, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** マイグレーションと環境の印まで済ませた、ローカルの環境 */
export async function migratedEnvironment(): Promise<TestEnvironment> {
  const environment = await temporaryEnvironment();
  await migrate(environment.target, silent);
  return environment;
}

/** マイグレーション済みの環境の状態を写した、新しい環境。migrate をやり直さずに、テストごとに分けるためのもの */
export async function cloneEnvironment(template: TestEnvironment): Promise<TestEnvironment> {
  const environment = await temporaryEnvironment();
  await cp(join(template.dir, "state"), join(environment.dir, "state"), { recursive: true });
  return environment;
}

/** 合成の ZIP をファイルに書いて、そのパスを返す */
export async function writeZip(dir: string, name: string, parts: SyntheticZipParts): Promise<string> {
  const path = join(dir, `${name}.zip`);
  await writeFile(path, toZip(parts));
  return path;
}

export const EVENT_KEYS = ["main", "eve", "party"] as const;
export type EventKey = (typeof EVENT_KEYS)[number];

/** 合成の ZIP を、作業ディレクトリに取り込む。版（取り込み日時）は now にする */
export async function importSynthetic(
  environment: TestEnvironment,
  config: ConfigBody,
  key: EventKey,
  now: number,
  change?: (parts: SyntheticZipParts) => void,
): Promise<void> {
  const parts = syntheticZipParts(SYNTHETIC_EVENTS[key]);
  change?.(parts);
  const zip = await writeZip(environment.dir, `${key}-${now}`, parts);
  await importZip(environment.target, config, { event: key, zip }, { now: () => now, log: silent, warn: silent });
}

/** テストの中で決まる UUID。n ごとに別の値 */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const DEVICE_A = "7f3c0000-0000-4000-8000-00000000000a";
export const DEVICE_B = "0a1b2000-0000-4000-8000-00000000000b";

type RecordBase = Pick<ServerRecord, "ticketToken" | "userName" | "ticketNo" | "deviceTime"> &
  Partial<Pick<ServerRecord, "deviceId" | "operatorId" | "operatorName" | "receivedAt" | "opId">> & { id: number };

const common = (input: RecordBase) => ({
  // seq は、D1 に入れたときに付く。入れる順に 1 から付くように、テストは空の表に id の順で入れる
  seq: input.id,
  recordId: uuid(input.id),
  opId: input.opId ?? uuid(0x1000 + input.id),
  ticketToken: input.ticketToken,
  userName: input.userName,
  ticketNo: input.ticketNo,
  deviceTime: input.deviceTime,
  deviceId: input.deviceId ?? DEVICE_A,
  operatorId: input.operatorId ?? "123456789012345678",
  operatorName: input.operatorName ?? "受付 一郎",
  receivedAt: input.receivedAt ?? input.deviceTime + 1000,
});

export function checkinRecord(input: RecordBase & { reception?: string; route?: "qr" | "search" }): ServerRecord {
  return {
    ...common(input),
    op: "checkin",
    reception: input.reception ?? "main",
    route: input.route ?? "qr",
    reasonKind: null,
    reasonText: null,
    targetRecordIds: null,
  };
}

export function cancelRecord(
  input: RecordBase & { targets: number[]; reception?: string | null; reasonKind?: "mistake" | "wrong_person" | "other"; reasonText?: string },
): ServerRecord {
  const reasonKind = input.reasonKind ?? "mistake";
  return {
    ...common(input),
    op: "cancel",
    reception: input.reception === undefined ? "main" : input.reception,
    route: null,
    reasonKind,
    reasonText: reasonKind === "other" ? (input.reasonText ?? "") : null,
    targetRecordIds: input.targets.map(uuid),
  };
}

/** 記録を、渡した順に D1 に入れる。Worker の同期の代わりに、テストが記録を置くためのもの */
export async function insertRecords(target: Target, records: readonly ServerRecord[]): Promise<void> {
  await d1ExecuteFile(target, restoreStatements(records.map(recordToRow)).join("\n"));
}

export type DeviceRow = {
  deviceId: string;
  clockOffsetMs: number;
  measuredAt: number;
  maxAbsOffsetMs: number;
  maxMeasuredAt: number;
  appVersion: string;
};

export async function insertDevices(target: Target, devices: readonly DeviceRow[]): Promise<void> {
  for (const device of devices) {
    await d1Execute(
      target,
      "INSERT INTO devices (device_id, clock_offset_ms, measured_at, max_abs_offset_ms, max_measured_at, app_version) " +
        `VALUES ('${device.deviceId}', ${device.clockOffsetMs}, ${device.measuredAt}, ${device.maxAbsOffsetMs}, ${device.maxMeasuredAt}, '${device.appVersion}')`,
    );
  }
}

/** config/local.toml を書き換えた設定を、一時ディレクトリに書いて読む */
export async function configVariant(dir: string, name: string, change: (toml: string) => string): Promise<ConfigBody> {
  const original = await readFile(LOCAL_CONFIG_PATH, "utf8");
  const changed = change(original);
  if (changed === original) throw new Error("書き換えが当たっていない");
  const path = join(dir, `${name}.toml`);
  await writeFile(path, changed);
  return readConfigFile(path, "local");
}
