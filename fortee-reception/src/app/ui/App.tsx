import { Component, type ComponentChildren } from "preact";
import { reportRenderError } from "../commands/index.ts";
import { screen } from "../state/index.ts";
import { OverlayHost } from "./Overlay.tsx";
import { RehearsalBand } from "./RehearsalBand.tsx";
import { ErrorScreen, Guide } from "./screens/Guide.tsx";
import { History, OperationDetail } from "./screens/History.tsx";
import { Home } from "./screens/Home.tsx";
import { Login } from "./screens/Login.tsx";
import { Menu } from "./screens/Menu.tsx";
import { Candidate, Search } from "./screens/Search.tsx";

/**
 * 描画中の例外を受けて、S99 に移る（Design Doc 6.10）。S99 は、失敗した部分木の外で、状態を読まずに描く
 */
class ErrorBoundary extends Component<{ children: ComponentChildren }, { failed: boolean }> {
  override state = { failed: false };

  override componentDidCatch(error: unknown) {
    this.setState({ failed: true });
    reportRenderError(error);
  }

  render() {
    return this.state.failed ? <ErrorScreen /> : this.props.children;
  }
}

/** 画面は URL ではなく状態で切り替える（Design Doc 6.9）ので、ルータは置かない。遷移は、すべて操作（commands）が行う */
function CurrentScreen() {
  const current = screen.value;
  switch (current.id) {
    case "boot":
      // 起動の最初の判定が終わるまでは、何も出さない
      return null;
    case "S00":
      return <Guide reason={current.reason} />;
    case "S01":
      return <Login state={current} />;
    case "home":
      return <Home mode={current.mode} />;
    case "S05":
      return <Search query={current.query} />;
    case "S06":
      return <Candidate state={current} />;
    case "S07":
      return <History filter={current.filter} />;
    case "S08":
      return <OperationDetail opId={current.opId} />;
    case "S09":
      return <Menu />;
    case "S99":
      return <ErrorScreen />;
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <CurrentScreen />
      <RehearsalBand />
      {screen.value.id !== "S99" && <OverlayHost />}
    </ErrorBoundary>
  );
}
