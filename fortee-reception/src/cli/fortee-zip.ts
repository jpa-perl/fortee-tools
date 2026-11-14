import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { NAME_MAX_LENGTH, TICKET_TOKEN_SOURCE } from "../core/fields.ts";
import type { Attendee, Snapshot } from "../core/snapshot.ts";
import { DISTRIBUTION_FORMAT } from "../core/versions.ts";

// fortee のダウンロード ZIP から、1 つのイベントのスナップショットを作る（Design Doc 8.3、FR-43）。
//
// 入力の値を上書き、切り詰め、補正しない。意味が一通りに決まらない入力と、取り込むと値が黙って失われる入力は、
// 該当する行と列をすべて列挙して止める。解析ライブラリの既定の振る舞いにも、この判断を任せない。
// 誤りと警告の文言には、参加者の値を出さない（Design Doc 9.3）。出すのは、行の番号と列の名前だけである。
//
// ZIP と CSV の形は docs/research/fortee/（data-sources.md、constraints.md 4 章）による。

/** どのイベントでも読む列（Design Doc 8.3） */
const COLUMN = {
  ticketType: "Ticket type",
  ticketNo: "Ticket no",
  userName: "User name",
  issued: "Issued",
  name: "Name",
  checkedIn: "checked_in",
  ticketUrl: "Ticket url",
  qrProfile: "QR profile filename",
} as const;

const QR_PROFILE_DIR = "qr-profile/";

export type ImportInput = {
  /** ZIP の中身 */
  zip: Uint8Array;
  /** 設定の conference.slug。Ticket url と go-profile の URL のスラッグと照合する */
  slug: string;
  /** 取り込み先のイベント ID。CSV にイベントの列はなく、この指定だけがイベントの所属の根拠である */
  eventId: string;
  /** そのイベントについて設定で参照する列（search.answers と display.answers の field）。重複のない並び */
  answerColumns: readonly string[];
  /** 取り込み日時。スナップショットの版になる */
  now: number;
  /**
   * profile_url_token の補正（チケットトークン → profile_url_token）。プロフィール QR の画像を複数の行が共有するときに、
   * その行の profile_url_token を、画像の代わりにここから取る。省略は、補正なし
   */
  profileUrlTokens?: ReadonlyMap<string, string>;
};

export type TicketTypeSummary = {
  ticketType: string;
  /** 取り込んだ行の数 */
  count: number;
  /** チケット番号の接頭辞（A-12 の A）。「-」のない番号は、空文字で表す */
  prefixes: string[];
};

export type ImportSummary = {
  /** 取り込んだ行の数 */
  imported: number;
  /** 未発券として除いた行の数 */
  unissued: number;
  /** チケット種別ごとの行の数と接頭辞。CSV に現れた順 */
  ticketTypes: TicketTypeSummary[];
};

export type ImportResult =
  | { ok: true; snapshot: Snapshot; summary: ImportSummary; warnings: string[] }
  /** needsProfileUrlTokens は、補正ファイルを書くか直すかすれば解ける誤りがあるとき（8.3 の「画像を共有する行」） */
  | { ok: false; errors: string[]; needsProfileUrlTokens: boolean };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** チケット番号の接頭辞（A-12 の A）。最後の「-」より前。「-」がなければ空文字 */
export function ticketNoPrefix(ticketNo: string): string {
  const at = ticketNo.lastIndexOf("-");
  return at < 0 ? "" : ticketNo.slice(0, at);
}

type Row = { line: number; cells: string[] };

/**
 * CSV を、行ごとの配列として読む。列名で値を引く読み方（columns）は使わない。csv-parse の columns は、
 * 同じ名前の列があると、後の列の値で前の列の値を黙って上書きする。ヘッダは、呼び出し側が検証する
 */
function readCsv(csv: Uint8Array): { ok: true; rows: Row[] } | { ok: false; error: string } {
  type Parsed = { record: string[]; info: { lines: number } };
  let parsed: Parsed[];
  try {
    // bom は真にし、trim、ltrim、rtrim、relax_column_count、relax_quotes、skip_empty_lines、cast は既定（偽）のままにする。
    // 行の列の数がヘッダと違えば、csv-parse が誤りにする
    parsed = parse(Buffer.from(csv.buffer, csv.byteOffset, csv.byteLength), { bom: true, info: true }) as unknown as Parsed[];
  } catch (error) {
    // csv-parse の文言は、行の番号と列の数だけを含み、値を含まない。code のない誤りは、文言を出さない
    const { code, message } = error as { code?: unknown; message?: unknown };
    const detail = typeof code === "string" && typeof message === "string" ? `: ${message}（${code}）` : "";
    return { ok: false, error: `CSV を読めません${detail}` };
  }
  // info.lines は、そのレコードを読み終えた時点の行の数。値の中に改行があれば、レコードは複数の行にまたがる
  const rows: Row[] = [];
  let line = 1;
  for (const { record, info } of parsed) {
    rows.push({ line, cells: record });
    line = info.lines + 1;
  }
  return { ok: true, rows };
}

