import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { toCsv } from "../../src/cli/csv.ts";

describe("書き出しの CSV", () => {
  it("カンマ、引用符、改行を含む値を引用符で囲み、ほかの値はそのまま出す", () => {
    const rows = [
      ["plain", "カンマ, を含む", '引用符 " を含む'],
      ["改行\nを含む", "\r", ""],
      ["=1+1", " 前後の空白 ", ";"],
    ];
    const csv = toCsv(["a", "b", "c"], rows, "machine");
    expect(csv.startsWith("a,b,c\nplain,")).toBe(true);
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv).not.toContain("\ufeff");
    // 読み戻すと、元の値になる
    expect(parse(csv)).toEqual([["a", "b", "c"], ...rows]);
  });

  it("行がなければ、ヘッダだけを出す", () => {
    expect(toCsv(["profile_url_token", "checkined_at"], [], "machine")).toBe("profile_url_token,checkined_at\n");
  });

  it("確認用 CSV では数式を文字列にし、通常の値と負の数値は保つ", () => {
    const unsafe = ["=1+1", "+1+2", "-1+2", "@SUM(1)", "  =1+1", "\t=1+1", "\r=1+1", "\n=1+1", "\ufeff=1+1", "\u200b=1+1", "　=1+1", "＝1+1", "=1,2\";=3"];
    const ordinary = ["plain", " 前後の空白 ", "-900", "引用符 \" と改行\nを含む", ""];
    const rows = [...unsafe, ...ordinary].map((value) => [value]);
    const csv = toCsv(["value"], rows, "spreadsheet");
    expect(parse(csv)).toEqual([["value"], ...unsafe.map((value) => [`\t${value}`]), ...ordinary.map((value) => [value])]);
    expect(csv).toContain('"\t=1+1"');
    expect(csv).toContain('"\t=1,2"";=3"');
    expect(toCsv(["value"], rows, "machine")).not.toContain('"\t=1+1"');
  });
});
