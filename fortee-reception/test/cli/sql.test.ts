import { describe, expect, it } from "vitest";
import { jsonParam } from "../../src/cli/sql.ts";

describe("SQL に渡す値（Design Doc 8.2）", () => {
  it("値を 16 進の BLOB リテラルにし、文に 16 進の文字しか出さない", () => {
    const sql = jsonParam({ text: "it's; \"quoted\"\n-- comment", n: 1 });
    expect(sql).toMatch(/^CAST\(x'[0-9a-f]+' AS TEXT\)$/);
  });

  it("16 進を戻すと、元の JSON になる", () => {
    const value = { text: "引用符 ' と \" と ; と改行\n、絵文字 🎫" };
    const hex = /x'([0-9a-f]+)'/.exec(jsonParam(value))?.[1] ?? "";
    expect(JSON.parse(Buffer.from(hex, "hex").toString("utf8"))).toEqual(value);
  });
});
