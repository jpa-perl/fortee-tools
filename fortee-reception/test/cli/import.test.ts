import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "csv-parse/sync";
import { strToU8, unzipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConfigBody } from "../../src/core/config-file.ts";
import { snapshotSchema } from "../../src/core/snapshot.ts";
import { importZip } from "../../src/cli/commands/import.ts";
import { importForteeZip, type ImportResult, ticketNoPrefix } from "../../src/cli/fortee-zip.ts";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";
import { answerColumnsOf } from "../../src/cli/references.ts";
import { profileUrlTokensPath, readSnapshot, snapshotPath } from "../../src/cli/workdir.ts";
import { loadLocalConfig, silent, temporaryEnvironment, type TestEnvironment, writeZip } from "./helpers.ts";
import {
  profileUrl,
  profileUrlTokenOf,
  qrPng,
  SYNTHETIC_EVENT_IDS,
  SYNTHETIC_EVENTS,
  SYNTHETIC_SLUG,
  type SyntheticZipParts,
  syntheticZipParts,
  ticketTokenOf,
  toCsvText,
  toZip,
} from "./synthetic-zip.ts";

// 取り込み（Design Doc 8.3、FR-43）。
//
// フィクスチャの ZIP は、テストのコード（synthetic-zip.ts）が合成したものである。fortee の Sandbox から
// ダウンロードした本物の ZIP ではない。リポジトリに Sandbox の ZIP はなく、形は docs/research/fortee/ の記述による。
// 本物の ZIP で確かめていないこと（CSV のファイル名とエントリの階層、fflate が本物の ZIP のエントリ名を読めること）は、
// このテストでは確かめられない。

const GOLDEN = join(PROJECT_ROOT, "test", "cli", "golden");
const NOW = Date.UTC(2026, 10, 12, 3, 0, 0);
const MAIN = SYNTHETIC_EVENTS.main;
const MAIN_COLUMNS = ["お名前", "所属", "懇親会参加"];

let config: ConfigBody;
beforeAll(async () => {
  config = await loadLocalConfig();
});

/** 本編の合成の ZIP を書き換えて、取り込む */
function importMain(
  change?: (parts: SyntheticZipParts) => void,
  answerColumns: readonly string[] = MAIN_COLUMNS,
  profileUrlTokens?: ReadonlyMap<string, string>,
): ImportResult {
  const parts = syntheticZipParts(MAIN);
  change?.(parts);
  return importForteeZip({
    zip: toZip(parts),
    slug: SYNTHETIC_SLUG,
    eventId: SYNTHETIC_EVENT_IDS.main,
    answerColumns,
    now: NOW,
    ...(profileUrlTokens === undefined ? {} : { profileUrlTokens }),
  });
}

const errorsOf = (result: ImportResult): string[] => (result.ok ? [] : result.errors);

/** 列の位置 */
const col = (parts: SyntheticZipParts, name: string): number => parts.header.indexOf(name);
/** チケット番号の行。CSV の行の番号は、ヘッダを 1 行目として、この番号 + 2 */
const rowOf = (parts: SyntheticZipParts, ticketNo: string): string[] => {
  const row = parts.rows.find((candidate) => candidate[col(parts, "Ticket no")] === ticketNo);
  if (row === undefined) throw new Error(`フィクスチャに ${ticketNo} がない`);
  return row;
};
const set = (parts: SyntheticZipParts, ticketNo: string, column: string, value: string): void => {
  rowOf(parts, ticketNo)[col(parts, column)] = value;
};