/** プロフィール QR の PNG を、pngjs と jsQR でデコードする。読めなければ null */
function decodeQr(png: Uint8Array): string | null {
  try {
    const image = PNG.sync.read(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
    const pixels = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    return jsQR(pixels, image.width, image.height)?.data ?? null;
  } catch {
    return null;
  }
}

/** 値 → その値を持つ行（2 行以上あるものだけ） */
function duplicateLines(entries: readonly { line: number; value: string }[]): number[][] {
  const lines = new Map<string, number[]>();
  for (const { line, value } of entries) {
    const list = lines.get(value);
    if (list === undefined) lines.set(value, [line]);
    else list.push(line);
  }
  return [...lines.values()].filter((list) => list.length > 1);
}

export function importForteeZip(input: ImportInput): ImportResult {
  const { slug, eventId, answerColumns } = input;

  // 1. ZIP を展開し、CSV と qr-profile/ 以外のエントリを捨てる（constraints.md 4 章）
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(input.zip, {
      filter: (file) => file.name.toLowerCase().endsWith(".csv") || file.name.startsWith(QR_PROFILE_DIR),
    });
  } catch {
    return { ok: false, needsProfileUrlTokens: false, errors: ["ZIP として読めません"] };
  }
  // ZIP の CSV は 1 本である（data-sources.md）。0 本と 2 本以上は、どれを読むかを選ばずに止める
  const csvNames = Object.keys(entries).filter((name) => name.toLowerCase().endsWith(".csv"));
  const csvName = csvNames[0];
  if (csvName === undefined || csvNames.length !== 1) {
    const found = csvNames.length === 0 ? "ありません" : `${csvNames.length} 本あります（${csvNames.join("、")}）`;
    return { ok: false, needsProfileUrlTokens: false, errors: [`ZIP の中の CSV は 1 本でなければなりませんが、${found}`] };
  }

  // 2. CSV を読む
  const csv = readCsv(entries[csvName] as Uint8Array);
  if (!csv.ok) return { ok: false, needsProfileUrlTokens: false, errors: [csv.error] };
  const [header, ...rows] = csv.rows;
  if (header === undefined) return { ok: false, needsProfileUrlTokens: false, errors: ["CSV が空です。ヘッダの行がありません"] };

  // 3. ヘッダを検証する。列名は文字列の完全一致で比べ、前後の空白や大文字と小文字を無視しない
  const errors: string[] = [];
  const warnings: string[] = [];
  const readColumns = [...new Set([...Object.values(COLUMN), ...answerColumns])];
  const positions = new Map<string, number[]>();
  header.cells.forEach((name, i) => {
    const list = positions.get(name);
    if (list === undefined) positions.set(name, [i]);
    else list.push(i);
  });
  const missing = readColumns.filter((name) => !positions.has(name));
  if (missing.length > 0) {
    errors.push(`CSV のヘッダに、読む列がありません: ${missing.map((name) => `「${name}」`).join("、")}`);
  }
  // 読む列の重複は止める。どちらの列の値を使うかが決まらない
  const ambiguous = readColumns.filter((name) => (positions.get(name)?.length ?? 0) > 1);
  if (ambiguous.length > 0) {
    errors.push(
      `CSV のヘッダに、読む列の名前が 2 回以上あります: ${ambiguous
        .map((name) => `「${name}」（${positions.get(name)?.map((i) => `${i + 1} 列目`).join("、")}）`)
        .join("、")}`,
    );
  }
  // 読まない列の重複は、列名を警告に出して続ける。読まないので、値は失われない
  const unreadDuplicates = [...positions].filter(([name, list]) => list.length > 1 && !readColumns.includes(name));
  if (unreadDuplicates.length > 0) {
    warnings.push(
      `CSV のヘッダに、同じ名前の列があります（読まない列なので続けます）: ${unreadDuplicates.map(([name]) => `「${name}」`).join("、")}`,
    );
  }
  if (errors.length > 0) return { ok: false, needsProfileUrlTokens: false, errors };

  const indexOf = (name: string) => positions.get(name)?.[0] as number;
  const at = (row: Row, name: string) => row.cells[indexOf(name)] as string;

  // 4. 各行を検証し、変換する
  const ticketUrlPattern = new RegExp(`^https://fortee\\.jp/${escapeRegExp(slug)}/attendee/(${TICKET_TOKEN_SOURCE})$`);
  const profileUrlPattern = new RegExp(`^https://fortee\\.jp/${escapeRegExp(slug)}/attendee/(${TICKET_TOKEN_SOURCE})/go-profile$`);

  const attendees: Attendee[] = [];
  const seen = { ticketToken: [], ticketNo: [], profileUrlToken: [] } as Record<
    "ticketToken" | "ticketNo" | "profileUrlToken",
    { line: number; value: string }[]
  >;
  const types = new Map<string, { count: number; prefixes: Set<string> }>();
  let unissued = 0;

  const isUnissued = (row: Row) => at(row, COLUMN.userName) === "" && at(row, COLUMN.issued) === "";

  // プロフィール QR の画像を共有する行。fortee は、チケット番号を複数の参加者に重ねて採番することがあり、
  // 画像の名前は種別名とチケット番号から決まるので、その参加者たちは 1 枚の画像を指す（data-sources.md）。
  // 画像の値はそのうちの高々 1 人のものなので、どの行にも使わず、補正から取る
  const qrUsers = new Map<string, number[]>();
  for (const row of rows) {
    const qrName = at(row, COLUMN.qrProfile);
    if (isUnissued(row) || qrName === "") continue;
    const list = qrUsers.get(qrName);
    if (list === undefined) qrUsers.set(qrName, [row.line]);
    else list.push(row.line);
  }
  const corrections = input.profileUrlTokens ?? new Map<string, string>();
  const usedCorrections = new Set<string>();
  const uncorrected: number[] = [];

  for (const row of rows) {
    const fail = (column: string, message: string) => errors.push(`${row.line} 行目の「${column}」: ${message}`);
    const userName = at(row, COLUMN.userName);
    const issued = at(row, COLUMN.issued);

    // User name と Issued が両方空の行は、未発券として除く。片方だけが空の行は、何を表すかを確かめていないので止める
    if (isUnissued(row)) {
      unissued++;
      continue;
    }
    if (userName === "" || issued === "") {
      const empty = userName === "" ? COLUMN.userName : COLUMN.issued;
      fail(empty, `「${COLUMN.userName}」と「${COLUMN.issued}」の片方だけが空です。未発券の行は、両方が空です`);
    }

    const ticketType = at(row, COLUMN.ticketType);
    const ticketNo = at(row, COLUMN.ticketNo);
    if (ticketType === "") fail(COLUMN.ticketType, "空です");
    if (ticketNo === "") fail(COLUMN.ticketNo, "空です");

    // 記録はこの 2 つを写し、Worker は 100 文字を超える記録を拒む。切り詰めずに止める
    if (userName.length > NAME_MAX_LENGTH) fail(COLUMN.userName, `${NAME_MAX_LENGTH} 文字を超えています（${userName.length} 文字）`);
    if (ticketNo.length > NAME_MAX_LENGTH) fail(COLUMN.ticketNo, `${NAME_MAX_LENGTH} 文字を超えています（${ticketNo.length} 文字）`);

    const ticketToken = ticketUrlPattern.exec(at(row, COLUMN.ticketUrl))?.[1];
    if (ticketToken === undefined) {
      fail(COLUMN.ticketUrl, `https://fortee.jp/${slug}/attendee/ に英数字 32 文字が続く形ではありません。別のカンファレンスの ZIP ではないか確かめてください`);
    }

    let profileUrlToken: string | undefined;
    const qrName = at(row, COLUMN.qrProfile);
    const png = qrName === "" ? undefined : entries[`${QR_PROFILE_DIR}${qrName}`];
    if (qrName === "") {
      fail(COLUMN.qrProfile, "空です");
    } else if ((qrUsers.get(qrName)?.length ?? 0) > 1) {
      // 画像を共有する行。チケットトークンが読めない行は、Ticket url の誤りとして上で挙げている
      if (ticketToken !== undefined) {
        profileUrlToken = corrections.get(ticketToken);
        if (profileUrlToken === undefined) uncorrected.push(row.line);
        else usedCorrections.add(ticketToken);
      }
    } else if (png === undefined) {
      fail(COLUMN.qrProfile, `ZIP に、この値の名前の画像（${QR_PROFILE_DIR} 以下）がありません`);
    } else {
      const decoded = decodeQr(png);
      profileUrlToken = decoded === null ? undefined : profileUrlPattern.exec(decoded)?.[1];
      if (decoded === null) {
        fail(COLUMN.qrProfile, "画像から QR を読み取れません");
      } else if (profileUrlToken === undefined) {
        fail(COLUMN.qrProfile, `画像の QR の内容が、https://fortee.jp/${slug}/attendee/ に英数字 32 文字と /go-profile が続く形ではありません`);
      }
    }

    const checkedIn = at(row, COLUMN.checkedIn);
    if (checkedIn !== "true" && checkedIn !== "false") fail(COLUMN.checkedIn, "true でも false でもありません");

    if (ticketNo !== "") seen.ticketNo.push({ line: row.line, value: ticketNo });
    if (ticketToken !== undefined) seen.ticketToken.push({ line: row.line, value: ticketToken });
    if (profileUrlToken !== undefined) seen.profileUrlToken.push({ line: row.line, value: profileUrlToken });

    const type = types.get(ticketType) ?? { count: 0, prefixes: new Set<string>() };
    type.count++;
    type.prefixes.add(ticketNoPrefix(ticketNo));
    types.set(ticketType, type);

    // Name とアンケートの列は、文字列をそのまま持つ。空は空文字
    attendees.push({
      ticketToken: ticketToken ?? "",
      ticketNo,
      ticketType,
      userName,
      name: at(row, COLUMN.name),
      profileUrlToken: profileUrlToken ?? "",
      forteeCheckedIn: checkedIn === "true",
      answers: Object.fromEntries(answerColumns.map((name) => [name, at(row, name)])),
    });
  }

  const linesText = (lines: readonly number[]) => lines.map((line) => `${line} 行目`).join("、");

  // 画像を共有する行に、補正がない。画像の値を黙って使うと、一括チェックイン CSV の 1 行が別の参加者を指す
  if (uncorrected.length > 0) {
    errors.push(
      `「${COLUMN.qrProfile}」の画像を、ほかの行と共有しています。profile_url_token を画像から決められないので、補正ファイルに、その行のチケットトークンと profile_url_token（fortee の参加者詳細画面の QR）を書いてください: ${linesText(uncorrected)}`,
    );
  }
  // 使わなかった補正は、止める。画像を共有しなくなった行の古い補正や、チケットトークンの書き間違いを、黙って捨てない
  const unusedCorrections = [...corrections.keys()].filter((ticketToken) => !usedCorrections.has(ticketToken)).length;
  if (unusedCorrections > 0) {
    errors.push(`補正ファイルに、画像を共有する行のどれにも当たらないチケットトークンが ${unusedCorrections} 件あります`);
  }

  // イベントの中での重複。チケットトークンと profile_url_token は、fortee ではチケットごとに別の値なので、
  // どちらの行を採るかを決める根拠がない
  for (const [label, entriesOf] of [
    [`「${COLUMN.ticketUrl}」のチケットトークンが`, seen.ticketToken],
    [`profile_url_token（「${COLUMN.qrProfile}」の画像か、補正の値）が`, seen.profileUrlToken],
  ] as const) {
    for (const lines of duplicateLines(entriesOf)) {
      errors.push(`${label}、行のあいだで重複しています: ${linesText(lines)}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, needsProfileUrlTokens: uncorrected.length > 0 || unusedCorrections > 0, errors };
  }

  // Ticket no の重複は、警告にとどめる。fortee の採番が、同じ番号を複数の参加者に付けることがある（本番で確認）。
  // 参加者はチケットトークンで特定し、チケット番号は表示、検索、並び順にしか使わない
  for (const lines of duplicateLines(seen.ticketNo)) {
    warnings.push(`「${COLUMN.ticketNo}」が、行のあいだで重複しています（fortee の採番によるものか確かめてください）: ${linesText(lines)}`);
  }

  if (unissued > 0) warnings.push(`未発券の行（「${COLUMN.userName}」と「${COLUMN.issued}」が空）を ${unissued} 行、取り込まずに除きました`);

  return {
    ok: true,
    snapshot: {
      format: DISTRIBUTION_FORMAT,
      eventId,
      version: input.now,
      columns: [...answerColumns],
      attendees,
    },
    summary: {
      imported: attendees.length,
      unissued,
      ticketTypes: [...types].map(([ticketType, { count, prefixes }]) => ({ ticketType, count, prefixes: [...prefixes] })),
    },
    warnings,
  };
}
