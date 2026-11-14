import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfigBody } from "../../src/core/config-file.ts";
import { preview, type PreviewOptions } from "../../src/cli/commands/preview.ts";
import { readSnapshot, writeSnapshot } from "../../src/cli/workdir.ts";
import { importSynthetic, loadLocalConfig, temporaryEnvironment, type TestEnvironment } from "./helpers.ts";
import { SYNTHETIC_EVENT_IDS, SYNTHETIC_EVENTS, ticketTokenOf } from "./synthetic-zip.ts";

// preview（Design Doc 8.7、FR-46）。作業ディレクトリのスナップショット（合成の ZIP から取り込んだもの）と、
// ローカルの開発の設定（config/local.toml）のテンプレートで確かめる。D1 と KV には触れない。

// 2026-11-12 12:34（Asia/Tokyo）
const NOW = Date.UTC(2026, 10, 12, 3, 34, 0);

let environment: TestEnvironment;
let config: ConfigBody;

beforeAll(async () => {
  config = await loadLocalConfig();
  environment = await temporaryEnvironment();
  await importSynthetic(environment, config, "main", NOW - 3);
  await importSynthetic(environment, config, "eve", NOW - 2);
});
afterAll(() => environment.cleanup());

async function run(options: PreviewOptions, useConfig: ConfigBody = config): Promise<{ text: string; warnings: string[] }> {
  let text = "";
  const warnings: string[] = [];
  await preview(environment.target, useConfig, options, { now: () => NOW, out: (rendered) => (text += rendered), warn: (line) => warnings.push(line) });
  // config/local.toml のテンプレートは、行の終わりに <br> を書く。期待値を読みやすくするために、除いて比べる
  return { text: text.replaceAll("<br>\n", "\n"), warnings };
}

