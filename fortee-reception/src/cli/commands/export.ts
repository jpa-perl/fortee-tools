import { access, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { eventKeyOf, type PublishedConfig, publishedConfigSchema } from "../../core/config.ts";
import { deviceName } from "../../core/device.ts";
import type { ServerRecord } from "../../core/record.ts";
import { aggregate, compareRecords, type TicketState } from "../../core/records.ts";
import { buildSnapshotIndex, compareCodeUnits, compareTicketNo, type Snapshot, ticketComparator } from "../../core/snapshot.ts";
import { formatOffsetIso } from "../../core/time.ts";
import { toCsv } from "../csv.ts";
import { CliError } from "../errors.ts";
import { RECORD_COLUMNS, RECORDS_DUMP_FORMAT, type RecordRow, type RecordsDump, rowToRecord } from "../records-dump.ts";
import type { Target } from "../target.ts";
import { parseSnapshot } from "../workdir.ts";
import { d1Execute, kvGet } from "../wrangler.ts";
import { configKey, parseVersions, snapshotKey } from "./publish.ts";

// export（Design Doc 8.1、8.5、FR-45）。D1 の記録、KV の設定と全イベントのスナップショット、D1 の devices を読み、
// core の集約で各チケットの状態を求めて、書き出しの各ファイルを --out のディレクトリに作る。
// 番号は Design Doc 8.5 の手順の番号である。1（環境の印とマイグレーションの照合）は、入口（main）が済ませる。
// 書き出しの間も同期で記録は増えるので、読む範囲（世代、版、連番の最大）を最初に固定する。fortee の API は呼ばない。

/** 記録を 1 回に読む件数（Design Doc 8.2） */
const PAGE = 1000;

/** 時計のずれの閾値の既定（分） */
export const DEFAULT_DRIFT_THRESHOLD_MINUTES = 5;

/** 取り消しの理由の区分の表示名（画面設計書 S08-M1）。記録には識別子を残し、表示名は出すときに引く（Design Doc 4.4） */
const REASON_LABEL: Record<string, string> = { mistake: "誤操作", wrong_person: "別人だった", other: "その他" };
const ROUTE_LABEL: Record<string, string> = { qr: "QR", search: "検索" };

export type ExportOptions = {
  /** 出力先のディレクトリ。まだないパスだけを受け付ける */
  out: string;
  /** 一括チェックイン CSV を分割する行数。省くと分割しない */
  chunk?: number | undefined;
  /** 時計のずれの閾値（分）。省くと 5 分 */
  driftThresholdMinutes?: number | undefined;
};

export type ExportDeps = {
  now: () => number;
  /** CLI のリリース名（git describe） */
  release: string | null;
  log: (line: string) => void;
  /** テストが、手順のあいだに割り込むためのもの。ふだんは指定しない */
  hooks?: {
    /** 2（範囲の固定）の後、3（記録の読み出し）の前 */
    afterFix?: () => Promise<void>;
    /** 6（世代の読み直し）の前 */
    beforeRecheck?: () => Promise<void>;
    /** 7 で、一時ディレクトリにすべてのファイルを書いた後、名前を変える前 */
    beforeRename?: () => Promise<void>;
  };
};

type DeviceRow = {
  device_id: string;
  clock_offset_ms: number;
  measured_at: number;
  max_abs_offset_ms: number;
  max_measured_at: number;
  app_version: string;
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

export async function exportRecords(target: Target, options: ExportOptions, deps: ExportDeps): Promise<void> {
  const out = resolve(options.out);
  const driftThresholdMinutes = options.driftThresholdMinutes ?? DEFAULT_DRIFT_THRESHOLD_MINUTES;
  const chunk = options.chunk ?? null;

  // --out には、まだないパスだけを受け付ける。すでにあるディレクトリは、空でも止まる
  const outExists = () => new CliError(`--out の ${out} は、すでにあります。まだないパスを指定してください。前回の書き出しを置き換えません`);
  if (await exists(out)) throw outExists();

  const startedAt = deps.now();

  // 2. 世代、版、記録の連番の最大を 1 文で読み、控える。1 文で読むので、3 つの値は同じ時点のものである
  const fixed = (
    await d1Execute<{ generation: string | null; versions: string | null; max_seq: number | null }>(
      target,
      "SELECT (SELECT value FROM meta WHERE key = 'generation') AS generation, " +
        "(SELECT value FROM meta WHERE key = 'versions') AS versions, " +
        "(SELECT max(seq) FROM records) AS max_seq",
    )
  )[0];
  if (fixed === undefined || fixed.generation === null) throw new CliError("D1 の meta に世代（generation）がありません");
  if (fixed.versions === null) throw new CliError("まだ公開していません。書き出しは公開中の設定とスナップショットを読むので、先に publish を実行してください");
  const generation = fixed.generation;
  const versions = parseVersions(fixed.versions, "D1 の meta.versions");
  const maxSeq = fixed.max_seq ?? 0;
  if (!Number.isSafeInteger(maxSeq) || maxSeq < 0) throw new CliError("D1 の記録の連番の最大を読めません");

  await deps.hooks?.afterFix?.();

  // 3. seq が、控えた最大以下の記録を、seq の範囲で 1,000 件ずつ読む。文に渡すのは、CLI が作る連番の整数だけである
  const records: ServerRecord[] = [];
  for (let after = 0; after < maxSeq; ) {
    const rows = await d1Execute<RecordRow>(
      target,
      `SELECT seq, ${RECORD_COLUMNS.join(", ")} FROM records WHERE seq > ${after} AND seq <= ${maxSeq} ORDER BY seq LIMIT ${PAGE}`,
    );
    const last = rows.at(-1)?.seq;
    if (last === undefined) break;
    for (const row of rows) records.push(rowToRecord(row));
    after = last;
  }

  // 4. 控えた版の config:{version} と snapshot:{eventId}:{version} を KV から読む。
  //    KV には現在と 1 つ前の版しか残さないので、書き出しの間に公開が 2 回あると、控えた版のキーが消えていることがある
  const readKv = async (key: string): Promise<string> => {
    const value = await kvGet(target, key);
    if (value === null) {
      throw new CliError(
        `KV に ${key} がありません。書き出しの間に公開が重なったか、DB を戻した後に公開をやり直していません。export をやり直してください`,
      );
    }
    return value;
  };
  const config = parseConfig(await readKv(configKey(versions.config)), `KV の ${configKey(versions.config)}`);
  const snapshots: Snapshot[] = [];
  for (const [eventId, version] of Object.entries(versions.events)) {
    const key = snapshotKey(eventId, version);
    snapshots.push(parseSnapshot(await readKv(key), eventId, `KV の ${key}`));
  }

  // 5. devices を読む。端末の行は範囲を固定せず、読んだ時刻を控える
  const devices = await d1Execute<DeviceRow>(
    target,
    "SELECT device_id, clock_offset_ms, measured_at, max_abs_offset_ms, max_measured_at, app_version FROM devices ORDER BY device_id",
  );
  const devicesReadAt = deps.now();

  await deps.hooks?.beforeRecheck?.();

  // 6. 世代を読み直し、控えた値と違えば、何も書かずに止まる。書き出しの間に世代の書き換えがあった
  const generationNow = (await d1Execute<{ value: string }>(target, "SELECT value FROM meta WHERE key = 'generation'"))[0]?.value;
  if (generationNow !== generation) {
    throw new CliError("書き出しの間に、DB の世代が書き換えられました（bump-generation）。何も書いていません。復旧が終わってから、export をやり直してください");
  }

  const tables = buildTables({ config, snapshots, records, devices, chunk, driftThresholdMinutes });
  const files = tables.map(([name, header, rows]): [string, string] => [
    name,
    toCsv(header, rows, name.startsWith("bulk-checkin-") ? "machine" : "spreadsheet"),
  ]);
  const rowCounts = tables.map(([name, , rows]): [string, number] => [name, rows.length]);
  const dump: RecordsDump = { format: RECORDS_DUMP_FORMAT, environment: target.env, generation, maxSeq, records };
  files.push(["records.json", `${JSON.stringify(dump)}\n`]);

  // manifest.json には、出力がどの版とどの記録の範囲から作られたかを残す
  const manifest = {
    environment: target.env,
    slug: config.conference.slug,
    release: deps.release,
    startedAt,
    startedAtIso: formatOffsetIso(startedAt, config.conference.timezone),
    generation,
    configVersion: versions.config,
    eventVersions: versions.events,
    maxSeq,
    recordCount: records.length,
    devicesReadAt,
    chunk,
    driftThresholdMinutes,
    files: files.map(([name]) => name),
  };

  // 7. --out の親ディレクトリの中に一時ディレクトリを作り、各ファイルを書き、最後に manifest.json を書く。
  //    書き終えたら、一時ディレクトリの名前を --out に変える。途中で止まった書き出しは、--out には現れない
  const parent = dirname(out);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, `.${basename(out)}.tmp-`));
  for (const [name, content] of files) await writeFile(join(temporary, name), content, "utf8");
  await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await deps.hooks?.beforeRename?.();

  if (await exists(out)) throw outExists();
  await rename(temporary, out);

  deps.log(`書き出しました: ${out}`);
  deps.log(`  世代 ${generation}、連番の最大 ${maxSeq}、記録 ${records.length} 件、設定の版 ${versions.config}`);
  for (const [name, count] of rowCounts) deps.log(`  ${name}: ${count} 行`);
  deps.log("fortee に反映する前に、done-with-cancel.csv（取り消した後に済みになったチケット）を確かめてください");
}

