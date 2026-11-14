import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/core/template.ts";

// 参考情報テンプレートが依存している mustache.js の挙動を、名指しで確かめる（Design Doc 4.6、11 章）。
// ライブラリを上げたときに、設計が頼っている挙動が変わっていないかを見るための回帰試験である。
// Mustache の仕様の公式のテスト（mustache/spec）は使わない。上流のファイルをリポジトリに入れないためである。

const render = (template: string, context: object): string => {
  const result = renderTemplate(template, context);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result.html;
};

describe("変数（Design Doc 4.6 の表）", () => {
  it("値を文字列にして出す", () => {
    expect(render("{{a}}|{{n}}", { a: "x", n: 12 })).toBe("x|12");
  });

  it("真偽値は true / false と出す", () => {
    expect(render("{{t}}|{{f}}", { t: true, f: false })).toBe("true|false");
  });

  it("見つからない値と null は、空文字になる", () => {
    expect(render("[{{missing}}][{{nothing}}]", { nothing: null })).toBe("[][]");
  });

  it("変数の値は、既定のエスケープを通す。テンプレートの文字は、そのまま出す", () => {
    expect(render("<i>{{v}}</i>", { v: "<b>&\"'/`=</b>" })).toBe("<i>&lt;b&gt;&amp;&quot;&#39;&#x2F;&#x60;&#x3D;&lt;&#x2F;b&gt;</i>");
  });

  it("値の中の記法は、解釈しない", () => {
    expect(render("{{v}}", { v: "{{w}}", w: "x" })).toBe("{{w}}");
  });

  it("{{.}} は、いまの文脈の値そのものを出す", () => {
    expect(render("{{#list}}({{.}}){{/list}}", { list: ["a", "b"] })).toBe("(a)(b)");
  });

  it("名前は . で区切り、直前に解決した値の中を辿る", () => {
    expect(render("{{a.b.c}}", { a: { b: { c: "x" } } })).toBe("x");
  });

  it("途中の名前が欠けていれば、空文字になる", () => {
    expect(render("[{{a.b.c}}]", { a: {} })).toBe("[]");
  });
});

describe("セクション（Design Doc 4.6 の表）", () => {
  it("配列は要素ごとに繰り返し、要素を文脈に積む", () => {
    expect(render("{{#items}}{{name}},{{/items}}", { items: [{ name: "a" }, { name: "b" }] })).toBe("a,b,");
  });

  it.each([
    ["false", false],
    ["null", null],
    ["空文字", ""],
    ["0", 0],
    ["空の配列", []],
  ])("%s なら出さない", (_name, value) => {
    expect(render("[{{#v}}x{{/v}}]", { v: value })).toBe("[]");
  });

  it("見つからない値なら出さない", () => {
    expect(render("[{{#v}}x{{/v}}]", {})).toBe("[]");
  });

  it("オブジェクトは 1 回出し、その値を文脈に積む", () => {
    expect(render("{{#o}}{{name}}{{/o}}", { o: { name: "inner" }, name: "outer" })).toBe("inner");
  });

  it("空でない文字列は 1 回出し、その値を文脈に積む", () => {
    expect(render("{{#s}}({{.}}){{/s}}", { s: "L" })).toBe("(L)");
  });

  it("0 でない数は 1 回出す", () => {
    expect(render("{{#n}}x{{/n}}", { n: 3 })).toBe("x");
  });

  it("true は 1 回出すが、文脈は変えない。中の名前は外側の文脈で解決する（仕様と違う点）", () => {
    expect(render("{{#done}}{{doneAt}}{{/done}}", { done: true, doneAt: "08:30" })).toBe("08:30");
  });

  it("セクションの中から、外側の文脈の名前を引ける", () => {
    expect(render("{{#items}}{{title}}:{{name}} {{/items}}", { title: "t", items: [{ name: "a" }, { name: "b" }] })).toBe(
      "t:a t:b ",
    );
  });

  it("内側の文脈の値が、外側の同じ名前より先に引かれる", () => {
    expect(render("{{#items}}{{name}}{{/items}}", { name: "outer", items: [{ name: "inner" }] })).toBe("inner");
  });
});

describe("反転セクション（Design Doc 4.6 の表）", () => {
  it.each([
    ["false", { v: false }],
    ["null", { v: null }],
    ["空文字", { v: "" }],
    ["空の配列", { v: [] }],
    ["見つからない値", {}],
  ])("%s なら 1 回出す", (_name, context) => {
    expect(render("[{{^v}}x{{/v}}]", context)).toBe("[x]");
  });

  it("値があれば出さない", () => {
    expect(render("[{{^v}}x{{/v}}]", { v: [1] })).toBe("[]");
  });

  it("文脈は変えない", () => {
    expect(render("{{^v}}{{name}}{{/v}}", { name: "outer" })).toBe("outer");
  });
});

describe("コメントと、タグだけの行", () => {
  it("コメントは出さない", () => {
    expect(render("a{{! comment }}b", {})).toBe("ab");
  });

  it("セクション、反転セクション、コメントだけの行は、行ごと取り除く", () => {
    const template = "1\n{{#v}}\n2\n{{/v}}\n{{^w}}\n3\n{{/w}}\n  {{! c }}\n4\n";
    expect(render(template, { v: true })).toBe("1\n2\n3\n4\n");
  });

  it("変数だけの行は、取り除かない", () => {
    expect(render("1\n{{v}}\n2\n", { v: "" })).toBe("1\n\n2\n");
  });
});

describe("仕様と違う挙動（Design Doc 4.6）。文脈の作り方と名前の検証で、描画に現れないようにしている", () => {
  it("名前の探し直し: 途中まで解決して最後の名前だけが欠けると、外側の文脈で同じ名前を探し直す", () => {
    // 内側の a は b を持たないので、外側の a.b を出す。Mustache の仕様では空文字になる
    const context = { a: { b: "outer" }, inner: { a: {} } };
    expect(render("[{{#inner}}{{a.b}}{{/inner}}]", context)).toBe("[outer]");
  });

  it("内側の値が空文字でも、鍵があれば探し直さない。文脈を作る関数が、鍵の和集合を置く理由である", () => {
    const context = { a: { b: "outer" }, inner: { a: { b: "" } } };
    expect(render("[{{#inner}}{{a.b}}{{/inner}}]", context)).toBe("[]");
  });

  it("名前の中の空白を、両端を除いて名前の一部として扱う", () => {
    expect(render("{{ a b }}", { "a b": "x" })).toBe("x");
  });

  it("prototype の名前も解決する。名前の検証が止める理由である", () => {
    expect(render("{{#o}}{{toString}}{{/o}}", { o: {} })).not.toBe("");
  });

  it("関数を渡さなければ、ラムダは成立しない", () => {
    expect(render("{{#v}}x{{/v}}", { v: "text" })).toBe("x");
  });
});