describe("preview", () => {
  it("参加者を指定して、テンプレートを描画する。そのユーザのほかのイベントのチケットも文脈に入る", async () => {
    const { text, warnings } = await run({ event: "main", ticket: "A-1" });
    expect(text).toBe(
      [
        "test-alice さん",
        "本編 A-1 テスト本編一般チケット",
        "  ネームカード: 一般",
        "  所属: テスト株式会社",
        "  懇親会: 参加する",
        "本編 A-2 テスト本編一般チケット",
        "  ネームカード: 一般",
        "  懇親会: 参加しない",
        "前夜祭 M-1",
        "",
      ].join("\n"),
    );
    // 取り込んでいないイベント（懇親会）があることを、警告に出す
    expect(warnings).toEqual([expect.stringContaining("テスト懇親会（party） のスナップショットが作業ディレクトリにない")]);
  });

  it("--reception で現在の受付を、--done で済みにするチケットを指定する", async () => {
    const { text } = await run({ event: "eve", ticket: "M-1", reception: "eve", done: ["main:A-2", "eve:M-1"] });
    expect(text).toBe(
      [
        "test-alice さん",
        "受付: 前夜祭受付",
        "本編 A-1 テスト本編一般チケット",
        "  ネームカード: 一般",
        "  所属: テスト株式会社",
        "  懇親会: 参加する",
        // doneAt は実行した時刻、doneReception は --reception の受付の表示名
        "本編 A-2 テスト本編一般チケット（済 12:34 前夜祭受付）",
        "  ネームカード: 一般",
        "  懇親会: 参加しない",
        "前夜祭 M-1（済 12:34）",
        "",
      ].join("\n"),
    );
  });

  it("--reception を省くと、受付なしの文脈で描画し、済みにした受付の表示名は空文字になる", async () => {
    const { text } = await run({ event: "main", ticket: "Z-1", done: ["00000000-0000-4000-8000-000000000001:Z-1"] });
    expect(text).toBe(
      ["test-erin さん", "本編 Z-1 テスト本編スタッフチケット（済 12:34 ）", "  ネームカード: スタッフ。スタッフ控室へ案内", "  所属: 実行委員会", "前夜祭 M-3", ""].join(
        "\n",
      ),
    );
  });

  it("テンプレートに書いたタグは、そのまま出す", async () => {
    let raw = "";
    await preview(environment.target, config, { event: "eve", ticket: "M-4" }, { now: () => NOW, out: (rendered) => (raw += rendered), warn: () => {} });
    expect(raw).toBe("test-grace さん（グレース）<br>\n本編チケットなし<br>\n前夜祭 M-4<br>\n");
  });

  it("描画の結果は HTML で、値はエスケープして出す", async () => {
    const { text } = await run({ event: "main", ticket: "A-6" });
    expect(text).toContain('test-dave さん（デイブ）\n');
    expect(text).toContain("  所属: &quot;引用符&quot; と, カンマ\nと改行の株式会社\n");
  });

  it("本編のチケットを持たない参加者", async () => {
    const { text } = await run({ event: "eve", ticket: "M-4" });
    expect(text).toBe("test-grace さん（グレース）\n本編チケットなし\n前夜祭 M-4\n");
  });

  it("チケットトークンでも参加者を指定できる。チケット番号が重複した参加者は、トークンで指定する", async () => {
    const main = SYNTHETIC_EVENTS.main;
    const byNo = await run({ event: "main", ticket: "A-1" });
    expect((await run({ event: "main", ticketToken: ticketTokenOf(main, "A-1") })).text).toBe(byNo.text);

    // fortee の採番が、A-4 を 2 人に付けた（Design Doc 8.3）
    const duplicated = await temporaryEnvironment();
    try {
      const snapshot = await readSnapshot(environment.target, SYNTHETIC_EVENT_IDS.main);
      if (snapshot === null) throw new Error("本編のスナップショットがない");
      const a5 = ticketTokenOf(main, "A-5");
      await writeSnapshot(duplicated.target, {
        ...snapshot,
        attendees: snapshot.attendees.map((attendee) => (attendee.ticketToken === a5 ? { ...attendee, ticketNo: "A-4" } : attendee)),
      });
      const render = (options: PreviewOptions) => {
        let text = "";
        return preview(duplicated.target, config, options, { now: () => NOW, out: (rendered) => (text += rendered), warn: () => {} }).then(() => text);
      };
      await expect(render({ event: "main", ticket: "A-4" })).rejects.toThrow(/2 枚あります。--ticket-token/);
      const first = await render({ event: "main", ticketToken: ticketTokenOf(main, "A-4") });
      const second = await render({ event: "main", ticketToken: a5 });
      expect(first).not.toBe(second);
    } finally {
      await duplicated.cleanup();
    }
  });

  it.each<[string, PreviewOptions, RegExp]>([
    ["チケットの指定がない", { event: "main" }, /--ticket <チケット番号> か --ticket-token <チケットトークン> の、どちらか一方/],
    ["チケットの指定が 2 つある", { event: "main", ticket: "A-1", ticketToken: "a".repeat(32) }, /どちらか一方/],
    ["トークンの形", { event: "main", ticketToken: "short" }, /--ticket-token は、英数字 32 文字/],
    ["スナップショットにないトークン", { event: "main", ticketToken: "0".repeat(32) }, /--ticket-token のチケットは、テスト本編（main） のスナップショットにありません/],
    ["スナップショットにないチケット番号", { event: "main", ticket: "A-99" }, /--ticket の "A-99" は、テスト本編（main） のスナップショットにありません/],
    ["未発券の行は取り込まれていない", { event: "main", ticket: "A-3" }, /スナップショットにありません/],
    ["チケット番号は、イベントの中で引く", { event: "eve", ticket: "A-1" }, /スナップショットにありません/],
    ["設定にないイベント", { event: "nursery", ticket: "A-1" }, /--event の "nursery"/],
    ["取り込んでいないイベント", { event: "party", ticket: "I-1" }, /テスト懇親会（party） のスナップショットが、作業ディレクトリにありません/],
    ["設定にない受付", { event: "main", ticket: "A-1", reception: "lunch" }, /--reception の "lunch" は、設定の受付の id ではありません/],
    ["--done の形", { event: "main", ticket: "A-1", done: ["A-1"] }, /--done の "A-1" は、<イベントの key か id>:<チケット番号> の形/],
    ["--done のイベントが設定にない", { event: "main", ticket: "A-1", done: ["nursery:E-1"] }, /--done の "nursery"/],
    ["--done のチケットが、その参加者のものでない", { event: "main", ticket: "A-1", done: ["main:A-4"] }, /この参加者のチケットではありません/],
  ])("止まる: %s", async (_name, options, message) => {
    await expect(run(options)).rejects.toThrow(message);
  });
});
