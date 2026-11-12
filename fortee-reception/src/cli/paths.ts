import { fileURLToPath } from "node:url";

/** パッケージの根（package.json、wrangler.jsonc、config/、migrations/ のあるディレクトリ） */
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
