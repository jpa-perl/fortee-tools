import { describe, expect, it } from "vitest";
import { describeRelease } from "../../src/cli/release.ts";

describe("リリース名（Design Doc 8.1、9.5）", () => {
  it("作業ツリーに未コミットの変更があっても、-dirty を付けない", () => {
    // git describe の --dirty は、リポジトリの全体（このパッケージの外）を見る
    const release = describeRelease();
    expect(release).not.toBeNull();
    expect(release).not.toMatch(/dirty/);
    // タグ（接頭辞を除いた v…）か、コミットの短いハッシュ
    expect(release).toMatch(/^(v[0-9][0-9A-Za-z.-]*|[0-9a-f]{7,40})$/);
  });
});
