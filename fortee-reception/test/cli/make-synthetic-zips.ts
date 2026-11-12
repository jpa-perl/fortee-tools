import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";
import { SYNTHETIC_EVENTS, syntheticZipParts, toZip } from "./synthetic-zip.ts";

// ローカルの開発で取り込む、合成の ZIP を作る。イベントごとに 1 つ（main.zip、eve.zip、party.zip）。
// 合成の ZIP は、Sandbox からダウンロードした本物の ZIP ではない（synthetic-zip.ts の冒頭を参照）。
//
//   node test/cli/make-synthetic-zips.ts [出力先のディレクトリ]
//
// 出力先を省くと、.work/local/synthetic-zips/ に作る。config/local.toml の冒頭に、公開までの手順がある

const out = process.argv[2] === undefined ? join(PROJECT_ROOT, ".work", "local", "synthetic-zips") : resolve(process.argv[2]);
await mkdir(out, { recursive: true });
for (const [key, event] of Object.entries(SYNTHETIC_EVENTS)) {
  const path = join(out, `${key}.zip`);
  await writeFile(path, toZip(syntheticZipParts(event)));
  console.log(`${path}（import --event ${key}）`);
}
