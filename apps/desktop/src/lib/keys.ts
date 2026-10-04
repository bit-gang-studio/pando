import { useEffect, useRef } from "react";

// One rule for keys: only the top layer hears them. Dialogs, confirms and
// menus are overlays; screens are pages. While any overlay is open, pages get
// no Escape and no shortcuts. With two overlays open, only the newest acts.

type Layer = { overlay: boolean; onEscape: () => void };
const layers: Layer[] = [];

const typing = () => {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(el.type));
};
const last = (overlay: boolean) => [...layers].reverse().find((l) => l.overlay === overlay);
const topOverlay = () => last(true);

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const over = topOverlay();
  // A page's Escape means "go back", so it must not fire while typing.
  const target = over ?? (typing() ? undefined : last(false));
  if (!target) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  target.onEscape();
}, true);

/// True while a dialog, confirm or menu is open. Page shortcuts check this.
export const overlayOpen = () => layers.some((l) => l.overlay);

/// Register a layer while mounted. `onEscape` is what Escape does when this
/// layer is on top; pass null to swallow it (a dialog that's busy).
/// Returns a check for "am I the top overlay", for the layer's own shortcuts.
export function useLayer(kind: "overlay" | "page", onEscape: (() => void) | null, active = true): () => boolean {
  const fn = useRef(onEscape);
  fn.current = onEscape;
  const me = useRef<Layer | null>(null);
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { overlay: kind === "overlay", onEscape: () => fn.current?.() };
    me.current = layer;
    layers.push(layer);
    return () => { layers.splice(layers.indexOf(layer), 1); me.current = null; };
  }, [kind, active]);
  return () => me.current !== null && topOverlay() === me.current;
}
