import { describe, expect, it } from "vitest";
import { conferenceSchema } from "../../src/core/config.ts";
import { configureJapaneseMessages } from "../../src/core/messages.ts";

const messages = (value: unknown) => conferenceSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];

describe("検証の文言", () => {
  it("設定しなければ、zod/mini はどの誤りにも同じ文言を返す", () => {
    expect(new Set(messages({ slug: "", name: 1 }))).toEqual(new Set(["Invalid input"]));
  });

  it("設定すると、誤りごとの日本語の文言になる", () => {
    configureJapaneseMessages();
    const [slug, name] = messages({ slug: "", name: 1, timezone: "Asia/Tokyo", environment: "local" });
    expect(slug).toContain("1文字以上");
    expect(name).toContain("string");
    expect(name).not.toBe(slug);
  });
});
