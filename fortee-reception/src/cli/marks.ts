import { CliError } from "./errors.ts";
import { jsonParam } from "./sql.ts";
import type { Target } from "./target.ts";
import { d1Execute, kvGet, kvPut, pendingMigrations } from "./wrangler.ts";

// 環境の印（Design Doc 3.6、8.1）。D1 の meta.environment と、KV のキー environment に環境名を置く。
// wrangler.jsonc の env に、別の環境の D1 か KV の ID を写し間違えたときに、書く前に止めるためのものである。
// 印を書くのは migrate だけで、ほかのコマンドは、印がひとつでもなければ止まる。

const KV_MARK_KEY = "environment";

export type Marks = {
  /** D1 の印。meta の表がまだないか、印がなければ null */
  d1: string | null;
  /** KV の印。なければ null */
  kv: string | null;
};

export async function readMarks(target: Target): Promise<Marks> {
  const hasMeta = await d1Execute(target, "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  const d1 =
    hasMeta.length === 0
      ? null
      : ((await d1Execute<{ value: string }>(target, "SELECT value FROM meta WHERE key = 'environment'"))[0]?.value ??
        null);
  return { d1, kv: await kvGet(target, KV_MARK_KEY) };
}

/** ある印が --env と違えば止める。印がないことは誤りにしない */
export function assertMarksNotMismatched(marks: Marks, target: Target): void {
  for (const [store, mark] of [
    ["D1", marks.d1],
    ["KV", marks.kv],
  ] as const) {
    if (mark !== null && mark !== target.env) {
      throw new CliError(
        `${store} の環境の印（"${mark}"）が --env（"${target.env}"）と一致しません。` +
          "wrangler.jsonc の env に、別の環境の ID を書いていないか確かめてください",
      );
    }
  }
}

/** 印のないほうへ環境名を書く。migrate だけが呼ぶ */
export async function writeMissingMarks(marks: Marks, target: Target): Promise<{ d1: boolean; kv: boolean }> {
  const written = { d1: false, kv: false };
  if (marks.d1 === null) {
    const param = jsonParam({ environment: target.env });
    await d1Execute(
      target,
      `INSERT INTO meta (key, value) VALUES ('environment', ${param} ->> '$.environment') ON CONFLICT (key) DO NOTHING`,
    );
    written.d1 = true;
  }
  if (marks.kv === null) {
    await kvPut(target, KV_MARK_KEY, target.env);
    written.kv = true;
  }
  return written;
}

/**
 * D1 と KV を読み書きするコマンド（migrate を除く）が、読み書きの前に行う照合（Design Doc 8.1）。
 * 環境の印が両方にあって --env と一致することと、CLI が持つマイグレーションがすべて適用済みであること
 */
export async function assertReady(target: Target): Promise<void> {
  const marks = await readMarks(target);
  assertMarksNotMismatched(marks, target);
  if (marks.d1 === null || marks.kv === null) {
    const missing = [marks.d1 === null ? "D1" : null, marks.kv === null ? "KV" : null].filter(Boolean).join(" と ");
    throw new CliError(`${missing} に環境の印がありません。先に migrate --env ${target.env} を実行してください`);
  }
  const pending = await pendingMigrations(target);
  if (pending.length > 0) {
    throw new CliError(
      `D1 に適用されていないマイグレーションがあります（${pending.join("、")}）。` +
        `先に migrate --env ${target.env} を実行してください`,
    );
  }
}
