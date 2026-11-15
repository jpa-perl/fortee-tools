import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { E2E_ENVIRONMENTS, E2E_HOST } from "./data.ts";

// Secure / __Host- Cookie を、HTTP の localhost に対するブラウザや OS ごとの例外に頼らずに使う。
// 証明書と鍵は実行ごとに作り、テスト用サーバだけで共有する。OS の信頼ストアには追加しない。
const directory = join(E2E_ENVIRONMENTS.main.dir, "tls");
const execFileAsync = promisify(execFile);
export const E2E_TLS_KEY = join(directory, "key.pem");
export const E2E_TLS_CERT = join(directory, "cert.pem");

/** prepare() がテストの保存先を空にした後、サーバを起動する前に呼ぶ */
export async function prepareTls(): Promise<void> {
  await mkdir(directory, { recursive: true });
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", E2E_TLS_KEY, "-out", E2E_TLS_CERT,
    "-days", "2", "-subj", `/CN=${E2E_HOST}`,
    "-addext", `subjectAltName=DNS:${E2E_HOST}`,
  ]);
}

export async function readTlsOptions(): Promise<{ key: Buffer; cert: Buffer }> {
  const [key, cert] = await Promise.all([readFile(E2E_TLS_KEY), readFile(E2E_TLS_CERT)]);
  return { key, cert };
}
