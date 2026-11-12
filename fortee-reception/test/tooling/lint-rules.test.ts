import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// 依存の方向と CSS のクラスの lint（eslint.config.js、Design Doc 3.2、6.1、6.12）が、
// 違反を実際に検出することを確かめる。規則の正規表現を変えたときに、強制が外れても気付けるようにする。
// 違反の例は、ファイルを置かずに、ファイルのパスを添えて ESLint に通す

const root = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: root });

const IMPORTS = "@typescript-eslint/no-restricted-imports";
const SYNTAX = "no-restricted-syntax";
const UNKNOWN_CLASS = "better-tailwindcss/no-unknown-classes";
const RESTRICTED_CLASS = "better-tailwindcss/no-restricted-classes";

/** 検出された規則の名前。使っていない変数の指摘は、例を短く書くために除く */
async function lint(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, path) });
  if (result === undefined) throw new Error(`${path} が lint の対象になっていない`);
  return result.messages.map((message) => message.ruleId ?? "(構文の誤り)").filter((rule) => !rule.endsWith("no-unused-vars"));
}

describe("層のあいだの依存の方向（Design Doc 3.1、3.2）", () => {
  it.each([
    ["src/core/x.ts", 'export { APP_RELEASE } from "../app/build-info.ts";'],
    ["src/core/x.ts", 'import { jsonParam } from "../cli/sql.ts";'],
    ["src/core/x.ts", 'export * from "../worker/session.ts";'],
    ["src/core/x.ts", 'import { readFileSync } from "node:fs";'],
    ["src/core/x.ts", 'import { Hono } from "hono";'],
    ["src/app/x.ts", 'import type { Env } from "../worker/env.ts";'],
    ["src/app/x.ts", 'import { jsonParam } from "../cli/sql.ts";'],
    ["src/app/x.ts", 'import { Hono } from "hono";'],
    ["src/app/x.ts", 'import { readFileSync } from "node:fs";'],
    ["src/sw/x.ts", 'import { SYNC_PROTOCOL_VERSION } from "../core/versions.ts";'],
    ["src/worker/x.ts", 'import { jsonParam } from "../cli/sql.ts";'],
    ["src/worker/x.ts", 'import { openDatabase } from "../app/storage/db.ts";'],
    ["src/worker/x.ts", 'import { readFileSync } from "node:fs";'],
    ["src/worker/x.ts", 'import { render } from "preact";'],
    ["src/cli/x.ts", 'import { signSession } from "../worker/session.ts";'],
    ["src/cli/x.ts", 'import { Hono } from "hono";'],
    ["src/cli/x.ts", 'import * as z from "zod/mini";'],
  ])("%s の %s を止める", async (path, code) => {
    expect(await lint(path, code)).toContain(IMPORTS);
  });

  it.each([
    ["src/core/x.ts", 'import * as z from "zod/mini";\nexport { uuidSchema } from "./fields.ts";\nexport const s = z.string();'],
    ["src/app/x.ts", 'import { render } from "preact";\nimport { signal } from "@preact/signals";\nimport { openDB } from "idb";\nexport { SYNC_PROTOCOL_VERSION } from "../core/versions.ts";\nexport const a = [render, signal, openDB];'],
    ["src/worker/x.ts", 'import { Hono } from "hono";\nimport { getCookie } from "hono/cookie";\nexport { syncRequestSchema } from "../core/sync.ts";\nexport const a = [Hono, getCookie];'],
    ["src/cli/x.ts", 'import { readFile } from "node:fs/promises";\nimport { parse } from "smol-toml";\nexport { conferenceSchema } from "../core/config.ts";\nexport const a = [readFile, parse];'],
  ])("%s が依存してよいものは通す", async (path, code) => {
    expect(await lint(path, code)).toEqual([]);
  });
});

