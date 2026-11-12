import { toPublishedConfig, type ConfigBody } from "../../core/config-file.ts";
import type { Snapshot } from "../../core/snapshot.ts";
import { type Versions, versionsSchema } from "../../core/sync.ts";
import { formatOffsetIso } from "../../core/time.ts";
import { CliError } from "../errors.ts";
import { answerColumnsOf, describeEvent } from "../references.ts";
import { textParam } from "../sql.ts";
import type { Target } from "../target.ts";
import { readSnapshot } from "../workdir.ts";
import { d1Execute, kvDelete, kvList, kvPut } from "../wrangler.ts";

// publish（Design Doc 8.1、8.4、9.4、FR-44）。作業ディレクトリの全イベントのスナップショットと設定を公開する。
// 番号は Design Doc 8.4 の手順の番号である。1（設定の検証）と 2（環境の印とマイグレーションの照合）は、入口（main）が済ませる。
// KV に新しい版を書いてから、D1 の版（meta.versions の 1 行）を 1 文で切り替え、古い版のキーを消す。
// 参加者の情報は、ログに出さない。

const CONFIG_PREFIX = "config:";
const SNAPSHOT_PREFIX = "snapshot:";

export const configKey = (version: number): string => `${CONFIG_PREFIX}${version}`;
export const snapshotKey = (eventId: string, version: number): string => `${SNAPSHOT_PREFIX}${eventId}:${version}`;

/** その版が指す KV のキー */
function keysOf(versions: Versions): string[] {
  return [configKey(versions.config), ...Object.entries(versions.events).map(([eventId, version]) => snapshotKey(eventId, version))];
}

/** いまの meta.versions の値。文字列のまま返す。行がなければ null */
export async function readVersionsText(target: Target): Promise<string | null> {
  const rows = await d1Execute<{ value: string }>(target, "SELECT value FROM meta WHERE key = 'versions'");
  return rows[0]?.value ?? null;
}

/** meta.versions の値を読む。what は、誤りの文言に出す出所 */
export function parseVersions(text: string, what: string): Versions {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`${what} を JSON として読めません`);
  }
  const parsed = versionsSchema.safeParse(raw);
  if (!parsed.success) throw new CliError(`${what} が、公開の版の形ではありません`);
  return parsed.data;
}

export type PublishDeps = {
  now: () => number;
  log: (line: string) => void;
  warn: (line: string) => void;
  /** テストが、手順のあいだに割り込むためのもの。ふだんは指定しない */
  hooks?: {
    /** 7（KV への書き込み）の後、8（版の切り替え）の前 */
    beforeSwitch?: () => Promise<void>;
  };
};

