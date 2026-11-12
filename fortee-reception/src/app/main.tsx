import { render } from "preact";
import { startAppShell } from "./commands/app-shell.ts";
import "./styles.css";
import { App } from "./ui/App.tsx";

const root = document.getElementById("app");
if (root === null) throw new Error("#app がない");

render(<App />, root);
startAppShell();
