import js from "@eslint/js";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import tseslint from "typescript-eslint";

// 依存の方向（Design Doc 3.1、3.2、6.1）と、CSS の書き方（Design Doc 6.12）を lint で守る。
// 型検査（tsc -b の project references）と合わせて、レビューに頼らずに守るためのものである。

/** 相対パスで、名前を挙げたディレクトリへ入る import に当たる正規表現 */
const into = (...dirs) => `^(\\.{1,2}/)+(.*/)?(${dirs.join("|")})/`;

/** 名前を挙げたもの以外のパッケージの import に当たる正規表現。相対パスの import には当たらない */
const packagesExcept = (...allowed) => `^(?!\\.{1,2}/)${allowed.map((pattern) => `(?!${pattern})`).join("")}`;

const restrictImports = (...patterns) => ({
  "@typescript-eslint/no-restricted-imports": ["error", { patterns }],
});

// no-restricted-imports は、静的な import と export ... from だけを見る。動的な import() は、
// 同じ層の中のファイルなら型検査も通るので、層の向きの検査をすり抜ける。src/ では使わない
const noDynamicImport = {
  selector: "ImportExpression",
  message: "動的な import() は使わない。依存の方向の検査（no-restricted-imports）が効かない。",
};

// core の関数は、引数だけから結果を決める。現在時刻と乱数は、呼び出し側が引数で渡す（Design Doc 5 章）
const noAmbientInputs = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: "core は現在時刻を自分で読まない。呼び出し側が引数で渡す。",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "core は現在時刻を自分で読まない。呼び出し側が引数で渡す。",
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: "core は乱数を自分で作らない。呼び出し側が引数で渡す。",
  },
];

const layer = {
  core: [
    { regex: into("app", "sw", "worker", "cli", "build", "test"), message: "core は、ほかの層に依存しない。" },
    {
      regex: packagesExcept("zod(/|$)", "mustache$"),
      message: "core が依存してよいライブラリは zod と mustache だけ。実行環境の API も使わない。",
    },
  ],
  app: [
    { regex: into("sw", "worker", "cli", "build", "test"), message: "app が依存してよい層は core だけ。" },
    {
      regex: packagesExcept("preact(/|$)", "@preact/signals$", "idb$", "zxing-wasm/reader(/|$)"),
      message: "app が依存してよいライブラリは Preact、@preact/signals、idb、zxing-wasm の reader だけ。",
    },
  ],
  sw: [{ regex: "^", message: "Service Worker は、ほかのファイルを読み込まない。一覧と版はビルドが埋め込む。" }],
  worker: [
    { regex: into("app", "sw", "cli", "build", "test"), message: "worker が依存してよい層は core だけ。" },
    {
      regex: packagesExcept("hono(/|$)", "cloudflare:"),
      message: "worker が依存してよいライブラリは Hono だけ。",
    },
  ],
  cli: [
    { regex: into("app", "sw", "worker", "build", "test"), message: "cli が依存してよい層は core だけ。" },
    {
      regex: packagesExcept("node:", "smol-toml$", "fflate$", "csv-parse(/|$)", "pngjs$", "jsqr$"),
      message: "cli が依存してよいライブラリは smol-toml、fflate、csv-parse、pngjs、jsQR と Node.js だけ。",
    },
  ],
};

// app の中の層（Design Doc 6.1）。上の層は下の層を呼び、下の層は上の層を知らない
const appLayer = {
  ui: [
    { regex: into("services", "storage"), message: "ui が依存してよいのは state と commands だけ。" },
    {
      regex: into("core"),
      allowTypeImports: true,
      message: "ui は core を直接呼ばない。型だけは import してよい。",
    },
    { regex: "^(idb$|zxing-wasm(/|$))", message: "ui は記憶域とデコードを直接使わない。" },
  ],
  state: [{ regex: into("ui", "commands", "services", "storage"), message: "state が依存してよいのは core だけ。" }],
  commands: [{ regex: into("ui"), message: "commands は ui を知らない。" }],
  services: [
    { regex: into("ui", "state", "commands", "storage"), message: "services が依存してよいのは core だけ。" },
  ],
  storage: [
    { regex: into("ui", "state", "commands", "services"), message: "storage が依存してよいのは core だけ。" },
  ],
};

export default tseslint.config(
  { ignores: ["dist/", ".tsbuild/", ".wrangler/", ".work/", "docs/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 使わない引数と変数は、名前を _ で始めて示す
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // 同じ規則の設定は後のものが置き換えるので、core には両方を並べる
  { files: ["src/**"], rules: { "no-restricted-syntax": ["error", noDynamicImport] } },
  { files: ["src/core/**"], rules: { "no-restricted-syntax": ["error", noDynamicImport, ...noAmbientInputs] } },

  // 層のあいだの依存の方向
  { files: ["src/core/**"], rules: restrictImports(...layer.core) },
  { files: ["src/app/**"], rules: restrictImports(...layer.app) },
  { files: ["src/sw/**"], rules: restrictImports(...layer.sw) },
  { files: ["src/worker/**"], rules: restrictImports(...layer.worker) },
  { files: ["src/cli/**"], rules: restrictImports(...layer.cli) },

  // app の中の層。同じ規則の設定は後のものが置き換えるので、app の規則も合わせて並べる
  ...Object.entries(appLayer).map(([name, patterns]) => ({
    files: [`src/app/${name}/**`],
    rules: restrictImports(...layer.app, ...patterns),
  })),

  // テストは、確かめる層と、その層が依存してよい層だけを読む
  { files: ["test/core/**"], rules: restrictImports({ regex: into("app", "sw", "worker", "cli"), message: "core のテストは core だけを読む。" }) },
  { files: ["test/app/**"], rules: restrictImports({ regex: into("sw", "worker", "cli"), message: "app のテストは app と core だけを読む。" }) },
  { files: ["test/worker/**"], rules: restrictImports({ regex: into("app", "sw", "cli"), message: "worker のテストは worker と core だけを読む。" }) },
  { files: ["test/cli/**"], rules: restrictImports({ regex: into("app", "sw", "worker"), message: "cli のテストは cli と core だけを読む。" }) },

  // CSS のクラス（Design Doc 6.12）
  {
    files: ["src/app/**/*.tsx"],
    plugins: { "better-tailwindcss": betterTailwindcss },
    settings: { "better-tailwindcss": { entryPoint: "src/app/styles.css" } },
    rules: {
      // 既定のテーマを消してあるので、既定のクラス（text-lg など）は CSS が生成されない。
      // 画面の上では気付きにくいので、登録していないクラスを検出する
      "better-tailwindcss/no-unknown-classes": ["error", { detectComponentClasses: true }],
      // 既定のテーマを消しても生成される、体系の外の値を持ち込む書き方を禁じる
      "better-tailwindcss/no-restricted-classes": [
        "error",
        {
          restrict: [
            {
              pattern: "[\\[(]",
              message:
                "任意の値と任意の変種（角括弧、丸括弧）は使わない。値はトークンか @utility に、条件は @custom-variant にする。",
            },
            {
              pattern: "^(.*:)?rounded-full$",
              message: "角丸は押せる要素の 1 種類だけ。丸い形はアイコンの SVG か @layer components に書く。",
            },
          ],
        },
      ],
    },
  },
);
