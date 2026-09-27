import { getCurrentWebview } from "@tauri-apps/api/webview";

// Zoom with limits, from the keyboard or a trackpad pinch. Uses the webview's
// own zoom so layout and mouse coordinates stay consistent.

const KEY = "pando.zoom";
export const MIN_ZOOM = 0.7;
export const MAX_ZOOM = 1.6;
const STEP = 0.1;

let current = 1;

function clamp(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 10) / 10));
}

function apply(z: number, round = true) {
  current = round ? clamp(z) : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
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
  // Trackpad pinch. WebKit (macOS, Linux) fires gesture events with a scale;
  // Chromium/WebView2 (Windows) sends ctrl+wheel. Both drive the same clamped zoom.
  let base = 1;
  type Gesture = Event & { scale: number };
  const onStart = (e: Event) => { e.preventDefault(); base = current; };
  const onChange = (e: Event) => { e.preventDefault(); apply(base * (e as Gesture).scale, false); };
  const onEnd = (e: Event) => { e.preventDefault(); apply(current); };
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    apply(current * Math.exp(-e.deltaY / 200), false);
  };

  window.addEventListener("keydown", onKey);
  window.addEventListener("gesturestart", onStart);
  window.addEventListener("gesturechange", onChange);
  window.addEventListener("gestureend", onEnd);
  window.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("gesturestart", onStart);
    window.removeEventListener("gesturechange", onChange);
    window.removeEventListener("gestureend", onEnd);
    window.removeEventListener("wheel", onWheel);
  };
}
