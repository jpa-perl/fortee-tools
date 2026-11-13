import { describe, expect, it } from "vitest";
import { type BuildEnv, deploy, type DeployDeps } from "../../src/cli/commands/deploy.ts";
import { CliError } from "../../src/cli/errors.ts";
import type { Target } from "../../src/cli/target.ts";

// deploy（Design Doc 8.1）。ビルド（vite build）とデプロイ（wrangler deploy）の実行は差し替えて、
// 止まる条件と、手順の順序と、ビルドとデプロイに渡す値を確かめる。
// 実際のビルドと、リモートへのデプロイは、このテストでは行わない。

const target: Target = { env: "yapc-tokyo-2026", local: false, configPath: "/repo/config/yapc-tokyo-2026.toml", workDir: "" };

function fake(overrides: Partial<DeployDeps> = {}) {
  const calls: string[] = [];
  const built: BuildEnv[] = [];
  const deployed: [string, string][] = [];
  const deps: DeployDeps = {
    log: () => {},
    uncommittedChanges: () => {
      calls.push("status");
      return "";
    },
    describeRelease: () => {
      calls.push("describe");
      return "v1.2.0";
    },
    assertReady: async () => {
      calls.push("ready");
    },
    build: async (env) => {
      calls.push("build");
      built.push(env);
    },
    deployWorker: async (deployTarget, release) => {
      calls.push("deploy");
      deployed.push([deployTarget.env, release]);
    },
    ...overrides,
  };
  return { deps, calls, built, deployed };
}

describe("deploy", () => {
  it("未コミットの変更、環境の印とマイグレーション、リリース名を確かめてから、その環境に向けてビルドし、デプロイする", async () => {
    const { deps, calls, built, deployed } = fake();
    await deploy(target, { allowDirty: false }, deps);
    expect(calls).toEqual(["status", "ready", "describe", "build", "deploy"]);
    // ビルドには、環境名（wrangler.jsonc の env）、その環境の設定ファイル、リリース名を渡す
    expect(built).toEqual([{ CLOUDFLARE_ENV: "yapc-tokyo-2026", CHECKIN_CONFIG: "/repo/config/yapc-tokyo-2026.toml", CHECKIN_RELEASE: "v1.2.0" }]);
    // デプロイの記録に、リリース名を残す
    expect(deployed).toEqual([["yapc-tokyo-2026", "v1.2.0"]]);
  });

  it("作業ツリーに未コミットの変更があれば、D1 と KV に触れる前に止まる", async () => {
    const { deps, calls } = fake({ uncommittedChanges: () => " M src/worker/app.ts\n?? src/app/new.tsx" });
    await expect(deploy(target, { allowDirty: false }, deps)).rejects.toThrow(/未コミットの変更があります[\s\S]*src\/worker\/app\.ts[\s\S]*src\/app\/new\.tsx/);
    expect(calls).toEqual([]);
  });

  it("--dangerously-allow-dirty を付けると、未コミットの変更があってもデプロイし、変更を知らせて、リリース名に -dirty を付ける", async () => {
    const logged: string[] = [];
    const { deps, calls, built, deployed } = fake({
      log: (line) => logged.push(line),
      uncommittedChanges: () => " M src/worker/app.ts",
    });
    await deploy(target, { allowDirty: true }, deps);
    expect(calls).toEqual(["ready", "describe", "build", "deploy"]);
    expect(logged.join("\n")).toMatch(/未コミットの変更を含めてデプロイします[\s\S]*src\/worker\/app\.ts/);
    expect(built[0]?.CHECKIN_RELEASE).toBe("v1.2.0-dirty");
    expect(deployed).toEqual([["yapc-tokyo-2026", "v1.2.0-dirty"]]);
  });

  it("--dangerously-allow-dirty を付けても、未コミットの変更がなければ、リリース名に -dirty を付けない", async () => {
    const { deps, deployed } = fake();
    await deploy(target, { allowDirty: true }, deps);
    expect(deployed).toEqual([["yapc-tokyo-2026", "v1.2.0"]]);
  });

  it("環境の印が一致しないか、マイグレーションが適用されていなければ、ビルドの前に止まる", async () => {
    const { deps, calls } = fake({
      assertReady: async () => {
        throw new CliError("D1 に適用されていないマイグレーションがあります");
      },
    });
    await expect(deploy(target, { allowDirty: false }, deps)).rejects.toThrow(/適用されていないマイグレーション/);
    expect(calls).toEqual(["status"]);
  });

  it("リリース名が求められなければ、ビルドの前に止まる", async () => {
    const { deps, calls } = fake({ describeRelease: () => null });
    await expect(deploy(target, { allowDirty: false }, deps)).rejects.toThrow(/リリース名/);
    expect(calls).toEqual(["status", "ready"]);
  });

  it("ビルドが失敗したら、デプロイしない", async () => {
    const { deps, calls } = fake({
      build: async () => {
        throw new CliError("vite build が失敗しました");
      },
    });
    await expect(deploy(target, { allowDirty: false }, deps)).rejects.toThrow(/vite build/);
    expect(calls).not.toContain("deploy");
  });

  it("ローカルの開発の環境には、デプロイしない", async () => {
    const { deps, calls } = fake();
    await expect(deploy({ ...target, env: "local", local: true }, { allowDirty: false }, deps)).rejects.toThrow(/local.*デプロイしません/);
    expect(calls).toEqual([]);
  });
});