export async function publish(target: Target, config: ConfigBody, deps: PublishDeps): Promise<void> {
  const { log, warn } = deps;
  const timezone = config.conference.timezone;
  const at = (version: number) => `${version}（${formatOffsetIso(version, timezone)}）`;

  // 1. 公開する JSON を作る。版は現在時刻にする
  const published = toPublishedConfig(config, deps.now());

  // 3. いまの meta.versions の値を、文字列のまま控える。行がなければ、ないことを控える。
  //    4 で作業ディレクトリの版と比べ、8 で競合を見つけ、9 で残すキーを決めるのに使う
  const previousText = await readVersionsText(target);
  const previous = previousText === null ? null : parseVersions(previousText, "D1 の meta.versions");

  // 4. 作業ディレクトリに、設定のすべてのイベントのスナップショットがあることを確かめる
  const snapshots: Snapshot[] = [];
  const absent: string[] = [];
  for (const event of config.events) {
    const snapshot = await readSnapshot(target, event.id);
    if (snapshot === null) absent.push(describeEvent(event));
    else snapshots.push(snapshot);
  }
  if (absent.length > 0) {
    throw new CliError(
      `作業ディレクトリ（${target.workDir}）に、スナップショットのないイベントがあります: ${absent.join("、")}\n` +
        "全イベントをそろえて公開します。先に import を実行してください",
    );
  }

  //    作業ディレクトリの版が、公開中の版より古いイベントがあれば止める。行がなかったときと、公開中の版にないイベントは比べない
  const eventOfSnapshot = (snapshot: Snapshot) => config.events.find((event) => event.id === snapshot.eventId);
  const describeSnapshot = (snapshot: Snapshot) => {
    const event = eventOfSnapshot(snapshot);
    return event === undefined ? snapshot.eventId : describeEvent(event);
  };
  const stale = snapshots.flatMap((snapshot) => {
    const current = previous?.events[snapshot.eventId];
    return current !== undefined && snapshot.version < current
      ? [`  ${describeSnapshot(snapshot)}: 作業ディレクトリの版 ${at(snapshot.version)}、公開中の版 ${at(current)}`]
      : [];
  });
  if (stale.length > 0) {
    throw new CliError(
      `作業ディレクトリのスナップショットの版が、公開中の版より古いイベントがあります\n${stale.join("\n")}\n` +
        "公開すると、全端末のそのイベントが古い参加者の一覧に戻ります。そのイベントを取り込み直してください",
    );
  }

  // 5. 全イベントのスナップショットを通して、ticketToken と profileUrlToken がそれぞれ一意であることを確かめる。
  //    値は出さず、重複のあるイベントと件数だけを出す
  for (const [field, label] of [
    ["ticketToken", "チケットトークン"],
    ["profileUrlToken", "profile_url_token"],
  ] as const) {
    // 値 → 最初に現れたイベント
    const firstSeen = new Map<string, string>();
    // 重複のあった場所（「A と B」か「A の中」）→ 件数
    const counts = new Map<string, number>();
    for (const snapshot of snapshots) {
      const here = describeSnapshot(snapshot);
      for (const attendee of snapshot.attendees) {
        const first = firstSeen.get(attendee[field]);
        if (first === undefined) {
          firstSeen.set(attendee[field], here);
          continue;
        }
        const where = first === here ? `${here} の中` : `${first} と ${here}`;
        counts.set(where, (counts.get(where) ?? 0) + 1);
      }
    }
    if (counts.size > 0) {
      const lines = [...counts].map(([where, count]) => `  ${where}: ${count} 件`);
      throw new CliError(
        `${label}が、スナップショットのあいだで重複しています\n${lines.join("\n")}\n` +
          "同じ ZIP を 2 つのイベントに取り込んでいないか確かめ、取り込み直してください",
      );
    }
  }

  // 6. 各スナップショットの columns が、そのイベントについて設定で参照する列と一致することを確かめる（Design Doc 9.4）
  const mismatched: string[] = [];
  for (const snapshot of snapshots) {
    const expected = answerColumnsOf(config, snapshot.eventId);
    const lacking = expected.filter((name) => !snapshot.columns.includes(name));
    const extra = snapshot.columns.filter((name) => !expected.includes(name));
    const quote = (names: string[]) => names.map((name) => `「${name}」`).join("、");
    if (lacking.length > 0) mismatched.push(`  ${describeSnapshot(snapshot)}: 設定で参照する列がスナップショットにありません: ${quote(lacking)}`);
    if (extra.length > 0) mismatched.push(`  ${describeSnapshot(snapshot)}: 設定で参照しない列をスナップショットが持っています: ${quote(extra)}`);
  }
  if (mismatched.length > 0) {
    throw new CliError(
      `スナップショットの列が、設定で参照する列と一致しないイベントがあります\n${mismatched.join("\n")}\n` +
        "参照する列を足す、変える、外すときは、そのイベントを取り込み直してから公開します",
    );
  }

  //    種別名の整合は、警告にとどめる（Design Doc 9.4）
  for (const snapshot of snapshots) {
    const groups = config.display.ticketTypes.filter((group) => group.event === snapshot.eventId);
    if (groups.length === 0) continue;
    const present = new Set(snapshot.attendees.map((attendee) => attendee.ticketType));
    const grouped = new Set(groups.flatMap((group) => group.types));
    for (const group of groups) {
      for (const type of group.types) {
        if (!present.has(type)) {
          warn(`警告: ${describeSnapshot(snapshot)} の display.ticketTypes（key "${group.key}"）の種別「${type}」は、スナップショットのどのチケットの種別とも一致しません`);
        }
      }
    }
    for (const type of present) {
      if (!grouped.has(type)) {
        warn(`警告: ${describeSnapshot(snapshot)} のスナップショットにある種別「${type}」は、display.ticketTypes のどのエントリにも含まれません`);
      }
    }
  }

  // 新しい版。設定から外したイベントは含めない
  const next: Versions = {
    config: published.version,
    events: Object.fromEntries(snapshots.map((snapshot) => [snapshot.eventId, snapshot.version])),
  };
  const nextText = JSON.stringify(next);

  // 7. KV に config:{version} と、各イベントの snapshot:{eventId}:{version} を書く。既に同じキーがあれば書かない
  const existing = new Set([...(await kvList(target, CONFIG_PREFIX)), ...(await kvList(target, SNAPSHOT_PREFIX))]);
  const writes: [key: string, value: string][] = [
    [configKey(published.version), JSON.stringify(published)],
    ...snapshots.map((snapshot): [string, string] => [snapshotKey(snapshot.eventId, snapshot.version), JSON.stringify(snapshot)]),
  ];
  for (const [key, value] of writes) {
    if (existing.has(key)) continue;
    await kvPut(target, key, value);
  }

  await deps.hooks?.beforeSwitch?.();

  // 8. meta.versions を 1 文で書き換える。3 で控えた値のままのときだけ書き換わる。
  //    3 で行がなかったときは、WHERE の比較（NULL との比較）が偽になり、ほかの公開が先に入れた行を書き換えない。
  //    書き換えたかは、RETURNING の行の有無で見る。wrangler のローカルの --json は、書き換えた行の数（changes）を返さない
  const sql =
    `INSERT INTO meta (key, value) VALUES ('versions', ${textParam(nextText)}) ` +
    "ON CONFLICT (key) DO UPDATE SET value = excluded.value " +
    `WHERE meta.value = ${previousText === null ? "NULL" : textParam(previousText)} RETURNING key`;
  const conflict = () =>
    new CliError(
      "公開の競合です。この公開が版を読んでから書くまでのあいだに、ほかの公開が版を書き換えました。" +
        "版は書き換えず、KV の掃除もしていません。いまの版を確かめて、要れば公開し直してください",
    );
  let switched: unknown[];
  try {
    switched = await d1Execute(target, sql);
  } catch (error) {
    // 結果が分からないときは、読み直して決める（Design Doc 8.8）
    const current = await readVersionsText(target).catch(() => undefined);
    if (current === undefined) throw error;
    if (current === previousText) {
      throw new CliError(`版を書き換えられませんでした。前の版のままです。publish をやり直してください\n${error instanceof Error ? error.message : ""}`);
    }
    if (current !== nextText) throw conflict();
    switched = [{}];
  }
  if (switched.length === 0) throw conflict();

  // 9. KV から、新しい版と、3 で控えた版のどちらでもない config: と snapshot: のキーを消す。環境の印には触れない
  const keep = new Set([...keysOf(next), ...(previous === null ? [] : keysOf(previous))]);
  const stored = [...(await kvList(target, CONFIG_PREFIX)), ...(await kvList(target, SNAPSHOT_PREFIX))];
  const obsolete = stored.filter((key) => !keep.has(key));
  for (const key of obsolete) await kvDelete(target, key);

  log(`公開しました（環境 ${target.env}）`);
  log(`  設定の版: ${at(published.version)}`);
  for (const snapshot of snapshots) {
    log(`  ${describeSnapshot(snapshot)}: 版 ${at(snapshot.version)}、${snapshot.attendees.length} 枚`);
  }
  log(`  KV から消した古い版のキー: ${obsolete.length} 個`);
}
