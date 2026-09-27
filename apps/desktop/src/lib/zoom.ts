import { getCurrentWebview } from "@tauri-apps/api/webview";

// Keyboard zoom with limits. Uses the webview's own zoom so layout and mouse
// coordinates stay consistent. Pinch zoom is blocked.

const KEY = "pando.zoom";
export const MIN_ZOOM = 0.7;
export const MAX_ZOOM = 1.6;
const STEP = 0.1;

let current = 1;

function clamp(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 10) / 10));
}

function apply(z: number) {
  current = clamp(z);
  getCurrentWebview().setZoom(current).catch(() => {});
  try { localStorage.setItem(KEY, String(current)); } catch { /* ignore */ }
}

export function installZoom(): () => void {
  let saved = 1;
  try { saved = Number(localStorage.getItem(KEY)) || 1; } catch { /* ignore */ }
  apply(saved);

  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); apply(current + STEP); }
    else if (e.key === "-") { e.preventDefault(); apply(current - STEP); }
    else if (e.key === "0") { e.preventDefault(); apply(1); }
  };
  // Trackpad pinch: WebKit fires gesture events; Chromium/WebView2 sends ctrl+wheel.
  const stop = (e: Event) => e.preventDefault();
  const onWheel = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault(); };

  window.addEventListener("keydown", onKey);
  window.addEventListener("gesturestart", stop);
  window.addEventListener("gesturechange", stop);
  window.addEventListener("gestureend", stop);
  window.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("gesturestart", stop);
    window.removeEventListener("gesturechange", stop);
    window.removeEventListener("gestureend", stop);
    window.removeEventListener("wheel", onWheel);
  };
}
