/// The branch a repository's branches are compared to, when the user picked
/// one. Remembered on this computer, per repository. Nothing picked: Pando
/// uses origin/<default branch>, or the local default branch with no remote.
const key = (root: string) => `pando.base:${root}`;

export function getChosenBase(root: string): string | null {
  try { return localStorage.getItem(key(root)) || null; } catch { return null; }
}

export function setChosenBase(root: string, name: string | null) {
  try { if (name) localStorage.setItem(key(root), name); else localStorage.removeItem(key(root)); } catch { /* not remembered */ }
}
