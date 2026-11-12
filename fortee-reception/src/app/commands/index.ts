// 操作（commands）の入口。画面（ui）は、ここから import する。
// 画面が呼ぶのは、ここに並べた関数だけである。状態は state/ の Signal と導出を読む。

export { reloadFromError, reloadFromGuide } from "./app-shell.ts";
export { reportRenderError } from "./errors.ts";
export { type CancelReason, confirmCancel } from "./history.ts";
export {
  closeOverlay,
  goBack,
  openCancelConfirm,
  openCandidate,
  openHistory,
  openMenu,
  openOperation,
  openSearch,
  openSearchCheckinConfirm,
  selectTicket,
  setHistoryFilter,
  setSearchQuery,
  tapSync,
} from "./navigation.ts";
export {
  backToReceptionList,
  chooseAutoReception,
  chooseReception,
  confirmReceptionChange,
  dismissNotice,
  openReceptionSheet,
} from "./reception.ts";
export {
  attachCameraVideo,
  confirmSearchCheckin,
  confirmSuggestedSwitch,
  nextFromResult,
  openReference,
  openSwitchConfirm,
  retryCamera,
  startScan,
  stopScan,
} from "./scan.ts";
export { boot, logout, openLogoutConfirm, retryPrepare, startLogin, startRelogin } from "./session.ts";
export { setSoundEnabled, setVibrationEnabled, testSound } from "./settings.ts";
