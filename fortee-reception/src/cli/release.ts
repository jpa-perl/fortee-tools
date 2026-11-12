import { execFileSync } from "node:child_process";
import { PROJECT_ROOT } from "./paths.ts";

// リリース名（Design Doc 9.5）。受付アプリに埋め込み（6.11）、同期で送り（4.5）、デプロイの記録に残す（8.1）。
//
// このパッケージは、ほかの道具と同じリポジトリの下にある。タグはリポジトリの全体で共有されるので、
// このパッケージのリリースのタグには接頭辞を付け（fortee-reception/v1、fortee-reception/v1.2.0）、
// リリース名は、接頭辞を除いた部分（v1、v1.2.0）にする。

export const RELEASE_TAG_PREFIX = "fortee-reception/";

/**
 * git describe から求めたリリース名。タグのちょうど上なら「v1.2.0」、
 * タグから進んでいれば「v1.2.0-3-g54bfc78」、タグがなければコミットの短いハッシュ。
 * git から求められなければ null。
 *
 * --dirty は付けない。git describe の --dirty はリポジトリの全体を見るので、
 * ほかの道具の作業中の変更でも「-dirty」が付く。未コミットの変更は、
 * deploy がパッケージのディレクトリ以下に限って別に確かめる（Design Doc 8.1）
 */
export function describeRelease(): string | null {
  try {
    const described = execFileSync(
      "git",
      ["describe", "--tags", "--always", "--match", `${RELEASE_TAG_PREFIX}v*`],
      { cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return described.startsWith(RELEASE_TAG_PREFIX) ? described.slice(RELEASE_TAG_PREFIX.length) : described;
  } catch {
    return null;
  }
}