describe("app の中の層（Design Doc 6.1）", () => {
  it.each([
    ["src/app/ui/x.tsx", 'import { syncRequestSchema } from "../../core/sync.ts";'],
    ["src/app/ui/x.tsx", 'import { isOfflineReady } from "../services/app-shell.ts";'],
    ["src/app/ui/x.tsx", 'import { openDatabase } from "../storage/db.ts";'],
    ["src/app/ui/x.tsx", 'import { openDB } from "idb";'],
    ["src/app/state/x.ts", 'import { isOfflineReady } from "../services/app-shell.ts";'],
    ["src/app/state/x.ts", 'import { refreshOfflineReady } from "../commands/app-shell.ts";'],
    ["src/app/commands/x.ts", 'import { App } from "../ui/App.tsx";'],
    ["src/app/services/x.ts", 'import { offlineReady } from "../state/app-shell.ts";'],
    ["src/app/services/x.ts", 'import { openDatabase } from "../storage/db.ts";'],
    ["src/app/storage/x.ts", 'import { isOfflineReady } from "../services/app-shell.ts";'],
    ["src/app/storage/x.ts", 'import { Hono } from "hono";'],
  ])("%s の %s を止める", async (path, code) => {
    expect(await lint(path, code)).toContain(IMPORTS);
  });

  it.each([
    ["src/app/ui/x.tsx", 'import type { SyncRequest } from "../../core/sync.ts";\nexport { offlineReady } from "../state/app-shell.ts";\nexport { refreshOfflineReady } from "../commands/app-shell.ts";\nexport type R = SyncRequest;'],
    ["src/app/state/x.ts", 'export { SYNC_PROTOCOL_VERSION } from "../../core/versions.ts";'],
    ["src/app/commands/x.ts", 'export { offlineReady } from "../state/app-shell.ts";\nexport { isOfflineReady } from "../services/app-shell.ts";\nexport { openDatabase } from "../storage/db.ts";\nexport { syncRequestSchema } from "../../core/sync.ts";'],
    ["src/app/storage/x.ts", 'export { openDB } from "idb";\nexport type { CheckinRecord } from "../../core/record.ts";'],
  ])("%s が依存してよいものは通す", async (path, code) => {
    expect(await lint(path, code)).toEqual([]);
  });
});

describe("型検査も lint も見ない書き方（Design Doc 3.2）", () => {
  it.each([
    ["src/app/ui/x.tsx", 'export const load = () => import("../storage/db.ts");'],
    ["src/app/ui/x.tsx", 'export const load = () => import("idb");'],
    ["src/app/x.ts", 'export const load = () => import("../worker/app.ts");'],
    ["src/core/x.ts", 'export const load = () => import("./record.ts");'],
    ["src/worker/x.ts", 'export const load = () => import("../cli/sql.ts");'],
    ["src/cli/x.ts", 'export const load = () => import("../worker/session.ts");'],
  ])("%s の動的な import を止める", async (path, code) => {
    expect(await lint(path, code)).toContain(SYNTAX);
  });

  it.each(["export const t = Date.now();", "export const t = new Date();", "export const r = Math.random();"])(
    "core の %s を止める",
    async (code) => {
      expect(await lint("src/core/x.ts", code)).toContain(SYNTAX);
    },
  );

  it("core が、渡された時刻から Date を作ることは通す", async () => {
    expect(await lint("src/core/x.ts", "export const d = (ms: number) => new Date(ms);")).toEqual([]);
  });

  it("core の外では、現在時刻を読める", async () => {
    expect(await lint("src/worker/x.ts", "export const t = () => Date.now();")).toEqual([]);
  });
});

describe("CSS のクラス（Design Doc 6.12）", () => {
  const view = (classes: string) => `export const View = () => <p class="${classes}">x</p>;`;

  it.each(["text-lg", "rounded-xl", "shadow-md", "bg-red-500"])("既定のテーマのクラス %s を検出する", async (name) => {
    expect(await lint("src/app/ui/x.tsx", view(name))).toContain(UNKNOWN_CLASS);
  });

  it.each(["text-[15px]", "bg-(--color-ok)", "rounded-full", "short:rounded-full"])(
    "体系の外の値を持ち込むクラス %s を検出する",
    async (name) => {
      expect(await lint("src/app/ui/x.tsx", view(name))).toContain(RESTRICTED_CLASS);
    },
  );

  it("トークンのクラスと、@layer components のクラスは通す", async () => {
    const classes = "flex p-4 h-12 text-3 text-ink bg-surface border-divider rounded-pressable short:p-4 safe-top";
    expect(await lint("src/app/ui/x.tsx", view(classes))).toEqual([]);
  });
});