describe("取り込み: 合成の ZIP からスナップショットを作る", () => {
  it("本編のスナップショットが、ゴールデンファイルと一致する", async () => {
    const result = importMain();
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(snapshotSchema.safeParse(result.snapshot).success).toBe(true);
    await expect(`${JSON.stringify(result.snapshot, null, 2)}\n`).toMatchFileSnapshot(join(GOLDEN, "import-main.snapshot.json"));
  });

  it("CSV の値を、上書き、切り詰め、補正せずにそのまま持つ", () => {
    const result = importMain();
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const byNo = new Map(result.snapshot.attendees.map((attendee) => [attendee.ticketNo, attendee]));
    // カンマ、引用符、改行を含む値、前後の空白、全角の文字
    expect(byNo.get("A-6")?.answers["所属"]).toBe('"引用符" と, カンマ\nと改行の株式会社');
    expect(byNo.get("A-12")?.answers).toEqual({ お名前: "ＦＲＡＮＫ\u3000全角", 所属: " 前後に空白 ", 懇親会参加: "参加しない" });
    expect(byNo.get("A-6")?.name).toBe("デイブ");
    expect(byNo.get("A-1")?.name).toBe("");
    expect(byNo.get("A-4")?.forteeCheckedIn).toBe(true);
    // チケットトークンは Ticket url から、profile_url_token は qr-profile/ の画像のデコードから得る
    expect(byNo.get("A-1")?.ticketToken).toBe(ticketTokenOf(MAIN, "A-1"));
    expect(byNo.get("A-1")?.profileUrlToken).toBe(profileUrlTokenOf(MAIN, "A-1"));
    expect(byNo.get("A-1")?.profileUrlToken).not.toBe(byNo.get("A-1")?.ticketToken);
  });

  it("未発券の行（User name と Issued が空）を取り込まず、件数を警告に出す", () => {
    const result = importMain();
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.snapshot.attendees.map((attendee) => attendee.ticketNo)).not.toContain("A-3");
    expect(result.summary).toEqual({
      imported: 7,
      unissued: 1,
      ticketTypes: [
        { ticketType: "テスト本編一般チケット", count: 6, prefixes: ["A"] },
        { ticketType: "テスト本編スタッフチケット", count: 1, prefixes: ["Z"] },
      ],
    });
    expect(result.warnings).toEqual([expect.stringContaining("未発券の行（「User name」と「Issued」が空）を 1 行")]);
  });

  it("設定で参照する列だけを answers と columns に持つ。ほかのイベントの項目は検証しない", () => {
    const some = importMain(undefined, ["所属"]);
    if (!some.ok) throw new Error(some.errors.join("\n"));
    expect(some.snapshot.columns).toEqual(["所属"]);
    expect(some.snapshot.attendees.every((attendee) => Object.keys(attendee.answers).join() === "所属")).toBe(true);

    // 参照する列のないイベント（前夜祭）は、フォーム項目の列がなくても取り込める
    const eve = importForteeZip({
      zip: toZip(syntheticZipParts(SYNTHETIC_EVENTS.eve)),
      slug: SYNTHETIC_SLUG,
      eventId: SYNTHETIC_EVENT_IDS.eve,
      answerColumns: answerColumnsOf(config, SYNTHETIC_EVENT_IDS.eve),
      now: NOW,
    });
    expect(eve.ok && eve.snapshot.columns).toEqual([]);
    expect(eve.ok && eve.snapshot.attendees.map((attendee) => attendee.answers)).toEqual([{}, {}, {}, {}]);
  });

  it("合成の ZIP は、config/local.toml のイベント、列、種別と対になっている", () => {
    for (const [key, event] of Object.entries(SYNTHETIC_EVENTS)) {
      const eventId = SYNTHETIC_EVENT_IDS[key as keyof typeof SYNTHETIC_EVENT_IDS];
      expect(config.events.map((candidate) => candidate.id)).toContain(eventId);
      const result = importForteeZip({
        zip: toZip(syntheticZipParts(event)),
        slug: config.conference.slug,
        eventId,
        answerColumns: answerColumnsOf(config, eventId),
        now: NOW,
      });
      expect(errorsOf(result)).toEqual([]);
      // 設定の種別名が、スナップショットの種別と過不足なく一致する（公開のときの警告が出ない）
      const groups = config.display.ticketTypes.filter((group) => group.event === eventId);
      if (result.ok && groups.length > 0) {
        expect(new Set(groups.flatMap((group) => group.types))).toEqual(new Set(result.summary.ticketTypes.map((type) => type.ticketType)));
      }
    }
  });

  it("ZIP のエントリ名（日本語を含む）が、CSV の QR profile filename の値と一致する", () => {
    const parts = syntheticZipParts(MAIN);
    const zip = toZip(parts);
    const names = Object.keys(unzipSync(zip));
    for (const row of parts.rows) expect(names).toContain(`qr-profile/${row[col(parts, "QR profile filename")]}`);
    expect(names).toContain("qr-profile/qr-profile-テスト本編一般チケット-A-1.png");
    // 合成の ZIP も、本物（constraints.md 4 章）と同じく、エントリ名に UTF-8 のフラグ（汎用ビット 11）を立てている。
    // 2 つ目のエントリ（qr-profile/…）のローカルファイルヘッダの位置を、署名から探す
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const headers: number[] = [];
    for (let i = 0; i + 4 <= zip.byteLength; i++) {
      if (view.getUint32(i, true) === 0x04034b50) headers.push(i);
    }
    const flags = headers.map((offset) => view.getUint16(offset + 6, true) & 0x0800);
    expect(flags.filter((flag) => flag !== 0).length).toBeGreaterThanOrEqual(parts.rows.length * 2);
  });

  it("CSV と qr-profile/ 以外のエントリ（qr-feedback/、avatar/）がなくても、結果は変わらない", () => {
    const full = importMain();
    const minimal = importMain((parts) => {
      for (const name of Object.keys(parts.files)) {
        if (!name.startsWith("qr-profile/")) delete parts.files[name];
      }
    });
    expect(minimal).toEqual(full);
  });
});

