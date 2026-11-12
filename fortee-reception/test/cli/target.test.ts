import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";
import { resolveTarget } from "../../src/cli/target.ts";

describe("環境の解決（Design Doc 3.6、8.1）", () => {
  it("--env から、設定ファイルと作業ディレクトリを決める", () => {
    const target = resolveTarget({ env: "yapc-tokyo-2026" });
    expect(target).toEqual({
      env: "yapc-tokyo-2026",
      local: false,
      configPath: join(PROJECT_ROOT, "config", "yapc-tokyo-2026.toml"),
      workDir: join(PROJECT_ROOT, ".work", "yapc-tokyo-2026"),
    });
  });

  it("local はローカルの開発のデータを対象にする", () => {
    expect(resolveTarget({ env: "local" }).local).toBe(true);
  });

  it("--config で設定ファイルを替えられる", () => {
    expect(resolveTarget({ env: "local", config: "/tmp/x.toml" }).configPath).toBe("/tmp/x.toml");
  });

  it("--env に既定値はない", () => {
    expect(() => resolveTarget({ env: undefined })).toThrow(/--env/);
    expect(() => resolveTarget({ env: "" })).toThrow(/--env/);
  });

  it.each(["../other", "a/b", "A", "a b", "-a", "a-", "a".repeat(56), "a;b"])("使えない環境名 %s を拒む", (env) => {
    expect(() => resolveTarget({ env })).toThrow(/環境名/);
  });
});
