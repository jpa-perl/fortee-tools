import { render } from "preact";
import { boot } from "./commands/index.ts";
import { installTestHook, testBootOptions } from "./commands/test-hook.ts";
import { createBrowserPorts } from "./services/browser.ts";
import "./styles.css";
import { App } from "./ui/App.tsx";

const root = document.getElementById("app");
if (root === null) throw new Error("#app がない");

render(<App />, root);
// テスト用の入口は、開発サーバと、画面のテストのビルドにだけ入れる。本番のビルドでは、この行ごと落ちる
if (__TEST_HOOK__) installTestHook();
// 起動（Design Doc 6.4）。画面は、状態（state/model.ts の screen）を読んで切り替える
void boot(createBrowserPorts(), __TEST_HOOK__ ? testBootOptions() : {});
