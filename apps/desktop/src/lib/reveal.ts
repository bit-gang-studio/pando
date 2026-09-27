import { revealItemInDir } from "@tauri-apps/plugin-opener";

const platform = navigator.userAgent.includes("Mac") ? "mac" : navigator.userAgent.includes("Windows") ? "windows" : "linux";

/// The file manager's own name for it.
export const REVEAL_LABEL = platform === "mac" ? "Show in Finder" : platform === "windows" ? "Show in Explorer" : "Show in folder";
export const reveal = (path: string) => revealItemInDir(path);
