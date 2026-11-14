import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TICKET_TOKEN_PATTERN } from "../core/fields.ts";
import { type Snapshot, snapshotSchema } from "../core/snapshot.ts";
import { CliError } from "./errors.ts";
import type { Target } from "./target.ts";

// 作業ディレクトリ（Design Doc 3.4、8.1）。取り込みの出力を .work/<環境名>/snapshots/{eventId}.json に置く。
// 参加者の情報を含むので、コミットしない。公開と preview は、ここから読む。

export function snapshotPath(target: Pick<Target, "workDir">, eventId: string): string {
  return join(target.workDir, "snapshots", `${eventId}.json`);
}

/**
 * スナップショットを置く。一時ファイルに書いてから名前を変える。
 * 途中で止まっても、前のスナップショットが残るようにするためである（Design Doc 8.3 の 4）
 */
export async function writeSnapshot(target: Pick<Target, "workDir">, snapshot: Snapshot): Promise<string> {
  const path = snapshotPath(target, snapshot.eventId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, path);
  return path;
}

/** 文字列を、スナップショットとして読む。what は、誤りの文言に出す出所（ファイルのパスや KV の鍵） */
export function parseSnapshot(text: string, eventId: string, what: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`${what} を JSON として読めません`);
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    // 値は出さない。場所だけを出す
    const where = parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".")).join("、");
    throw new CliError(`${what} が、この版の CLI が読めるスナップショットの形ではありません（${where}）。取り込み直してください`);
  }
  if (parsed.data.eventId !== eventId) {
    throw new CliError(`${what} の eventId（${parsed.data.eventId}）が、イベント ${eventId} と一致しません`);
  }
  return parsed.data;
}

/** 作業ディレクトリのスナップショットを読む。まだ取り込んでいなければ null */
export async function readSnapshot(target: Pick<Target, "workDir">, eventId: string): Promise<Snapshot | null> {
  const path = snapshotPath(target, eventId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(`スナップショット ${path} を読めません`);
  }
  return parseSnapshot(text, eventId, `スナップショット ${path}`);
}

/**
 * profile_url_token の補正ファイル（Design Doc 8.3）。プロフィール QR の画像を複数の行が共有するイベントについて、
 * 管理者が .work/<環境名>/profile-url-tokens/{eventId}.json に、チケットトークン → profile_url_token の対応を書く。
 * トークンを含むので、スナップショットと同じく、コミットしない
 */
export function profileUrlTokensPath(target: Pick<Target, "workDir">, eventId: string): string {
  return join(target.workDir, "profile-url-tokens", `${eventId}.json`);
}

/** 補正ファイルを読む。なければ、空の対応 */
export async function readProfileUrlTokens(target: Pick<Target, "workDir">, eventId: string): Promise<Map<string, string>> {
  const path = profileUrlTokensPath(target, eventId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new CliError(`補正ファイル ${path} を読めません`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`補正ファイル ${path} を JSON として読めません`);
  }
  // 値は出さない。形だけを確かめる
  const entries = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Object.entries(raw) : null;
  if (entries === null || !entries.every(([key, value]) => TICKET_TOKEN_PATTERN.test(key) && typeof value === "string" && TICKET_TOKEN_PATTERN.test(value))) {
    throw new CliError(
      `補正ファイル ${path} が、チケットトークン（英数字 32 文字）を鍵、profile_url_token（英数字 32 文字）を値とする JSON のオブジェクトではありません`,
    );
  }
  return new Map(entries as [string, string][]);
}