function parseConfig(text: string, what: string): PublishedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`${what} を JSON として読めません`);
  }
  const parsed = publishedConfigSchema.safeParse(raw);
  if (!parsed.success) throw new CliError(`${what} が、この版の CLI が読める設定の形ではありません。この版の CLI で公開し直してください`);
  return parsed.data;
}

type BuildInput = {
  config: PublishedConfig;
  snapshots: Snapshot[];
  records: ServerRecord[];
  devices: DeviceRow[];
  chunk: number | null;
  driftThresholdMinutes: number;
};

type Table = [name: string, header: string[], rows: string[][]];

/** 書き出しの CSV の中身を作る。ファイルの名前、ヘッダ、行の組。行の順は、入力だけから決まる */
function buildTables(input: BuildInput): Table[] {
  const { config, records, devices } = input;
  const timezone = config.conference.timezone;
  const iso = (epochMs: number) => formatOffsetIso(epochMs, timezone);
  const eventIds = config.events.map((event) => event.id);
  const index = buildSnapshotIndex(input.snapshots, eventIds);
  const states = aggregate(records);

  const eventKey = (ticketToken: string): string => {
    const ticket = index.byToken.get(ticketToken);
    const event = ticket === undefined ? undefined : config.events.find((candidate) => candidate.id === ticket.eventId);
    // スナップショットにないチケットでは、イベントの列は空になる
    return event === undefined ? "" : eventKeyOf(event);
  };
  const receptionName = (id: string | null): string =>
    id === null ? "受付なし" : (config.receptions.find((reception) => reception.id === id)?.name ?? "");

  // チケットの並び順。スナップショットにあるチケットは、設定のイベントの順、チケット番号の順。
  // スナップショットにないチケットは、その後ろに、記録のチケット番号とチケットトークンの順で置く
  const compareTickets = ticketComparator(eventIds);
  const lastRecordOf = new Map<string, ServerRecord>();
  const recordCount = new Map<string, number>();
  const hasCheckin = new Set<string>();
  for (const record of records) {
    const last = lastRecordOf.get(record.ticketToken);
    if (last === undefined || compareRecords(record, last) > 0) lastRecordOf.set(record.ticketToken, record);
    recordCount.set(record.ticketToken, (recordCount.get(record.ticketToken) ?? 0) + 1);
    if (record.op === "checkin") hasCheckin.add(record.ticketToken);
  }
  const compareTokens = (a: string, b: string): number => {
    const ticketA = index.byToken.get(a);
    const ticketB = index.byToken.get(b);
    if (ticketA !== undefined && ticketB !== undefined) return compareTickets(ticketA, ticketB);
    if (ticketA !== undefined) return -1;
    if (ticketB !== undefined) return 1;
    return compareTicketNo(lastRecordOf.get(a)?.ticketNo ?? "", lastRecordOf.get(b)?.ticketNo ?? "") || compareCodeUnits(a, b);
  };
  const ordered = [...states].sort(([a], [b]) => compareTokens(a, b));

  const files: Table[] = [];
  const table = (header: string[], rows: string[][]): [string[], string[][]] => [header, rows];

  // bulk-checkin-{n}.csv: 済みで、かつ現在のスナップショットにあるチケットを、根拠の記録の端末の時刻で 1 行ずつ
  const bulk = ordered.flatMap(([ticketToken, state]) => {
    const ticket = index.byToken.get(ticketToken);
    return state.done && ticket !== undefined ? [[ticket.profileUrlToken, iso(state.basis.deviceTime)]] : [];
  });
  const size = input.chunk ?? Math.max(bulk.length, 1);
  for (let n = 0; n === 0 || n * size < bulk.length; n++) {
    files.push([`bulk-checkin-${n + 1}.csv`, ...table(["profile_url_token", "checkined_at"], bulk.slice(n * size, (n + 1) * size))]);
  }

  // 取り消しの記録の列。時刻、受付、理由の区分、自由記述、操作者、端末
  const cancelHeader = (prefix: string) => [
    `${prefix}at`,
    `${prefix}reception`,
    `${prefix}reception_name`,
    `${prefix}reason_kind`,
    `${prefix}reason_text`,
    `${prefix}operator_id`,
    `${prefix}operator_name`,
    `${prefix}device_id`,
    `${prefix}device_name`,
  ];
  const cancelCells = (cancel: ServerRecord) => [
    iso(cancel.deviceTime),
    cancel.reception ?? "",
    receptionName(cancel.reception),
    REASON_LABEL[cancel.reasonKind ?? ""] ?? cancel.reasonKind ?? "",
    cancel.reasonText ?? "",
    cancel.operatorId,
    cancel.operatorName,
    cancel.deviceId,
    deviceName(cancel.deviceId),
  ];
  // チケット番号とユーザ名は、記録の値（Design Doc 4.4）
  const ticketCells = (ticketToken: string, record: ServerRecord) => [eventKey(ticketToken), ticketToken, record.ticketNo, record.userName];
  const ticketHeader = ["event", "ticket_token", "ticket_no", "user_name"];

  // cancelled.csv: 未で、かつ取り消しの記録があるチケット
  type WithCancel = TicketState<ServerRecord> & { lastCancel: ServerRecord };
  const withCancel = ordered.filter((entry): entry is [string, WithCancel] => entry[1].lastCancel !== undefined);
  files.push([
    "cancelled.csv",
    ...table(
      [...ticketHeader, ...cancelHeader("cancelled_")],
      withCancel.flatMap(([ticketToken, state]) =>
        state.done ? [] : [[...ticketCells(ticketToken, state.lastCancel), ...cancelCells(state.lastCancel)]],
      ),
    ),
  ]);

  // done-with-cancel.csv: 済みで、かつ取り消しの記録があるチケット。fortee に反映する前に、管理者が確かめる
  files.push([
    "done-with-cancel.csv",
    ...table(
      [
        ...ticketHeader,
        "done_at",
        "done_reception",
        "done_reception_name",
        "done_route",
        "done_operator_id",
        "done_operator_name",
        "done_device_id",
        "done_device_name",
        ...cancelHeader("last_cancel_"),
        "basis_before_last_cancel",
      ],
      withCancel.flatMap(([ticketToken, state]) => {
        if (!state.done) return [];
        const { basis, lastCancel } = state;
        return [
          [
            ...ticketCells(ticketToken, basis),
            iso(basis.deviceTime),
            basis.reception ?? "",
            receptionName(basis.reception),
            ROUTE_LABEL[basis.route ?? ""] ?? basis.route ?? "",
            basis.operatorId,
            basis.operatorName,
            basis.deviceId,
            deviceName(basis.deviceId),
            ...cancelCells(lastCancel),
            // 真の行は、取り消した端末が持っていなかった重複のチェックインで、済みに戻ったチケットである見込みが高い
            String(basis.deviceTime < lastCancel.deviceTime),
          ],
        ];
      }),
    ),
  ]);

  // missing-from-snapshot.csv: 記録はあるが、現在のスナップショットにないチケット。値は最新の記録のもの
  files.push([
    "missing-from-snapshot.csv",
    ...table(
      ["ticket_token", "ticket_no", "user_name", "record_count"],
      ordered.flatMap(([ticketToken]) => {
        const last = lastRecordOf.get(ticketToken);
        return index.byToken.has(ticketToken) || last === undefined
          ? []
          : [[ticketToken, last.ticketNo, last.userName, String(recordCount.get(ticketToken) ?? 0)]];
      }),
    ),
  ]);

  // fortee-only.csv: スナップショットの forteeCheckedIn が真で、本システムにチェックインの記録がないチケット
  files.push([
    "fortee-only.csv",
    ...table(
      ["event", "ticket_token", "ticket_no", "ticket_type", "user_name"],
      [...index.byToken.values()]
        .filter((ticket) => ticket.forteeCheckedIn && !hasCheckin.has(ticket.ticketToken))
        .sort(compareTickets)
        .map((ticket) => [eventKey(ticket.ticketToken), ticket.ticketToken, ticket.ticketNo, ticket.ticketType, ticket.userName]),
    ),
  ]);

  // clock-drift.csv: 最大の差の絶対値が、閾値を超える端末。最新の差だけで判定すると、時計が直った端末が漏れる
  const thresholdMs = input.driftThresholdMinutes * 60_000;
  files.push([
    "clock-drift.csv",
    ...table(
      ["device_id", "device_name", "clock_offset_ms", "measured_at", "max_abs_offset_ms", "max_measured_at"],
      devices
        .filter((device) => device.max_abs_offset_ms > thresholdMs)
        .map((device) => [
          device.device_id,
          deviceName(device.device_id),
          String(device.clock_offset_ms),
          iso(device.measured_at),
          String(device.max_abs_offset_ms),
          iso(device.max_measured_at),
        ]),
    ),
  ]);

  // devices.csv: すべての端末。measured_at は、最後に同期した時刻の目安（10 分の粒度）
  files.push([
    "devices.csv",
    ...table(
      ["device_id", "device_name", "measured_at", "clock_offset_ms", "max_abs_offset_ms", "app_version"],
      devices.map((device) => [
        device.device_id,
        deviceName(device.device_id),
        iso(device.measured_at),
        String(device.clock_offset_ms),
        String(device.max_abs_offset_ms),
        device.app_version,
      ]),
    ),
  ]);

  return files;
}
