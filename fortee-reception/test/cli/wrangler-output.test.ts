import { describe, expect, it } from "vitest";
import { parseJsonOutput } from "../../src/cli/wrangler.ts";

describe("wrangler の標準出力からの JSON の取り出し（Design Doc 8.2）", () => {
  const json = JSON.stringify([{ results: [{ name: "[a]" }], success: true }], null, 2);

  it("JSON だけの出力を読む", () => {
    expect(parseJsonOutput(json, "d1 execute")).toEqual([{ results: [{ name: "[a]" }], success: true }]);
  });

  it("JSON の前の知らせに「[」があっても読む", () => {
    const stdout = `[WARNING] 知らせ\n ⛅️ wrangler [1.2.3]\n[wrangler:info] 知らせ\n${json}\n`;
    expect(parseJsonOutput(stdout, "d1 execute")).toEqual([{ results: [{ name: "[a]" }], success: true }]);
  });

  it("JSON がなければ止まる", () => {
    expect(() => parseJsonOutput("[WARNING] 知らせ\n", "kv key list")).toThrow(/JSON として読めません/);
    expect(() => parseJsonOutput("", "kv key list")).toThrow(/JSON として読めません/);
  });
});