describe("取り込み: csv-parse の振る舞い（Design Doc 12.2）", () => {
  const csv = Buffer.from(toCsvText(["a", "b", "a"], [["1", "2", "3"]]));

  it("columns: true は、同じ名前の列の値を、後の列の値で黙って上書きする。取り込みは、この読み方を使わない", () => {
    expect(parse(csv, { bom: true, columns: true })).toEqual([{ a: "3", b: "2" }]);
  });

  it("bom: true で、BOM が先頭の列名から除かれる", () => {
    expect(parse(csv, { bom: true })).toEqual([
      ["a", "b", "a"],
      ["1", "2", "3"],
    ]);
    expect((parse(csv, {}) as string[][])[0]?.[0]).toBe("\ufeffa");
  });
});

describe("取り込み: 条件に合わない入力は、該当する行と列を列挙して止まる（Design Doc 8.3 の表）", () => {
  it("読む列がヘッダにない: ない列をすべて列挙する", () => {
    const errors = errorsOf(
      importMain((parts) => {
        parts.header[col(parts, "Ticket url")] = "Ticket URL"; // 大文字と小文字を無視しない
        parts.header[col(parts, "所属")] = " 所属"; // 前後の空白を無視しない
      }),
    );
    expect(errors).toEqual(["CSV のヘッダに、読む列がありません: 「Ticket url」、「所属」"]);
  });

  it("設定で参照する列がヘッダにない", () => {
    expect(errorsOf(importMain(undefined, ["お名前", "Tシャツのサイズ"]))).toEqual([
      "CSV のヘッダに、読む列がありません: 「Tシャツのサイズ」",
    ]);
  });

  it("読む列の名前が重複する: どちらの列の値を使うかを選ばずに止まる", () => {
    const errors = errorsOf(
      importMain((parts) => {
        parts.header.push("所属");
        for (const row of parts.rows) row.push("別の値");
      }),
    );
    expect(errors).toEqual(["CSV のヘッダに、読む列の名前が 2 回以上あります: 「所属」（18 列目、20 列目）"]);
  });

  it("読まない列の名前が重複する: 列名を警告に出して続ける", () => {
    const result = importMain((parts) => {
      parts.header.push("Twitter");
      for (const row of parts.rows) row.push("");
    });
    expect(result.ok && result.warnings[0]).toBe("CSV のヘッダに、同じ名前の列があります（読まない列なので続けます）: 「Twitter」");
    expect(result.ok && result.snapshot.attendees).toHaveLength(7);
  });

  it("行の列の数がヘッダと違う", () => {
    const errors = errorsOf(importMain((parts) => void rowOf(parts, "A-2").pop()));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/CSV を読めません: .*on line 3.*CSV_RECORD_INCONSISTENT_FIELDS_LENGTH/);
  });

  it("User name と Issued の片方だけが空", () => {
    const errors = errorsOf(
      importMain((parts) => {
        set(parts, "A-2", "Issued", "");
        set(parts, "A-5", "User name", "");
      }),
    );
    expect(errors).toEqual([
      expect.stringMatching(/^3 行目の「Issued」: 「User name」と「Issued」の片方だけが空です/),
      expect.stringMatching(/^6 行目の「User name」: 「User name」と「Issued」の片方だけが空です/),
    ]);
  });

  it("Ticket type、Ticket no が空", () => {
    const errors = errorsOf(
      importMain((parts) => {
        set(parts, "A-4", "Ticket type", "");
        set(parts, "A-5", "Ticket no", "");
      }),
    );
    expect(errors).toEqual(["5 行目の「Ticket type」: 空です", "6 行目の「Ticket no」: 空です"]);
  });

  it.each([
    ["別のカンファレンスのスラッグ", `https://fortee.jp/yapc-tokyo-2026/attendee/${"a".repeat(32)}`],
    ["トークンが 31 文字", `https://fortee.jp/${SYNTHETIC_SLUG}/attendee/${"a".repeat(31)}`],
    ["後ろに余分な文字", `https://fortee.jp/${SYNTHETIC_SLUG}/attendee/${"a".repeat(32)}/`],
    ["http", `http://fortee.jp/${SYNTHETIC_SLUG}/attendee/${"a".repeat(32)}`],
    ["空", ""],
  ])("Ticket url の形が違う: %s", (_name, url) => {
    const errors = errorsOf(importMain((parts) => set(parts, "A-1", "Ticket url", url)));
    expect(errors).toEqual([expect.stringMatching(/^2 行目の「Ticket url」: https:\/\/fortee\.jp\/yapc-tokyo-2026-sandbox\/attendee\/ に英数字 32 文字が続く形ではありません/)]);
  });

  it("スラッグの「.」などの文字を、正規表現として扱わない", () => {
    const zip = toZip(syntheticZipParts(MAIN));
    const result = importForteeZip({ zip, slug: "yapc-tokyo-2026.sandbox", eventId: "x", answerColumns: [], now: NOW });
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  it("qr-profile/ の画像が ZIP にない", () => {
    const errors = errorsOf(importMain((parts) => delete parts.files["qr-profile/qr-profile-テスト本編一般チケット-A-2.png"]));
    expect(errors).toEqual(["3 行目の「QR profile filename」: ZIP に、この値の名前の画像（qr-profile/ 以下）がありません"]);
  });

  it("qr-profile/ の画像から QR を読み取れない", () => {
    const errors = errorsOf(
      importMain((parts) => {
        parts.files["qr-profile/qr-profile-テスト本編一般チケット-A-2.png"] = strToU8("PNG ではない");
      }),
    );
    expect(errors).toEqual(["3 行目の「QR profile filename」: 画像から QR を読み取れません"]);
  });

  it.each([
    ["フィードバック QR（チケット詳細の URL）", `https://fortee.jp/${SYNTHETIC_SLUG}/attendee/${"b".repeat(32)}`],
    ["別のカンファレンスの go-profile", profileUrl("yapc-tokyo-2026", "b".repeat(32))],
    ["チケット QR の文字列", `fortee:${"b".repeat(32)}`],
  ])("qr-profile/ の画像の QR の内容が、go-profile の URL でない: %s", (_name, content) => {
    const errors = errorsOf(
      importMain((parts) => {
        parts.files["qr-profile/qr-profile-テスト本編一般チケット-A-2.png"] = qrPng(content);
      }),
    );
    expect(errors).toEqual([expect.stringMatching(/^3 行目の「QR profile filename」: 画像の QR の内容が、.*\/go-profile が続く形ではありません$/)]);
  });

  it("checked_in が true でも false でもない", () => {
    const errors = errorsOf(
      importMain((parts) => {
        set(parts, "A-1", "checked_in", "TRUE");
        set(parts, "A-2", "checked_in", "");
      }),
    );
    expect(errors).toEqual(["2 行目の「checked_in」: true でも false でもありません", "3 行目の「checked_in」: true でも false でもありません"]);
  });

  it("User name と Ticket no が 100 文字を超える: 切り詰めずに止まる", () => {
    expect(errorsOf(importMain((parts) => set(parts, "A-1", "User name", "a".repeat(100))))).toEqual([]);
    const errors = errorsOf(
      importMain((parts) => {
        set(parts, "A-1", "User name", "a".repeat(101));
        set(parts, "A-2", "Ticket no", `A-${"9".repeat(99)}`);
      }),
    );
    expect(errors).toEqual([
      "2 行目の「User name」: 100 文字を超えています（101 文字）",
      "3 行目の「Ticket no」: 100 文字を超えています（101 文字）",
    ]);
  });

  it("チケットトークンと profile_url_token が、行のあいだで重複する: 重複した行をすべて列挙する", () => {
    const errors = errorsOf(
      importMain((parts) => {
        set(parts, "A-2", "Ticket url", rowOf(parts, "A-1")[col(parts, "Ticket url")] as string);
        // 名前の違う 2 枚の画像が、同じ profile_url_token を持つ
        parts.files[`qr-profile/${rowOf(parts, "Z-1")[col(parts, "QR profile filename")] as string}`] = qrPng(
          profileUrl(SYNTHETIC_SLUG, profileUrlTokenOf(MAIN, "A-6")),
        );
      }),
    );
    expect(errors).toEqual([
      "「Ticket url」のチケットトークンが、行のあいだで重複しています: 2 行目、3 行目",
      "profile_url_token（「QR profile filename」の画像か、補正の値）が、行のあいだで重複しています: 7 行目、10 行目",
    ]);
  });

  // fortee の採番が、同じチケット番号を 2 人の参加者に付けた（本番の本編で確認）。画像の名前は種別名とチケット番号から
  // 決まるので、2 人は 1 枚の画像を指す
  const duplicateTicketNo = (parts: SyntheticZipParts): void => {
    set(parts, "A-5", "QR profile filename", rowOf(parts, "A-4")[col(parts, "QR profile filename")] as string);
    set(parts, "A-5", "Ticket no", "A-4");
  };
  const A4 = ticketTokenOf(MAIN, "A-4");
  const A5 = ticketTokenOf(MAIN, "A-5");

  it("Ticket no が重複し、画像を共有する行に補正がない: 画像の値を使わずに止まる", () => {
    expect(errorsOf(importMain(duplicateTicketNo))).toEqual([
      "「QR profile filename」の画像を、ほかの行と共有しています。profile_url_token を画像から決められないので、補正ファイルに、その行のチケットトークンと profile_url_token（fortee の参加者詳細画面の QR）を書いてください: 5 行目、6 行目",
    ]);
    // 片方だけの補正では、もう片方の行で止まる
    const partial = new Map([[A4, profileUrlTokenOf(MAIN, "A-4")]]);
    expect(errorsOf(importMain(duplicateTicketNo, MAIN_COLUMNS, partial))[0]).toMatch(/: 6 行目$/);
  });

  it("Ticket no が重複し、画像を共有する行に補正がある: 補正の値を取り込み、重複を警告に出す", () => {
    const corrections = new Map([
      [A4, profileUrlTokenOf(MAIN, "A-4")],
      [A5, profileUrlTokenOf(MAIN, "A-5")],
    ]);
    const result = importMain(duplicateTicketNo, MAIN_COLUMNS, corrections);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.warnings).toContain("「Ticket no」が、行のあいだで重複しています（fortee の採番によるものか確かめてください）: 5 行目、6 行目");
    const byToken = new Map(result.snapshot.attendees.map((attendee) => [attendee.ticketToken, attendee]));
    expect(byToken.get(A4)).toMatchObject({ ticketNo: "A-4", profileUrlToken: profileUrlTokenOf(MAIN, "A-4") });
    expect(byToken.get(A5)).toMatchObject({ ticketNo: "A-4", profileUrlToken: profileUrlTokenOf(MAIN, "A-5") });
  });

  it("補正が、画像を共有する行に当たらない。補正の値どうしが重複する: 止まる", () => {
    // 画像を共有しない ZIP に補正がある
    expect(errorsOf(importMain(undefined, MAIN_COLUMNS, new Map([[A4, profileUrlTokenOf(MAIN, "A-4")]])))).toEqual([
      "補正ファイルに、画像を共有する行のどれにも当たらないチケットトークンが 1 件あります",
    ]);
    const same = new Map([
      [A4, profileUrlTokenOf(MAIN, "A-4")],
      [A5, profileUrlTokenOf(MAIN, "A-4")],
    ]);
    expect(errorsOf(importMain(duplicateTicketNo, MAIN_COLUMNS, same))).toEqual([
      "profile_url_token（「QR profile filename」の画像か、補正の値）が、行のあいだで重複しています: 5 行目、6 行目",
    ]);
  });

  it("複数の誤りを、すべて列挙する。行の番号は、値の中の改行を数える", () => {
    const errors = errorsOf(
      importMain((parts) => {
        set(parts, "A-1", "checked_in", "yes");
        // A-6 の値は改行を含むので、その次の行（A-12）は 9 行目になる
        set(parts, "A-12", "Ticket type", "");
        set(parts, "Z-1", "checked_in", "no");
      }),
    );
    expect(errors).toEqual([
      "2 行目の「checked_in」: true でも false でもありません",
      "9 行目の「Ticket type」: 空です",
      "10 行目の「checked_in」: true でも false でもありません",
    ]);
  });

  it("誤りの文言に、参加者の値を出さない", () => {
    const errors = errorsOf(
      importMain((parts) => {
        set(parts, "A-1", "checked_in", "yes");
        set(parts, "A-4", "Issued", "");
        set(parts, "A-5", "Ticket url", "https://example.com/secret-token");
      }),
    ).join("\n");
    for (const value of ["test-alice", "test-bob", "テスト 太郎", "secret-token", ticketTokenOf(MAIN, "A-1")]) {
      expect(errors).not.toContain(value);
    }
  });

  it("ZIP として読めない、CSV がない、CSV が 2 本ある", () => {
    const run = (zip: Uint8Array) =>
      errorsOf(importForteeZip({ zip, slug: SYNTHETIC_SLUG, eventId: SYNTHETIC_EVENT_IDS.main, answerColumns: [], now: NOW }));
    expect(run(strToU8("ZIP ではない"))).toEqual(["ZIP として読めません"]);
    const parts = syntheticZipParts(MAIN);
    expect(run(toZip({ ...parts, csvName: "attendees.txt" }))).toEqual(["ZIP の中の CSV は 1 本でなければなりませんが、ありません"]);
    expect(run(toZip({ ...parts, files: { ...parts.files, "other.csv": strToU8("a\n") } }))).toEqual([
      "ZIP の中の CSV は 1 本でなければなりませんが、2 本あります（attendees.csv、other.csv）",
    ]);
  });
});

