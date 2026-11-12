import { NAME_MAX_LENGTH } from "../core/fields.ts";
import { meResponseSchema } from "../core/sync.ts";
import type { Env } from "./env.ts";

// Discord の OAuth（Design Doc 7.2）。認可コードフローに PKCE（S256）を付ける。
// Discord への通信はこのモジュールに閉じる。認可コードとトークンは、ログにも例外にも入れない。

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const API = "https://discord.com/api/v10";
/** ユーザの識別と、ギルドでのメンバー情報（ロールとニックネーム）の読み取り */
const SCOPE = "identify guilds.members.read";
/** Discord の応答を待つ時間。待つ時間は CPU 時間に数えられない（バックエンド 5 章） */
const TIMEOUT_MS = 10_000;

export function authorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    scope: SCOPE,
    state: params.state,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 認可コードを、code_verifier とともにアクセストークンに交換する。失敗すれば null */
export async function exchangeCode(
  env: Env,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<string | null> {
  const response = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      code_verifier: params.codeVerifier,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return isObject(body) ? nonEmptyString(body["access_token"]) : null;
}

export type OperatorResult =
  | { kind: "ok"; sub: string; name: string }
  /** 受付スタッフのロールを持たない。ギルドのメンバーでない場合を含む */
  | { kind: "no-role" }
  | { kind: "failed"; reason: string };

/** 設定されたロール ID の集合。カンマ区切りの秘密から作る */
function staffRoleIds(env: Env): Set<string> {
  return new Set(
    env.DISCORD_ROLE_IDS.split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
  );
}

/**
 * ユーザとギルドのメンバー情報を取り、ロールを確かめて、セッションに入れる操作者を返す（FR-35）。
 * 表示名は、ギルドでのニックネーム、グローバルな表示名、ユーザ名の順で最初にあるものにする
 */
export async function fetchOperator(env: Env, accessToken: string): Promise<OperatorResult> {
  const init = {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  const [userResponse, memberResponse] = await Promise.all([
    fetch(`${API}/users/@me`, init),
    fetch(`${API}/users/@me/guilds/${encodeURIComponent(env.DISCORD_GUILD_ID)}/member`, init),
  ]);
  if (!userResponse.ok) return { kind: "failed", reason: "user" };
  // ギルドのメンバーでなければ、Discord は 404 を返す。ロールを持たないのと同じに扱う
  if (memberResponse.status === 404) return { kind: "no-role" };
  if (!memberResponse.ok) return { kind: "failed", reason: "member" };

  const user: unknown = await userResponse.json();
  const member: unknown = await memberResponse.json();
  if (!isObject(user) || !isObject(member)) return { kind: "failed", reason: "shape" };

  const roles: unknown[] = Array.isArray(member["roles"]) ? member["roles"] : [];
  const staff = staffRoleIds(env);
  if (!roles.some((role) => typeof role === "string" && staff.has(role))) return { kind: "no-role" };

  const name = nonEmptyString(member["nick"]) ?? nonEmptyString(user["global_name"]) ?? nonEmptyString(user["username"]);
  // 操作者は記録に写される。記録のスキーマと同じ形（数字の ID、100 文字までの名前）でなければ、
  // 以後の同期がすべて 400 になるので、セッションを発行しない。Discord の名前は 32 文字までなので、
  // 切り詰めは実際には起きない
  const operator = meResponseSchema.safeParse({
    operatorId: user["id"],
    operatorName: name?.slice(0, NAME_MAX_LENGTH),
  });
  if (!operator.success) return { kind: "failed", reason: "operator" };
  return { kind: "ok", sub: operator.data.operatorId, name: operator.data.operatorName };
}