describe("チケット番号の接頭辞", () => {
  it.each([
    ["A-12", "A"],
    ["AB-C-3", "AB-C"],
    ["12", ""],
  ])("%s → %s", (ticketNo, prefix) => {
    expect(ticketNoPrefix(ticketNo)).toBe(prefix);
  });
});

describe("import コマンド", () => {
  let environment: TestEnvironment;
  beforeEach(async () => {
    environment = await temporaryEnvironment();
  });
  afterEach(() => environment.cleanup());

  const run = async (parts: SyntheticZipParts, now: number, event = "main") => {
    const lines: string[] = [];
    const warnings: string[] = [];
    const zip = await writeZip(environment.dir, `fixture-${now}`, parts);
    await importZip(environment.target, config, { event, zip }, { now: () => now, log: (line) => lines.push(line), warn: (line) => warnings.push(line) });
    return { lines, warnings };
  };

  it("作業ディレクトリにスナップショットを書き、取り込みの結果を出す。結果がゴールデンファイルと一致する", async () => {
    const { lines, warnings } = await run(syntheticZipParts(MAIN), NOW);
    const path = snapshotPath(environment.target, SYNTHETIC_EVENT_IDS.main);
    expect(path).toBe(join(environment.dir, "work", "snapshots", `${SYNTHETIC_EVENT_IDS.main}.json`));
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ eventId: SYNTHETIC_EVENT_IDS.main, version: NOW });
    expect(warnings).toHaveLength(1);
    // 出力には、参加者の情報を出さない
    const output = lines.join("\n").replaceAll(environment.dir, "<一時ディレクトリ>");
    expect(output).not.toMatch(/test-alice|テスト 太郎/);
    await expect(`${output}\n`).toMatchFileSnapshot(join(GOLDEN, "import-main.output.txt"));
  });

  it("イベントは key でも id でも指定でき、設定にないイベントでは止まる", async () => {
    await run(syntheticZipParts(SYNTHETIC_EVENTS.eve), NOW, SYNTHETIC_EVENT_IDS.eve);
    expect((await readSnapshot(environment.target, SYNTHETIC_EVENT_IDS.eve))?.attendees).toHaveLength(4);
    await expect(run(syntheticZipParts(MAIN), NOW, "nursery")).rejects.toThrow(/--event の "nursery" は、設定の events の key でも id でもありません/);
  });

  it("再取り込みは、そのイベントのスナップショットだけを置き換える。止まったときは、前のスナップショットが残る", async () => {
    await run(syntheticZipParts(MAIN), NOW);
    await run(syntheticZipParts(SYNTHETIC_EVENTS.eve), NOW + 1, "eve");

    const fewer = syntheticZipParts(MAIN);
    fewer.rows.pop();
    await run(fewer, NOW + 2);
    expect(await readSnapshot(environment.target, SYNTHETIC_EVENT_IDS.main)).toMatchObject({ version: NOW + 2, attendees: { length: 6 } });
    expect(await readSnapshot(environment.target, SYNTHETIC_EVENT_IDS.eve)).toMatchObject({ version: NOW + 1 });

    const broken = syntheticZipParts(MAIN);
    set(broken, "A-1", "checked_in", "");
    await expect(run(broken, NOW + 3)).rejects.toThrow(/取り込めません（1 件）。スナップショットは変えていません\n {2}2 行目の「checked_in」/);
    expect(await readSnapshot(environment.target, SYNTHETIC_EVENT_IDS.main)).toMatchObject({ version: NOW + 2 });
  });

  it("補正ファイル（profile-url-tokens/{eventId}.json）を読む。なければ置き場所を出して止まり、形が違えば止まる", async () => {
    const parts = syntheticZipParts(MAIN);
    set(parts, "A-5", "QR profile filename", rowOf(parts, "A-4")[col(parts, "QR profile filename")] as string);
    set(parts, "A-5", "Ticket no", "A-4");
    const zip = await writeZip(environment.dir, "duplicated", parts);
    const warnings: string[] = [];
    const run = () => importZip(environment.target, config, { event: "main", zip }, { now: () => NOW, log: silent, warn: (line) => warnings.push(line) });
    const path = profileUrlTokensPath(environment.target, SYNTHETIC_EVENT_IDS.main);

    await expect(run()).rejects.toThrow(`5 行目、6 行目\n補正ファイル: ${path}`);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ [ticketTokenOf(MAIN, "A-4")]: "short" }));
    await expect(run()).rejects.toThrow(/補正ファイル .* が、チケットトークン（英数字 32 文字）を鍵/);
    await writeFile(path, "[");
    await expect(run()).rejects.toThrow(/を JSON として読めません/);

    await writeFile(
      path,
      JSON.stringify({
        [ticketTokenOf(MAIN, "A-4")]: profileUrlTokenOf(MAIN, "A-4"),
        [ticketTokenOf(MAIN, "A-5")]: profileUrlTokenOf(MAIN, "A-5"),
      }),
    );
    await run();
    expect(warnings).toContain("警告: 「Ticket no」が、行のあいだで重複しています（fortee の採番によるものか確かめてください）: 5 行目、6 行目");
    const snapshot = await readSnapshot(environment.target, SYNTHETIC_EVENT_IDS.main);
    expect(snapshot?.attendees.find((attendee) => attendee.ticketToken === ticketTokenOf(MAIN, "A-5"))?.profileUrlToken).toBe(
      profileUrlTokenOf(MAIN, "A-5"),
    );
  });

  it("読めない ZIP のパスで止まる", async () => {
    await expect(
      importZip(environment.target, config, { event: "main", zip: join(environment.dir, "none.zip") }, { now: () => NOW, log: silent, warn: silent }),
    ).rejects.toThrow(/を読めません/);
  });
});
